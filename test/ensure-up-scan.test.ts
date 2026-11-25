import { describe, expect, test } from "bun:test";
import { scanEnsureUpProcesses } from "../src/ensure-up-scan.ts";
import type { Exec } from "../src/runtime/exec.ts";

const HOME = "/home/u/.dori";
const ENTRY = "/home/u/.dori/src/src/plugins/run.ts";

const fakeExec =
  (list: string, envs: Readonly<Record<string, string>>): Exec =>
  async (cmd, argv) => {
    if (cmd !== "ps") return { code: 1, stdout: "", stderr: "not ps" };
    if (argv[0] === "-A") return { code: 0, stdout: list, stderr: "" };
    const pid = argv[2] ?? "";
    return { code: 0, stdout: envs[pid] ?? "", stderr: "" };
  };

describe("the ensure-up process scan", () => {
  test("only this home's idle ensure-up child is returned", async () => {
    const list = [
      ` 101 ${ENTRY} ensure-up`,
      ` 102 ${ENTRY} ensure-up`,
      ` 103 ${ENTRY} update-check`,
      " 104 /elsewhere/src/plugins/run.ts ensure-up",
      ` 105 ${ENTRY}`,
      ` ${process.pid} ${ENTRY} ensure-up`,
    ].join("\n");
    const exec = fakeExec(list, {
      "101": `bun ${ENTRY} ensure-up DORI_HOME=${HOME}`,
      "102": `bun ${ENTRY} ensure-up DORI_HOME=/home/u/other`,
      "103": `bun ${ENTRY} update-check DORI_HOME=${HOME}`,
      "104": `bun /elsewhere/src/plugins/run.ts ensure-up DORI_HOME=${HOME}`,
      "105": `bun ${ENTRY} DORI_HOME=${HOME}`,
    });
    expect(
      await scanEnsureUpProcesses({ home: HOME, entry: ENTRY, exec, platform: "linux", started: () => 111 }),
    ).toEqual([{ pid: 101, startedAt: 111 }]);
  });

  test("Windows has no surviving orphan child, so it never spawns a scan", async () => {
    const exec: Exec = async () => {
      throw new Error("exec must not be called on Windows");
    };
    expect(await scanEnsureUpProcesses({ home: HOME, entry: ENTRY, exec, platform: "win32" })).toEqual([]);
  });

  test("an unreadable process list or environment is doubt, never a crash", async () => {
    const failed: Exec = async () => ({ code: 1, stdout: "", stderr: "ps failed" });
    expect(await scanEnsureUpProcesses({ home: HOME, entry: ENTRY, exec: failed, platform: "linux" })).toEqual([]);
    const noEnv = fakeExec(` 101 ${ENTRY} ensure-up`, {});
    expect(await scanEnsureUpProcesses({ home: HOME, entry: ENTRY, exec: noEnv, platform: "darwin" })).toEqual([]);
  });
});
