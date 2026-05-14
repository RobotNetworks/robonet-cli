import type { IncomingMessage } from "node:http";
import type { Duplex } from "node:stream";

import { WebSocketServer } from "ws";

import { requireAgentForUpgrade } from "../auth.js";
import type { ConnectionRegistry } from "../domain/transport.js";
import { OperatorError, UnauthorizedError } from "../errors.js";
import type { OperatorRepository } from "../storage/repository.js";

/**
 * `/connect` WebSocket upgrade handler.
 *
 * Pure server push: after a successful upgrade the connection is added
 * to the registry, and the operator pushes `envelope.notify` and
 * `monitor.fact` frames as new entries land. Clients send nothing; any
 * inbound frame is silently ignored.
 *
 * REST catch-up after (re)connect is the client's job: paginate
 * `GET /mailbox?after_created_at=&after_envelope_id=` from the persisted
 * watermark. The operator never replays on connect.
 */
export interface ConnectRoutesContext {
  readonly repo: OperatorRepository;
  readonly registry: ConnectionRegistry;
}

export function buildConnectHandler(ctx: ConnectRoutesContext): {
  readonly handleUpgrade: (
    req: IncomingMessage,
    socket: Duplex,
    head: Buffer,
  ) => void;
  readonly closeAll: () => void;
} {
  const wss = new WebSocketServer({ noServer: true });

  const handleUpgrade = (
    req: IncomingMessage,
    socket: Duplex,
    head: Buffer,
  ): void => {
    let url: URL;
    try {
      url = new URL(req.url ?? "/", `http://${req.headers.host ?? "127.0.0.1"}`);
    } catch {
      socketReject(socket, 400, "invalid request URL");
      return;
    }
    if (url.pathname !== "/connect") {
      socketReject(socket, 404, "not found");
      return;
    }

    let agentHandle: string;
    try {
      const agent = requireAgentForUpgrade(req, url, ctx.repo.agents);
      agentHandle = agent.handle;
    } catch (err) {
      const status = err instanceof UnauthorizedError ? 401 : 400;
      const detail = err instanceof OperatorError ? err.message : "unauthorized";
      socketReject(socket, status, detail);
      return;
    }

    wss.handleUpgrade(req, socket, head, (ws) => {
      ctx.registry.register(agentHandle, ws);
      // Spec: the WS is one-way (server > client). Any inbound frame
      // is ignored.
      ws.on("message", () => {
        /* ignore */
      });
    });
  };

  const closeAll = (): void => {
    ctx.registry.closeAll(1001, "operator shutting down");
    wss.close();
  };

  return { handleUpgrade, closeAll };
}

function socketReject(socket: Duplex, status: number, message: string): void {
  // Note: the WS spec uses 1008 on auth failure for already-upgraded
  // sockets. Pre-upgrade we're still in HTTP territory and respond with
  // a 401/404/400 as appropriate.
  const statusText =
    status === 401
      ? "Unauthorized"
      : status === 404
        ? "Not Found"
        : "Bad Request";
  const body = JSON.stringify({
    error: { code: status === 401 ? "UNAUTHORIZED" : "BAD_REQUEST", message },
  });
  socket.write(
    `HTTP/1.1 ${status} ${statusText}\r\n` +
      "Content-Type: application/json\r\n" +
      `Content-Length: ${Buffer.byteLength(body)}\r\n` +
      "Connection: close\r\n" +
      "\r\n" +
      body,
  );
  socket.destroy();
}
