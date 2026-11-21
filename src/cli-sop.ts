import { need, one, type Args } from "./cli-args.ts";
import type { Deps } from "./harness.ts";
import { Refusal } from "./refusal.ts";
import { createRun, decideGate, gateView, pendingGates, rerunNode, stepRun } from "./sop-runs.ts";
import { postGate, providerOf } from "./sop-mr.ts";
import { syncGate } from "./sop-sync.ts";
import { SopStore } from "./sop-store.ts";
import {
  BUNDLE_ID_RE,
  defaultBundleNodes,
  NODE_STATES,
  SOP_ID_RE,
  validateSop,
  type SopDef,
  type SopNodeState,
} from "./sop-types.ts";

const SOP_COMMANDS = "list|show|validate|new|run|step|gate|sync|rerun";
const GATE_COMMANDS = "list|show|approve|reject|skip";

const iso = (at: number): string => new Date(at).toISOString();

export async function runSop(d: Deps, a: Args, x: string | undefined): Promise<number> {
  const store = new SopStore(d.store.root);
  switch (x) {
    case "list":
      return list(store);
    case "show":
      return show(store, need(a.pos[2], "sop id"));
    case "validate":
      return validate(store, need(a.pos[2], "sop id"));
    case "new":
      return create(store, need(a.pos[2], "sop id"), a);
    case "run":
      return start(store, need(a.pos[2], "sop id"), a, d.now());
    case "step":
      return step(store, need(a.pos[2], "run id"), need(a.pos[3], "node id"), a, d.now());
    case "gate":
      return gate(store, d, a, d.now());
    case "sync":
      return sync(store, d, need(a.pos[2], "run id"), a);
    case "rerun":
      return rerun(store, need(a.pos[2], "run id"), need(a.pos[3], "node id"), d.now());
    default:
      throw new Refusal(`unknown sop command ${x ?? "(none)"}\n\ndori sop ${SOP_COMMANDS}`);
  }
}

function list(store: SopStore): number {
  const defs = store.defs();
  if (defs.length === 0) console.log("NO_SOPS");
  for (const entry of defs)
    console.log(
      entry.def === undefined
        ? `INVALID ${entry.id} ${entry.error}`
        : `SOP ${entry.id} nodes=${entry.def.nodes.length} ${entry.def.title}`,
    );
  return 0;
}

function show(store: SopStore, id: string): number {
  console.log(JSON.stringify(store.required(id), null, 2));
  return 0;
}

function validate(store: SopStore, id: string): number {
  const def = store.required(id);
  console.log(`VALID ${id} nodes=${def.nodes.length}`);
  return 0;
}

function create(store: SopStore, id: string, a: Args): number {
  if (!SOP_ID_RE.test(id)) throw new Refusal(`invalid SOP id ${JSON.stringify(id)}: must match ${SOP_ID_RE.source}`);
  if (store.has(id)) throw new Refusal(`SOP ${id} already exists`);
  const title = need(one(a, "title"), "--title <text>");
  const from = one(a, "from");
  const nodes =
    from === undefined || from === "bundle"
      ? defaultBundleNodes(id)
      : store.required(from).nodes.map((node) => ({
          ...node,
          ...(node.needs === undefined ? {} : { needs: [...node.needs] }),
        }));
  const def: SopDef = { id, title, nodes };
  const errors = validateSop(def, id);
  if (errors.length > 0) throw new Refusal(`generated SOP ${id} is invalid:\n  ${errors.join("\n  ")}`);
  store.save(def);
  console.log(`CREATED ${id} nodes=${nodes.length}`);
  return 0;
}

function start(store: SopStore, id: string, a: Args, now: number): number {
  const bundle = need(one(a, "bundle"), "--bundle <bundle-id>");
  if (!BUNDLE_ID_RE.test(bundle))
    throw new Refusal(`invalid bundle id ${JSON.stringify(bundle)}: must match ${BUNDLE_ID_RE.source}`);
  const def = store.required(id);
  const run = createRun(store, def, bundle, now);
  console.log(`RUN ${run.runId} sop=${run.sop} bundle=${run.bundle} nodes=${def.nodes.length}`);
  return 0;
}

