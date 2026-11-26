import { describe, expect, test } from "bun:test";
import { join } from "node:path";
import { addMembers, openBundle } from "../src/bundles.ts";
import { closeBundle } from "../src/bundle-close.ts";
import { main } from "../src/cli.ts";
import { mergeGate } from "../src/gate.ts";
import type { Deps } from "../src/harness.ts";
import { startLane } from "../src/lanes.ts";
import { base, diff, receipt, tipA, tipB, tipC, url } from "./bundle-setup.ts";
import { fakeGit, type Repo } from "./fake-git.ts";
import { setup } from "./harness-setup.ts";
import { captureIo } from "./inbox-setup.ts";

describe("merge --bundle", () => {
  const head = "e".repeat(40);

  type GhResult = { readonly code: number; readonly stdout: string; readonly stderr?: string };
  const noChecks: GhResult = { code: 1, stdout: "", stderr: "no checks reported on the 'main' branch" };
  type Runs = { readonly status: string; readonly conclusion: string | null } | "fail" | "none";

  function gh(
    w: ReturnType<typeof setup>["w"],
    checks: unknown[] | GhResult = [{ name: "test", bucket: "pass" }],
    workflows = 1,
    runs: Runs = { status: "completed", conclusion: "success" },
  ) {
    w.gh = (argv) => {
      if (argv[1] === "view") return { code: 0, stdout: JSON.stringify({ headRefOid: head }) };
      if (argv[1] === "checks") return Array.isArray(checks) ? { code: 0, stdout: JSON.stringify(checks) } : checks;
      if (argv[0] === "api" && argv[1]?.endsWith("/actions/workflows")) return { code: 0, stdout: `${workflows}\n` };
      if (argv[0] === "api" && argv[1]?.includes("/actions/runs?")) {
        const query = new URLSearchParams(argv[1].split("?")[1] ?? "");
        if (query.get("head_sha") !== head || query.get("event") !== "pull_request")
          return { code: 1, stdout: "", stderr: `unexpected runs query: ${argv[1]}` };
        if (runs === "fail") return { code: 1, stdout: "", stderr: "HTTP 403: Resource not accessible by integration" };
        const list =
          runs === "none" || workflows === 0
            ? []
            : [{ id: 1, workflow_id: 10, name: "ci", head_sha: head, event: "pull_request", ...runs }];
        return { code: 0, stdout: JSON.stringify({ total_count: list.length, workflow_runs: list }) };
      }
      if (argv[1] === "merge") return { code: 0, stdout: "" };
      return { code: 1, stdout: "" };
    };
  }

  async function membersBundle() {
    const { w, d } = setup();
    const repo: Repo = { head: base, mergeBase: base, diff };
    fakeGit(w, repo);
    for (const [key, sha] of [
      ["alpha", tipA],
      ["beta", tipB],
    ] as const) {
      await startLane(d, key, join(d.store.root, "brief.md"), { group: "w1" });
      repo.refs = { ...(repo.refs ?? {}), [`lane/${key}`]: sha };
      receipt(d, key, sha);
    }
    openBundle(d, "b1", { title: "Bundle", repo: "o/r" });
    await addMembers(d, "b1", ["alpha", "beta"]);
    return { w, d, repo };
  }

  test("accepts every member CLEAR + green checks when the PR head has no receipt", async () => {
    const { w, d } = await membersBundle();
    gh(w);
    expect(await mergeGate(d, "o/r#7", { bundle: "b1" })).toBe(`MERGED o/r#7 head=${head}`);
  });

  test("accepts a CLEAR receipt at the PR head even when a member moved", async () => {
    const { w, d, repo } = await membersBundle();
    gh(w);
    repo.refs = { ...(repo.refs ?? {}), "lane/beta": tipC };
    d.store.saveReceipt({ pr: "o/r#7", sha: head, verdict: "CLEAR", model: "m", at: 1, summary: "" });
    expect(await mergeGate(d, "o/r#7", { bundle: "b1" })).toBe(`MERGED o/r#7 head=${head}`);
  });

  test("refuses when a member is not CLEAR; zero workflows with no checks still merges", async () => {
    const first = await membersBundle();
    gh(first.w);
    first.repo.refs = { ...(first.repo.refs ?? {}), "lane/beta": tipC };
    await expect(mergeGate(first.d, "o/r#7", { bundle: "b1" })).rejects.toThrow("not all CLEAR");

    const second = await membersBundle();
    gh(second.w, noChecks, 0);
    expect(await mergeGate(second.d, "o/r#7", { bundle: "b1" })).toBe(`MERGED o/r#7 head=${head}`);
  });

  test("refuses when workflows exist but no checks are reported", async () => {
    const { w, d } = await membersBundle();
    gh(w, noChecks, 1);
    await expect(mergeGate(d, "o/r#7", { bundle: "b1" })).rejects.toThrow("1 workflow");
    expect(w.calls.some((call) => call.cmd === "gh" && call.argv[1] === "merge")).toBe(false);
  });

  test("refuses a bundle merge on every pull_request workflow answer that is not green", async () => {
    for (const [runs, why] of [
      [{ status: "queued", conclusion: null }, "ci=queued"],
      [{ status: "completed", conclusion: "action_required" }, "ci=action_required"],
      ["fail", "could not be read: HTTP 403"],
    ] as const) {
      const { w, d } = await membersBundle();
      gh(w, [{ name: "test", bucket: "pass" }], 1, runs);
      await expect(mergeGate(d, "o/r#7", { bundle: "b1" })).rejects.toThrow(why);
      expect(w.calls.some((call) => call.cmd === "gh" && call.argv[1] === "merge")).toBe(false);
    }
  });
});

