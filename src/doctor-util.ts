import { dirname, join } from "node:path";
import type { DoctorEnv } from "./doctor-env.ts";

export const GIB = 1024 ** 3;

export const messageOf = (e: unknown): string => (e instanceof Error ? e.message : String(e));

export const clip = (text: string, max = 160): string =>
  text.length <= max ? text : `${text.slice(0, Math.max(0, max - 3))}...`;

export const firstLine = (text: string): string =>
  text
    .split(/\r?\n/)
    .map((line) => line.trim())
    .find((line) => line !== "") ?? "";

export const versionOf = (text: string): string | undefined =>
  /(\d+\.\d+(?:\.\d+)?(?:[-+][0-9A-Za-z.]+)?)/.exec(text)?.[1];

export const atLeast = (version: string, major: number, minor: number): boolean => {
  const parts = version.split(/[.+-]/).map((part) => Number(part));
  const a = parts[0] ?? 0;
  const b = parts[1] ?? 0;
  return a > major || (a === major && b >= minor);
};

export const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

export const homePath = (e: DoctorEnv): string => e.env["DORI_HOME"]?.trim() || join(e.homeDir, ".dori");

/** The path itself, or the nearest ancestor that exists: a home under a not-yet-created project dir is still writable. */
export const nearestExisting = (e: DoctorEnv, path: string): string => {
  let at = path;
  for (let parent = dirname(at); !e.pathExists(at) && parent !== at; parent = dirname(at)) at = parent;
  return at;
};

const CREDENTIAL_KEY = /(api[_-]?key|access[_-]?key|secret|token|password|credential|authorization)/i;

/** Whether a credential-shaped key holds a value. The value itself is never returned: doctor may only warn. */
export const hasCredentials = (value: unknown, depth = 0): boolean => {
  if (depth > 4) return false;
  if (Array.isArray(value)) return value.some((entry) => hasCredentials(entry, depth + 1));
  if (!isRecord(value)) return false;
  return Object.entries(value).some(
    ([key, entry]) =>
      (CREDENTIAL_KEY.test(key) && (typeof entry === "string" ? entry.trim() !== "" : typeof entry === "number")) ||
      hasCredentials(entry, depth + 1),
  );
};

export const hasModel = (entry: unknown): boolean =>
  isRecord(entry) &&
  ((typeof entry["model"] === "string" && entry["model"].trim() !== "") ||
    (Array.isArray(entry["models"]) &&
      entry["models"].some((model) => typeof model === "string" && model.trim() !== "")));
