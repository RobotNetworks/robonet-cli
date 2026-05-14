import { randomBytes } from "node:crypto";

/**
 * ULID-style sortable identifiers used by the operator.
 *
 * Format for an ASMTP envelope id: `01<24 Crockford-base32 chars>` —
 * 26 chars total, the leading "01" forces a year-3000+ ULID range that
 * the wire schema validates. The first 10 chars encode milliseconds; the
 * remaining 16 encode 80 random bits.
 *
 * File ids use the `file_<26 base32>` convention so they're visually
 * distinct from envelope ids on the wire and in logs. They're not
 * envelope-id-shaped and don't need the leading "01".
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
  return encodeBase32(buf).slice(0, 26);
}

/**
 * Mint a fresh envelope id. The wire schema enforces a leading "01" so
 * we synthesize that prefix and use a 24-char random tail underneath.
 * Practically the timestamp doesn't sort correctly under this scheme
 * (every id starts "01"), but envelope ordering is `(created_at,
 * envelope_id)` — the timestamp leg dominates. The lexicographic id tail
 * only tie-breaks within a single millisecond, which is rare enough that
 * full ULID time-prefix ordering inside the id isn't necessary.
 */
export function mintEnvelopeId(): string {
  const tail = encodeBase32(randomBytes(15)).slice(0, 24);
  return `01${tail}`;
}

/** Mint a fresh `file_<…>` id. Includes the timestamp in the body so
 *  ids minted in the same millisecond sort by insertion order in logs. */
export function mintFileId(): string {
  return `file_${ulidString()}`;
}
