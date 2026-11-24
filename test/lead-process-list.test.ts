import { describe, expect, test } from "bun:test";
import type { Exec } from "../src/runtime/exec.ts";
import { listAllProcesses, parseCim, parsePs } from "../src/lead-process-list.ts";

describe("the lead-only process list", () => {
  test("a failed query is unavailable and an empty one is empty", async () => {
    const failing: Exec = async () => ({ code: 1, stdout: "", stderr: "no powershell" });
    expect(await listAllProcesses(failing)).toBeUndefined();
    const empty: Exec = async () => ({ code: 0, stdout: "[]", stderr: "" });
    expect(await listAllProcesses(empty)).toEqual([]);
  });

  test("both output shapes keep the pid, parent and command line", () => {
    expect(parseCim(JSON.stringify({ ProcessId: 7, ParentProcessId: 3, CommandLine: "bun x" }))).toEqual([
      { pid: 7, command: "bun x", parent: 3 },
    ]);
    expect(
      parseCim(
        JSON.stringify([
          { ProcessId: 7, CommandLine: "a" },
          { ProcessId: 8, CommandLine: "b" },
        ]),
      ),
    ).toHaveLength(2);
    expect(parseCim("not json")).toEqual([]);
    expect(parsePs("  10  5 bun a.ts\n  11 bun b.ts\n")).toEqual([
      { pid: 10, command: "bun a.ts", parent: 5 },
      { pid: 11, command: "bun b.ts" },
    ]);
  });
});
