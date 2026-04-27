/** Base class for all errors raised by the RoboNet CLI; catch this to handle any CLI-origin failure. */
export class RoboNetCLIError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "RoboNetCLIError";
  }
}

/** Thrown when CLI configuration (profile, endpoints, paths) is missing or malformed. */
export class ConfigurationError extends RoboNetCLIError {
  constructor(message: string) {
    super(message);
    this.name = "ConfigurationError";
  }
}

/** Thrown when OAuth discovery metadata cannot be fetched or is missing required fields. */
export class DiscoveryError extends RoboNetCLIError {
  constructor(message: string) {
    super(message);
    this.name = "DiscoveryError";
  }
}

/** Thrown on OAuth/login failures: registration, token exchange, refresh, or missing stored credentials. */
export class AuthenticationError extends RoboNetCLIError {
  constructor(message: string) {
    super(message);
    this.name = "AuthenticationError";
  }
}

/**
 * Thrown when the auth server has rejected a stored credential in a way that
 * cannot be recovered by retrying — e.g. revoked refresh-token family, expired
 * refresh token, or a deleted authorization. Callers should surface this to
 * the user (re-login required) rather than retry.
 */
export class FatalAuthError extends AuthenticationError {
  constructor(message: string) {
    super(message);
    this.name = "FatalAuthError";
  }
}

/**
 * Thrown for retryable failures from the auth server: 5xx responses, request
 * timeouts (408), and rate-limiting (429). Distinct from {@link AuthenticationError}
 * because the stored credential is still valid — the listener should back off
 * and retry rather than treat the failure as terminal.
 */
export class TransientAuthError extends RoboNetCLIError {
  constructor(message: string) {
    super(message);
    this.name = "TransientAuthError";
  }
}

/** Thrown when a REST API call to the RoboNet backend fails (network or non-2xx status). */
export class APIError extends RoboNetCLIError {
  constructor(message: string) {
    super(message);
    this.name = "APIError";
  }
}

/** Thrown when an MCP JSON-RPC call fails at the transport level or returns a JSON-RPC error. */
export class MCPError extends RoboNetCLIError {
  constructor(message: string) {
    super(message);
    this.name = "MCPError";
  }
}

/** Thrown for daemon lifecycle failures: already-running, spawn failure, or corrupted daemon state. */
export class DaemonError extends RoboNetCLIError {
  constructor(message: string) {
    super(message);
    this.name = "DaemonError";
  }
}
