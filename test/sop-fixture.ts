import { mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { Deps } from "../src/harness.ts";
import type { SopDef, SopRun } from "../src/sop-types.ts";

export function putSop(d: Deps, def: SopDef): void {
  mkdirSync(join(d.store.root, "sops"), { recursive: true });
  writeFileSync(join(d.store.root, "sops", `${def.id}.json`), `${JSON.stringify(def, null, 2)}\n`);
}

export function runs(d: Deps): SopRun[] {
  return (JSON.parse(readFileSync(join(d.store.root, "state", "sop-runs.json"), "utf8")) as { runs: SopRun[] }).runs;
}

export function findRun(d: Deps, runId: string): SopRun {
  const run = runs(d).find((candidate) => candidate.runId === runId);
  if (run === undefined) throw new Error(`run ${runId} not found`);
  return run;
}

export function runIdOf(out: string): string {
  const match = /^RUN (\S+)/m.exec(out);
  if (match?.[1] === undefined) throw new Error(`no run id in output: ${out}`);
  return match[1];
}

export function sopReceipts(d: Deps): string[] {
  return readdirSync(join(d.store.root, "receipts"))
    .filter((name) => name.startsWith("sop-"))
    .sort();
}
