import { readFileSync } from "node:fs";
import { parseData } from "./board-input.ts";
import { blockTask, claimTask, completeTask, failTask, releaseTask, renewTask } from "./board-claims.ts";
import { compactLog } from "./board-compact.ts";
import { type ThreadView, postMessage, readThread, replyThread } from "./board-threads.ts";
import {
  type TaskFilter,
  cancelTask,
  changeNeeds,
  createTask,
  listTasks,
  reopenTask,
  unblockTask,
} from "./board-tasks.ts";
import { type BoardTask, BoardError, viewTask } from "./board-types.ts";
import { need, one, textOf, type Args } from "./cli-args.ts";
import type { Deps } from "./harness.ts";
import { Refusal } from "./refusal.ts";

const BOARD_COMMANDS = "post|reply|read|tasks|task|compact";
const TASK_COMMANDS = "create|claim|renew|release|complete|fail|block|unblock|cancel|reopen|needs";
const FILTERS = new Set(["waiting", "ready", "claimed", "blocked", "done"]);

const iso = (at: number): string => new Date(at).toISOString();
const firstLine = (text: string): string => text.split("\n")[0] ?? text;

function emit(json: boolean, value: unknown, human: string): void {
  console.log(json ? JSON.stringify(value) : human);
}

export async function runBoard(d: Deps, a: Args, x: string | undefined): Promise<number> {
  const json = one(a, "json") === "true";
  try {
    return await dispatch(d, a, x, json);
  } catch (error) {
    if (!json || !(error instanceof Refusal)) throw error;
    console.log(
      JSON.stringify({
        ok: false,
        reason: error instanceof BoardError ? error.reason : "bad_request",
        error: error.message,
      }),
    );
    return 1;
  }
}

async function dispatch(d: Deps, a: Args, x: string | undefined, json: boolean): Promise<number> {
  if (x === "post") {
    const channel = one(a, "channel");
    const labels = a.flags.get("label") ?? [];
    const posted = postMessage(d, {
      thread: need(one(a, "thread"), "--thread <id|new>"),
      text: await textOf(a),
      ...(channel === undefined ? {} : { channel }),
      ...(labels.length === 0 ? {} : { labels }),
    });
    emit(
      json,
      { ok: true, thread: posted.thread, message: posted.message },
      `POSTED ${posted.thread} ${posted.message.id}`,
    );
    return 0;
  }
  if (x === "reply") {
    const posted = replyThread(d, need(a.pos[2], "thread"), await textOf(a));
    emit(
      json,
      { ok: true, thread: posted.thread, message: posted.message },
      `REPLIED ${posted.thread} ${posted.message.id}`,
    );
    return 0;
  }
  if (x === "read") {
    const view = readThread(d, need(a.pos[2], "thread"));
    emit(
      json,
      { ok: true, thread: view.thread, ...(view.task === undefined ? {} : { task: viewTask(view.task) }) },
      formatThread(view),
    );
    return 0;
  }
  if (x === "tasks") {
    const state = one(a, "state");
    const filter = state === undefined ? undefined : asFilter(state);
    const tasks = listTasks(d, filter);
    if (json) console.log(JSON.stringify({ ok: true, tasks: tasks.map(viewTask) }));
    else for (const task of tasks) console.log(formatTask(task));
    return 0;
  }
  if (x === "task") {
    await taskCommand(d, a, json);
    return 0;
  }
  if (x === "compact") {
    const result = compactLog(d.store.root, d.now());
    emit(
      json,
      { ok: true, ...result },
      `COMPACTED ${result.before} events -> ${result.threads} threads, ${result.tasks} tasks`,
    );
    return 0;
  }
  throw new Refusal(`unknown board command ${x ?? "(none)"}\n\ndori board ${BOARD_COMMANDS}`);
}

