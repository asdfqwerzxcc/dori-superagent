import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Deps } from "../src/harness.ts";
import type { Lane } from "../src/store-types.ts";
import { href, type World } from "./fake.ts";
import { fakeGit, type Repo } from "./fake-git.ts";
import { setup } from "./harness-setup.ts";

export const base = "a".repeat(40);
export const tipA = "b".repeat(40);
export const tipB = "c".repeat(40);
export const repoName = "asdfqwerzxcc/dori-design-system";
export const url = `https://github.com/${repoName}/pull/7`;

const GREEN = [{ name: "test", bucket: "pass" }] as const;
type GhResult = { readonly code: number; readonly stdout: string; readonly stderr?: string };
type CheckList = readonly { readonly name: string; readonly bucket: string }[];
type Runs = { readonly status: string; readonly conclusion: string | null } | "fail" | "none";

const isCheckList = (value: CheckList | GhResult): value is CheckList => Array.isArray(value);

export function laneFixture(tip = tipA) {
  const { w, d } = setup();
  const repoPath = mkdtempSync(join(tmpdir(), "dori-lane-land-"));
  const repo: Repo = {
    head: base,
    mergeBase: base,
    remotes: { origin: `https://github.com/${repoName}.git` },
    heads: { [repoPath]: tip },
  };
  fakeGit(w, repo);
  const lane: Lane = {
    key: "alpha",
    sessionRef: href("w1:p9"),
    paneId: "w1:p9",
    tabId: "w1:t1",
    brief: join(d.store.root, "lane-brief.md"),
    cwd: repoPath,
    worktree: repoPath,
    repo: repoPath,
    baseSha: base,
    tipSha: tip,
    status: "ready",
    createdAt: 1,
    lastActivityAt: 1,
    nudges: 0,
    final: { text: "Lane alpha ready", evidence: ["https://example.test/alpha"], at: 2 },
    log: [],
  };
  d.store.saveLane(lane);
  return { w, d, repo, repoPath, lane };
}

export function receiptAt(d: Deps, tip: string, verdict: "CLEAR" | "BLOCK" = "CLEAR"): void {
  d.store.saveLaneReceipt({
    lane: "alpha",
    verdict,
    base,
    tip,
    brief: "Land the design lane through its PR.",
    reviewer: "reviewer-alpha",
    at: 3,
    summary: "",
  });
}

export function setFinal(d: Deps, text: string): void {
  const lane = d.store.lane("alpha");
  if (lane === undefined) throw new Error("no alpha lane");
  d.store.saveLane({ ...lane, final: { text, evidence: ["https://example.test/alpha"], at: 2 } });
}

export function laneGh(
  w: World,
  opts: {
    readonly existing?: boolean;
    readonly checks?: CheckList | GhResult;
    readonly workflows?: number | GhResult;
    readonly runs?: Runs;
    readonly head?: string;
    readonly stale?: "at-head" | "older";
    readonly base?: string;
    readonly headRepo?: string;
    readonly cross?: boolean;
    readonly prHead?: string;
  } = {},
): void {
  w.gh = (argv) => {
    if (argv[0] === "pr" && argv[1] === "list") {
      const state = argv[argv.indexOf("--state") + 1];
      if (state === "open" && opts.existing === true) {
        const headRepo = opts.headRepo ?? repoName;
        return {
          code: 0,
          stdout: JSON.stringify([
            {
              number: 7,
              url,
              state: "OPEN",
              headRefOid: opts.prHead ?? tipA,
              baseRefName: opts.base ?? "main",
              headRepository: { nameWithOwner: headRepo },
              headRepositoryOwner: { login: headRepo.split("/")[0] ?? "" },
              isCrossRepository: opts.cross ?? false,
            },
          ]),
        };
      }
      if (state === "all" && opts.stale !== undefined)
        return {
          code: 0,
          stdout: JSON.stringify([
            {
              number: 3,
              url: "https://github.com/asdfqwerzxcc/dori-design-system/pull/3",
              state: "MERGED",
              headRefOid: opts.stale === "at-head" ? tipA : base,
            },
          ]),
        };
      return { code: 0, stdout: "[]" };
    }
    if (argv[0] === "pr" && argv[1] === "create") return { code: 0, stdout: `${url}\n` };
    if (argv[0] === "pr" && argv[1] === "edit") return { code: 0, stdout: "" };
    if (argv[0] === "api" && argv[1]?.endsWith("/actions/workflows")) {
      const workflows = opts.workflows ?? 1;
      return typeof workflows === "number" ? { code: 0, stdout: `${workflows}\n` } : workflows;
    }
    if (argv[0] === "api" && argv[1]?.includes("/actions/runs?")) {
      const query = new URLSearchParams(argv[1].split("?")[1] ?? "");
      const sha = query.get("head_sha");
      if (sha !== (opts.head ?? tipA) || query.get("event") !== "pull_request")
        return { code: 1, stdout: "", stderr: `unexpected runs query: ${argv[1]}` };
      const runs = opts.runs ?? { status: "completed", conclusion: "success" };
      if (runs === "fail") return { code: 1, stdout: "", stderr: "HTTP 403: Resource not accessible by integration" };
      const list =
        runs === "none" ? [] : [{ id: 1, workflow_id: 10, name: "ci", head_sha: sha, event: "pull_request", ...runs }];
      return { code: 0, stdout: JSON.stringify({ total_count: list.length, workflow_runs: list }) };
    }
    if (argv[0] === "pr" && argv[1] === "checks") {
      const checks = opts.checks ?? GREEN;
      if (isCheckList(checks)) return { code: 0, stdout: JSON.stringify(checks) };
      return checks;
    }
    if (argv[0] === "pr" && argv[1] === "merge") return { code: 0, stdout: "" };
    return { code: 1, stdout: `unhandled gh ${argv.join(" ")}` };
  };
}
