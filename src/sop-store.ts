import { existsSync, mkdirSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { readJson, writeJson } from "./json-file.ts";
import { Receipts } from "./receipts.ts";
import { Refusal } from "./refusal.ts";
import { SOP_ID_RE, validateSop, type SopDef, type SopRun } from "./sop-types.ts";

export class SopStore {
  readonly receipts: Receipts;

  constructor(readonly root: string) {
    this.receipts = new Receipts(root);
    for (const dir of ["sops", "state", "receipts"]) mkdirSync(join(root, dir), { recursive: true });
  }

  path(id: string): string {
    if (!SOP_ID_RE.test(id)) throw new Refusal(`invalid SOP id ${JSON.stringify(id)}: must match ${SOP_ID_RE.source}`);
    return join(this.root, "sops", `${id}.json`);
  }

  has(id: string): boolean {
    return existsSync(this.path(id));
  }

  def(id: string): SopDef | undefined {
    const path = this.path(id);
    let raw: unknown;
    try {
      raw = readJson<unknown>(path);
    } catch (error) {
      throw new Refusal(`SOP ${id} is not valid JSON: ${(error as Error).message}`);
    }
    if (raw === undefined) return undefined;
    const errors = validateSop(raw, id);
    if (errors.length > 0) throw new Refusal(`SOP ${id} is invalid:\n  ${errors.join("\n  ")}`);
    return raw as SopDef;
  }

  required(id: string): SopDef {
    const def = this.def(id);
    if (def === undefined) throw new Refusal(`no SOP ${id} (create it with: dori sop new ${id} --title <title>)`);
    return def;
  }

  defs(): { id: string; def?: SopDef; error?: string }[] {
    return readdirSync(join(this.root, "sops"))
      .filter((file) => file.endsWith(".json"))
      .sort()
      .map((file) => {
        const id = file.slice(0, -5);
        try {
          const def = this.required(id);
          return { id, def };
        } catch (error) {
          if (error instanceof Refusal) return { id, error: error.message.replaceAll("\n", " ") };
          throw error;
        }
      });
  }

  save(def: SopDef): void {
    writeJson(this.path(def.id), def);
  }

  runsPath(): string {
    return join(this.root, "state", "sop-runs.json");
  }

  runs(): SopRun[] {
    let raw: unknown;
    try {
      raw = readJson<unknown>(this.runsPath());
    } catch (error) {
      throw new Refusal(`state/sop-runs.json is not valid JSON: ${(error as Error).message}`);
    }
    if (raw === undefined) return [];
    if (typeof raw !== "object" || raw === null || !Array.isArray((raw as { runs?: unknown }).runs))
      throw new Refusal("state/sop-runs.json is malformed: runs must be an array");
    return (raw as { runs: SopRun[] }).runs;
  }

  run(runId: string): SopRun {
    const found = this.runs().find((run) => run.runId === runId);
    if (found === undefined) throw new Refusal(`no SOP run ${runId}`);
    return found;
  }

  saveRun(run: SopRun): void {
    const runs = this.runs();
    const at = runs.findIndex((other) => other.runId === run.runId);
    if (at >= 0) runs[at] = run;
    else runs.push(run);
    writeJson(this.runsPath(), { runs });
  }
}