async function taskCommand(d: Deps, a: Args, json: boolean): Promise<void> {
  const sub = need(a.pos[2], `task command (${TASK_COMMANDS})`);
  const id = a.pos[3];
  if (sub === "create") {
    const task = createTask(d, {
      title: need(one(a, "title"), "--title"),
      needs: a.flags.get("needs") ?? [],
      data: parseData(a.flags.get("data") ?? []),
    });
    emit(json, { ok: true, task: viewTask(task) }, `TASK ${task.id} ${task.state}`);
    return;
  }
  if (sub === "claim") {
    const lease = one(a, "lease");
    const worker = one(a, "for");
    const claimed = claimTask(d, {
      ...(id === undefined ? {} : { id }),
      ...(one(a, "ready") === "true" ? { ready: true } : {}),
      ...(lease === undefined ? {} : { lease: Number(lease) }),
      ...(worker === undefined ? {} : { worker }),
    });
    emit(
      json,
      {
        ok: true,
        task: viewTask(claimed.task),
        token: claimed.token,
        epoch: claimed.epoch,
        leaseUntil: claimed.leaseUntil,
      },
      `CLAIMED ${claimed.task.id} epoch=${claimed.epoch} token=${claimed.token} lease_until=${iso(claimed.leaseUntil)}`,
    );
    return;
  }
  if (sub === "renew") {
    const task = renewTask(d, need(id, "task id"), need(one(a, "token"), "--token"));
    const until = task.claim === undefined ? "" : ` lease_until=${iso(task.claim.leaseUntil)}`;
    emit(json, { ok: true, task: viewTask(task) }, `RENEWED ${task.id}${until}`);
    return;
  }
  if (sub === "release") {
    const task = releaseTask(d, need(id, "task id"), need(one(a, "token"), "--token"), one(a, "reason"));
    emit(json, { ok: true, task: viewTask(task) }, `RELEASED ${task.id} ${task.state}`);
    return;
  }
  if (sub === "complete") {
    const task = completeTask(d, need(id, "task id"), need(one(a, "token"), "--token"), resultOf(a), one(a, "for"));
    emit(json, { ok: true, task: viewTask(task) }, `COMPLETED ${task.id}`);
    return;
  }
  if (sub === "fail") {
    const task = failTask(d, need(id, "task id"), need(one(a, "token"), "--token"), need(one(a, "reason"), "--reason"));
    emit(json, { ok: true, task: viewTask(task) }, `FAILED ${task.id} ${task.state}`);
    return;
  }
  if (sub === "block") {
    const task = blockTask(
      d,
      need(id, "task id"),
      need(one(a, "token"), "--token"),
      need(one(a, "reason"), "--reason"),
      one(a, "kind"),
    );
    emit(json, { ok: true, task: viewTask(task) }, `BLOCKED ${task.id} ${task.hold?.kind ?? ""}`.trimEnd());
    return;
  }
  if (sub === "unblock") {
    const task = unblockTask(d, need(id, "task id"));
    emit(json, { ok: true, task: viewTask(task) }, `UNBLOCKED ${task.id} ${task.state}`);
    return;
  }
  if (sub === "cancel") {
    const task = cancelTask(d, need(id, "task id"), one(a, "reason") ?? "canceled");
    emit(json, { ok: true, task: viewTask(task) }, `CANCELED ${task.id}`);
    return;
  }
  if (sub === "reopen") {
    const task = reopenTask(d, need(id, "task id"));
    emit(json, { ok: true, task: viewTask(task) }, `REOPENED ${task.id} ${task.state}`);
    return;
  }
  if (sub === "needs") {
    const add = a.flags.get("add") ?? [];
    const remove = a.flags.get("remove") ?? [];
    const task = changeNeeds(d, need(id, "task id"), {
      ...(add.length === 0 ? {} : { add }),
      ...(remove.length === 0 ? {} : { remove }),
    });
    emit(json, { ok: true, task: viewTask(task) }, `NEEDS ${task.id} ${task.needs.join(",") || "-"}`);
    return;
  }
  throw new Refusal(`unknown task command ${sub}\n\ndori board task ${TASK_COMMANDS}`);
}

function asFilter(raw: string): TaskFilter {
  if (!FILTERS.has(raw)) throw new Refusal(`--state must be one of ${[...FILTERS].join("|")}`);
  return raw as TaskFilter;
}

function resultOf(a: Args): string {
  const raw = need(one(a, "result"), "--result <text|@file>");
  if (!raw.startsWith("@")) return raw;
  const path = raw.slice(1);
  if (!path) throw new Refusal("--result @ needs a file path");
  try {
    return readFileSync(path, "utf8");
  } catch {
    throw new Refusal(`cannot read result file ${path}`);
  }
}

function formatTask(task: BoardTask): string {
  const needs = task.needs.length === 0 ? "-" : task.needs.join(",");
  const lease = task.claim === undefined ? "" : ` lease_until=${iso(task.claim.leaseUntil)}`;
  return `${task.id} ${task.state} needs=${needs}${lease} ${firstLine(task.title)}`;
}

function formatThread(view: ThreadView): string {
  const lines = [`THREAD ${view.thread.id} #${view.thread.channel}`];
  const task = view.task;
  if (task !== undefined) {
    const needs = task.needs.length === 0 ? "" : ` needs=${task.needs.join(",")}`;
    const lease =
      task.claim === undefined
        ? ""
        : ` lease_until=${iso(task.claim.leaseUntil)}${task.claim.worker === undefined ? "" : ` by=${task.claim.worker}`}`;
    lines.push(`TASK ${task.id} ${task.state} epoch=${task.epoch}${needs}${lease}`);
    if (task.hold !== undefined) lines.push(`HOLD ${task.hold.kind ?? "blocked"}: ${task.hold.reason}`);
    if (task.result !== undefined) lines.push(`RESULT ${firstLine(task.result)}`);
    if (task.reason !== undefined) lines.push(`REASON ${firstLine(task.reason)}`);
  }
  for (const message of view.thread.messages)
    lines.push(`${message.id} ${iso(message.at)} ${message.text.replaceAll("\n", "\n  ")}`);
  return lines.join("\n");
}
