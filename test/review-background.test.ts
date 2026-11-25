import { describe, expect, test } from "bun:test";
import { spawn } from "node:child_process";
import { readFileSync, rmSync, statSync } from "node:fs";
import { join } from "node:path";
import { main } from "../src/cli.ts";
import { dutyTick } from "../src/duty.ts";
import type { Deps } from "../src/harness.ts";
import { HOUR } from "../src/loop.ts";
import { HOSTNAME, pidAlive, processStartTime } from "../src/process-identity.ts";
import { readRunJob, reviewCapacity } from "../src/review-run.ts";
import { readSessionRef, sessionPath } from "../src/review-meta.ts";
import { startBackgroundReview } from "../src/review-start.ts";
import { runReviewJob } from "../src/review-worker.ts";
import type { World } from "./fake.ts";
import { setup } from "./harness-setup.ts";
import { captureIo } from "./inbox-setup.ts";
import { setup as loopSetup } from "./loop-setup.ts";

const head = "a".repeat(40);
const posixModes = process.platform !== "win32";
const jobsDir = (d: Deps): string => join(d.store.root, "state", "reviews", "jobs");
const jobAt = (d: Deps, id: string) => readRunJob(join(jobsDir(d), `${id}.json`));

function gh(w: World): void {
  w.gh = (argv) => {
    if (argv[1] === "view") return { code: 0, stdout: JSON.stringify({ headRefOid: head, title: "t", body: "b" }) };
    if (argv[1] === "diff") return { code: 0, stdout: "diff --git a/x b/x\n+line\n" };
    return { code: 1, stdout: "" };
  };
}