function step(store: SopStore, runId: string, nodeId: string, a: Args, now: number): number {
  const raw = need(one(a, "state"), "--state <state>");
  if (!(NODE_STATES as readonly string[]).includes(raw))
    throw new Refusal(`--state must be one of ${NODE_STATES.join("|")}`);
  const run = stepRun(store, runId, nodeId, raw as SopNodeState, one(a, "note"), now);
  console.log(`STEP ${run.runId} ${nodeId} ${run.nodes[nodeId]!.state}`);
  return 0;
}

async function gate(store: SopStore, d: Deps, a: Args, now: number): Promise<number> {
  const sub = need(a.pos[2], `gate command (${GATE_COMMANDS})`);
  if (sub === "list") return gateList(store, a, now);
  if (sub === "show") return gateShow(store, d, need(a.pos[3], "run id"), need(a.pos[4], "node id"), a);
  const runId = need(a.pos[3], "run id");
  const by = need(one(a, "by"), "--by <name>");
  if (sub === "approve") {
    const { receipt } = decideGate(store, runId, "approve", by, undefined, one(a, "note"), now);
    console.log(`APPROVED ${runId} by=${by.trim()} receipt=${receipt}`);
    return 0;
  }
  if (sub === "reject" || sub === "skip") {
    const reason = need(one(a, "reason"), "--reason <text>");
    const { receipt } = decideGate(store, runId, sub === "reject" ? "reject" : "skip", by, reason, undefined, now);
    console.log(`${sub === "reject" ? "REJECTED" : "SKIPPED"} ${runId} by=${by.trim()} receipt=${receipt}`);
    return 0;
  }
  throw new Refusal(`unknown gate command ${sub}\n\ndori sop gate ${GATE_COMMANDS}`);
}

async function gateShow(store: SopStore, d: Deps, runId: string, nodeId: string, a: Args): Promise<number> {
  const provider = providerOf(one(a, "provider"));
  const view = gateView(store, runId, nodeId);
  console.log(`GATE ${view.run} sop=${view.sop} node=${view.node} state=${view.state}`);
  console.log(`bundle: ${view.bundle}`);
  const record = view.bundleRecord;
  if (record === undefined) {
    console.log(`WARN bundle missing: ${view.bundle}`);
    for (const line of await postGate(d, store, runId, nodeId, provider)) console.log(line);
    return 0;
  }
  console.log(`repo: ${record.repo}`);
  console.log(`pr: ${record.pr === null ? "-" : `#${record.pr.number} ${record.pr.url}`}`);
  for (const line of await postGate(d, store, runId, nodeId, provider)) console.log(line);
  return 0;
}

async function sync(store: SopStore, d: Deps, runId: string, a: Args): Promise<number> {
  const outcome = await syncGate(d, store, runId, providerOf(one(a, "provider")), one(a, "by"));
  for (const line of outcome.lines) console.log(line);
  return outcome.code;
}

function gateList(store: SopStore, a: Args, now: number): number {
  const runs = pendingGates(store);
  if (one(a, "json") === "true") {
    const gates = runs.map((run) => ({
      run: run.runId,
      sop: run.sop,
      bundle: run.bundle,
      node: run.gate!.node,
      since: run.gate!.since,
      waitingMs: Math.max(0, now - run.gate!.since),
    }));
    console.log(JSON.stringify({ ok: true, gates }));
    return 0;
  }
  if (runs.length === 0) console.log("NO_PENDING_GATES");
  for (const run of runs)
    console.log(
      `GATE ${run.runId} sop=${run.sop} bundle=${run.bundle} node=${run.gate!.node} waiting_since=${iso(run.gate!.since)}`,
    );
  return 0;
}

function rerun(store: SopStore, runId: string, nodeId: string, now: number): number {
  const { reset } = rerunNode(store, runId, nodeId, now);
  console.log(`RERUN ${runId} node=${nodeId} reset=${reset.length}`);
  return 0;
}