describe("bundle close", () => {
  function landedBundle(d: Deps) {
    const bundle = openBundle(d, "b1", { title: "Bundle", repo: "acme/fork", issue: 12 });
    bundle.members = [
      { lane: "alpha", sha: tipA, verdict: "CLEAR", reviewer: "reviewer-alpha" },
      { lane: "beta", sha: tipB, verdict: "CLEAR", reviewer: "reviewer-beta" },
    ];
    bundle.pr = { number: 42, url };
    bundle.status = "landed";
    d.store.saveBundle(bundle);
    return bundle;
  }

  function gh(w: ReturnType<typeof setup>["w"], state: string, body: string) {
    w.gh = (argv) => {
      if (argv[1] === "view") return { code: 0, stdout: JSON.stringify({ state, body, url }) };
      if (argv[1] === "comment") return { code: 0, stdout: "" };
      return { code: 1, stdout: "" };
    };
  }

  test("after MERGED it comments Refs for every member and closes the record", async () => {
    const { w, d } = setup();
    landedBundle(d);
    gh(w, "MERGED", "## 왜\n\n<!-- 예: Closes #99 -->\nCloses #12\n");
    expect(await closeBundle(d, "b1", "nightly ok")).toBe("CLOSED b1 pr=#42 comment=2 refs");
    const comment = w.calls.find((c) => c.cmd === "gh" && c.argv[1] === "comment");
    const body = comment?.argv[comment.argv.indexOf("--body") + 1] ?? "";
    expect(body).toContain(`Refs lane/alpha@${tipA.slice(0, 12)}`);
    expect(body).toContain(`Refs lane/beta@${tipB.slice(0, 12)}`);
    expect(body).toContain("nightly ok");
    expect(d.store.bundle("b1")!.status).toBe("closed");
  });

  test("refuses a PR that closes any other issue", async () => {
    const { w, d } = setup();
    landedBundle(d);
    gh(w, "MERGED", "Closes #12\nCloses #99\n");
    await expect(closeBundle(d, "b1")).rejects.toThrow("not the representative issue #12");
    expect(d.store.bundle("b1")!.status).toBe("landed");
  });

  test("refuses before the PR is merged", async () => {
    const { w, d } = setup();
    landedBundle(d);
    gh(w, "OPEN", "Closes #12\n");
    await expect(closeBundle(d, "b1")).rejects.toThrow("not MERGED");
  });
});

describe("bundle cli", () => {
  test("open, show --json and list --json use the state/bundles record", async () => {
    const { d } = setup();
    const opened = await captureIo(() =>
      main(["bundle", "open", "cli-b", "--title", "CLI bundle", "--repo", "o/r"], d),
    );
    expect(opened).toEqual({ code: 0, out: "BUNDLE_OPEN cli-b branch=bundle/cli-b repo=o/r" });
    const shown = await captureIo(() => main(["bundle", "show", "cli-b", "--json"], d));
    expect(JSON.parse(shown.out)).toMatchObject({ id: "cli-b", status: "open", branch: "bundle/cli-b", members: [] });
    const listed = await captureIo(() => main(["bundle", "list", "--json"], d));
    expect((JSON.parse(listed.out) as unknown[]).length).toBe(1);
    await expect(main(["bundle", "land", "cli-b"], d)).rejects.toThrow("has no members");
    await expect(main(["bundle", "nonsense"], d)).rejects.toThrow("unknown bundle command");
  });
});
