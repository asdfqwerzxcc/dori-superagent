import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { Deps } from "../src/harness.ts";
import type { SopDef, SopReceipt } from "../src/sop-types.ts";
import { cli } from "./board-fixture.ts";
import { setup } from "./harness-setup.ts";
import { findRun, putSop, runIdOf, sopReceipts } from "./sop-fixture.ts";

const honestyDef = (): SopDef => ({
  id: "honesty",
  title: "Honesty",
  nodes: [
    { id: "work", kind: "agent" },
    { id: "ship", kind: "script", script: "echo ship" },
    { id: "approve", kind: "approval", prompt: "Approve?" },
  ],
});

async function started(d: Deps): Promise<string> {
  putSop(d, honestyDef());
  return runIdOf((await cli(d, ["sop", "run", "honesty", "--bundle", "b-1"])).out);
}

describe("sop gates", () => {
  test("gate list shows pending runs in human and JSON form", async () => {
    const { d } = setup();
    const first = await started(d);
    const second = await started(d);
    await cli(d, ["sop", "gate", "approve", first, "--by", "lee"]);
    const human = (await cli(d, ["sop", "gate", "list"])).out;
    expect(human).toContain(`GATE ${second} `);
    expect(human).not.toContain(`GATE ${first} `);
    const parsed = JSON.parse((await cli(d, ["sop", "gate", "list", "--json"])).out) as {
      ok: boolean;
      gates: { run: string; node: string; waitingMs: number }[];
    };
    expect(parsed.ok).toBe(true);
    expect(parsed.gates.map((gate) => gate.run)).toEqual([second]);
    expect(parsed.gates[0]).toMatchObject({ node: "approve", waitingMs: 0 });
    await cli(d, ["sop", "gate", "approve", second, "--by", "lee"]);
    expect((await cli(d, ["sop", "gate", "list"])).out).toBe("NO_PENDING_GATES");
    expect(JSON.parse((await cli(d, ["sop", "gate", "list", "--json"])).out)).toEqual({ ok: true, gates: [] });
  });

  test("approve writes a receipt and marks the gate and its node done", async () => {
    const { d } = setup();
    const runId = await started(d);
    const out = await cli(d, ["sop", "gate", "approve", runId, "--by", "lee", "--note", "looks good"]);
    expect(out.code).toBe(0);
    expect(out.out).toContain(`APPROVED ${runId} by=lee receipt=${join(d.store.root, "receipts", "sop-")}`);
    const receipts = sopReceipts(d);
    expect(receipts).toHaveLength(1);
    const path = join(d.store.root, "receipts", receipts[0]!);
    const receipt = JSON.parse(readFileSync(path, "utf8")) as SopReceipt;
    expect(receipt).toMatchObject({
      kind: "sop-gate",
      run: runId,
      sop: "honesty",
      bundle: "b-1",
      node: "approve",
      decision: "approve",
      by: "lee",
      at: d.now(),
      note: "looks good",
    });
    const run = findRun(d, runId);
    expect(run.gate).toMatchObject({ state: "approved", by: "lee", at: d.now(), note: "looks good" });
    expect(run.nodes["approve"]).toMatchObject({ state: "done", receipt: path });
    await expect(cli(d, ["sop", "gate", "approve", runId, "--by", "lee"])).rejects.toThrow("already approved");
  });

  test("reject and skip require a reason, write receipts, and update their node", async () => {
    const { d } = setup();
    const rejected = await started(d);
    await expect(cli(d, ["sop", "gate", "reject", rejected, "--by", "lee"])).rejects.toThrow("missing --reason");
    expect((await cli(d, ["sop", "gate", "reject", rejected, "--by", "lee", "--reason", "scope creep"])).out).toContain(
      "REJECTED",
    );
    expect(findRun(d, rejected).gate).toMatchObject({ state: "rejected", reason: "scope creep" });
    expect(findRun(d, rejected).nodes["approve"]?.state).toBe("failed");

    const skipped = await started(d);
    await expect(cli(d, ["sop", "gate", "skip", skipped, "--by", "lee"])).rejects.toThrow("missing --reason");
    expect((await cli(d, ["sop", "gate", "skip", skipped, "--by", "lee", "--reason", "low risk"])).out).toContain(
      "SKIPPED",
    );
    expect(findRun(d, skipped).gate).toMatchObject({ state: "skipped", reason: "low risk" });
    expect(findRun(d, skipped).nodes["approve"]?.state).toBe("skipped");
    await cli(d, ["sop", "step", skipped, "ship", "--state", "running"]);
    expect((await cli(d, ["sop", "step", skipped, "ship", "--state", "done"])).code).toBe(0);

    const decisions = sopReceipts(d)
      .map((name) => (JSON.parse(readFileSync(join(d.store.root, "receipts", name), "utf8")) as SopReceipt).decision)
      .sort();
    expect(decisions).toEqual(["reject", "skip"]);
  });

  test("a terminal node cannot be done while the gate is pending or rejected", async () => {
    const { d } = setup();
    const runId = await started(d);
    await cli(d, ["sop", "step", runId, "ship", "--state", "running"]);
    await expect(cli(d, ["sop", "step", runId, "ship", "--state", "done"])).rejects.toThrow("gate is pending");
    await cli(d, ["sop", "gate", "reject", runId, "--by", "lee", "--reason", "no"]);
    await expect(cli(d, ["sop", "step", runId, "ship", "--state", "done"])).rejects.toThrow("gate was rejected");

    const other = setup();
    const approved = await started(other.d);
    await cli(other.d, ["sop", "gate", "approve", approved, "--by", "lee"]);
    await cli(other.d, ["sop", "step", approved, "ship", "--state", "running"]);
    expect((await cli(other.d, ["sop", "step", approved, "ship", "--state", "done"])).code).toBe(0);
  });

  test("rerun resets the node and its descendants; only an upstream rerun resets the gate", async () => {
    const { d } = setup();
    putSop(d, {
      id: "chain",
      title: "Chain",
      nodes: [
        { id: "work", kind: "agent" },
        { id: "approve", kind: "approval", prompt: "Approve?", needs: ["work"] },
        { id: "ship", kind: "script", script: "echo ship", needs: ["approve"] },
      ],
    });
    const runId = runIdOf((await cli(d, ["sop", "run", "chain", "--bundle", "b-1"])).out);
    await cli(d, ["sop", "step", runId, "work", "--state", "running"]);
    await cli(d, ["sop", "step", runId, "work", "--state", "done"]);
    await cli(d, ["sop", "gate", "approve", runId, "--by", "lee"]);
    await cli(d, ["sop", "step", runId, "ship", "--state", "running"]);
    await cli(d, ["sop", "step", runId, "ship", "--state", "done"]);

    expect((await cli(d, ["sop", "rerun", runId, "ship"])).out).toBe(`RERUN ${runId} node=ship reset=1`);
    expect(findRun(d, runId).gate).toMatchObject({ state: "approved" });

    expect((await cli(d, ["sop", "rerun", runId, "work"])).out).toBe(`RERUN ${runId} node=work reset=3`);
    const run = findRun(d, runId);
    expect(run.gate).toMatchObject({ state: "pending", node: "approve", since: d.now() });
    expect(Object.values(run.nodes).map((node) => node.state)).toEqual(["waiting", "waiting", "waiting"]);
    expect(run.nodes["approve"]?.receipt).toBeUndefined();
  });
});
