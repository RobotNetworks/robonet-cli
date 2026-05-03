/**
 * Readiness probe for a running operator's `/healthz` endpoint.
 *
 * Used by `network start` to confirm the spawned operator is actually
 * accepting requests before declaring success, and by `network status` to
 * surface live operational health alongside the cached PID/port from the
 * state file.
 */

interface HealthBody {
  readonly ok: true;
  readonly network: string;
  readonly version: string;
  readonly uptime_ms: number;
}

export interface HealthSnapshot extends HealthBody {
  /** Round-trip time of the probe in milliseconds. */
  readonly rtt_ms: number;
}

export interface ProbeOptions {
  readonly timeoutMs?: number;
}

export class HealthProbeError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "HealthProbeError";
  }
}

/** One-shot probe. Resolves when /healthz returns 200 + a well-formed body, rejects on timeout, transport error, or malformed body. */
export async function probeHealth(
  url: string,
  opts: ProbeOptions = {},
): Promise<HealthSnapshot> {
  const timeoutMs = opts.timeoutMs ?? 1_000;
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  const start = Date.now();
  try {
    const res = await fetch(url, { signal: ctrl.signal });
    if (res.status !== 200) {
      throw new HealthProbeError(
        `unexpected status ${res.status} from ${url}`,
      );
    }
    const body = (await res.json()) as unknown;
    return { ...validateHealthBody(body), rtt_ms: Date.now() - start };
  } catch (err) {
    if (err instanceof HealthProbeError) throw err;
    if (err instanceof Error && err.name === "AbortError") {
      throw new HealthProbeError(`timed out after ${timeoutMs}ms probing ${url}`);
    }
    const detail = err instanceof Error ? err.message : String(err);
    throw new HealthProbeError(`fetch ${url} failed: ${detail}`);
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Poll `/healthz` until it succeeds or the deadline elapses.
 *
 * Used immediately after spawning the operator: we don't know exactly when
 * `listen()` resolves on the child socket, so the supervision layer fires
 * probes on a 50ms cadence and declares success on the first 200.
 */
export async function waitForHealth(
  url: string,
  args: { readonly deadlineMs: number; readonly intervalMs?: number },
): Promise<HealthSnapshot> {
  const intervalMs = args.intervalMs ?? 50;
  let lastError: Error = new HealthProbeError("never probed");
  while (Date.now() < args.deadlineMs) {
    try {
      return await probeHealth(url, { timeoutMs: 500 });
    } catch (err) {
      lastError = err instanceof Error ? err : new Error(String(err));
    }
    await sleep(intervalMs);
  }
  throw lastError;
}

function validateHealthBody(body: unknown): HealthBody {
  if (typeof body !== "object" || body === null || Array.isArray(body)) {
    throw new HealthProbeError("/healthz body is not an object");
  }
  const o = body as Record<string, unknown>;
  if (o["ok"] !== true) {
    throw new HealthProbeError("/healthz body missing `ok: true`");
  }
  if (typeof o["network"] !== "string" || typeof o["version"] !== "string") {
    throw new HealthProbeError("/healthz body missing `network` or `version`");
  }
  if (typeof o["uptime_ms"] !== "number" || !Number.isFinite(o["uptime_ms"])) {
    throw new HealthProbeError("/healthz body missing numeric `uptime_ms`");
  }
  return {
    ok: true,
    network: o["network"],
    version: o["version"],
    uptime_ms: o["uptime_ms"],
  };
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}