describe("background gate review", () => {
  test("review --background opens a review session and returns before the reviewer runs", async () => {
    const { w, d } = setup();
    gh(w);
    const first = await captureIo(() => main(["review", "o/r#7", "--background"], d));
    expect(first.code).toBe(0);
    expect(first.out).toStartWith("REVIEW_STARTED o/r#7 job=");
    const id = /job=(\S+)/.exec(first.out)?.[1];
    if (id === undefined) throw new Error("no job id in output");
    expect(jobAt(d, id)).toMatchObject({ pr: "o/r#7", state: "starting" });
    expect(first.out).toContain("session=herdr:");
    expect(readSessionRef(d.store.root, id)).toStartWith("herdr:");
    const started = [...w.panes.values()].flatMap((pane) => pane.ran);
    expect(started.some((command) => command.includes("--job") && command.includes(id))).toBe(true);
    expect(w.calls.filter((call) => call.cmd === "omo")).toEqual([]);

    const again = await captureIo(() => main(["review", "o/r#7", "--background"], d));
    expect(again.out).toContain("REVIEW_RUNNING");
    expect(again.out).toContain(id);

    const listed = await captureIo(() => main(["review", "--list"], d));
    expect(listed.out).toContain(`job=${id}`);
    expect(listed.out).toContain("REVIEW o/r#7 starting");
  });

  test("the worker writes the receipt, keeps progress, and tells the lead exactly once", async () => {
    const { w, d, lead } = setup();
    gh(w);
    w.reviewer = (_argv, options) => {
      options?.onStdout?.("tool: read src/x.ts\n");
      options?.onStdout?.("VERDICT: CLEAR\n");
      return { code: 0, stdout: "tool: read src/x.ts\nVERDICT: CLEAR" };
    };
    const started = await startBackgroundReview(d, "o/r#7");
    const done = await runReviewJob(d, started.job.job);
    expect(done.state).toBe("done");
    expect(done.verdict).toBe("CLEAR");
    expect(done.sha).toBe(head);
    expect(done.lastLine).toBe("VERDICT: CLEAR");
    expect(done.bytes).toBeGreaterThan(0);
    expect(readFileSync(done.log, "utf8")).toContain("VERDICT: CLEAR");
    if (posixModes) expect(statSync(done.log).mode & 0o777).toBe(0o600);
    expect(d.store.receipt("o/r#7", head)!.verdict).toBe("CLEAR");
    const notices = lead.received.filter((message) => message.startsWith("[REVIEW o/r#7] CLEAR"));
    expect(notices).toHaveLength(1);

    const calls = w.calls.length;
    expect(await runReviewJob(d, started.job.job)).toMatchObject({ state: "done" });
    expect(w.calls.length).toBe(calls);
    expect((await dutyTick(d)).filter((event) => event.action === "review-done")).toEqual([]);
    expect(lead.received.filter((message) => message.startsWith("[REVIEW o/r#7] CLEAR"))).toHaveLength(1);
    expect(jobAt(d, started.job.job)!.sessionClosedAt).toBeDefined();
  });

  test("a start that never opened a session is replaced, not treated as a live review", async () => {
    const { w, d } = setup();
    gh(w);
    await startBackgroundReview(d, "o/r#7", { job: "stuck-job" });
    rmSync(sessionPath(d.store.root, "stuck-job"), { force: true });
    const second = await startBackgroundReview(d, "o/r#7");
    expect(second.existing).toBe(false);
    expect(second.job.job).not.toBe("stuck-job");
    expect(jobAt(d, "stuck-job")!.state).toBe("failed");
  });

  test("a worker keeps the slow notice duty already recorded while it writes progress", async () => {
    const { w, d } = setup();
    gh(w);
    const started = await startBackgroundReview(d, "o/r#7");
    const path = join(jobsDir(d), `${started.job.job}.json`);
    await Bun.write(path, JSON.stringify({ ...started.job, state: "running", slowNotifiedAt: 123 }));
    w.reviewer = () => ({ code: 0, stdout: "VERDICT: CLEAR" });
    const done = await runReviewJob(d, started.job.job);
    expect(done.state).toBe("done");
    expect(done.slowNotifiedAt).toBe(123);
  });

  test("a running review records its last output line while the worker is still going", async () => {
    const { w, d } = setup();
    gh(w);
    let release: () => void = () => {};
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    let sawFirst: () => void = () => {};
    const firstOutput = new Promise<void>((resolve) => {
      sawFirst = resolve;
    });
    w.reviewer = async (_argv, options) => {
      options?.onStdout?.("도구: grep review\n");
      sawFirst();
      await gate;
      options?.onStdout?.("VERDICT: CLEAR\n");
      return { code: 0, stdout: "도구: grep review\nVERDICT: CLEAR" };
    };
    const started = await startBackgroundReview(d, "o/r#7");
    const running = runReviewJob(d, started.job.job);
    await firstOutput;
    const mid = jobAt(d, started.job.job);
    expect(mid).toMatchObject({ state: "running", lastLine: "도구: grep review" });
    expect(mid!.sha).toBe(head);
    expect(mid!.workerPid).toBe(process.pid);
    expect(mid!.heartbeatAt).toBeDefined();
    expect(mid!.bytes).toBeGreaterThanOrEqual(Buffer.byteLength("도구: grep review\n", "utf8"));
    release();
    expect((await running).state).toBe("done");
  });

  test("a review past two hours is reported once and is never interrupted", async () => {
    const { w, d, lead } = setup();
    gh(w);
    const started = await startBackgroundReview(d, "o/r#7");
    const path = join(jobsDir(d), `${started.job.job}.json`);
    const running = {
      ...started.job,
      state: "running" as const,
      workerPid: process.pid,
      host: HOSTNAME,
      startTime: processStartTime(process.pid),
      lastLine: "tool: grep review",
      bytes: 1234,
      lastOutputAt: w.clock,
    };
    await Bun.write(path, JSON.stringify(running));
    w.clock += 3 * HOUR;

    const first = await dutyTick(d);
    expect(first.filter((event) => event.action === "review-slow")).toHaveLength(1);
    const slow = lead.received.filter((message) => message.startsWith("[REVIEW o/r#7] still running"));
    expect(slow).toHaveLength(1);
    expect(slow[0]).toContain("not interrupted");
    expect(slow[0]).toContain("tool: grep review");
    expect(jobAt(d, started.job.job)).toMatchObject({ state: "running", slowNotifiedAt: w.clock });
    expect(pidAlive(process.pid)).toBe(true);

    const second = await dutyTick(d);
    expect(second.filter((event) => event.action === "review-slow")).toEqual([]);
    expect(lead.received.filter((message) => message.startsWith("[REVIEW o/r#7] still running"))).toHaveLength(1);
    expect(jobAt(d, started.job.job)!.state).toBe("running");
  });

  test("free memory, not elapsed time, limits how many reviews may run", async () => {
    const { w, d } = setup();
    gh(w);
    w.host = { load1: 0, cores: 8, memFreePct: 8, memFreeMb: 600 };
    expect(reviewCapacity(w.host)).toBe(0);
    await expect(startBackgroundReview(d, "o/r#7")).rejects.toThrow("free memory 8% (600 MB) holds 0 reviewer");

    w.host = { load1: 0, cores: 8, memFreePct: 50, memFreeMb: 900 };
    expect(reviewCapacity(w.host)).toBe(1);
    const first = await startBackgroundReview(d, "o/r#7");
    await expect(startBackgroundReview(d, "o/r#8")).rejects.toThrow("1 already running");
    w.clock += 100 * HOUR;
    await expect(startBackgroundReview(d, "o/r#8")).rejects.toThrow("1 already running");

    w.host = { load1: 0, cores: 8, memFreePct: 50, memFreeMb: 1100 };
    expect(reviewCapacity(w.host)).toBe(2);
    expect((await startBackgroundReview(d, "o/r#8")).job.pr).toBe("o/r#8");
    expect(jobAt(d, first.job.job)!.state).toBe("starting");
  });

  test("a worker that exits without a receipt is reported once and its session closed", async () => {
    const { w, d, lead } = setup();
    gh(w);
    const started = await startBackgroundReview(d, "o/r#7");
    const path = join(jobsDir(d), `${started.job.job}.json`);
    const dead = spawn(process.execPath, ["-e", ""], { stdio: "ignore", windowsHide: true });
    const pid = dead.pid;
    if (pid === undefined) throw new Error("spawned worker has no pid");
    await new Promise<void>((resolve) => dead.once("exit", () => resolve()));
    await Bun.write(
      path,
      JSON.stringify({ ...started.job, state: "running", workerPid: pid, host: HOSTNAME, startTime: null }),
    );

    const events = await dutyTick(d);
    expect(events).toContainEqual({
      pr: "o/r#7",
      action: "review-failed",
      detail: `the review worker (pid ${pid}) exited without writing a receipt`,
    });
    expect(jobAt(d, started.job.job)!.state).toBe("failed");
    expect(lead.received.filter((message) => message.startsWith("[REVIEW o/r#7] failed")).length).toBe(1);
    expect(w.panes.has("w1:p2")).toBe(false);

    expect((await dutyTick(d)).filter((event) => event.action === "review-failed")).toEqual([]);
    expect(lead.received.filter((message) => message.startsWith("[REVIEW o/r#7] failed")).length).toBe(1);
  });

  test("a review in flight does not block the hourly loop from starting a lane", async () => {
    const s = loopSetup();
    gh(s.w);
    s.add("next");
    s.w.host = { load1: 0, cores: 8, memFreePct: 50, memFreeMb: 4096 };
    const started = await startBackgroundReview(s.d, "o/r#7");
    const run = await s.tick({ maxStarts: 1 });
    expect(run.started.some((line) => line.startsWith("next"))).toBe(true);
    expect(s.d.store.lane("next")).toBeDefined();
    expect(jobAt(s.d, started.job.job)!.state).toBe("starting");

    const before = s.w.calls.filter((call) => call.cmd === "omo").length;
    await dutyTick(s.d);
    expect(s.w.calls.filter((call) => call.cmd === "omo").length).toBe(before);
  });
});
