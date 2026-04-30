/** Default HTTP request timeout in milliseconds. */
export const REQUEST_TIMEOUT_MS = 20_000;

/** Timeout for lightweight discovery/health requests. */
export const DISCOVERY_TIMEOUT_MS = 10_000;

/** Base URLs for the RobotNet service surfaces the CLI talks to. */
export interface EndpointConfig {
  readonly apiBaseUrl: string;
  readonly authBaseUrl: string;
  readonly websocketUrl: string;
}
