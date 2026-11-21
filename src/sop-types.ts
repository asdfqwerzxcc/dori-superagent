const SOP_KINDS = ["agent", "script", "approval"] as const;
export type SopKind = (typeof SOP_KINDS)[number];

export const NODE_STATES = ["waiting", "running", "blocked", "done", "failed", "skipped"] as const;
export type SopNodeState = (typeof NODE_STATES)[number];

const GATE_STATES = ["pending", "approved", "rejected", "skipped"] as const;
export type SopGateState = (typeof GATE_STATES)[number];

export type SopNodeDef = {
  id: string;
  kind: SopKind;
  run?: string;
  script?: string;
  prompt?: string;
  /** The bundle this node works on. An approval node must name the one bundle its human gate decides. */
  bundle?: string;
  needs?: string[];
};

export type SopDef = { id: string; title: string; nodes: SopNodeDef[] };

export type SopRunNode = {
  state: SopNodeState;
  startedAt?: number;
  endedAt?: number;
  note?: string;
  receipt?: string;
};

export type SopGate = {
  state: SopGateState;
  node: string;
  since: number;
  by?: string;
  at?: number;
  reason?: string;
  note?: string;
};

export type SopRun = {
  runId: string;
  sop: string;
  bundle: string;
  createdAt: number;
  nodes: Record<string, SopRunNode>;
  gate?: SopGate;
};

export type SopDecision = "approve" | "reject" | "skip";

export type SopReceipt = {
  kind: "sop-gate";
  run: string;
  sop: string;
  bundle: string;
  node: string;
  decision: SopDecision;
  by: string;
  at: number;
  reason?: string;
  note?: string;
};

/** SOP ids become file names under `sops/`, so they may not contain a separator or start with a dot. */
export const SOP_ID_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;
export const NODE_ID_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;
export const BUNDLE_ID_RE = /^[A-Za-z0-9][A-Za-z0-9._/-]{0,127}$/;

export function defaultBundleNodes(bundle: string): SopNodeDef[] {
  return [
    {
      id: "implement",
      kind: "agent",
      prompt: "Implement the bundle in a lane; report each step with dori sop step.",
    },
    {
      id: "approve",
      kind: "approval",
      bundle,
      prompt: "Review the bundle: approve, reject with a reason, or skip with a reason.",
      needs: ["implement"],
    },
    { id: "verify", kind: "script", script: "bun run ci", needs: ["approve"] },
  ];
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const isText = (value: unknown): value is string => typeof value === "string" && value.trim() !== "";

const cycleIn = (needs: Map<string, string[]>): string[] | undefined => {
  const done = new Set<string>();
  const stack: string[] = [];
  const visit = (id: string): string[] | undefined => {
    const at = stack.indexOf(id);
    if (at >= 0) return [...stack.slice(at), id];
    if (done.has(id)) return undefined;
    stack.push(id);
    for (const next of needs.get(id) ?? []) {
      const found = visit(next);
      if (found !== undefined) return found;
    }
    stack.pop();
    done.add(id);
    return undefined;
  };
  for (const id of needs.keys()) {
    const found = visit(id);
    if (found !== undefined) return found;
  }
  return undefined;
};

export function validateSop(raw: unknown, expectedId?: string): string[] {
  if (!isRecord(raw)) return ["definition must be a JSON object"];
  const errors: string[] = [];
  const id = raw["id"];
  if (!isText(id) || !SOP_ID_RE.test(id)) errors.push(`id must match ${SOP_ID_RE.source}`);
  else if (expectedId !== undefined && id !== expectedId)
    errors.push(`id "${id}" does not match file ${expectedId}.json`);
  if (!isText(raw["title"])) errors.push("title must be a non-empty string");
  const nodes = raw["nodes"];
  if (!Array.isArray(nodes) || nodes.length === 0) return [...errors, "nodes must be a non-empty array"];

  const ids = new Set<string>();
  const approvals: string[] = [];
  const needs = new Map<string, string[]>();
  nodes.forEach((node: unknown, index: number) => {
    if (!isRecord(node)) {
      errors.push(`nodes[${index}] must be an object`);
      return;
    }
    const nodeId = node["id"];
    if (!isText(nodeId) || !NODE_ID_RE.test(nodeId)) {
      errors.push(`nodes[${index}].id must match ${NODE_ID_RE.source}`);
      return;
    }
    if (ids.has(nodeId)) errors.push(`duplicate node id ${nodeId}`);
    ids.add(nodeId);
    const kind = node["kind"];
    if (typeof kind !== "string" || !(SOP_KINDS as readonly string[]).includes(kind))
      errors.push(`node ${nodeId}: kind must be one of ${SOP_KINDS.join("|")} (got ${JSON.stringify(kind)})`);
    for (const field of ["run", "script", "prompt"] as const) {
      const value = node[field];
      if (value !== undefined && typeof value !== "string") errors.push(`node ${nodeId}: ${field} must be a string`);
    }
    if (kind === "approval" && !isText(node["prompt"])) errors.push(`node ${nodeId}: approval needs a prompt`);
    const bundle = node["bundle"];
    if (kind === "approval" && !isText(bundle))
      errors.push(`node ${nodeId}: approval needs a bundle (the human gate is one bundle gate)`);
    else if (bundle !== undefined && (!isText(bundle) || !BUNDLE_ID_RE.test(bundle)))
      errors.push(`node ${nodeId}: bundle must match ${BUNDLE_ID_RE.source}`);
    if (kind === "approval") approvals.push(nodeId);
    const rawNeeds = node["needs"];
    if (rawNeeds === undefined) needs.set(nodeId, []);
    else if (!Array.isArray(rawNeeds) || rawNeeds.some((value: unknown) => !isText(value)))
      errors.push(`node ${nodeId}: needs must be an array of node ids`);
    else needs.set(nodeId, rawNeeds);
  });

  if (approvals.length > 1)
    errors.push(
      `${approvals.length} approval nodes (${approvals.join(", ")}): a definition has at most one human gate, and it is the bundle gate`,
    );

  for (const [nodeId, list] of needs) {
    for (const needId of list) {
      if (needId === nodeId) errors.push(`node ${nodeId}: needs itself`);
      else if (!ids.has(needId)) errors.push(`node ${nodeId}: needs unknown node ${needId}`);
    }
  }
  const cycle = cycleIn(needs);
  if (cycle !== undefined) errors.push(`needs cycle: ${cycle.join(" -> ")}`);
  return errors;
}
