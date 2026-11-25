import { expect, test } from "bun:test";
import { spawnExec } from "../src/runtime/exec.ts";

// Real provider calls are opt-in: CI has no credentials and a review costs a model turn.
const enabled = process.env["DORI_OMO_STDIN_CONTRACT"] === "1";
const contract = enabled ? test : test.skip;

contract(
  "the real omo CLI reads its prompt from stdin after '-'",
  async () => {
    const r = await spawnExec("omo", ["-p", "--no-session", "-nt", "-"], {
      stdin: "Answer with exactly: VERDICT: CLEAR",
    });
    expect(r.code).toBe(0);
    expect(r.stdout).toContain("VERDICT: CLEAR");
  },
  180_000,
);
