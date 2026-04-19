import { MCP_TIMEOUT_MS } from "./endpoints.js";
import { MCPError } from "./errors.js";
import { isRetryableNetworkError, isRetryableStatus } from "./retry.js";

const MAX_RETRIES = 2;
const INITIAL_RETRY_DELAY_MS = 500;

import { createRequire } from "node:module";
const pkg = createRequire(import.meta.url)("../package.json") as { version: string };
const VERSION = pkg.version;

/**
 * JSON-RPC 2.0 client for RoboNet's MCP (Model Context Protocol) endpoint.
 * Handles the MCP session handshake, caches the session ID, and retries
 * transient failures. All methods throw {@link MCPError} on transport or
 * RPC-level errors.
 */
export class MCPClient {
  private readonly baseUrl: string;
  private readonly bearerToken: string;
  private sessionId: string | null = null;
  private rpcCounter = 1;

  constructor(baseUrl: string, bearerToken: string) {
    this.baseUrl = baseUrl.replace(/\/+$/, "");
    this.bearerToken = bearerToken;
  }

  private get rpcUrl(): string {
    return this.baseUrl.endsWith("/mcp") ? this.baseUrl : `${this.baseUrl}/mcp`;
  }

  /** Perform the MCP `initialize` handshake if it hasn't been done yet; safe to call multiple times. */
  async initialize(): Promise<void> {
    if (this.sessionId) return;
    await this.rpc("initialize", {
      protocolVersion: "2024-11-05",
      clientInfo: { name: "robonet-cli", version: VERSION },
      capabilities: { tools: {}, resources: {} },
    });
  }

  /** List the tools exposed by the MCP server, auto-initializing the session if needed. */
  async listTools(): Promise<Record<string, unknown>[]> {
    await this.initialize();
    const result = await this.rpc("tools/list");
    const tools = result.tools;
    if (!Array.isArray(tools)) return [];
    return tools.filter(
      (t): t is Record<string, unknown> => typeof t === "object" && t !== null,
    );
  }

  /**
   * Invoke an MCP tool and return its structured result. If the tool responds
   * with a single text content block that contains JSON, the JSON is parsed and
   * returned directly (with `_meta` preserved); otherwise raw text is wrapped as `{ raw: ... }`.
   */
  async callTool(
    name: string,
    args: Record<string, unknown>,
  ): Promise<Record<string, unknown>> {
    await this.initialize();
    const result = await this.rpc("tools/call", { name, arguments: args });

    const content = result.content;
    const meta = result._meta;

    if (Array.isArray(content) && content.length > 0) {
      const first = content[0];
      if (typeof first === "object" && first !== null && typeof first.text === "string") {
        const text = first.text as string;
        try {
          const parsed = JSON.parse(text) as Record<string, unknown>;
          if (typeof parsed === "object" && parsed !== null && typeof meta === "object" && meta !== null) {
            parsed._meta = meta;
          }
          return parsed;
        } catch {
          const payload: Record<string, unknown> = { raw: text };
          if (typeof meta === "object" && meta !== null) {
            payload._meta = meta;
          }
          return payload;
        }
      }
    }
    return result;
  }

  private async rpc(
    method: string,
    params?: Record<string, unknown>,
  ): Promise<Record<string, unknown>> {
    const headers: Record<string, string> = {
      Authorization: `Bearer ${this.bearerToken}`,
      "Content-Type": "application/json",
    };
    if (this.sessionId) {
      headers["MCP-Session-Id"] = this.sessionId;
    }

    const rpcId = this.rpcCounter++;
    const body = JSON.stringify({
      jsonrpc: "2.0",
      id: rpcId,
      method,
      params: params ?? {},
    });

    let lastError: unknown;
    for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
      if (attempt > 0) {
        const delay = INITIAL_RETRY_DELAY_MS * Math.pow(2, attempt - 1) * (0.5 + Math.random() * 0.5);
        await new Promise((r) => setTimeout(r, delay));
      }

      let response: Response;
      try {
        response = await fetch(this.rpcUrl, {
          method: "POST",
          headers,
          body,
          signal: AbortSignal.timeout(MCP_TIMEOUT_MS),
        });
      } catch (err) {
        lastError = err;
        if (attempt < MAX_RETRIES && isRetryableNetworkError(err)) continue;
        throw new MCPError(`MCP ${method} failed: ${err}`);
      }

      if (response.status >= 400) {
        lastError = new MCPError(
          `MCP ${method} failed (${response.status}): ${await response.text()}`,
        );
        if (attempt < MAX_RETRIES && isRetryableStatus(response.status)) continue;
        throw lastError;
      }

      const sessionHeader = response.headers.get("MCP-Session-Id");
      if (sessionHeader && !this.sessionId) {
        this.sessionId = sessionHeader;
      }

      const payload = (await response.json()) as Record<string, unknown>;
      if ("error" in payload) {
        throw new MCPError(`MCP error for ${method}: ${JSON.stringify(payload.error)}`);
      }

      const result = payload.result;
      if (typeof result !== "object" || result === null) {
        return { result };
      }
      return result as Record<string, unknown>;
    }
    throw lastError;
  }
}
