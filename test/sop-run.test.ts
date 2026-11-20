import { describe, expect, test } from "bun:test";
import { cli } from "./board-fixture.ts";
import { setup } from "./harness-setup.ts";
import { findRun, putSop, runIdOf } from "./sop-fixture.ts";

describe("sop runs", () => {
  test("one run starts every node waiting and collapses extra approvals into the first gate", async () => {
    const { d } = setup();
    putSop(d, {
      id: "two",
      title: "Two",
      nodes: [
        { id: "work", kind: "agent" },
        { id: "first", kind: "approval", prompt: "First?", needs: ["work"] },
        { id: "second", kind: "approval", prompt: "Second?", needs: ["work"] },
        { id: "ship", kind: "script", script: "echo ship", needs: ["first"] },
      ],
    });
    const out = await cli(d, ["sop", "run", "two", "--bundle", "b-1"]);
    expect(out.code).toBe(0);
    const runId = runIdOf(out.out);
    const run = findRun(d, runId);
    expect(run).toMatchObject({ sop: "two", bundle: "b-1", createdAt: d.now() });
    expect(Object.fromEntries(Object.entries(run.nodes).map(([id, node]) => [id, node.state]))).toEqual({
      work: "waiting",
      first: "waiting",
      second: "skipped",
      ship: "waiting",
    });
    expect(run.nodes["second"]?.note ?? "").toContain("collapsed into gate first");
    expect(run.gate).toMatchObject({ state: "pending", node: "first", since: d.now() });
    expect((await cli(d, ["sop", "run", "two", "--bundle", "b-2"])).out).not.toContain(`RUN ${runId} `);
  });

  test("step records legal transitions with injected time and refuses illegal ones", async () => {
    const { d, w } = setup();
    putSop(d, {
      id: "flow",
      title: "Flow",
      nodes: [
        { id: "work", kind: "agent" },
        { id: "gate", kind: "approval", prompt: "Approve?", needs: ["work"] },
        { id: "ship", kind: "script", script: "echo ship", needs: ["gate"] },
      ],
    });
    const started = d.now();
    const runId = runIdOf((await cli(d, ["sop", "run", "flow", "--bundle", "b-1"])).out);
    expect((await cli(d, ["sop", "step", runId, "work", "--state", "running"])).out).toBe(`STEP ${runId} work running`);
    let run = findRun(d, runId);
    expect(run.nodes["work"]).toMatchObject({ state: "running", startedAt: started });
    expect(run.nodes["work"]?.endedAt).toBeUndefined();
    w.clock = started + 5000;
    expect((await cli(d, ["sop", "step", runId, "work", "--state", "done", "--note", "implemented"])).out).toBe(
      `STEP ${runId} work done`,
    );
    run = findRun(d, runId);
    expect(run.nodes["work"]).toMatchObject({
      state: "done",
      startedAt: started,
      endedAt: started + 5000,
      note: "implemented",
    });
    await expect(cli(d, ["sop", "step", runId, "ship", "--state", "done"])).rejects.toThrow(
      "cannot move node ship from waiting to done",
    );
    await expect(cli(d, ["sop", "step", runId, "gate", "--state", "done"])).rejects.toThrow("approval gate");
    await expect(cli(d, ["sop", "step", runId, "work", "--state", "running"])).rejects.toThrow(
      "cannot move node work from done to running",
    );
    await expect(cli(d, ["sop", "step", runId, "work", "--state", "nope"])).rejects.toThrow("--state must be one of");
  });

  test("a run with no approval node has no gate", async () => {
    const { d } = setup();
    putSop(d, { id: "plain", title: "Plain", nodes: [{ id: "only", kind: "script", script: "echo ok" }] });
    const runId = runIdOf((await cli(d, ["sop", "run", "plain", "--bundle", "b-1"])).out);
    expect(findRun(d, runId).gate).toBeUndefined();
    expect((await cli(d, ["sop", "step", runId, "only", "--state", "running"])).code).toBe(0);
    await expect(cli(d, ["sop", "step", runId, "only", "--state", "done"])).rejects.toThrow("has no approval gate");
  });
});
