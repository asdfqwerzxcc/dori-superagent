import { describe, expect, setDefaultTimeout, test } from "bun:test";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runReviewer } from "../src/review-run.ts";
import { killReviewTree } from "../src/review-kill.ts";
import { spawnExec } from "../src/runtime/exec.ts";

// The probe waits on real process death (seconds, not milliseconds); the test's own waits still bound it.
setDefaultTimeout(15_000);

const alive = (pid: number): boolean => {
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return (e as NodeJS.ErrnoException).code !== "ESRCH";
  }
};

/** Process death is reported by the OS a moment after the kill returns; this waits for that fact, not for a delay. */
async function deadWithin(pid: number, ms: number): Promise<boolean> {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    if (!alive(pid)) return true;
    await Bun.sleep(10);
  }
  return !alive(pid);
}

describe("reviewer process tree", () => {
  test("a kill that cannot land reports why instead of pretending", () => {
    const outcome = killReviewTree(undefined, {
      kill: () => {
        throw new Error("access denied");
      },
    });
    expect(outcome).toEqual({ ok: false, why: expect.stringContaining("access denied") });
  });

  test("a timed-out reviewer takes the provider child with it", async () => {
    const dir = mkdtempSync(join(tmpdir(), "dori-review-tree-"));
    const sleeper = join(dir, "sleeper.ts");
    writeFileSync(sleeper, "await Bun.sleep(60_000);\n");
    const tree = join(dir, "tree.ts");
    writeFileSync(
      tree,
      `const child = Bun.spawn([process.execPath, ${JSON.stringify(sleeper)}], { stdout: "ignore", stderr: "ignore" });\n` +
        `console.log("PIDS " + process.pid + " " + child.pid);\n` +
        "await Bun.sleep(60_000);\n",
    );
    let pids: number[] = [];
    try {
      const outcome = await runReviewer({
        exec: spawnExec,
        cmd: process.execPath,
        argv: [tree],
        log: join(dir, "review.log"),
        label: "tree probe",
        timeoutMs: 3_000,
        progressMs: 60_000,
        onProgress: () => {},
      });
      expect(outcome.kind).toBe("timeout");
      const match = /^PIDS (\d+) (\d+)$/m.exec(outcome.stdout);
      expect(match).not.toBeNull();
      pids = [Number(match![1]), Number(match![2])];
      expect(await deadWithin(pids[0]!, 2_000)).toBe(true);
      expect(await deadWithin(pids[1]!, 2_000)).toBe(true);
    } finally {
      for (const pid of pids) killReviewTree(pid);
    }
  });
});
