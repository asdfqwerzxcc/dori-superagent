import { BoardError } from "./board-types.ts";

export const MAX_TEXT = 10_000;

export function cleanText(value: string, what: string, max = MAX_TEXT): string {
  const text = value.replace(/\r\n?/g, "\n").trimEnd();
  if (!text.trim()) throw new BoardError("bad_request", `${what} is empty`);
  if (text.length > max) throw new BoardError("bad_request", `${what} is longer than ${max} characters`);
  return text;
}

export function unique(items: readonly string[], what: string): string[] {
  const out = [...new Set(items)];
  if (out.length !== items.length) throw new BoardError("bad_request", `${what} repeats a value`);
  return out;
}

export function normalizeChannel(raw: string | undefined): string {
  if (raw === undefined) return "general";
  const channel = raw.trim().replace(/\/+$/u, "");
  if (channel.length > 100 || !/^[A-Za-z0-9][A-Za-z0-9._-]*(?:\/[A-Za-z0-9][A-Za-z0-9._-]*)*$/u.test(channel))
    throw new BoardError("bad_request", `channel ${JSON.stringify(raw)} is not a path like work/checkout`);
  return channel;
}

export function validateLabels(raw: readonly string[]): string[] {
  const labels = [...new Set(raw.map((label) => label.trim()))];
  for (const label of labels)
    if (!/^[A-Za-z0-9][A-Za-z0-9_.:=-]{0,63}$/u.test(label))
      throw new BoardError("bad_request", `label ${JSON.stringify(label)} must be a short k=v style word`);
  return labels;
}

export function parseData(raw: readonly string[]): Record<string, string> {
  const entries: [string, string][] = [];
  const seen = new Set<string>();
  for (const pair of raw) {
    const at = pair.indexOf("=");
    if (at <= 0) throw new BoardError("bad_request", "--data needs KEY=VALUE");
    const key = pair.slice(0, at);
    const value = pair.slice(at + 1);
    if (!/^[A-Za-z0-9_.-]{1,64}$/u.test(key))
      throw new BoardError("bad_request", `data key ${JSON.stringify(key)} must be 1-64 word characters`);
    if (seen.has(key)) throw new BoardError("bad_request", `--data repeats ${key}`);
    if (value.length > MAX_TEXT) throw new BoardError("bad_request", `data ${key} is longer than ${MAX_TEXT}`);
    seen.add(key);
    entries.push([key, value]);
  }
  return Object.fromEntries(entries);
}

export function cleanKind(raw: string | undefined): string | undefined {
  if (raw === undefined) return undefined;
  const kind = raw.trim();
  if (!/^[A-Za-z0-9][A-Za-z0-9_-]{0,39}$/u.test(kind))
    throw new BoardError("bad_request", "--kind must be a short word like awaiting_approval");
  return kind;
}
