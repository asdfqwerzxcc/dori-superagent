import { describe, expect, test } from "bun:test";
import { appendFileSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { blockTask, claimTask, completeTask, failTask, releaseTask, renewTask } from "../src/board-claims.ts";
import { compactLog } from "../src/board-compact.ts";
import { parseData } from "../src/board-input.ts";
import { boardPath, foldBoard, readEvents } from "../src/board-log.ts";
import { type BoardOp, BOARD_OPS, TASK_STATES, type TaskState, allows } from "../src/board-types.ts";
import { cancelTask, changeNeeds, createTask, listTasks, reopenTask, unblockTask } from "../src/board-tasks.ts";
import { postMessage, readThread, replyThread } from "../src/board-threads.ts";
import type { Deps } from "../src/harness.ts";
import { cli } from "./board-fixture.ts";
import { setup } from "./harness-setup.ts";

const find = (d: Deps, id: string) => listTasks(d, "all").find((task) => task.id === id)!;

const EXPECTED: Record<BoardOp, readonly TaskState[]> = {
  claim: ["ready"],
  renew: ["claimed"],
  release: ["claimed"],
  complete: ["claimed"],
  fail: ["claimed"],
  block: ["claimed"],
  unblock: ["blocked"],
  cancel: ["waiting", "ready", "claimed", "blocked"],
  reopen: ["failed", "canceled"],
  needs: ["waiting", "ready", "blocked"],
};

describe("board", () => {
  test("the transition table is exhaustive for every operation and state", () => {
    for (const op of BOARD_OPS)
      for (const state of TASK_STATES)
        expect({ op, state, allowed: allows(op, state) }).toEqual({
          op,
          state,
          allowed: EXPECTED[op].includes(state),
        });
  });

  test("a task is a thread: create, claim, reply, renew, complete with a free-text result", () => {
    const { w, d } = setup();
    const task = createTask(d, { title: "fix CVE-123", data: { branch: "fix/cve" } });
    expect(task).toMatchObject({ state: "ready", title: "fix CVE-123" });
    expect(task.data["branch"]).toBe("fix/cve");
    const claimed = claimTask(d, { id: task.id, worker: "worker-a" });
    expect(claimed.task.state).toBe("claimed");
    expect(claimed.task.claim?.worker).toBe("worker-a");
    expect(claimed.task.claim?.token).toBe(claimed.token);
    replyThread(d, task.id, "patched, running the tests");
    w.clock += 60_000;
    const renewed = renewTask(d, task.id, claimed.token);
    expect(renewed.claim?.leaseUntil).toBe(w.clock + 300_000);
    const done = completeTask(d, task.id, claimed.token, "fixed in a1b2c3, tests pass", "worker-a");
    expect(done).toMatchObject({ state: "completed", result: "fixed in a1b2c3, tests pass", worker: "worker-a" });
    expect(readThread(d, task.id).thread.messages.map((message) => message.text)).toEqual([
      "fix CVE-123",
      "patched, running the tests",
    ]);
    expect(() => completeTask(d, task.id, claimed.token, "again")).toThrow("claim_lost");
    expect(() => renewTask(d, task.id, claimed.token)).toThrow("claim_lost");
  });

  test("an expired lease returns the task; a stale token cannot settle it after another worker reclaims", () => {
    const { w, d } = setup();
    const task = createTask(d, { title: "lease" });
    const first = claimTask(d, { id: task.id, lease: 60, worker: "a" });
    w.clock += 60_000;
    expect(find(d, task.id).state).toBe("ready");
    expect(find(d, task.id).claim).toBeUndefined();
    expect(() => renewTask(d, task.id, first.token)).toThrow("claim_lost");
    expect(() => completeTask(d, task.id, first.token, "late")).toThrow("claim_lost");
    const second = claimTask(d, { id: task.id, lease: 60, worker: "b" });
    expect(second.epoch).toBe(first.epoch + 1);
    expect(() => completeTask(d, task.id, first.token, "stale")).toThrow("claim_lost");
    expect(completeTask(d, task.id, second.token, "done").state).toBe("completed");
  });

  test("when two workers claim one ready task, one wins with task_claimed for the other", () => {
    const { d } = setup();
    const task = createTask(d, { title: "race" });
    const winner = claimTask(d, { id: task.id, worker: "a" });
    expect(() => claimTask(d, { id: task.id, worker: "b" })).toThrow("task_claimed");
    expect(() => claimTask(d, { ready: true })).toThrow("nothing_ready");
    expect(winner.task.claim?.worker).toBe("a");
  });

  test("needs gates readiness and a failed predecessor readies nothing", () => {
    const { d } = setup();
    const a = createTask(d, { title: "a" });
    const b = createTask(d, { title: "b", needs: [a.id] });
    const c = createTask(d, { title: "c", needs: [b.id] });
    expect([a.state, b.state, c.state]).toEqual(["ready", "waiting", "waiting"]);
    expect(() => claimTask(d, { id: b.id })).toThrow("task_waiting");
    const ca = claimTask(d, { id: a.id });
    completeTask(d, a.id, ca.token, "a done");
    expect(find(d, b.id).state).toBe("ready");
    expect(find(d, c.id).state).toBe("waiting");
    const cb = claimTask(d, { id: b.id });
    failTask(d, b.id, cb.token, "cannot");
    expect(find(d, c.id).state).toBe("waiting");
    reopenTask(d, b.id);
    expect(find(d, c.id).state).toBe("waiting");
    const cb2 = claimTask(d, { id: b.id });
    completeTask(d, b.id, cb2.token, "b done");
    expect(find(d, c.id).state).toBe("ready");
    const x = createTask(d, { title: "x" });
    const y = createTask(d, { title: "y", needs: [x.id] });
    cancelTask(d, x.id);
    expect(find(d, y.id).state).toBe("waiting");
  });

  test("needs refuses unknown ids, self-dependency and cycles", () => {
    const { d } = setup();
    const a = createTask(d, { title: "a" });
    const b = createTask(d, { title: "b", needs: [a.id] });
    expect(() => createTask(d, { title: "x", needs: ["t_missing"] })).toThrow("invalid_needs");
    expect(() => changeNeeds(d, a.id, { add: [a.id] })).toThrow("invalid_needs");
    expect(() => changeNeeds(d, a.id, { add: [b.id] })).toThrow("invalid_needs");
    expect(() => changeNeeds(d, a.id, { add: ["t_missing"] })).toThrow("invalid_needs");
    expect(changeNeeds(d, b.id, { remove: [a.id] }).needs).toEqual([]);
    expect(find(d, b.id).state).toBe("ready");
    const extra = createTask(d, { title: "extra" });
    expect(changeNeeds(d, extra.id, { add: [a.id] }).state).toBe("waiting");
  });

  test("block ends the claim; unblock, release, cancel and reopen follow the table", () => {
    const { d } = setup();
    const task = createTask(d, { title: "hold" });
    const first = claimTask(d, { id: task.id });
    const held = blockTask(d, task.id, first.token, "approve the deploy?", "awaiting_approval");
    expect(held.state).toBe("blocked");
    expect(held.hold).toMatchObject({ reason: "approve the deploy?", kind: "awaiting_approval" });
    expect(() => completeTask(d, task.id, first.token, "x")).toThrow("claim_lost");
    expect(unblockTask(d, task.id).state).toBe("ready");
    const second = claimTask(d, { id: task.id });
    expect(releaseTask(d, task.id, second.token, "yield").state).toBe("ready");
    expect(() => completeTask(d, task.id, second.token, "x")).toThrow("claim_lost");
    const third = claimTask(d, { id: task.id });
    expect(third.task.state).toBe("claimed");
    expect(cancelTask(d, task.id, "superseded").state).toBe("canceled");
    expect(() => claimTask(d, { id: task.id })).toThrow("task_finished");
    expect(reopenTask(d, task.id).state).toBe("ready");
    const fourth = claimTask(d, { id: task.id });
    expect(failTask(d, task.id, fourth.token, "gave up").state).toBe("failed");
  });

  test("the log is append-only, replaying an event is idempotent, and compaction preserves the board", () => {
    const { w, d } = setup();
    const a = createTask(d, { title: "a" });
    const b = createTask(d, { title: "b", needs: [a.id] });
    const claimed = claimTask(d, { id: a.id });
    const before = readFileSync(boardPath(d.store.root), "utf8");
    completeTask(d, a.id, claimed.token, "a done");
    const after = readFileSync(boardPath(d.store.root), "utf8");
    expect(after.startsWith(before)).toBe(true);
    const events = readEvents(d.store.root);
    const original = foldBoard(events, w.clock);
    expect(foldBoard([...events, events[events.length - 1]!], w.clock)).toEqual(original);
    appendFileSync(boardPath(d.store.root), `${JSON.stringify(events[0])}\n`);
    const withDuplicate = foldBoard(readEvents(d.store.root), w.clock);
    expect(withDuplicate).toEqual(original);
    expect(withDuplicate.threads[a.id]?.messages).toHaveLength(1);
    expect(compactLog(d.store.root, w.clock)).toEqual({ before: events.length + 1, threads: 2, tasks: 2 });
    expect(foldBoard(readEvents(d.store.root), w.clock)).toEqual(original);
    expect(listTasks(d, "done").map((task) => task.id)).toEqual([a.id]);
    expect(find(d, b.id).state).toBe("ready");
  });

  test("post and reply form a thread, and read returns it with its channel", () => {
    const { d } = setup();
    const posted = postMessage(d, {
      thread: "new",
      channel: "work/checkout/",
      text: "deploy is green",
      labels: ["kind=note"],
    });
    expect(posted.thread).toStartWith("t_");
    expect(readThread(d, posted.thread).thread.channel).toBe("work/checkout");
    replyThread(d, posted.thread, "confirmed");
    const view = readThread(d, posted.thread);
    expect(view.thread.messages.map((message) => message.text)).toEqual(["deploy is green", "confirmed"]);
    expect(view.thread.messages[0]?.labels).toEqual(["kind=note"]);
    expect(view.task).toBeUndefined();
    expect(() => replyThread(d, "t_missing", "x")).toThrow("thread_not_found");
    expect(() => replyThread(d, "new", "x")).toThrow("bad_request");
    expect(() => postMessage(d, { thread: posted.thread, channel: "other", text: "x" })).toThrow("--channel");
  });

  test("the CLI prints tokens on claim, never on read or tasks, and reason JSON on refusal", async () => {
    const { d } = setup();
    const created = JSON.parse((await cli(d, ["board", "task", "create", "--title", "cli task", "--json"])).out) as {
      task: { id: string };
    };
    expect(created.task.id).toStartWith("t_");
    const claimed = JSON.parse((await cli(d, ["board", "task", "claim", created.task.id, "--json"])).out) as {
      token: string;
    };
    expect(claimed.token).toStartWith("c_");
    const listed = JSON.parse((await cli(d, ["board", "tasks", "--json"])).out) as {
      tasks: { claim?: { token?: string } }[];
    };
    expect(listed.tasks).toHaveLength(1);
    expect(listed.tasks[0]?.claim?.token).toBeUndefined();
    const read = JSON.parse((await cli(d, ["board", "read", created.task.id, "--json"])).out) as {
      task: { claim?: { token?: string } };
    };
    expect(read.task.claim?.token).toBeUndefined();
    const file = join(d.store.root, "result.txt");
    writeFileSync(file, "from the file");
    const done = JSON.parse(
      (
        await cli(d, [
          "board",
          "task",
          "complete",
          created.task.id,
          "--token",
          claimed.token,
          "--result",
          `@${file}`,
          "--json",
        ])
      ).out,
    ) as { task: { result: string } };
    expect(done.task.result).toBe("from the file");
    const refused = await cli(d, ["board", "task", "claim", "t_missing", "--json"]);
    expect(refused.code).toBe(1);
    expect(JSON.parse(refused.out)).toMatchObject({ ok: false, reason: "task_not_found" });
  });

  test("a bad lease, data or state transition is refused without touching the log", () => {
    const { d } = setup();
    const task = createTask(d, { title: "valid" });
    const before = readEvents(d.store.root).length;
    expect(() => claimTask(d, { id: task.id, lease: 0 })).toThrow("--lease");
    expect(() => claimTask(d, { id: task.id, lease: 301 })).toThrow("--lease");
    expect(() => parseData(["novalue"])).toThrow("KEY=VALUE");
    expect(() => unblockTask(d, task.id)).toThrow("not blocked");
    expect(readEvents(d.store.root).length).toBe(before);
    const claimed = claimTask(d, { id: task.id });
    expect(() => changeNeeds(d, task.id, { add: [task.id] })).toThrow("task_claimed");
    expect(() => claimTask(d, { id: task.id, ready: true })).toThrow("bad_request");
    expect(() => completeTask(d, task.id, "wrong-token", "x")).toThrow("claim_lost");
    expect(claimed.task.state).toBe("claimed");
    expect(find(d, task.id).state).toBe("claimed");
  });
});
