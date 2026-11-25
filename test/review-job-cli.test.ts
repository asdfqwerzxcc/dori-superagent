import { describe, expect, test } from "bun:test";
import { join } from "node:path";
import { main } from "../src/cli.ts";
import { parse } from "../src/cli-args.ts";
import type { Deps } from "../src/harness.ts";
import { readRunJob } from "../src/review-run.ts";
import { startBackgroundReview } from "../src/review-start.ts";
import type { World } from "./fake.ts";
import { setup } from "./harness-setup.ts";
import { captureIo } from "./inbox-setup.ts";

const head = "a".repeat(40);
const jobsDir = (d: Deps): string => join(d.store.root, "state", "reviews", "jobs");
const jobAt = (d: Deps, id: string) => readRunJob(join(jobsDir(d), `${id}.json`));

function gh(w: World): void {
  w.gh = (argv) => {
    if (argv[1] === "view") return { code: 0, stdout: JSON.stringify({ headRefOid: head, title: "t", body: "b" }) };
    if (argv[1] === "diff") return { code: 0, stdout: "diff --git a/x b/x\n+line\n" };
    return { code: 1, stdout: "" };
  };
}

describe("review --job on the main CLI", () => {
  test("--job is parsed as a value flag", () => {
    const a = parse(["review", "--job", "job-1", "o/r#7"]);
    expect(a.flags.get("job")).toEqual(["job-1"]);
    expect(a.pos).toEqual(["review", "o/r#7"]);
  });

  test("CLEAR exits 0, BLOCK exits 1, and a failed reviewer exits 1", async () => {
    for (const [verdict, code] of [
      ["CLEAR", 0],
      ["BLOCK", 1],
    ] as const) {
      const { w, d } = setup();
      gh(w);
      w.reviewer = () => ({ code: 0, stdout: `ok\nVERDICT: ${verdict}` });
      const started = await startBackgroundReview(d, "o/r#7");
      const result = await captureIo(() => main(["review", "o/r#7", "--job", started.job.job], d));
      expect(result.code).toBe(code);
      expect(result.out).toContain(`verdict=${verdict}`);
      expect(jobAt(d, started.job.job)!.state).toBe("done");
    }

    const { w, d } = setup();
    gh(w);
    w.reviewer = () => ({ code: 1, stdout: "", stderr: "boom" });
    const started = await startBackgroundReview(d, "o/r#7");
    const result = await captureIo(() => main(["review", "o/r#7", "--job", started.job.job], d));
    expect(result.code).toBe(1);
    expect(result.out).toContain("failed");
    expect(jobAt(d, started.job.job)!.state).toBe("failed");
  });

  test("a mismatched PR is refused before the worker runs", async () => {
    const { w, d } = setup();
    gh(w);
    let called = false;
    w.reviewer = () => {
      called = true;
      return { code: 0, stdout: "VERDICT: CLEAR" };
    };
    const started = await startBackgroundReview(d, "o/r#7");
    await expect(main(["review", "o/r#8", "--job", started.job.job], d)).rejects.toThrow("reviews o/r#7, not o/r#8");
    expect(called).toBe(false);
    expect(jobAt(d, started.job.job)!.state).toBe("starting");
  });
});
