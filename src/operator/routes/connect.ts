import type { IncomingMessage } from "node:http";
import type { Duplex } from "node:stream";

import { WebSocketServer, type WebSocket } from "ws";

import { requireAgentForUpgrade } from "../auth.js";
import type { SessionService } from "../domain/sessions.js";
import type { ConnectionRegistry } from "../domain/transport.js";
import { OperatorError, UnauthorizedError } from "../errors.js";
import type { OperatorRepository } from "../storage/repository.js";

/**
 * `/connect` WebSocket upgrade handler.
 *
 * The HTTP server emits an `upgrade` event for any non-Upgrade-rejecting
 * request; we route those to {@link handleConnectUpgrade} which:
 *
 * 1. Validates the request path and bearer (via `?token=` query string,
 *    since browsers can't set Authorization on WS).
 * 2. Hands the socket to the `ws` library to complete the handshake.
 * 3. Registers the new connection with {@link ConnectionRegistry}.
 * 4. Triggers a replay-since-cursor for the agent so they catch up on
 *    anything they missed while disconnected.
 */
export interface ConnectRoutesContext {
  readonly repo: OperatorRepository;
  readonly registry: ConnectionRegistry;
  readonly service: SessionService;
}

export function buildConnectHandler(ctx: ConnectRoutesContext): {
  readonly handleUpgrade: (
    req: IncomingMessage,
    socket: Duplex,
    head: Buffer,
  ) => void;
  readonly closeAll: () => void;
} {
  // `noServer: true` means the WSS doesn't bind to anything itself —
  // we hand it the upgrade event from the http server.
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
      onSocketReady(ctx, ws, agentHandle);
    });
  };

  const closeAll = (): void => {
    ctx.registry.closeAll(1001, "operator shutting down");
    wss.close();
  };

  return { handleUpgrade, closeAll };
}

function onSocketReady(
  ctx: ConnectRoutesContext,
  ws: WebSocket,
  handle: string,
): void {
  ctx.registry.register(handle, ws);
  // Decline any inbound frames — `/connect` is server-push only. Drop the
  // socket on first frame received to make the contract obvious.
  ws.on("message", () => {
    ws.close(1003, "client frames not accepted on /connect");
  });
  // Replay anything the agent missed while offline.
  try {
    ctx.service.replayForHandle(handle);
  } catch (err) {
    const detail = err instanceof Error ? err.message : String(err);
    process.stderr.write(`robotnet-operator: replay failed for ${handle}: ${detail}\n`);
    ws.close(1011, "replay failed");
  }
}

function socketReject(socket: Duplex, status: number, message: string): void {
  const statusText = status === 401
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
