/** Base class for all errors raised by the RobotNet CLI; catch this to handle any CLI-origin failure. */
export class RobotNetCLIError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "RobotNetCLIError";
  }
}

/** Thrown when CLI configuration (profile, endpoints, paths) is missing or malformed. */
export class ConfigurationError extends RobotNetCLIError {
  constructor(message: string) {
    super(message);
    this.name = "ConfigurationError";
  }
}

/** Thrown when OAuth discovery metadata cannot be fetched or is missing required fields. */
export class DiscoveryError extends RobotNetCLIError {
  constructor(message: string) {
    super(message);
    this.name = "DiscoveryError";
  }
}

/** Thrown on OAuth/login failures: registration, token exchange, refresh, or missing stored credentials. */
export class AuthenticationError extends RobotNetCLIError {
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
export class TransientAuthError extends RobotNetCLIError {
  constructor(message: string) {
    super(message);
    this.name = "TransientAuthError";
  }
}

