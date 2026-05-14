import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";

import type { CLIConfig } from "../config.js";
import { handleToFilenameStem } from "./handles.js";
import type { EnvelopeId, MailboxCursor, Timestamp } from "./types.js";

/**
 * Per-identity catch-up watermark persisted alongside the rest of the
 * CLI's per-profile state.
 *
 * The wire protocol is at-least-once: a client paginating asc with a
 * cursor and a flapping WS may both see the same envelope. The watermark
 * answers two questions:
 *
 * 1. **Where do I resume `GET /mailbox?order=asc` from?** Pass
 *    `(last_seen_created_at, last_seen_envelope_id)` so the operator
 *    starts at the lookback window above that pair.
 * 2. **Have I already processed this envelope?** Dedupe against the
 *    bounded `dedup_ids` map so a duplicate frame (REST + WS, brief
 *    disconnect, etc.) doesn't surface to the agent twice.
 *
 * The map is pruned on every advance: entries with
 * `created_at < last_seen_created_at - LOOKBACK_OVERLAP_MS` fall outside
 * the lookback window and can't be duplicated anymore.
 */

/** Operator-mandated lookback overlap for `order=asc` mailbox catch-up. */
export const LOOKBACK_OVERLAP_MS = 30_000;

/** On-disk shape of one identity's watermark. */
export interface WatermarkFile {
  readonly last_seen_created_at: Timestamp;
  readonly last_seen_envelope_id: EnvelopeId | null;
  readonly dedup_ids: Readonly<Record<EnvelopeId, Timestamp>>;
}

/** Fresh-install shape — nothing seen yet, empty dedup map. */
function emptyWatermark(): WatermarkFile {
  return {
    last_seen_created_at: 0,
    last_seen_envelope_id: null,
    dedup_ids: {},
  };
}

/**
 * Compute the absolute path to the watermark file for `(profileStateDir,
 * networkName, handle)`. Does not touch the filesystem.
 *
 * The path mirrors `networkStatePaths` for credentials, so a `network
 * reset` of a single network removes the watermarks alongside the rest of
 * its state. The filename stem is the handle with the leading `@` stripped
 * to keep the path filesystem-safe.
 */
export function watermarkPath(
  profileStateDir: string,
  networkName: string,
  handle: string,
): string {
  const stem = handleToFilenameStem(handle);
  return join(
    profileStateDir,
    "networks",
    networkName,
    "watermarks",
    `${stem}.json`,
  );
}

/**
 * Load the watermark for `(network, handle)` from the configured profile's
 * state directory. Returns a fresh-install value on missing file or
 * unparseable JSON — the protocol's lookback overlap absorbs the
 * recoverable case of "we forgot one envelope" without re-delivery harm.
 *
 * `overridePath` lets the caller route the watermark elsewhere (useful
 * for tests, and for the `--watermark <path>` listen flag).
 */
export async function loadWatermark(
  config: CLIConfig,
  handle: string,
  overridePath?: string,
): Promise<WatermarkFile> {
  const path = overridePath ?? watermarkPath(
    config.paths.stateDir,
    config.network.name,
    handle,
  );
  let raw: string;
  try {
    raw = await readFile(path, "utf8");
  } catch {
    return emptyWatermark();
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    // Corruption recovery: treat a malformed file as a fresh install.
    // The operator's lookback overlap means we re-fetch at most ~30s of
    // history, which is cheap.
    return emptyWatermark();
  }
  return normalize(parsed);
}

/**
 * Persist `watermark` for `(network, handle)`. Writes through a temp file
 * and `rename` so a crash mid-write doesn't leave a half-written watermark
 * that the next invocation interprets as "fresh install."
 */
export async function saveWatermark(
  config: CLIConfig,
  handle: string,
  watermark: WatermarkFile,
  overridePath?: string,
): Promise<void> {
  const path = overridePath ?? watermarkPath(
    config.paths.stateDir,
    config.network.name,
    handle,
  );
  await mkdir(dirname(path), { recursive: true });
  const tmp = `${path}.tmp.${process.pid}`;
  const payload = JSON.stringify(watermark, null, 2) + "\n";
  await writeFile(tmp, payload, { mode: 0o600 });
  await rename(tmp, path);
}

