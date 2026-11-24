import { existsSync, readdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { readJson, writeJson } from "./json-file.ts";
import { KEEP_RUNS, KEY_RE, type Bundle, type Item, type LoopRun } from "./store-types.ts";

const checkedId = (id: string): string => {
  if (!KEY_RE.test(id)) throw new Error(`invalid id ${JSON.stringify(id)}: must match ${KEY_RE}`);
  return id;
};

/**
 * The JSON record collections under a store root: bundles, backlog items and hourly-loop runs. `Store` extends this so
 * one class keeps its API; every method here reads and writes only files under `root`.
 */
export class StoreRecords {
  constructor(readonly root: string) {}

  // ---------- bundles ----------

  bundlePath(id: string): string {
    return join(this.root, "state", "bundles", `${checkedId(id)}.json`);
  }

  bundle(id: string): Bundle | undefined {
    return readJson<Bundle>(this.bundlePath(id));
  }

  saveBundle(bundle: Bundle): void {
    writeJson(this.bundlePath(bundle.id), bundle);
  }

  bundles(): Bundle[] {
    const dir = join(this.root, "state", "bundles");
    return readdirSync(dir)
      .filter((f) => f.endsWith(".json"))
      .map((f) => readJson<Bundle>(join(dir, f)))
      .filter((b): b is Bundle => b !== undefined)
      .sort((a, b) => a.id.localeCompare(b.id));
  }

  // ---------- backlog ----------

  itemBrief(id: string): string {
    return join(this.root, "backlog", `${checkedId(id)}.md`);
  }

  item(id: string): Item | undefined {
    return readJson<Item>(join(this.root, "backlog", `${checkedId(id)}.json`));
  }

  saveItem(item: Item): void {
    writeJson(join(this.root, "backlog", `${checkedId(item.id)}.json`), item);
  }

  items(): Item[] {
    return readdirSync(join(this.root, "backlog"))
      .filter((f) => f.endsWith(".json"))
      .map((f) => readJson<Item>(join(this.root, "backlog", f)))
      .filter((i): i is Item => i !== undefined)
      .sort((a, b) => a.createdAt - b.createdAt || a.id.localeCompare(b.id));
  }

  // ---------- hourly loop ----------

  loopPath(name: string): string {
    return join(this.root, "loop", name);
  }

  /** The single-instance lock of the hourly loop (`loop/lock`) or of the duty loop (`duty/lock`). */
  lockPath(of: "loop" | "duty"): string {
    return join(this.root, of, "lock");
  }

  /** The kill switch of the hourly loop (`loop/stop`) or of the duty loop (`duty/stop`). */
  stop(of: "loop" | "duty" = "loop"): { at: number; reason: string } | undefined {
    return readJson(join(this.root, of, "stop"));
  }

  setStop(at: number, reason: string, of: "loop" | "duty" = "loop"): void {
    writeJson(join(this.root, of, "stop"), { at, reason });
  }

  clearStop(of: "loop" | "duty" = "loop"): void {
    rmSync(join(this.root, of, "stop"), { force: true });
  }

  lastRun(): LoopRun | undefined {
    return readJson(this.loopPath("last-run.json"));
  }

  /** Writes the run record and the last-run stamp, keeping the newest KEEP_RUNS records. Pass `name` to rewrite a record. */
  saveRun(run: LoopRun, name?: string): string {
    const dir = this.loopPath("runs");
    if (name === undefined) {
      const stem = new Date(run.at).toISOString().replaceAll(":", "-");
      name = `${stem}.json`;
      for (let n = 2; existsSync(join(dir, name)); n++) name = `${stem}-${n}.json`;
    }
    writeJson(join(dir, name), run);
    writeJson(this.loopPath("last-run.json"), run);
    const files = readdirSync(dir)
      .filter((f) => f.endsWith(".json"))
      .sort();
    for (const f of files.slice(0, Math.max(0, files.length - KEEP_RUNS))) rmSync(join(dir, f), { force: true });
    return name;
  }

  runs(): string[] {
    return readdirSync(this.loopPath("runs"))
      .filter((f) => f.endsWith(".json"))
      .sort();
  }
}
