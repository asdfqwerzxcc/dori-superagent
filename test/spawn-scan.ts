import { readFileSync, readdirSync } from "node:fs";
import { join, relative, resolve } from "node:path";
import { parseSync } from "oxc-parser";

const CHILD_FNS = new Set(["spawn", "spawnSync", "exec", "execFile", "execFileSync", "execSync", "fork"]);
const BUN_FNS = new Set(["spawn", "spawnSync"]);

export const SCAN_ROOTS = ["src", "scripts", "test", "skills/dori-mode/scripts/src", "skills/dori-mode/scripts/test"];
/** Only a call that cannot take options (a GUI launcher) may be listed here, with the reason. */
export const SPAWN_WHITELIST: Readonly<Record<string, string>> = {};

type Node = Record<string, unknown> & { type?: string; start?: number; end?: number };

const walk = (node: unknown, visit: (node: Node) => void): void => {
  if (node === null || typeof node !== "object") return;
  if (Array.isArray(node)) {
    for (const child of node) walk(child, visit);
    return;
  }
  const row = node as Node;
  if (typeof row["type"] === "string") visit(row);
  for (const [key, value] of Object.entries(row)) if (key !== "loc") walk(value, visit);
};

const isRecord = (node: unknown): node is Record<string, unknown> =>
  node !== null && typeof node === "object" && !Array.isArray(node);

const hasWindowsHide = (object: Record<string, unknown>): boolean => {
  const properties = Array.isArray(object["properties"]) ? object["properties"] : [];
  return properties.some((raw) => {
    if (!isRecord(raw) || raw["type"] !== "Property") return false;
    const key = raw["key"] as Record<string, unknown> | undefined;
    const value = raw["value"] as Record<string, unknown> | undefined;
    return (key?.["name"] === "windowsHide" || key?.["value"] === "windowsHide") && value?.["value"] === true;
  });
};

const childImports = (program: Node): { named: Set<string>; namespaces: Set<string> } => {
  const named = new Set<string>();
  const namespaces = new Set<string>();
  walk(program, (node) => {
    if (node["type"] !== "ImportDeclaration") return;
    const source = node["source"] as Record<string, unknown> | undefined;
    if (source?.["value"] !== "node:child_process") return;
    const specifiers = Array.isArray(node["specifiers"]) ? node["specifiers"] : [];
    for (const spec of specifiers) {
      if (!isRecord(spec)) continue;
      const local = (spec["local"] as Record<string, unknown> | undefined)?.["name"];
      if (typeof local !== "string") continue;
      if (spec["type"] === "ImportSpecifier") {
        const imported = (spec["imported"] as Record<string, unknown> | undefined)?.["name"];
        if (typeof imported === "string" && CHILD_FNS.has(imported)) named.add(local);
      }
      if (spec["type"] === "ImportNamespaceSpecifier") namespaces.add(local);
    }
  });
  return { named, namespaces };
};

const lineOf = (source: string, offset: number): number => source.slice(0, offset).split("\n").length;

/** Calls that must pass `windowsHide: true`; an options object without it, or no options at all, is a finding. */
export function scanSource(file: string, source: string): string[] {
  const parsed = parseSync(file, source);
  const { named, namespaces } = childImports(parsed.program as unknown as Node);
  const problems: string[] = [];
  walk(parsed.program, (node) => {
    if (node["type"] !== "CallExpression") return;
    const callee = node["callee"] as Record<string, unknown> | undefined;
    if (callee === undefined) return;
    let isSpawn = false;
    if (callee["type"] === "Identifier" && typeof callee["name"] === "string") isSpawn = named.has(callee["name"]);
    if (callee["type"] === "MemberExpression") {
      const object = callee["object"] as Record<string, unknown> | undefined;
      const property = callee["property"] as Record<string, unknown> | undefined;
      const objectName = object?.["type"] === "Identifier" ? object["name"] : undefined;
      const propertyName = property?.["name"] ?? property?.["value"];
      if (objectName === "Bun" && typeof propertyName === "string" && BUN_FNS.has(propertyName)) isSpawn = true;
      if (typeof objectName === "string" && namespaces.has(objectName) && CHILD_FNS.has(String(propertyName)))
        isSpawn = true;
    }
    if (!isSpawn) return;
    const args = Array.isArray(node["arguments"]) ? node["arguments"] : [];
    const last = args[args.length - 1];
    if (isRecord(last) && last["type"] === "ObjectExpression" && hasWindowsHide(last)) return;
    const offset = typeof node["start"] === "number" ? node["start"] : 0;
    problems.push(`${file}:${lineOf(source, offset)}: spawn without windowsHide: true`);
  });
  return problems;
}

const files = (dir: string): string[] =>
  readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) return entry.name === "node_modules" ? [] : files(path);
    return /\.(ts|js|mjs)$/.test(entry.name) ? [path] : [];
  });

/** Every missing windowsHide in the repository's own sources, as `file:line: ...`. */
export function findSpawnProblems(root: string): string[] {
  return SCAN_ROOTS.flatMap((scanRoot) => {
    const dir = resolve(root, scanRoot);
    return files(dir)
      .map((path) => relative(root, path).replaceAll("\\", "/"))
      .filter((file) => SPAWN_WHITELIST[file] === undefined)
      .flatMap((file) => scanSource(file, readFileSync(resolve(root, file), "utf8")));
  });
}
