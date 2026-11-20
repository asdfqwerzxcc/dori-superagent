import { describe, expect, test } from "bun:test";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { type SopDef, validateSop } from "../src/sop-types.ts";
import { cli } from "./board-fixture.ts";
import { setup } from "./harness-setup.ts";
import { putSop } from "./sop-fixture.ts";

const def = (nodes: SopDef["nodes"], id = "bundle"): SopDef => ({ id, title: "T", nodes });

describe("sop definitions", () => {
  test("validateSop rejects cycles, duplicate ids, unknown kinds and promptless approvals", () => {
    expect(
      validateSop(
        def([
          { id: "a", kind: "agent" },
          { id: "b", kind: "script", needs: ["a"] },
        ]),
        "bundle",
      ),
    ).toEqual([]);
    expect(
      validateSop(
        def([
          { id: "a", kind: "agent", needs: ["b"] },
          { id: "b", kind: "script", needs: ["a"] },
        ]),
        "bundle",
      ).join("\n"),
    ).toContain("needs cycle: a -> b -> a");
    expect(
      validateSop(
        def([
          { id: "a", kind: "agent" },
          { id: "a", kind: "script" },
        ]),
        "bundle",
      ).join("\n"),
    ).toContain("duplicate node id a");
    expect(
      validateSop({ id: "bundle", title: "T", nodes: [{ id: "a", kind: "manual" }] }, "bundle").join("\n"),
    ).toContain("kind must be one of");
    expect(validateSop(def([{ id: "a", kind: "approval" }]), "bundle").join("\n")).toContain("approval needs a prompt");
    expect(validateSop(def([{ id: "a", kind: "script", needs: ["nope"] }]), "bundle").join("\n")).toContain(
      "needs unknown node nope",
    );
    expect(validateSop({ ...def([{ id: "a", kind: "agent" }]), id: "other" }, "bundle").join("\n")).toContain(
      "does not match file bundle.json",
    );
  });

  test("new writes the bundle template and refuses a duplicate id", async () => {
    const { d } = setup();
    const made = await cli(d, ["sop", "new", "bundle", "--title", "Bundle flow"]);
    expect(made.code).toBe(0);
    expect(made.out).toBe("CREATED bundle nodes=3");
    const written = JSON.parse(readFileSync(join(d.store.root, "sops", "bundle.json"), "utf8")) as SopDef;
    expect(written.nodes.map((node) => `${node.id}:${node.kind}`)).toEqual([
      "implement:agent",
      "approve:approval",
      "verify:script",
    ]);
    expect(written.nodes[1]).toMatchObject({
      needs: ["implement"],
      prompt: "Review the bundle: approve, reject with a reason, or skip with a reason.",
    });
    await expect(cli(d, ["sop", "new", "bundle", "--title", "Again"])).rejects.toThrow("already exists");
  });

  test("new --from clones an existing SOP under a new id", async () => {
    const { d } = setup();
    putSop(d, { id: "base", title: "Base", nodes: [{ id: "one", kind: "script", script: "echo 1" }] });
    const out = await cli(d, ["sop", "new", "copy", "--title", "Copy", "--from", "base"]);
    expect(out.out).toBe("CREATED copy nodes=1");
    const copy = JSON.parse(readFileSync(join(d.store.root, "sops", "copy.json"), "utf8")) as SopDef;
    expect(copy.id).toBe("copy");
    expect(copy.title).toBe("Copy");
    expect(copy.nodes).toHaveLength(1);
    expect(copy.nodes[0]?.script).toBe("echo 1");
  });

  test("list, show and validate report files, and invalid definitions are listed", async () => {
    expect((await cli(setup().d, ["sop", "list"])).out).toBe("NO_SOPS");
    const { d } = setup();
    await cli(d, ["sop", "new", "bundle", "--title", "Bundle flow"]);
    expect((await cli(d, ["sop", "list"])).out).toBe("SOP bundle nodes=3 Bundle flow");
    const shown = JSON.parse((await cli(d, ["sop", "show", "bundle"])).out) as SopDef;
    expect(shown).toMatchObject({ id: "bundle", title: "Bundle flow" });
    expect((await cli(d, ["sop", "validate", "bundle"])).out).toBe("VALID bundle nodes=3");
    writeFileSync(join(d.store.root, "sops", "broken.json"), "{");
    expect((await cli(d, ["sop", "list"])).out).toContain("INVALID broken");
    await expect(cli(d, ["sop", "validate", "broken"])).rejects.toThrow("not valid JSON");
    await expect(cli(d, ["sop", "show", "missing"])).rejects.toThrow("no SOP missing");
  });
});
