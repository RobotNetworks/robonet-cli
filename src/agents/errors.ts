import { RobotNetCLIError } from "../errors.js";

/**
 * Thrown when an agent-discovery operation is invoked against a network
 * that doesn't expose the discovery surface (e.g. operators that
 * implement only the core wire protocol and skip the directory layer).
 *
 * Distinct from `AsmtpApiError`: this isn't an authentication or
 * not-found failure, it's a network-capability gap. Surfaced to the user
 * with an actionable hint to switch networks via `--network`.
 */
export class CapabilityNotSupportedError extends RobotNetCLIError {
  readonly networkName: string;
  readonly capability: string;

  constructor(networkName: string, capability: string) {
    super(
      `${capability} is not supported on the "${networkName}" network. ` +
        `Switch to a network that exposes it with --network <name>.`,
    );
    this.name = "CapabilityNotSupportedError";
    this.networkName = networkName;
    this.capability = capability;
  }
}
