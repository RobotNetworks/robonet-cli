/**
 * Tiny wrappers around `process.kill(pid, 0)`, signal dispatch, and TCP
 * port-occupancy probing so the supervision layer can be unit-tested with
 * stubs.
 *
 * Centralising these here keeps `lifecycle.ts` free of platform conditionals
 * — Windows reports liveness somewhat differently than POSIX, and we want a
 * single place to grow that compatibility shim if it ever matters.
 */

import { createServer } from "node:net";

/** Returns true when the OS reports a process is alive (or the caller lacks permission to know either way). */
export function isProcessAlive(pid: number): boolean {
  try {
    // Signal 0 is the documented "test process exists" probe on POSIX. It
    // returns true for unkillable processes too, but that's fine for our
    // use — we only care that the PID is still bound to *something*.
    process.kill(pid, 0);
    return true;
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    // EPERM means the process exists but we don't own it. Treat as alive
    // so we don't confidently delete a state file pointing at a different
    // user's PID.
    return code === "EPERM";
  }
}

/** Send a signal; swallow ESRCH (already dead). */
export function sendSignal(pid: number, signal: NodeJS.Signals): void {
  try {
    process.kill(pid, signal);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== "ESRCH") throw err;
  }
}

/** Poll `isProcessAlive` until it returns false or the deadline elapses. Returns true when the process exited within the budget. */
export async function waitForExit(
  pid: number,
  args: { readonly deadlineMs: number; readonly intervalMs?: number },
): Promise<boolean> {
  const intervalMs = args.intervalMs ?? 50;
  while (Date.now() < args.deadlineMs) {
    if (!isProcessAlive(pid)) return true;
    await new Promise((r) => setTimeout(r, intervalMs));
  }
  return !isProcessAlive(pid);
}

/**
 * Probe whether `host:port` is already accepting TCP connections. Resolves
 * `true` if a `bind()` attempt fails with `EADDRINUSE`, `false` if the bind
 * would succeed (we close immediately) or fails for any other reason. The
 * other-reason branch deliberately reports "not in use" so the caller can
 * proceed and surface a more specific error from the spawn path — we don't
 * want a transient permission glitch on the probe to block startup.
 */
export async function isPortInUse(host: string, port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const server = createServer();
    server.once("error", (err: NodeJS.ErrnoException) => {
      resolve(err.code === "EADDRINUSE");
    });
    server.once("listening", () => {
      server.close(() => resolve(false));
    });
    server.listen(port, host);
  });
}
