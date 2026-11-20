import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { addMembers, openBundle } from "../src/bundles.ts";
import { startLane } from "../src/lanes.ts";
import { fakeGit, type Repo } from "./fake-git.ts";
import { base, diff, receipt, tipA, tipB } from "./bundle-setup.ts";
import { setup } from "./harness-setup.ts";

describe("bundle add gate", () => {
  test("refuses no receipt, BLOCK and a stale sha; a CLEAR receipt at the head is recorded", async () => {
    const { w, d } = setup();
    const repo: Repo = { head: base, mergeBase: base, diff, refs: { "lane/alpha": base } };
    fakeGit(w, repo);
    await startLane(d, "alpha", join(d.store.root, "brief.md"), { group: "w1" });
    openBundle(d, "b1", { title: "Fix login", repo: "acme/fork", issue: 12 });

    await expect(addMembers(d, "b1", ["alpha"])).rejects.toThrow("no receipt");
    expect(d.store.bundle("b1")!.members).toHaveLength(0);

    repo.refs = { "lane/alpha": tipA };
    receipt(d, "alpha", tipA, "BLOCK");
    await expect(addMembers(d, "b1", ["alpha"])).rejects.toThrow("BLOCK");
    expect(d.store.bundle("b1")!.members).toHaveLength(0);

    repo.refs = { "lane/alpha": tipB };
    await expect(addMembers(d, "b1", ["alpha"])).rejects.toThrow("stale sha");
    expect(d.store.bundle("b1")!.members).toHaveLength(0);

    receipt(d, "alpha", tipB, "CLEAR", "hook: lane reviewer");
    expect((await addMembers(d, "b1", ["alpha"])).members).toEqual([
      { lane: "alpha", sha: tipB, verdict: "CLEAR", reviewer: "hook: lane reviewer" },
    ]);
    expect(JSON.parse(readFileSync(join(d.store.root, "state", "bundles", "b1.json"), "utf8"))).toEqual({
      id: "b1",
      title: "Fix login",
      issue: 12,
      repo: "acme/fork",
      members: [{ lane: "alpha", sha: tipB, verdict: "CLEAR", reviewer: "hook: lane reviewer" }],
      branch: "bundle/b1",
      pr: null,
      status: "open",
    });
  });

  test("a bundle id is one record; opening it twice is refused", () => {
    const { d } = setup();
    openBundle(d, "b1", { title: "One", repo: "acme/fork" });
    expect(() => openBundle(d, "b1", { title: "Two", repo: "acme/fork" })).toThrow("already exists");
  });
});
