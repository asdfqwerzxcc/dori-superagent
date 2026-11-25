import type { SupervisorHealth } from "./supervisors.ts";

/** Unicode format controls and separators that would move the cursor, reorder text, or forge a log line. */
const FORMAT_RANGES: readonly (readonly [number, number])[] = [
  [0x00ad, 0x00ad],
  [0x061c, 0x061c],
  [0x180e, 0x180e],
  [0x200b, 0x200f],
  [0x202a, 0x202e],
  [0x2060, 0x206f],
  [0xfeff, 0xfeff],
  [0xfff9, 0xfffb],
];

/** A label as it may reach a terminal: C0/C1, line/paragraph separators and format controls become `?`. */
export function printable(text: string): string {
  return [...text]
    .map((ch) => {
      const code = ch.codePointAt(0) ?? 0;
      const control =
        code < 32 ||
        (code >= 127 && code <= 159) ||
        code === 0x2028 ||
        code === 0x2029 ||
        FORMAT_RANGES.some(([from, to]) => code >= from && code <= to);
      return control ? "?" : ch;
    })
    .join("");
}

/**
 * One line saying where every expected unit runs: `UNITS panes=5/7 headless=duty dead=loop missing=none`. `panes` counts
 * a unit recorded in a pane whose unit pid is alive (the runtime pane itself is not re-queried); `dead` counts any
 * recorded unit whose pid died (with or without a pane); a recorded unit without a pane whose pid is alive is the
 * headless fallback. `snapshot` labels a young supervisor whose units may still be registering (a fresh `dori up`).
 */
export function formatUnitPlacement(
  health: readonly SupervisorHealth[],
  expected: readonly string[],
  snapshot = false,
): string {
  const units = health.find((h) => h.name === "supervisor")?.units ?? [];
  const placed = expected.filter((name) => units.some((u) => u.name === name && u.pane !== undefined && u.alive));
  const dead = expected.filter((name) => units.some((u) => u.name === name && !u.alive));
  const headless = expected.filter((name) => units.some((u) => u.name === name && u.pane === undefined && u.alive));
  const missing = expected.filter((name) => !units.some((u) => u.name === name));
  const list = (names: readonly string[]): string => (names.length === 0 ? "none" : names.map(printable).join(","));
  return `UNITS ${snapshot ? "snapshot=startup " : ""}panes=${placed.length}/${expected.length} headless=${list(headless)} dead=${list(dead)} missing=${list(missing)}`;
}
