import { createHash, randomBytes, timingSafeEqual } from "node:crypto";

/**
 * Bearer-token utilities for the operator.
 *
 * Tokens are 32 bytes of CSPRNG randomness, base64url-encoded → 43 chars.
 * Storage is the sha256 hex digest; the plaintext is returned exactly once
 * at registration / rotation time.
 */

export function mintBearerToken(): string {
  return randomBytes(32).toString("base64url");
}

export function sha256Hex(value: string): string {
  return createHash("sha256").update(value, "utf-8").digest("hex");
}

/** Constant-time hex digest equality. Both inputs must be the same length. */
export function safeHexEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  const ab = Buffer.from(a, "hex");
  const bb = Buffer.from(b, "hex");
  if (ab.length !== bb.length || ab.length === 0) return false;
  return timingSafeEqual(ab, bb);
}
