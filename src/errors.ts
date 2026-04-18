export class RoboNetCLIError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "RoboNetCLIError";
  }
}

export class ConfigurationError extends RoboNetCLIError {
  constructor(message: string) {
    super(message);
    this.name = "ConfigurationError";
  }
}

export class DiscoveryError extends RoboNetCLIError {
  constructor(message: string) {
    super(message);
    this.name = "DiscoveryError";
  }
}

export class AuthenticationError extends RoboNetCLIError {
  constructor(message: string) {
    super(message);
    this.name = "AuthenticationError";
  }
}

export class APIError extends RoboNetCLIError {
  constructor(message: string) {
    super(message);
    this.name = "APIError";
  }
}

export class MCPError extends RoboNetCLIError {
  constructor(message: string) {
    super(message);
    this.name = "MCPError";
  }
}

export class DaemonError extends RoboNetCLIError {
  constructor(message: string) {
    super(message);
    this.name = "DaemonError";
  }
}
