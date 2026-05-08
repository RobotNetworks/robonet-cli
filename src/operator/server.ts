import {
  createServer,
  type IncomingMessage,
  type Server,
  type ServerResponse,
} from "node:http";
import type { Duplex } from "node:stream";

import type Database from "better-sqlite3";

import type { OperatorConfig } from "./config.js";
import { FileService } from "./domain/files.js";
import { SessionService } from "./domain/sessions.js";
import { ConnectionRegistry } from "./domain/transport.js";
import { NotFoundError } from "./errors.js";
import { registerAdminRoutes } from "./routes/admin.js";
import { buildConnectHandler } from "./routes/connect.js";
import { registerFileRoutes } from "./routes/files.js";
import { sendError, sendJson } from "./routes/json.js";
import { Router, type RouteContext } from "./routes/router.js";
import { registerSearchRoutes } from "./routes/search.js";
import { registerSelfRoutes } from "./routes/self.js";
import { registerSessionRoutes } from "./routes/sessions.js";
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
  readonly db: Database.Database;
  /**
   * Override the grace window between a handle's last WS closing and
   * `session.left{reason: "grace_expired"}` firing. Defaults to 30s in
   * production. Tests pass tight values (~100ms) to exercise the timer
   * without sleeping for half a minute.
   */
  readonly graceMs?: number;
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
 * - `GET /healthz` — readiness, always public.
 * - `/_admin/*` — admin surface (bearer-auth via the operator admin token).
 * - `/sessions/*` — session surface (bearer-auth via per-agent bearers).
 * - `GET /connect` — WS upgrade for live event delivery.
 *
 * Errors thrown from handlers translate into ASP error envelopes via
 * {@link sendError}.
 */
export function startOperatorServer(
  deps: OperatorServerDeps,
): Promise<OperatorHandle> {
  const registry = new ConnectionRegistry(
    deps.graceMs !== undefined ? { graceMs: deps.graceMs } : {},
  );
  const fileService = new FileService(deps.repo, {
    host: deps.config.host,
    port: deps.config.port,
    filesDir: deps.config.filesDir,
  });
  const service = new SessionService(deps.repo, deps.db, registry, fileService);
  // Wire the presence transitions so connection lifecycle drives
  // session.disconnected / session.reconnected / session.left{grace_expired}.
  registry.setHooks({
    onWentOffline: (handle) => service.onAgentWentOffline(handle),
    onCameBack: (handle) => service.onAgentCameBack(handle),
    onGraceExpired: (handle) => service.onAgentGraceExpired(handle),
  });
  const connect = buildConnectHandler({
    repo: deps.repo,
    registry,
    service,
  });
  const router = buildRouter(deps, service, fileService);
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

function buildRouter(
  deps: OperatorServerDeps,
  service: SessionService,
  fileService: FileService,
): Router {
  const router = new Router();
  registerAdminRoutes(router, {
    repo: deps.repo,
    db: deps.db,
    adminTokenHash: deps.config.adminTokenHash,
  });
  registerSelfRoutes(router, { repo: deps.repo });
  registerSessionRoutes(router, { repo: deps.repo, service });
  registerSearchRoutes(router, { repo: deps.repo, service });
  registerFileRoutes(router, { repo: deps.repo, files: fileService });
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

  if (method === "GET" && url.pathname === "/healthz") {
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
  // Tear down WS connections first so the http server's close() doesn't
  // wait on long-lived upgrade sockets.
  connect.closeAll();
  return new Promise<void>((resolve, reject) => {
    server.close((err) => {
      if (err) reject(err);
      else resolve();
    });
    server.closeAllConnections?.();
  });
}
