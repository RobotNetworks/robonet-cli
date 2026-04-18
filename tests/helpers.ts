import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";

/**
 * Create a temporary directory with isolated XDG env vars.
 * Returns the base tmp dir and a cleanup function.
 */
export function isolatedXdg(): {
  tmpDir: string;
  cleanup: () => void;
  originalEnv: Record<string, string | undefined>;
} {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "robonet-test-"));
  const configHome = path.join(tmpDir, "config");
  const stateHome = path.join(tmpDir, "state");

  const originalEnv: Record<string, string | undefined> = {
    XDG_CONFIG_HOME: process.env.XDG_CONFIG_HOME,
    XDG_STATE_HOME: process.env.XDG_STATE_HOME,
    ROBONET_PROFILE: process.env.ROBONET_PROFILE,
    ROBONET_ENVIRONMENT: process.env.ROBONET_ENVIRONMENT,
    ROBONET_API_BASE_URL: process.env.ROBONET_API_BASE_URL,
    ROBONET_MCP_BASE_URL: process.env.ROBONET_MCP_BASE_URL,
    ROBONET_AUTH_BASE_URL: process.env.ROBONET_AUTH_BASE_URL,
    ROBONET_WEBSOCKET_URL: process.env.ROBONET_WEBSOCKET_URL,
  };

  process.env.XDG_CONFIG_HOME = configHome;
  process.env.XDG_STATE_HOME = stateHome;
  delete process.env.ROBONET_PROFILE;
  delete process.env.ROBONET_ENVIRONMENT;
  delete process.env.ROBONET_API_BASE_URL;
  delete process.env.ROBONET_MCP_BASE_URL;
  delete process.env.ROBONET_AUTH_BASE_URL;
  delete process.env.ROBONET_WEBSOCKET_URL;

  return {
    tmpDir,
    originalEnv,
    cleanup: () => {
      for (const [key, value] of Object.entries(originalEnv)) {
        if (value === undefined) {
          delete process.env[key];
        } else {
          process.env[key] = value;
        }
      }
      fs.rmSync(tmpDir, { recursive: true, force: true });
    },
  };
}
