import { readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { backlogAdd } from "../src/backlog.ts";
import type { Deps } from "../src/harness.ts";
import { ready, report, startLane } from "../src/lanes.ts";
import { HOUR, loopTick } from "../src/loop.ts";
import type { Exec } from "../src/runtime/exec.ts";
import { World, href } from "./fake.ts";

export function setup(opts: { lead?: boolean; exec?: (inner: Exec) => Exec } = {}) {
  const w = new World();
  if (opts.exec) w.exec = opts.exec(w.exec);
  const d = w.deps();
  const lead = w.addPane("w1:p1", "idle");
  if (opts.lead !== false) d.store.setRole("lead", href("w1:p1"));
  const brief = join(d.store.root, "brief.md");
  writeFileSync(brief, "Do the thing.");
  const add = (id: string, o: Parameters<typeof backlogAdd>[3] = {}) =>
    backlogAdd(d, id, brief, { cwd: d.store.root, ...o });
  const tick = (o: Parameters<typeof loopTick>[1] = {}) => loopTick(d, { force: true, ...o });
  const destructive = () => w.calls.filter((c) => c.argv.join(" ").match(/pane close|pr merge|push/));
  return { w, d, lead, brief, add, tick, destructive };
}

export type LoopSetup = ReturnType<typeof setup>;

/** Test-1 fixture: items whose priority, age and id decide the start order; the lead's inbox starts empty. */
export function seedPriority(): LoopSetup {
  const s = setup();
  s.add("old-five");
  s.w.clock += 1000;
  s.add("urgent", { priority: 1 });
  s.w.clock += 1000;
  s.add("new-five");
  s.add("aaa-five");
  s.lead.received.length = 0;
  return s;
}

/** Test-2 fixture: one plain item, one that needs a decision, and two hand-started lanes. */
export async function seedFull(): Promise<LoopSetup> {
  const s = setup();
  s.add("next");
  s.add("blocked", { priority: 1, decision: "which database?" });
  await startLane(s.d, "hand-a", s.brief, { group: "w1" });
  await startLane(s.d, "hand-b", s.brief, { group: "w1" });
  return s;
}

/** Test-10 fixture: an urgent item with no brief left, and a healthy one behind it. */
export function seedBroken(): LoopSetup {
  const s = setup();
  s.add("broken", { priority: 1 });
  s.add("healthy", { priority: 5 });
  rmSync(s.d.store.item("broken")!.brief);
  return s;
}

/** Adds one item and runs a forced tick, so its lane exists and it is running. */
export async function seedRunning(s: LoopSetup, id: string) {
  s.add(id);
  await loopTick(s.d, { force: true });
  return s.d.store.lane(id)!;
}

/** Test-8 fixture: a world with one item waiting on a decision, and the clock-seeded tick helper. */
export function decisionSetup() {
  const s = setup();
  s.add("pick-db", { decision: "postgres or sqlite?" });
  return { ...s, at: clockAt(s.w, s.d) };
}

export const lose = (d: Deps, key: string): void => {
  const lane = d.store.lane(key)!;
  lane.status = "lost";
  d.store.saveLane(lane);
};

/** Every lane file's text, in directory order: two snapshots that match mean the loop touched no lane. */
export const laneFiles = (d: Deps): string[] =>
  readdirSync(join(d.store.root, "lanes")).map((f) => readFileSync(join(d.store.root, "lanes", f), "utf8"));

/** A clock-seeded loop tick: `at(h)` advances `h` hours before running the loop once. */
export const clockAt = (w: World, d: Deps) => async (hours: number) => {
  w.clock += hours * HOUR;
  return loopTick(d);
};

export const hourlyTick =
  (w: World, d: Deps) =>
  async (opts: Parameters<typeof loopTick>[1] = { maxStarts: 1 }) => {
    w.clock += HOUR;
    return loopTick(d, opts);
  };

export async function readyIdle(w: World, d: Deps, key: string, text: string, evidence: string[]): Promise<void> {
  await ready(d, key, text, evidence);
  w.panes.get(d.store.lane(key)!.paneId)!.status = "idle";
}

/** The audit fixture: quiet, busy, waiting, READY and vanished lanes plus a fresh one, and gh reporting OPEN. */
export async function seedAudit(w: World, d: Deps, brief: string) {
  const quiet = await startLane(d, "quiet", brief, { group: "w1" });
  const busy = await startLane(d, "busy", brief, { group: "w1" });
  const wait = await startLane(d, "wait-ci", brief, { group: "w1" });
  const fin = await startLane(d, "finished", brief, { group: "w1" });
  const gone = await startLane(d, "vanished", brief, { group: "w1" });
  await startLane(d, "fresh", brief, { group: "w1" });
  await report(d, "wait-ci", "WAITING: CI on acme/app#3", "waiting");
  await ready(d, "finished", "done", ["https://github.com/acme/app/pull/3"]);
  for (const l of [quiet, wait, fin]) w.panes.get(l.paneId)!.status = "idle";
  w.panes.get(busy.paneId)!.status = "working";
  w.panes.delete(gone.paneId);
  w.gh = () => ({ code: 0, stdout: JSON.stringify({ state: "OPEN" }) });
  return { quiet, busy, wait, fin, gone };
}

const tabDown =
  (inner: Exec): Exec =>
  async (cmd, argv) =>
    cmd === "herdr" && argv[0] === "tab" ? { code: 1, stdout: "", stderr: "server down" } : inner(cmd, argv);

const leadUnreachable =
  (inner: Exec): Exec =>
  async (cmd, argv) =>
    cmd === "herdr" && argv[0] === "agent" && argv[2] === "w1:p1"
      ? { code: 1, stdout: "", stderr: "lead pane hung" }
      : inner(cmd, argv);

/** A world whose tab creation fails, seeded with three backlog items in start order. */
export function failingStarts() {
  const s = setup({ exec: tabDown });
  for (const id of ["one", "two", "three"]) s.add(id);
  return s;
}

/** A world with no lead pane registered, seeded with one item. */
export function headlessSetup() {
  const s = setup({ lead: false });
  s.add("one");
  return s;
}

/** A world where the [START] report cannot reach the lead pane, seeded with one item. */
export function leadUnreachableSetup() {
  const s = setup({ exec: leadUnreachable });
  s.add("solo");
  return s;
}
