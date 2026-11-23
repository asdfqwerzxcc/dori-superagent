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
    readonly checks?: readonly { readonly name: string; readonly bucket: string }[];
    readonly stale?: "at-head" | "older";
  } = {},
): void {
  w.gh = (argv) => {
    if (argv[0] === "pr" && argv[1] === "list") {
      const state = argv[argv.indexOf("--state") + 1];
      if (state === "open" && opts.existing === true)
        return { code: 0, stdout: JSON.stringify([{ number: 7, url, state: "OPEN", headRefOid: tipA }]) };
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
    if (argv[0] === "pr" && argv[1] === "checks") return { code: 0, stdout: JSON.stringify(opts.checks ?? GREEN) };
    if (argv[0] === "pr" && argv[1] === "merge") return { code: 0, stdout: "" };
    return { code: 1, stdout: `unhandled gh ${argv.join(" ")}` };
  };
}
