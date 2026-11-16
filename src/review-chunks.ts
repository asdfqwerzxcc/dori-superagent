// A diff past the size cap is split by path so the reviewer never receives more than one pass can finish in the
// deadline. A chunk that still returns no answer is split once more, by path or by hunks, before it is called empty.

/** A pass over more than this is where the provider starts returning nothing; keep each chunk well under it. */
export const REVIEW_CHUNK_BYTES = 16 * 1024;
export const REVIEW_CHUNK_LINES = 200;
const RESPLIT_BYTES = REVIEW_CHUNK_BYTES / 2;
const RESPLIT_LINES = REVIEW_CHUNK_LINES / 2;

export type DiffChunk = {
  readonly index: number;
  readonly paths: readonly string[];
  readonly text: string;
  readonly bytes: number;
  readonly lines: number;
  /** Set for a hunk-level sub-chunk; a path chunk is named by its paths. */
  readonly label?: string;
};

export type ReviewPlan = { readonly chunks: readonly DiffChunk[]; readonly chunked: boolean };

type Section = { readonly path: string; readonly text: string; readonly bytes: number; readonly lines: number };

const filePath = (section: string): string =>
  /^diff --git a\/(.+?) b\/(.+)$/m.exec(section)?.[2]?.trim() ?? "(unknown path)";

const changedLines = (text: string): number =>
  text
    .split("\n")
    .filter((l) => (l.startsWith("+") && !l.startsWith("+++")) || (l.startsWith("-") && !l.startsWith("---"))).length;

const sections = (diff: string): Section[] => {
  const starts = [...diff.matchAll(/^diff --git /gm)].map((m) => m.index ?? 0);
  return starts.map((start, i) => {
    const text = diff.slice(start, starts[i + 1] ?? diff.length);
    return { path: filePath(text), text, bytes: Buffer.byteLength(text), lines: changedLines(text) };
  });
};

const chunkOf = (group: readonly Section[], index: number, label?: string): DiffChunk => {
  const text = group.map((s) => s.text).join("");
  return {
    index,
    paths: group.map((s) => s.path),
    text,
    bytes: Buffer.byteLength(text),
    lines: changedLines(text),
    ...(label === undefined ? {} : { label }),
  };
};

/** Packs whole path sections in order; one oversized file stays one chunk. */
const pack = (list: readonly Section[], maxBytes: number, maxLines: number): DiffChunk[] => {
  const chunks: DiffChunk[] = [];
  let group: Section[] = [];
  let bytes = 0;
  let lines = 0;
  const flush = (): void => {
    if (group.length === 0) return;
    chunks.push(chunkOf(group, chunks.length + 1));
    group = [];
    bytes = 0;
    lines = 0;
  };
  for (const section of list) {
    if (group.length > 0 && (bytes + section.bytes > maxBytes || lines + section.lines > maxLines)) flush();
    group.push(section);
    bytes += section.bytes;
    lines += section.lines;
  }
  flush();
  return chunks;
};

const halves = <T>(list: readonly T[]): [T[], T[]] => {
  const mid = Math.ceil(list.length / 2);
  return [list.slice(0, mid), list.slice(mid)];
};

/** Splits one file by its `@@` hunks (two halves); a file with fewer than two hunks cannot be split. */
const splitHunks = (section: Section): DiffChunk[] => {
  const starts = [...section.text.matchAll(/^@@ /gm)].map((m) => m.index ?? 0);
  if (starts.length < 2) return [];
  const header = section.text.slice(0, starts[0]);
  const hunks = starts.map((start, i) => section.text.slice(start, starts[i + 1] ?? section.text.length));
  const [first, second] = halves(hunks);
  const firstEnd = first.length;
  return [first, second]
    .filter((group) => group.length > 0)
    .map((group, i) => {
      const text = header + group.join("");
      return {
        index: i + 1,
        paths: [section.path],
        text,
        bytes: Buffer.byteLength(text),
        lines: changedLines(text),
        label: `${section.path} (hunks ${i === 0 ? 1 : firstEnd + 1}-${i === 0 ? firstEnd : hunks.length})`,
      };
    });
};

export function planReview(
  diff: string,
  maxBytes: number = REVIEW_CHUNK_BYTES,
  maxLines: number = REVIEW_CHUNK_LINES,
): ReviewPlan {
  if (Buffer.byteLength(diff) <= maxBytes && changedLines(diff) <= maxLines) return { chunks: [], chunked: false };
  const list = sections(diff);
  if (list.length === 0) return { chunks: [], chunked: false };
  if (list.length === 1) {
    const chunks = splitHunks(list[0]!);
    return chunks.length > 1 ? { chunks, chunked: true } : { chunks: [], chunked: false };
  }
  const chunks = pack(list, maxBytes, maxLines);
  return { chunks, chunked: chunks.length > 1 };
}

/** A chunk that produced no answer is split once more, by path or by hunks, before it is called empty. */
export function resplitChunk(chunk: DiffChunk): DiffChunk[] {
  const list = sections(chunk.text);
  if (list.length >= 2) {
    const packed = pack(list, RESPLIT_BYTES, RESPLIT_LINES);
    if (packed.length >= 2) return packed;
    const [first, second] = halves(list);
    return [first, second].filter((group) => group.length > 0).map((group, i) => chunkOf(group, i + 1));
  }
  if (list.length === 1) return splitHunks(list[0]!);
  return [];
}
