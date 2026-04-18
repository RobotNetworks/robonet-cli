const DEFAULT_MAX_RETRIES = 2;
const DEFAULT_INITIAL_DELAY_MS = 500;

export interface RetryOptions {
  readonly maxRetries?: number;
  readonly initialDelayMs?: number;
}

/**
 * Returns true if the HTTP status code is transient and safe to retry.
 * 429 = rate limited, 502/503/504 = upstream/infrastructure errors.
 */
export function isRetryableStatus(status: number): boolean {
  return status === 429 || status === 502 || status === 503 || status === 504;
}

/**
 * Returns true if the error is a network-level failure (not an HTTP response).
 * Covers DNS failures, connection resets, and timeouts from AbortSignal.timeout.
 */
export function isRetryableNetworkError(err: unknown): boolean {
  if (err instanceof TypeError) return true; // fetch network errors
  if (err instanceof DOMException && err.name === "TimeoutError") return true;
  return false;
}

/**
 * Execute an async function with retry on transient failures.
 * Uses exponential backoff with jitter.
 */
export async function withRetry<T>(
  fn: () => Promise<T>,
  options?: RetryOptions,
): Promise<T> {
  const maxRetries = options?.maxRetries ?? DEFAULT_MAX_RETRIES;
  const initialDelay = options?.initialDelayMs ?? DEFAULT_INITIAL_DELAY_MS;

  let lastError: unknown;
  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    try {
      return await fn();
    } catch (err) {
      lastError = err;
      if (attempt >= maxRetries || !shouldRetry(err)) {
        throw err;
      }
      const delay = initialDelay * Math.pow(2, attempt) * (0.5 + Math.random() * 0.5);
      await sleep(delay);
    }
  }
  throw lastError;
}

function shouldRetry(err: unknown): boolean {
  if (isRetryableNetworkError(err)) return true;
  // APIError and MCPError carry the status in their message; those are handled
  // at the call site by checking the status before throwing. For generic errors
  // from fetch itself, we retry.
  return false;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
