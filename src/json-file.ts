import { existsSync, readFileSync, renameSync, writeFileSync } from "node:fs";

/** Reads a JSON record, or undefined when the file does not exist. */
export const readJson = <T>(path: string): T | undefined =>
  existsSync(path) ? (JSON.parse(readFileSync(path, "utf8")) as T) : undefined;

/** Writes a JSON record atomically: a pid-suffixed temp file, then a rename over the target. */
export const writeJson = (path: string, value: unknown): void => {
  const tmp = `${path}.${process.pid}.tmp`;
  writeFileSync(tmp, `${JSON.stringify(value, null, 2)}\n`);
  renameSync(tmp, path);
};
