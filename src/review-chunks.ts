// A diff past the size cap is split by path so the reviewer never receives more than one pass can finish in the
// deadline. Sections keep their file context whole; a single oversized file stays one chunk by itself.

/** A diff over either limit is reviewed in path-grouped chunks instead of one slow, hanging pass. */
export const REVIEW_CHUNK_BYTES = 40 * 1024;
export const REVIEW_CHUNK_LINES = 3_000;

export type DiffChunk = {
  readonly index: number;
  readonly paths: readonly string[];
  readonly text: string;
  readonly bytes: number;
  readonly lines: number;
};

export type ReviewPlan = { readonly chunks: readonly DiffChunk[]; readonly chunked: boolean };

const filePath = (section: string): string =>
  /^diff --git a\/(.+?) b\/(.+)$/m.exec(section)?.[2]?.trim() ?? "(unknown path)";

const changedLines = (text: string): number =>
  text
    .split("\n")
    .filter((l) => (l.startsWith("+") && !l.startsWith("+++")) || (l.startsWith("-") && !l.startsWith("---"))).length;

/**
 * Plans one review: `chunked: false` means a single reviewer pass over the whole diff. `chunked: true` carries the
 * path-grouped chunks in review order, each within the caps unless one file alone is over them.
 */
export function planReview(
  diff: string,
  maxBytes: number = REVIEW_CHUNK_BYTES,
  maxLines: number = REVIEW_CHUNK_LINES,
): ReviewPlan {
  const starts = [...diff.matchAll(/^diff --git /gm)].map((m) => m.index ?? 0);
  if (starts.length <= 1 || (Buffer.byteLength(diff) <= maxBytes && changedLines(diff) <= maxLines))
    return { chunks: [], chunked: false };

  const sections = starts.map((start, i) => {
    const text = diff.slice(start, starts[i + 1] ?? diff.length);
    return { path: filePath(text), text, bytes: Buffer.byteLength(text), lines: changedLines(text) };
  });
  const chunks: DiffChunk[] = [];
  let group: typeof sections = [];
  let bytes = 0;
  let lines = 0;
  const flush = (): void => {
    if (group.length === 0) return;
    chunks.push({
      index: chunks.length + 1,
      paths: group.map((s) => s.path),
      text: group.map((s) => s.text).join(""),
      bytes,
      lines,
    });
    group = [];
    bytes = 0;
    lines = 0;
  };
  for (const section of sections) {
    if (group.length > 0 && (bytes + section.bytes > maxBytes || lines + section.lines > maxLines)) flush();
    group.push(section);
    bytes += section.bytes;
    lines += section.lines;
  }
  flush();
  return { chunks, chunked: chunks.length > 1 };
}
