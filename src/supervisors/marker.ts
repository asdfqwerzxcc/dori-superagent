import type { ForegroundProcess } from "../runtime/types.ts";

const WIN = process.platform === "win32";
const unquote = (word: string): string => word.replace(/^["']|["']$/g, "");
const slashed = (word: string): string => unquote(word).replaceAll("\\", "/");
const looksLikePath = (word: string): boolean => /[\\/]/.test(word) || /^[A-Za-z]:/.test(word);

/** A word as argv carries it: quotes and slashes normalized; only path-like words fold case on Windows. */
const canonicalWord = (word: string): string => {
  const value = slashed(word);
  return WIN && looksLikePath(value) ? value.toLowerCase() : value;
};

/** An executable as a bare name: directories and quotes dropped, `.exe` stripped on Windows. */
export function canonicalExe(word: string | undefined): string | undefined {
  if (word === undefined) return undefined;
  const base = slashed(word).split("/").at(-1) ?? "";
  const bare = WIN ? base.replace(/\.exe$/i, "").toLowerCase() : base;
  return bare === "" ? undefined : bare;
}

/**
 * True when a process command line is exactly the unit's: argv[0] must be the unit's own interpreter (when one is
 * given) and the marker (its script and args) must be the remaining argv, in order and with no extra arguments. A
 * foreign interpreter running the same script, a marker found deeper in a command line, or a case-different argument is
 * not the unit.
 */
export function argvHasMarker(
  argv: readonly string[] | undefined,
  marker: readonly string[],
  program?: string,
): boolean {
  if (argv === undefined || marker.length === 0 || argv.length !== marker.length + 1) return false;
  if (program !== undefined) {
    const exe = canonicalExe(argv[0]);
    if (exe === undefined || exe !== canonicalExe(program)) return false;
  }
  return marker.every((word, at) => canonicalWord(argv[at + 1] ?? "") === canonicalWord(word));
}

/** The pid of the foreground process whose command line is exactly the unit's, when the runtime reports command lines. */
export function foregroundMatch(
  processes: readonly ForegroundProcess[] | undefined,
  marker: readonly string[],
  program?: string,
): number | undefined {
  for (const process of processes ?? []) {
    if (process.pid !== undefined && argvHasMarker(process.argv, marker, program)) return process.pid;
  }
  return undefined;
}
