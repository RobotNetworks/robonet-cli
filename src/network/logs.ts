import { closeSync, existsSync, openSync, readSync, statSync, watch } from "node:fs";

/**
 * Tail the operator log file, like `tail [-f]`.
 *
 * Implementation: open the file at the offset corresponding to the last
 * `lines` lines, stream the rest to the supplied `out` writer, and (when
 * `follow` is true) watch for appends and emit them as they land.
 *
 * Watching is implemented via `fs.watch` rather than polling so it's
 * reasonably efficient on macOS (FSEvents) and Linux (inotify). The
 * lifetime is bounded by `signal.aborted` — `Ctrl-C` in the CLI flips the
 * controller, which closes the watcher and resolves the returned promise.
 */
export interface TailOptions {
  /** When true, keep streaming appended bytes until `signal` aborts. */
  readonly follow: boolean;
  /** Tail this many lines from the end of the file before streaming. Default 50. */
  readonly lines?: number;
  /** Sink for the tailed bytes. Defaults to stdout. */
  readonly out?: (chunk: string) => void;
  /** Aborts the follow loop. No-op for one-shot tails. */
  readonly signal?: AbortSignal;
}

export async function tailLog(filePath: string, opts: TailOptions): Promise<void> {
  if (!existsSync(filePath)) {
    // Match `tail`'s behavior: complain to stderr and exit; in our case we
    // throw so the command layer can format the error.
    throw new Error(`log file ${filePath} does not exist`);
  }
  const out = opts.out ?? ((s: string) => process.stdout.write(s));
  const lines = opts.lines ?? 50;

  const initialSize = statSync(filePath).size;
  const startOffset = await findTailOffset(filePath, initialSize, lines);
  let offset = await streamFrom(filePath, startOffset, out);

  if (!opts.follow) return;
  const signal = opts.signal;
  if (signal?.aborted) return;

  await new Promise<void>((resolve) => {
    const watcher = watch(filePath, { persistent: false });
    const onAbort = (): void => {
      watcher.close();
      resolve();
    };
    if (signal !== undefined) {
      signal.addEventListener("abort", onAbort, { once: true });
    }
    watcher.on("change", () => {
      // `fs.watch` fires "change" for both modifications and renames; we
      // tolerate either by re-statting and only reading new bytes.
      try {
        const size = statSync(filePath).size;
        if (size < offset) {
          // File was rotated/truncated. Restart from the new EOF rather
          // than emit a flood of duplicates.
          offset = size;
          return;
        }
        if (size > offset) {
          streamFrom(filePath, offset, out)
            .then((newOffset) => {
              offset = newOffset;
            })
            .catch(() => {
              // The underlying file might disappear briefly during a
              // rotation; a subsequent change event will resync us.
            });
        }
      } catch {
        // Ditto: a missing file mid-rotate is recoverable on the next event.
      }
    });
    watcher.on("error", () => {
      watcher.close();
      resolve();
    });
  });
}

/** Walk backwards from `endOffset` until we've passed `lines` newlines (or hit BOF). Returns the byte offset to start streaming from. */
async function findTailOffset(
  filePath: string,
  endOffset: number,
  lines: number,
): Promise<number> {
  if (lines <= 0 || endOffset === 0) return endOffset;
  const fd = openSync(filePath, "r");
  try {
    const chunkSize = 8192;
    const buf = Buffer.allocUnsafe(chunkSize);
    let pos = endOffset;
    let newlinesSeen = 0;
    while (pos > 0) {
      const readLen = Math.min(chunkSize, pos);
      pos -= readLen;
      const got = readSync(fd, buf, 0, readLen, pos);
      // Walk this chunk right-to-left counting newlines. We need
      // `lines + 1` newlines total: the `+1` skips past the leading
      // newline of the first kept line so streaming starts at the *next*
      // byte rather than at the trailing newline of the previous line.
      for (let i = got - 1; i >= 0; i--) {
        if (buf[i] === 0x0a) {
          newlinesSeen += 1;
          if (newlinesSeen > lines) {
            return pos + i + 1;
          }
        }
      }
    }
    return 0;
  } finally {
    closeSync(fd);
  }
}

/** Stream `[startOffset, EOF)` to `out`, returning the new EOF offset. */
async function streamFrom(
  filePath: string,
  startOffset: number,
  out: (chunk: string) => void,
): Promise<number> {
  const fd = openSync(filePath, "r");
  try {
    const buf = Buffer.allocUnsafe(64 * 1024);
    let offset = startOffset;
    while (true) {
      const got = readSync(fd, buf, 0, buf.length, offset);
      if (got === 0) return offset;
      out(buf.subarray(0, got).toString("utf-8"));
      offset += got;
    }
  } finally {
    closeSync(fd);
  }
}
