import { describe, expect, test } from "bun:test";
import { type SopDef, validateSop } from "../src/sop-types.ts";
import { cli } from "./board-fixture.ts";
import { setup } from "./harness-setup.ts";
import { putSop, runIdOf } from "./sop-fixture.ts";

const def = (nodes: SopDef["nodes"]): SopDef => ({ id: "gate", title: "Gate", nodes });

const bound = (bundle: string): SopDef =>
  def([
    { id: "work", kind: "agent" },
    { id: "approve", kind: "approval", prompt: "Approve?", bundle, needs: ["work"] },
    { id: "ship", kind: "script", script: "echo ship", needs: ["approve"] },
  ]);

describe("one human gate per SOP", () => {
  test("an approval without a bundle is rejected, and a malformed bundle id is named", () => {
    const missing = validateSop(def([{ id: "approve", kind: "approval", prompt: "Approve?" }]), "gate").join("\n");
    expect(missing).toContain("approval needs a bundle");
    const malformed = validateSop(
      def([{ id: "approve", kind: "approval", prompt: "Approve?", bundle: "two words" }]),
      "gate",
    ).join("\n");
    expect(malformed).toContain("bundle must match");
  });

  test("a second approval is rejected with both node ids and the one-gate reason", () => {
    const errors = validateSop(
      def([
        { id: "first", kind: "approval", prompt: "First?", bundle: "b-1" },
        { id: "second", kind: "approval", prompt: "Second?", bundle: "b-1" },
      ]),
      "gate",
    ).join("\n");
    expect(errors).toContain("first, second");
    expect(errors).toContain("at most one human gate");
  });

  test("a definition with one bound approval validates and starts a run", async () => {
    const { d } = setup();
    const valid = bound("b-1");
    expect(validateSop(valid, "gate")).toEqual([]);
    putSop(d, valid);
    expect((await cli(d, ["sop", "validate", "gate"])).out).toBe("VALID gate nodes=3");
    const out = await cli(d, ["sop", "run", "gate", "--bundle", "b-1"]);
    expect(out.code).toBe(0);
    expect(out.out).toContain("RUN ");
  });

  test("gate show prints the gate's bundle and that bundle's repo and PR, then posts it", async () => {
    const { w, d } = setup();
    putSop(d, bound("b-1"));
    const runId = runIdOf((await cli(d, ["sop", "run", "gate", "--bundle", "b-1"])).out);
    d.store.saveBundle({
      id: "b-1",
      title: "One",
      issue: null,
      repo: "acme/fork",
      members: [],
      branch: "bundle/b-1",
      pr: { number: 7, url: "https://github.com/acme/fork/pull/7" },
      status: "open",
    });
    const comment = "https://github.com/acme/fork/pull/7#issuecomment-1";
    let comments: { body: string; url: string }[] = [];
    w.gh = (argv) => {
      if (argv[1] === "view") return { code: 0, stdout: JSON.stringify({ comments }) };
      if (argv[1] === "comment") {
        comments = [{ body: String(argv[argv.indexOf("--body") + 1]), url: comment }];
        return { code: 0, stdout: `${comment}\n` };
      }
      if (argv[0] === "api") return { code: 0, stdout: "{}" };
      return { code: 1, stdout: "" };
    };
    const out = await cli(d, ["sop", "gate", "show", runId, "approve"]);
    expect(out.code).toBe(0);
    expect(out.out.split("\n")).toEqual([
      `GATE ${runId} sop=gate node=approve state=pending`,
      "bundle: b-1",
      "repo: acme/fork",
      "pr: #7 https://github.com/acme/fork/pull/7",
      `post: ${comment}`,
    ]);
    const again = await cli(d, ["sop", "gate", "show", runId, "approve"]);
    expect(again.out).toContain(`post: updated ${comment}`);
    expect(w.calls.filter((c) => c.cmd === "gh" && c.argv[1] === "comment")).toHaveLength(1);
    const patch = w.calls.find((c) => c.cmd === "gh" && c.argv[0] === "api")!;
    expect(patch.argv).toContain("PATCH");
    expect(patch.argv).toContain("repos/acme/fork/issues/comments/1");
  });

  test("gate show warns that the bundle is missing without failing", async () => {
    const { d } = setup();
    putSop(d, bound("ghost"));
    const runId = runIdOf((await cli(d, ["sop", "run", "gate", "--bundle", "b-1"])).out);
    const out = await cli(d, ["sop", "gate", "show", runId, "approve"]);
    expect(out.code).toBe(0);
    expect(out.out).toContain("bundle: ghost");
    expect(out.out).toContain("bundle missing");
    expect(out.out).toContain("post: skipped (bundle ghost is missing)");
  });
});
