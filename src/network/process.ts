/**
 * Tiny wrappers around `process.kill(pid, 0)` and signal dispatch so the
 * supervision layer can be unit-tested with a stub.
 *
 * Centralising these here keeps `lifecycle.ts` free of platform conditionals
 * — Windows reports liveness somewhat differently than POSIX, and we want a
 * single place to grow that compatibility shim if it ever matters.
 */

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
