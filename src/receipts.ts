import { readdirSync } from "node:fs";
import { join } from "node:path";
import { readJson, writeJson } from "./json-file.ts";
import type { LaneReceipt, ReviewReceipt } from "./store-types.ts";

const NAME_RE = /^[\w.-]+$/;
const SHA_RE = /^[0-9a-f]{7,64}$/;

/**
 * PR and lane receipts under `<root>/receipts/` (and the lane diffs under `<root>/lane-reviews/`). A file name is a PR
 * id or `lane_<key>` plus a commit sha; anything else is refused, so a receipt can never be written outside those dirs.
 */
export class Receipts {
  constructor(private readonly root: string) {}

  private checked(name: string, sha: string): string {
    if (!NAME_RE.test(name) || !SHA_RE.test(sha)) throw new Error(`invalid receipt name ${name}@${sha}`);
    return `${name}@${sha}`;
  }

  private path(dir: "receipts" | "lane-reviews", name: string, sha: string, ext: "json" | "diff"): string {
    return join(this.root, dir, `${this.checked(name, sha)}.${ext}`);
  }

  private prName(pr: string): string {
    return pr.replaceAll("/", "__").replace("#", "_");
  }

  save(r: ReviewReceipt): void {
    writeJson(this.path("receipts", this.prName(r.pr), r.sha, "json"), r);
  }

  receipt(pr: string, sha: string): ReviewReceipt | undefined {
    return readJson<ReviewReceipt>(this.path("receipts", this.prName(pr), sha, "json"));
  }

  saveLane(r: LaneReceipt): void {
    writeJson(this.path("receipts", `lane_${r.lane}`, r.tip, "json"), r);
  }

  /** The lane receipt pinned to `tip`: a receipt at another commit never describes this diff. */
  lane(key: string, tip: string): LaneReceipt | undefined {
    return readJson<LaneReceipt>(this.laneReceiptPath(key, tip));
  }

  /**
   * Every lane receipt of `key`, newest first. A review that moved past a receipt leaves the older file in place, so
   * this is how the bundle gate tells a stale sha (a receipt exists at another tip) from a lane never reviewed at all.
   * Failed-review diagnostics share the `lane_<key>@` prefix but are not receipts: only `<lane>@<sha>.json` counts.
   */
  laneReceipts(key: string): LaneReceipt[] {
    const name = `lane_${key}`;
    if (!NAME_RE.test(name)) throw new Error(`invalid lane ${key}`);
    const escaped = key.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const file = new RegExp(`^lane_${escaped}@[0-9a-f]{7,64}\\.json$`);
    const dir = join(this.root, "receipts");
    return readdirSync(dir)
      .filter((f) => file.test(f))
      .map((f) => readJson<LaneReceipt>(join(dir, f)))
      .filter((r): r is LaneReceipt => r !== undefined)
      .sort((a, b) => b.at - a.at);
  }

  /** Where the receipt for lane `key` at `tip` lives, whether or not it was written yet. */
  laneReceiptPath(key: string, tip: string): string {
    return this.path("receipts", `lane_${key}`, tip, "json");
  }

  /** Where `dori review --lane` keeps the diff it hands the reviewer, one file per lane and tip. */
  laneDiffPath(key: string, tip: string): string {
    return this.path("lane-reviews", `lane_${key}`, tip, "diff");
  }

  /** The diff for one path-grouped chunk of a large lane review, reviewed in place of the whole diff. */
  laneChunkDiffPath(key: string, tip: string, index: number): string {
    if (!Number.isInteger(index) || index < 1) throw new Error(`invalid chunk index ${index}`);
    return join(this.root, "lane-reviews", `${this.checked(`lane_${key}`, tip)}.chunk-${index}.diff`);
  }
}
