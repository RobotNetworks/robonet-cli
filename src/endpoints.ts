/** Default HTTP request timeout in milliseconds. */
export const REQUEST_TIMEOUT_MS = 20_000;

/** Longer timeout for MCP RPC calls that may involve tool execution. */
export const MCP_TIMEOUT_MS = 30_000;

/** Timeout for lightweight discovery/health requests. */
export const DISCOVERY_TIMEOUT_MS = 10_000;

export interface EndpointConfig {
  readonly apiBaseUrl: string;
  readonly mcpBaseUrl: string;
  readonly authBaseUrl: string;
  readonly websocketUrl: string;
}
