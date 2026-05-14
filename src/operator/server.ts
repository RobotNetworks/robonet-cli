import {
  createServer,
  type IncomingMessage,
  type Server,
  type ServerResponse,
} from "node:http";
import type { Duplex } from "node:stream";

import type { DatabaseSync } from "node:sqlite";

import type { OperatorConfig } from "./config.js";
import { EnvelopeService } from "./domain/envelopes.js";
import { FileService } from "./domain/files.js";
import { MailboxService } from "./domain/mailbox.js";
import { ConnectionRegistry } from "./domain/transport.js";
import { NotFoundError } from "./errors.js";
import { registerAdminRoutes } from "./routes/admin.js";
import { buildConnectHandler } from "./routes/connect.js";
import { registerFileRoutes } from "./routes/files.js";
import { sendError, sendJson } from "./routes/json.js";
import { registerMailboxRoutes } from "./routes/mailbox.js";
import { registerMessagesRoutes } from "./routes/messages.js";
import { Router, type RouteContext } from "./routes/router.js";
import { registerSearchRoutes } from "./routes/search.js";
import { registerSelfRoutes } from "./routes/self.js";
import type { OperatorRepository } from "./storage/repository.js";

/**
 * Public handle returned by {@link startOperatorServer}. Closing it shuts
 * the listener down, terminates every live WebSocket, and resolves once
 * all in-flight connections have drained.
 */
export interface OperatorHandle {
  readonly host: string;
  readonly port: number;
  close(): Promise<void>;
}

interface OperatorServerDeps {
  readonly config: OperatorConfig;
  readonly repo: OperatorRepository;
  readonly db: DatabaseSync;
}

interface HealthBody {
  readonly ok: true;
  readonly network: string;
  readonly version: string;
  readonly uptime_ms: number;
}

/**
 * Start the operator's HTTP+WS server and resolve with a {@link OperatorHandle}.
 *
 * Endpoints:
 *
 *  - `GET /healthz` / `GET /health` readiness, always public.
 *  - `/_admin/*` admin surface (bearer auth via the operator admin token).
 *  - `/agents/me/*`, `/agents/:owner/:name`, `/blocks/*` self + discovery
 *    surface (agent bearer).
 *  - `/messages`, `/messages/:id` envelope send and fetch.
 *  - `/mailbox`, `/mailbox/read` mailbox listing and bulk mark-read.
 *  - `/files`, `/files/:id` upload and download.
 *  - `/search`, `/search/agents` agent discovery.
 *  - `GET /connect` WebSocket upgrade for push frames.
 */
export function startOperatorServer(
  deps: OperatorServerDeps,
): Promise<OperatorHandle> {
  const registry = new ConnectionRegistry();
  const envelopes = new EnvelopeService(deps.repo, deps.db, registry);
  const mailbox = new MailboxService(deps.repo);
  const files = new FileService(deps.repo, {
    host: deps.config.host,
    port: deps.config.port,
    filesDir: deps.config.filesDir,
  });

  const connect = buildConnectHandler({ repo: deps.repo, registry });
  const router = buildRouter(deps, { envelopes, mailbox, files });
  const startedAt = Date.now();

  const server = createServer((req, res) => {
    handleRequest(req, res, deps.config, router, startedAt).catch((err: unknown) => {
      try {
        sendError(res, err);
      } catch {
        // Response already started or socket dead.
      }
    });
  });

  server.on("upgrade", (req, socket, head) => {
    connect.handleUpgrade(req, socket as Duplex, head);
  });

  return new Promise<OperatorHandle>((resolve, reject) => {
    const onError = (err: NodeJS.ErrnoException): void => {
      server.removeListener("listening", onListening);
      reject(err);
    };
    const onListening = (): void => {
      server.removeListener("error", onError);
      resolve({
        host: deps.config.host,
        port: deps.config.port,
        close: () => closeServer(server, connect),
      });
    };
    server.once("error", onError);
    server.once("listening", onListening);
    server.listen(deps.config.port, deps.config.host);
  });
}

interface RouterServices {
  readonly envelopes: EnvelopeService;
  readonly mailbox: MailboxService;
  readonly files: FileService;
}

function buildRouter(
  deps: OperatorServerDeps,
  services: RouterServices,
): Router {
  const router = new Router();
  registerAdminRoutes(router, {
    repo: deps.repo,
    db: deps.db,
    adminTokenHash: deps.config.adminTokenHash,
  });
  registerSelfRoutes(router, { repo: deps.repo });
  registerMessagesRoutes(router, { repo: deps.repo, envelopes: services.envelopes });
  registerMailboxRoutes(router, { repo: deps.repo, mailbox: services.mailbox });
  registerFileRoutes(router, { repo: deps.repo, files: services.files });
  registerSearchRoutes(router, { repo: deps.repo });
  return router;
}

async function handleRequest(
  req: IncomingMessage,
  res: ServerResponse,
  config: OperatorConfig,
  router: Router,
  startedAt: number,
): Promise<void> {
  const method = req.method ?? "GET";
  const url = new URL(req.url ?? "/", `http://${req.headers.host ?? "127.0.0.1"}`);

  if (
    method === "GET" &&
    (url.pathname === "/healthz" || url.pathname === "/health")
  ) {
    const body: HealthBody = {
      ok: true,
      network: config.networkName,
      version: config.operatorVersion,
      uptime_ms: Date.now() - startedAt,
    };
    sendJson(res, 200, body);
    return;
  }

  let resolved: { handler: (rc: RouteContext) => void | Promise<void>; params: Readonly<Record<string, string>> };
  try {
    resolved = router.resolve(method, url.pathname);
  } catch (err) {
    sendError(res, err);
    return;
  }

  try {
    await resolved.handler({ req, res, url, params: resolved.params });
  } catch (err) {
    sendError(res, err);
  }

  if (!res.writableEnded) {
    sendError(res, new NotFoundError("route did not produce a response"));
  }
}

function closeServer(
  server: Server,
  connect: { readonly closeAll: () => void },
): Promise<void> {
  connect.closeAll();
  return new Promise<void>((resolve, reject) => {
    server.close((err) => {
      if (err) reject(err);
      else resolve();
    });
    server.closeAllConnections?.();
  });
}
