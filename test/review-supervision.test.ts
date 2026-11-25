import { describe, expect, test } from "bun:test";
import { spawn } from "node:child_process";
import { join } from "node:path";
import { main } from "../src/cli.ts";
import { dutyTick } from "../src/duty.ts";
import type { Deps } from "../src/harness.ts";
import { HOUR } from "../src/loop.ts";
import { HOSTNAME, processStartTime } from "../src/process-identity.ts";
import { readRunJob, type ReviewRunJob } from "../src/review-run.ts";
import { startBackgroundReview } from "../src/review-start.ts";
import { drainReviewRuns } from "../src/review-drain.ts";
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

async function writeJob(d: Deps, job: ReviewRunJob, patch: Partial<ReviewRunJob>): Promise<void> {
  await Bun.write(join(jobsDir(d), `${job.job}.json`), JSON.stringify({ ...job, ...patch }));
}

describe("background review supervision", () => {
  test("a live pid with an unreadable start time stays running and its session stays open", async () => {
    const { w, d } = setup();
    gh(w);
    const started = await startBackgroundReview(d, "o/r#7");
    await writeJob(d, started.job, {
      state: "running",
      workerPid: process.pid,
      host: HOSTNAME,
      startTime: 123,
    });
    const events = await drainReviewRuns(d, { readStartTime: () => null, launchMs: 0 });
    expect(events.filter((event) => event.action === "review-failed")).toEqual([]);
    expect(jobAt(d, started.job.job)!.state).toBe("running");
    expect(w.panes.has("w1:p2")).toBe(true);
  });

  test("a record from another host is skipped, not failed or closed", async () => {
    const { w, d } = setup();
    gh(w);
    const started = await startBackgroundReview(d, "o/r#7");
    await writeJob(d, started.job, {
      state: "running",
      workerPid: process.pid,
      host: "other-host",
      startTime: null,
    });
    const events = await drainReviewRuns(d, { launchMs: 0 });
    expect(events.filter((event) => event.action === "review-failed")).toEqual([]);
    expect(jobAt(d, started.job.job)!.state).toBe("running");
    expect(w.panes.has("w1:p2")).toBe(true);
  });

  test("a dead worker with a receipt already on disk is reported done, not failed", async () => {
    const { w, d, lead } = setup();
    gh(w);
    const started = await startBackgroundReview(d, "o/r#7");
    const dead = spawn(process.execPath, ["-e", ""], { stdio: "ignore", windowsHide: true });
    const pid = dead.pid;
    if (pid === undefined) throw new Error("spawned worker has no pid");
    await new Promise<void>((resolve) => dead.once("exit", () => resolve()));
    await writeJob(d, started.job, {
      state: "running",
      workerPid: pid,
      host: HOSTNAME,
      startTime: null,
      sha: head,
    });
    d.store.saveReceipt({ pr: "o/r#7", sha: head, verdict: "CLEAR", model: "test", at: d.now(), summary: "" });
    const events = await drainReviewRuns(d, { launchMs: 0 });
    expect(events).toContainEqual({
      pr: "o/r#7",
      action: "review-done",
      detail: `CLEAR receipt at ${head.slice(0, 12)}`,
    });
    expect(jobAt(d, started.job.job)).toMatchObject({ state: "done", verdict: "CLEAR", sha: head });
    expect(lead.received.filter((message) => message.startsWith("[REVIEW o/r#7] CLEAR"))).toHaveLength(1);
    expect(w.panes.has("w1:p2")).toBe(false);
  });

  test("a start whose worker never writes running fails once and can be retried", async () => {
    const { w, d, lead } = setup();
    gh(w);
    const started = await startBackgroundReview(d, "o/r#7");
    const events = await drainReviewRuns(d, { launchMs: 0 });
    expect(events).toContainEqual({
      pr: "o/r#7",
      action: "review-failed",
      detail: "the review worker did not write its running row within 0s",
    });
    expect(jobAt(d, started.job.job)!.state).toBe("failed");
    expect(w.panes.has("w1:p2")).toBe(false);
    expect(lead.received.filter((message) => message.startsWith("[REVIEW o/r#7] failed")).length).toBe(1);

    const retry = await startBackgroundReview(d, "o/r#7");
    expect(retry.existing).toBe(false);
    expect(retry.job.job).not.toBe(started.job.job);
    expect(jobAt(d, started.job.job)!.state).toBe("failed");
  });

  test("--background --restart replaces a stuck start that did open a tab", async () => {
    const { w, d } = setup();
    gh(w);
    const started = await startBackgroundReview(d, "o/r#7");
    const restarted = await captureIo(() => main(["review", "o/r#7", "--background", "--restart"], d));
    expect(restarted.code).toBe(0);
    expect(restarted.out).toStartWith("REVIEW_RESTARTED o/r#7 job=");
    expect(jobAt(d, started.job.job)!.state).toBe("failed");
    expect(w.panes.has("w1:p2")).toBe(false);
  });

  test("two duty passes send the slow notice once", async () => {
    const { w, d, lead } = setup();
    gh(w);
    const started = await startBackgroundReview(d, "o/r#7");
    await writeJob(d, started.job, {
      state: "running",
      workerPid: process.pid,
      host: HOSTNAME,
      startTime: processStartTime(process.pid),
    });
    w.clock += 3 * HOUR;
    await Promise.all([drainReviewRuns(d), drainReviewRuns(d)]);
    expect(lead.received.filter((message) => message.startsWith("[REVIEW o/r#7] still running"))).toHaveLength(1);
    expect(jobAt(d, started.job.job)!.state).toBe("running");
  });

  test("two duty passes announce a done job once", async () => {
    const { w, d, lead } = setup();
    gh(w);
    const started = await startBackgroundReview(d, "o/r#7");
    await writeJob(d, started.job, {
      state: "done",
      host: HOSTNAME,
      sha: head,
      verdict: "CLEAR",
      finishedAt: d.now(),
    });
    await Promise.all([drainReviewRuns(d), drainReviewRuns(d)]);
    expect(lead.received.filter((message) => message.startsWith("[REVIEW o/r#7] CLEAR"))).toHaveLength(1);
  });

  test("a failed close is retried without being marked closed", async () => {
    const { w, d } = setup();
    gh(w);
    const started = await startBackgroundReview(d, "o/r#7");
    await writeJob(d, started.job, {
      state: "done",
      host: HOSTNAME,
      sha: head,
      verdict: "CLEAR",
      finishedAt: d.now(),
    });
    w.closeFails = true;
    await drainReviewRuns(d);
    expect(jobAt(d, started.job.job)!.sessionClosedAt).toBeUndefined();
    expect(jobAt(d, started.job.job)!.sessionCloseAttempts).toBe(1);
    expect(w.panes.has("w1:p2")).toBe(true);
    w.closeFails = false;
    await drainReviewRuns(d);
    expect(jobAt(d, started.job.job)!.sessionClosedAt).toBeDefined();
    expect(w.panes.has("w1:p2")).toBe(false);
  });

  test("duty still reports a running review and starts no process", async () => {
    const { w, d } = setup();
    gh(w);
    const started = await startBackgroundReview(d, "o/r#7");
    await writeJob(d, started.job, {
      state: "running",
      workerPid: process.pid,
      host: HOSTNAME,
      startTime: processStartTime(process.pid),
    });
    const before = w.calls.length;
    const events = await dutyTick(d);
    expect(events).toContainEqual({ pr: "o/r#7", action: "review-running", detail: expect.stringContaining("0s") });
    expect(w.calls.length).toBe(before);
  });
});
