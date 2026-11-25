import { describe, expect, test } from "bun:test";
import { existsSync, writeFileSync } from "node:fs";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readRunJob, reviewLogPath, runPath, writeRunJob, type ReviewRunJob } from "../src/review-run.ts";
import { pruneRuns, writeSessionRef } from "../src/review-meta.ts";

const root = (): string => mkdtempSync(join(tmpdir(), "dori-review-retention-"));
let rootPath = "";
const job = (id: string, state: ReviewRunJob["state"], startedAt: number, finishedAt?: number): ReviewRunJob => ({
  job: id,
  pr: "o/r#7",
  state,
  startedAt,
  log: reviewLogPath(rootPath, id),
  ...(finishedAt === undefined ? {} : { finishedAt }),
});

describe("review job retention", () => {
  test("old terminal rows and logs are pruned; a running review is preserved", () => {
    rootPath = root();
    for (const [id, startedAt, finishedAt] of [
      ["old", 1, 1],
      ["mid", 2, 2],
      ["new", 3, 3],
    ] as const) {
      const row = job(id, "done", startedAt, finishedAt);
      writeRunJob(rootPath, row);
      writeFileSync(row.log, id);
      writeSessionRef(rootPath, id, "herdr:w1:p9");
    }
    const live = job("live", "running", 4);
    writeRunJob(rootPath, live);
    writeFileSync(live.log, "live");

    const removed = pruneRuns(rootPath, 10_000, 2, 1_000_000);
    expect(removed).toEqual(["old"]);
    expect(readRunJob(runPath(rootPath, "old"))).toBeUndefined();
    expect(existsSync(reviewLogPath(rootPath, "old"))).toBe(false);
    expect(readRunJob(runPath(rootPath, "mid"))).toBeDefined();
    expect(readRunJob(runPath(rootPath, "new"))).toBeDefined();
    expect(readRunJob(runPath(rootPath, "live"))).toBeDefined();
    expect(existsSync(reviewLogPath(rootPath, "live"))).toBe(true);
  });

  test("a terminal row past the age limit is pruned even under the keep count", () => {
    rootPath = root();
    const row = job("stale", "failed", 1, 1);
    writeRunJob(rootPath, row);
    writeFileSync(row.log, "stale");
    expect(pruneRuns(rootPath, 1_000_000, 100, 1000)).toEqual(["stale"]);
    expect(readRunJob(runPath(rootPath, "stale"))).toBeUndefined();
  });
});
