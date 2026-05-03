import { randomBytes } from "node:crypto";

/**
 * ULID-style sortable identifiers used throughout the operator.
 *
 * Format: `<prefix>_<26-char Crockford base32>` where the first 10
 * characters encode the millisecond timestamp and the remaining 16
 * encode 80 random bits. IDs minted in the same millisecond are
 * lexicographically ordered by their random tail.
 *
 * Why ULID-ish instead of UUID v4: the time-prefix means SQLite's
 * default ordering on the PK roughly matches insertion order, which
 * makes pagination + log-style scans far cheaper than sorting on a
 * separate timestamp column. ASP IDs (`sess_`, `msg_`, `evt_`) follow
 * the same convention so cross-referencing across logs is easy.
 */

const CROCKFORD_BASE32 = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";

function encodeBase32(bytes: Uint8Array): string {
  let out = "";
  let bits = 0;
  let value = 0;
  for (const byte of bytes) {
    value = (value << 8) | byte;
    bits += 8;
    while (bits >= 5) {
      bits -= 5;
      out += CROCKFORD_BASE32[(value >>> bits) & 0x1f];
    }
  }
  if (bits > 0) {
    out += CROCKFORD_BASE32[(value << (5 - bits)) & 0x1f];
  }
  return out;
}

function timeBytes(ms: number): Uint8Array {
  // 48 bits of milliseconds — fits all timestamps until year ~10889.
  const bytes = new Uint8Array(6);
  let v = ms;
  for (let i = 5; i >= 0; i--) {
    bytes[i] = v & 0xff;
    v = Math.floor(v / 0x100);
  }
  return bytes;
}

function ulidString(now: number = Date.now()): string {
  const buf = new Uint8Array(16);
  buf.set(timeBytes(now), 0);
  buf.set(randomBytes(10), 6);
  // 16 bytes → 26 base32 chars (with the last char only carrying 1 bit
  // of payload — that's the canonical ULID width).
  return encodeBase32(buf).slice(0, 26);
}

/** Mint a fresh prefixed ULID-ish identifier (e.g. `sess_01HXY…`). */
export function mintId(prefix: "sess" | "msg" | "evt"): string {
  return `${prefix}_${ulidString()}`;
}
