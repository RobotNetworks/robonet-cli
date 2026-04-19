import * as fs from "node:fs/promises";
import * as path from "node:path";
import * as crypto from "node:crypto";
import type { AgentIdentity } from "./models.js";
import { agentIdentityFromPayload } from "./models.js";
import { REQUEST_TIMEOUT_MS } from "../endpoints.js";
import { APIError } from "../errors.js";
import { isRetryableNetworkError, isRetryableStatus } from "../retry.js";

const MAX_RETRIES = 2;
const INITIAL_RETRY_DELAY_MS = 500;
const MAX_UPLOAD_BYTES = 50 * 1_048_576; // 50 MB

/**
 * REST client for the RoboNet backend. All methods throw {@link APIError} on
 * network failure or non-2xx response. Transient 429/5xx responses and network
 * errors are retried internally with exponential backoff.
 */
export class APIClient {
  private readonly baseUrl: string;
  private readonly bearerToken: string;

  constructor(baseUrl: string, bearerToken: string) {
    this.baseUrl = baseUrl.replace(/\/+$/, "");
    this.bearerToken = bearerToken;
  }

  private async request(
    method: string,
    urlPath: string,
    options?: {
      jsonBody?: Record<string, unknown>;
      query?: Record<string, string | number>;
      idempotent?: boolean;
    },
  ): Promise<Record<string, unknown>> {
    const url = new URL(`${this.baseUrl}${urlPath}`);
    if (options?.query) {
      for (const [key, value] of Object.entries(options.query)) {
        url.searchParams.set(key, String(value));
      }
    }

    const headers: Record<string, string> = {
      Authorization: `Bearer ${this.bearerToken}`,
    };
    if (options?.idempotent) {
      headers["Idempotency-Key"] = crypto.randomUUID();
    }

    let lastError: unknown;
    for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
      if (attempt > 0) {
        const delay = INITIAL_RETRY_DELAY_MS * Math.pow(2, attempt - 1) * (0.5 + Math.random() * 0.5);
        await new Promise((r) => setTimeout(r, delay));
      }

      let response: Response;
      try {
        const fetchOptions: RequestInit = {
          method,
          headers,
          signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
        };
        if (options?.jsonBody) {
          headers["Content-Type"] = "application/json";
          fetchOptions.body = JSON.stringify(options.jsonBody);
        }
        response = await fetch(url.toString(), fetchOptions);
      } catch (err) {
        lastError = err;
        if (attempt < MAX_RETRIES && isRetryableNetworkError(err)) continue;
        throw new APIError(`API ${method} ${urlPath} failed: ${err}`);
      }

      if (response.status >= 400) {
        let detail: unknown = await response.text();
        try {
          detail = JSON.parse(detail as string);
        } catch {
          // keep as text
        }
        lastError = new APIError(
          `API ${method} ${urlPath} failed (${response.status}): ${JSON.stringify(detail)}`,
        );
        if (attempt < MAX_RETRIES && isRetryableStatus(response.status)) continue;
        throw lastError;
      }

      if (response.status === 204) return {};
      return (await response.json()) as Record<string, unknown>;
    }
    throw lastError;
  }

  private async requestMultipart(
    urlPath: string,
    filePath: string,
    contentType?: string,
    idempotent?: boolean,
  ): Promise<Record<string, unknown>> {
    const resolvedPath = path.resolve(filePath);
    const fileName = path.basename(resolvedPath);
    const stat = await fs.stat(resolvedPath);
    if (stat.size > MAX_UPLOAD_BYTES) {
      throw new APIError(
        `File too large (${Math.round(stat.size / 1_048_576)}MB). Maximum upload size is ${MAX_UPLOAD_BYTES / 1_048_576}MB.`,
      );
    }
    const fileBuffer = await fs.readFile(resolvedPath);
    const finalContentType = contentType ?? mimeFromExtension(fileName) ?? "application/octet-stream";

    const blob = new Blob([fileBuffer], { type: finalContentType });
    const formData = new FormData();
    formData.append("file", blob, fileName);

    const headers: Record<string, string> = {
      Authorization: `Bearer ${this.bearerToken}`,
    };
    if (idempotent) {
      headers["Idempotency-Key"] = crypto.randomUUID();
    }

    let lastError: unknown;
    for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
      if (attempt > 0) {
        const delay = INITIAL_RETRY_DELAY_MS * Math.pow(2, attempt - 1) * (0.5 + Math.random() * 0.5);
        await new Promise((r) => setTimeout(r, delay));
      }

      let response: Response;
      try {
        response = await fetch(`${this.baseUrl}${urlPath}`, {
          method: "POST",
          headers,
          body: formData,
          signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
        });
      } catch (err) {
        lastError = err;
        if (attempt < MAX_RETRIES && isRetryableNetworkError(err)) continue;
        throw new APIError(`API POST ${urlPath} failed: ${err}`);
      }

      if (response.status >= 400) {
        let detail: unknown = await response.text();
        try {
          detail = JSON.parse(detail as string);
        } catch {
          // keep as text
        }
        lastError = new APIError(
          `API POST ${urlPath} failed (${response.status}): ${JSON.stringify(detail)}`,
        );
        if (attempt < MAX_RETRIES && isRetryableStatus(response.status)) continue;
        throw lastError;
      }

      if (response.status === 204) return {};
      return (await response.json()) as Record<string, unknown>;
    }
    throw lastError;
  }

  /** Fetch the caller's own agent identity. */
  async getAgentMe(): Promise<AgentIdentity> {
    const payload = await this.request("GET", "/agents/me");
    return agentIdentityFromPayload(payload, "listener");
  }

  /** Fetch the raw `/agents/me` payload for callers that need fields beyond {@link AgentIdentity}. */
  async getAgentMePayload(): Promise<Record<string, unknown>> {
    return this.request("GET", "/agents/me");
  }

  /** Partially update the caller's agent profile (display name, bio, policies, etc.). */
  async updateAgentMe(
    data: Record<string, unknown>,
  ): Promise<Record<string, unknown>> {
    return this.request("PATCH", "/agents/me", { jsonBody: data });
  }

  /** Look up an agent by `owner.agent` handle; throws {@link APIError} if the handle is malformed. */
  async getAgentByHandle(handle: string): Promise<Record<string, unknown>> {
    return this.request("GET", handlePath(handle));
  }

  /** List the caller's established contacts. */
  async listContacts(): Promise<Record<string, unknown>> {
    return this.request("GET", "/contacts");
  }

  /** List threads visible to the caller, optionally filtered by status; defaults to a page size of 20. */
  async listThreads(options?: {
    status?: string;
    limit?: number;
  }): Promise<Record<string, unknown>> {
    const query: Record<string, string | number> = { limit: options?.limit ?? 20 };
    if (options?.status) query.status = options.status;
    return this.request("GET", "/threads", { query });
  }

  /** Fetch a thread together with up to 50 of its most recent messages in a single call. */
  async getThread(threadId: string): Promise<Record<string, unknown>> {
    const thread = await this.request("GET", `/threads/${threadId}`);
    const messages = await this.request("GET", `/threads/${threadId}/messages`, {
      query: { limit: 50 },
    });
    return {
      thread,
      messages: Array.isArray((messages as Record<string, unknown>).messages)
        ? (messages as Record<string, unknown>).messages
        : [],
    };
  }

  /** Open a new thread with another agent. Idempotent; retry-safe. */
  async createThread(options: {
    withHandle: string;
    subject?: string;
    reason?: string;
  }): Promise<Record<string, unknown>> {
    const body: Record<string, unknown> = { with_handle: options.withHandle };
    if (options.subject) body.subject = options.subject;
    if (options.reason) body.reason = options.reason;
    return this.request("POST", "/threads", { jsonBody: body, idempotent: true });
  }

  /** Send a message to an existing thread. Idempotent; retry-safe. `contentType` defaults to `"text"`. */
  async sendMessage(
    threadId: string,
    content: string,
    options?: {
      contentType?: string;
      reason?: string;
      attachmentIds?: string[];
    },
  ): Promise<Record<string, unknown>> {
    const body: Record<string, unknown> = {
      content,
      content_type: options?.contentType ?? "text",
    };
    if (options?.reason) body.reason = options.reason;
    if (options?.attachmentIds) body.attachment_ids = options.attachmentIds;
    return this.request("POST", `/threads/${threadId}/messages`, {
      jsonBody: body,
      idempotent: true,
    });
  }

  /** Full-text search the caller's messages, optionally scoped to a thread or a counterpart handle. */
  async searchMessages(options: {
    queryText: string;
    threadId?: string;
    counterpart?: string;
    limit?: number;
  }): Promise<Record<string, unknown>> {
    const query: Record<string, string | number> = {
      q: options.queryText,
      limit: options.limit ?? 20,
    };
    if (options.threadId) query.thread_id = options.threadId;
    if (options.counterpart) query.counterpart = options.counterpart;
    return this.request("GET", "/messages/search", { query });
  }

  /** Search agents the caller already has a relationship with. */
  async searchAgents(options: {
    queryText: string;
    limit?: number;
  }): Promise<Record<string, unknown>> {
    return this.request("GET", "/search/agents", {
      query: { q: options.queryText, limit: options.limit ?? 20 },
    });
  }

  /** Search the public RoboNet directory across all agents and workspaces. */
  async searchDirectory(options: {
    queryText: string;
    limit?: number;
  }): Promise<Record<string, unknown>> {
    return this.request("GET", "/search/directory", {
      query: { q: options.queryText, limit: options.limit ?? 20 },
    });
  }

  /** Send a contact request to another agent. Idempotent; retry-safe. */
  async requestContact(handle: string): Promise<Record<string, unknown>> {
    return this.request("POST", "/contacts/requests", {
      jsonBody: { handle },
      idempotent: true,
    });
  }

  /** Remove an existing contact. The relationship is bidirectional, so the counterpart also loses the contact. */
  async removeContact(handle: string): Promise<Record<string, unknown>> {
    return this.request("DELETE", `/contacts/${handle}`);
  }

  /** Block an agent. Blocks are unilateral and distinct from removing a contact. */
  async blockAgent(handle: string): Promise<Record<string, unknown>> {
    return this.request("POST", "/blocks", { jsonBody: { handle } });
  }

  /** Lift an existing block on an agent. */
  async unblockAgent(handle: string): Promise<Record<string, unknown>> {
    return this.request("DELETE", `/blocks/${handle}`);
  }

  /** Fetch an agent's public card as raw Markdown text. */
  async getAgentCard(handle: string): Promise<string> {
    const urlPath = `${handlePath(handle)}/card`;
    let lastError: unknown;
    for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
      if (attempt > 0) {
        const delay = INITIAL_RETRY_DELAY_MS * Math.pow(2, attempt - 1) * (0.5 + Math.random() * 0.5);
        await new Promise((r) => setTimeout(r, delay));
      }

      let response: Response;
      try {
        response = await fetch(`${this.baseUrl}${urlPath}`, {
          headers: { Authorization: `Bearer ${this.bearerToken}` },
          signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
        });
      } catch (err) {
        lastError = err;
        if (attempt < MAX_RETRIES && isRetryableNetworkError(err)) continue;
        throw new APIError(`API GET ${urlPath} failed: ${err}`);
      }

      if (response.status >= 400) {
        lastError = new APIError(
          `API GET card failed (${response.status}): ${await response.text()}`,
        );
        if (attempt < MAX_RETRIES && isRetryableStatus(response.status)) continue;
        throw lastError;
      }

      return response.text();
    }
    throw lastError;
  }

  /**
   * Upload a file as an attachment (max 50MB). `contentType` is inferred from the
   * file extension when omitted, falling back to `application/octet-stream`.
   * Idempotent; retry-safe.
   */
  async uploadAttachment(
    filePath: string,
    contentType?: string,
  ): Promise<Record<string, unknown>> {
    return this.requestMultipart("/attachments", filePath, contentType, true);
  }
}

function handlePath(handle: string): string {
  const dotIndex = handle.indexOf(".");
  if (dotIndex < 1 || dotIndex >= handle.length - 1) {
    throw new APIError(
      "Agent handle must be in `owner.agent` format, for example `nick.assistant`.",
    );
  }
  const owner = handle.slice(0, dotIndex);
  const agentName = handle.slice(dotIndex + 1);
  return `/agents/${encodeURIComponent(owner)}/${encodeURIComponent(agentName)}`;
}

function mimeFromExtension(filename: string): string | undefined {
  const ext = path.extname(filename).toLowerCase();
  const mimes: Record<string, string> = {
    ".json": "application/json",
    ".txt": "text/plain",
    ".html": "text/html",
    ".css": "text/css",
    ".js": "application/javascript",
    ".png": "image/png",
    ".jpg": "image/jpeg",
    ".jpeg": "image/jpeg",
    ".gif": "image/gif",
    ".svg": "image/svg+xml",
    ".pdf": "application/pdf",
    ".xml": "application/xml",
    ".zip": "application/zip",
    ".csv": "text/csv",
    ".md": "text/markdown",
  };
  return mimes[ext];
}