/**
 * Apply a batch of seen `(envelope_id, created_at)` pairs to the
 * watermark in-memory, returning the advanced watermark.
 *
 * Behavior:
 *  - `last_seen_created_at` / `last_seen_envelope_id` advance to the
 *    `(created_at ASC, envelope_id ASC)` maximum across the input pairs
 *    and the existing watermark.
 *  - Each `(envelope_id, created_at)` pair is added to the dedup map so a
 *    later duplicate frame is caught.
 *  - Entries whose `created_at` falls below the new
 *    `last_seen_created_at - LOOKBACK_OVERLAP_MS` are dropped; they can't
 *    appear in any future `order=asc` page from the operator's lookback.
 */
export function advanceWatermark(
  current: WatermarkFile,
  seen: readonly { readonly id: EnvelopeId; readonly created_at: Timestamp }[],
): WatermarkFile {
  let topCreatedAt = current.last_seen_created_at;
  let topEnvelopeId = current.last_seen_envelope_id;
  const dedup: Record<EnvelopeId, Timestamp> = { ...current.dedup_ids };

  for (const { id, created_at } of seen) {
    dedup[id] = created_at;
    if (compareCursor(created_at, id, topCreatedAt, topEnvelopeId) > 0) {
      topCreatedAt = created_at;
      topEnvelopeId = id;
    }
  }

  const cutoff = topCreatedAt - LOOKBACK_OVERLAP_MS;
  const pruned: Record<EnvelopeId, Timestamp> = {};
  for (const [id, ts] of Object.entries(dedup)) {
    if (ts >= cutoff) pruned[id] = ts;
  }

  return {
    last_seen_created_at: topCreatedAt,
    last_seen_envelope_id: topEnvelopeId,
    dedup_ids: pruned,
  };
}

/**
 * True when `envelope_id` is already represented in the watermark. Use
 * before forwarding a live push frame or REST mailbox entry to the agent.
 */
export function hasSeen(watermark: WatermarkFile, envelopeId: EnvelopeId): boolean {
  return Object.prototype.hasOwnProperty.call(watermark.dedup_ids, envelopeId);
}

/**
 * Translate a watermark into the `MailboxCursor` shape the wire expects
 * for `?after_created_at=&after_envelope_id=`. Returns `null` for a
 * fresh-install watermark — the caller should omit the cursor params and
 * let the operator return from the start of the chosen order.
 */
export function watermarkToCursor(
  watermark: WatermarkFile,
): MailboxCursor | null {
  if (watermark.last_seen_envelope_id === null) return null;
  return {
    created_at: watermark.last_seen_created_at,
    envelope_id: watermark.last_seen_envelope_id,
  };
}

/* -------------------------------------------------------------------------- */
/* Internals                                                                   */
/* -------------------------------------------------------------------------- */

function compareCursor(
  aCreated: Timestamp,
  aId: EnvelopeId | null,
  bCreated: Timestamp,
  bId: EnvelopeId | null,
): number {
  if (aCreated !== bCreated) return aCreated < bCreated ? -1 : 1;
  // Fresh-install (`bId === null`) is below any concrete cursor.
  if (aId === null && bId === null) return 0;
  if (aId === null) return -1;
  if (bId === null) return 1;
  if (aId === bId) return 0;
  return aId < bId ? -1 : 1;
}

function normalize(value: unknown): WatermarkFile {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return emptyWatermark();
  }
  const obj = value as Record<string, unknown>;
  const last_seen_created_at =
    typeof obj["last_seen_created_at"] === "number"
      ? (obj["last_seen_created_at"] as Timestamp)
      : 0;
  const last_seen_envelope_id =
    typeof obj["last_seen_envelope_id"] === "string"
      ? (obj["last_seen_envelope_id"] as EnvelopeId)
      : null;
  const rawDedup = obj["dedup_ids"];
  const dedup_ids: Record<EnvelopeId, Timestamp> = {};
  if (typeof rawDedup === "object" && rawDedup !== null && !Array.isArray(rawDedup)) {
    for (const [id, ts] of Object.entries(rawDedup as Record<string, unknown>)) {
      if (typeof ts === "number") dedup_ids[id] = ts;
    }
  }
  return { last_seen_created_at, last_seen_envelope_id, dedup_ids };
}
