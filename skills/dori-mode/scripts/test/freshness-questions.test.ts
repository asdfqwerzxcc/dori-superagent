import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

import { FakeOmoHost } from "../../../../test/fake-omo-host.ts";
import { freshnessTick } from "../src/freshness.ts";
import { Reports } from "../src/reports.ts";
import { depsFor, fakeClock, fakeRunner, newWorld, withState } from "./fakes.ts";

// A lane with omo's question-tool request pending (senpi RpcQuestionUiRequest); its 30-min-old milestone invites a nudge.
const spec = { id: "q1", header: "진행", question: "어떻게 진행할까요?", options: [{ label: "A" }, { label: "B" }] };
const asked = { method: "question", questions: [{ ...spec, multiSelect: false }] };
const questionLane = async (pendingQuestions: unknown[], entries: unknown[] = []) => {
  const state = withState();
  const T0 = Date.parse("2026-11-20T09:00:00.000Z");
  const world = newWorld();
  const host = new FakeOmoHost(join(state.dir, "sessions"));
  const s = host.add({ id: "00000000-0000-4000-8000-000000000021", state: { pendingQuestions }, entries });
  const deps = {
    ...depsFor(world, fakeClock(T0), state.dir, { runtime: "hc", laneRuntime: "omo-host", laneWorkspace: "g1" }),
    run: async (argv: readonly string[]) => {
      if (argv[0] !== "omo") return fakeRunner(world)(argv);
      const r = await host.exec("omo", argv.slice(1));
      return { code: r.code, out: r.stdout.trim(), err: r.stderr };
    },
  };
  const reports = new Reports(state.dir);
  reports.report("ask-lane", "milestone", "started", T0 - 30 * 60_000);
  const lane = { key: "ask-lane", title: "t", thread: "none", brief: "/b.md", done: "merged acme/app#1" };
  const at = new Date(T0 - 60 * 60_000).toISOString();
  const ref = { runtime: "omo-host" as const, id: s.id };
  await deps.registry.write({ ...lane, openedAt: at, sessionRef: ref, pane: s.id, reportProtocol: "jsonl-v1" });
  const rows = () => readFileSync(reports.path("ask-lane"), "utf8").trim().split("\n");
  const journal = () => rows().map((l) => JSON.parse(l) as { kind?: string; text: string });
  const delivered = () => host.calls.filter((c) => c[0] === "prompt" || c[0] === "steer");
  return { state, s, deps, reports, journal, delivered };
};

test("a lane waiting on a question prompt gets one question report and no nudge (T2.10)", async () => {
  const q = await questionLane([asked]);
  try {
    const first = await freshnessTick(q.deps, "/home/test");
    expect(q.journal().map((e) => [e.kind, e.text])).toEqual([
      ["milestone", "started"],
      ["question", "어떻게 진행할까요? [A / B]"],
    ]);
    expect(q.reports.read("ask-lane")?.state).toBe("blocked");
    expect(first.map((a) => a.kind).filter((k) => k === "nudged" || k === "stalled")).toEqual([]);
    expect(q.delivered()).toEqual([]);
    // The same footer on the next tick writes nothing more.
    await freshnessTick(q.deps, "/home/test");
    expect(q.journal()).toHaveLength(2);
    expect(q.delivered()).toEqual([]);
  } finally {
    q.state.done();
  }
});

test("once the question is answered the next report is taken as usual, and a new question is reported again (T2.11)", async () => {
  const q = await questionLane([asked]);
  try {
    await freshnessTick(q.deps, "/home/test");
    q.s.state = { ...q.s.state, pendingQuestions: [] };
    await freshnessTick(q.deps, "/home/test");
    expect((await q.deps.registry.read("ask-lane"))?.lastQuestion).toBeUndefined();
    q.reports.report("ask-lane", "milestone", "went with A", Date.parse("2026-11-20T09:01:00.000Z"));
    await freshnessTick(q.deps, "/home/test");
    expect(q.reports.read("ask-lane")?.lastReport?.kind).toBe("milestone");
    q.s.state = { ...q.s.state, pendingQuestions: [asked] };
    await freshnessTick(q.deps, "/home/test");
    expect(q.journal().map((e) => e.kind)).toEqual(["milestone", "question", "milestone", "question"]);
  } finally {
    q.state.done();
  }
});

test("a ? line inside the transcript, not directly above the status line, is no question", async () => {
  const said = (role: string, text: string) => ({ type: "message", message: { role, content: text } });
  const q = await questionLane(
    [],
    [said("assistant", "? 어떻게 진행할까요? [A] [B]\nI will take A."), said("user", "? looks fine")],
  );
  try {
    await freshnessTick(q.deps, "/home/test");
    expect(q.journal().map((e) => e.kind)).not.toContain("question");
  } finally {
    q.state.done();
  }
});
