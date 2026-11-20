import { Refusal } from "./refusal.ts";
import type { SopStore } from "./sop-store.ts";
import type {
  SopDecision,
  SopDef,
  SopGate,
  SopGateState,
  SopNodeDef,
  SopNodeState,
  SopReceipt,
  SopRun,
  SopRunNode,
} from "./sop-types.ts";

const LEGAL: Record<SopNodeState, readonly SopNodeState[]> = {
  waiting: ["running", "blocked", "failed", "skipped"],
  running: ["done", "failed", "blocked"],
  blocked: ["running", "failed", "skipped"],
  failed: ["running", "waiting"],
  done: [],
  skipped: [],
};

const terminal = (def: SopDef, nodeId: string): boolean =>
  !def.nodes.some((node) => (node.needs ?? []).includes(nodeId));

const unmetNeeds = (run: SopRun, node: SopNodeDef): string[] =>
  (node.needs ?? []).filter((id) => {
    const state = run.nodes[id]?.state;
    return state !== "done" && state !== "skipped";
  });

export function createRun(store: SopStore, def: SopDef, bundle: string, now: number): SopRun {
  const nodes: Record<string, SopRunNode> = {};
  let gate: SopGate | undefined;
  for (const node of def.nodes) {
    if (node.kind !== "approval") {
      nodes[node.id] = { state: "waiting" };
      continue;
    }
    if (gate === undefined) {
      gate = { state: "pending", node: node.id, since: now };
      nodes[node.id] = { state: "waiting" };
      continue;
    }
    nodes[node.id] = { state: "skipped", endedAt: now, note: `collapsed into gate ${gate.node}` };
  }

  const base = `${def.id}-${now.toString(36)}`;
  const taken = new Set(store.runs().map((run) => run.runId));
  let runId = base;
  for (let n = 2; taken.has(runId); n++) runId = `${base}-${n}`;
  const run: SopRun = { runId, sop: def.id, bundle, createdAt: now, nodes, ...(gate ? { gate } : {}) };
  store.saveRun(run);
  return run;
}

export function stepRun(
  store: SopStore,
  runId: string,
  nodeId: string,
  state: SopNodeState,
  note: string | undefined,
  now: number,
): SopRun {
  const run = store.run(runId);
  const def = store.required(run.sop);
  const node = def.nodes.find((candidate) => candidate.id === nodeId);
  if (node === undefined) throw new Refusal(`run ${runId} has no node ${nodeId}`);
  if (node.kind === "approval")
    throw new Refusal(`node ${nodeId} is the approval gate: decide it with dori sop gate approve|reject|skip ${runId}`);

  const current = run.nodes[nodeId];
  if (current === undefined) throw new Refusal(`run ${runId} has no state for node ${nodeId}`);
  if (state !== current.state && !LEGAL[current.state].includes(state))
    throw new Refusal(`cannot move node ${nodeId} from ${current.state} to ${state}`);

  if (state === "done" && terminal(def, nodeId)) {
    const gate = run.gate;
    if (gate === undefined)
      throw new Refusal(`run ${runId} has no approval gate: a terminal node cannot be done without one`);
    if (gate.state === "pending")
      throw new Refusal(
        `run ${runId} gate is pending: approve or skip it with --by, or reject it with --reason, before completing ${nodeId}`,
      );
    if (gate.state === "rejected")
      throw new Refusal(`run ${runId} gate was rejected: fix the work, then rerun ${nodeId} and decide again`);
  }
  if (state === "running" || state === "done") {
    const missing = unmetNeeds(run, node);
    if (missing.length > 0) throw new Refusal(`cannot mark ${nodeId} ${state}: needs not done: ${missing.join(", ")}`);
  }

  const next: SopRunNode = { ...current, state };
  if (note !== undefined) next.note = note;
  if (state === "running") {
    next.startedAt = next.startedAt ?? now;
    delete next.endedAt;
  }
  if (state === "done" || state === "failed" || state === "skipped") {
    next.startedAt = next.startedAt ?? now;
    next.endedAt = now;
  }
  if (state === "waiting") {
    delete next.startedAt;
    delete next.endedAt;
    delete next.receipt;
  }
  run.nodes[nodeId] = next;
  store.saveRun(run);
  return run;
}

export function decideGate(
  store: SopStore,
  runId: string,
  decision: SopDecision,
  by: string,
  reason: string | undefined,
  note: string | undefined,
  now: number,
): { run: SopRun; receipt: string } {
  const name = by.trim();
  const why = reason?.trim();
  const comment = note?.trim();
  if (name === "") throw new Refusal("--by needs a name");
  if (decision !== "approve" && (why === undefined || why === ""))
    throw new Refusal(`gate ${decision} needs --reason <text>`);

  const run = store.run(runId);
  const gate = run.gate;
  if (gate === undefined) throw new Refusal(`run ${runId} has no approval gate`);
  if (gate.state !== "pending")
    throw new Refusal(`run ${runId} gate is already ${gate.state}: rerun ${gate.node} before deciding again`);
  const node = run.nodes[gate.node];
  if (node === undefined) throw new Refusal(`run ${runId} gate node ${gate.node} has no state`);

  const receipt: SopReceipt = {
    kind: "sop-gate",
    run: run.runId,
    sop: run.sop,
    bundle: run.bundle,
    node: gate.node,
    decision,
    by: name,
    at: now,
    ...(why === undefined || why === "" ? {} : { reason: why }),
    ...(comment === undefined || comment === "" ? {} : { note: comment }),
  };
  const path = store.receipts.saveSop(receipt);

  const gateState: SopGateState = decision === "approve" ? "approved" : decision === "reject" ? "rejected" : "skipped";
  const nodeState: SopNodeState = decision === "approve" ? "done" : decision === "reject" ? "failed" : "skipped";
  run.gate = {
    ...gate,
    state: gateState,
    by: name,
    at: now,
    ...(why === undefined || why === "" ? {} : { reason: why }),
    ...(comment === undefined || comment === "" ? {} : { note: comment }),
  };
  run.nodes[gate.node] = {
    ...node,
    state: nodeState,
    startedAt: node.startedAt ?? now,
    endedAt: now,
    receipt: path,
  };
  store.saveRun(run);
  return { run, receipt: path };
}

export function rerunNode(
  store: SopStore,
  runId: string,
  nodeId: string,
  now: number,
): { run: SopRun; reset: string[] } {
  const run = store.run(runId);
  const def = store.required(run.sop);
  if (!def.nodes.some((node) => node.id === nodeId)) throw new Refusal(`run ${runId} has no node ${nodeId}`);

  const reset = new Set<string>([nodeId]);
  for (let grew = true; grew; ) {
    grew = false;
    for (const node of def.nodes) {
      if (reset.has(node.id)) continue;
      if ((node.needs ?? []).some((need) => reset.has(need))) {
        reset.add(node.id);
        grew = true;
      }
    }
  }
  for (const id of reset) run.nodes[id] = { state: "waiting" };
  if (run.gate !== undefined && reset.has(run.gate.node))
    run.gate = { state: "pending", node: run.gate.node, since: now };
  store.saveRun(run);
  return { run, reset: [...reset] };
}

export function pendingGates(store: SopStore): SopRun[] {
  return store
    .runs()
    .filter((run) => run.gate?.state === "pending")
    .sort((a, b) => (a.gate?.since ?? 0) - (b.gate?.since ?? 0));
}
