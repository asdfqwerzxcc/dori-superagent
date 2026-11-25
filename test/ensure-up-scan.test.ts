import { describe, expect, test } from "bun:test";
import { homedir } from "node:os";
import { join } from "node:path";
import { pluginRunEntry } from "../src/plugins/plugin.ts";
import { isEnsureUpCommand, parseWindowsArgv, scanEnsureUpProcesses } from "../src/ensure-up-scan.ts";
import type { Exec } from "../src/runtime/exec.ts";

const HOME = "/home/u/.dori";
const ENTRY = "/home/u/.dori/src/src/plugins/run.ts";

const fakeExec =
  (list: string, envs: Readonly<Record<string, string>>): Exec =>
  async (cmd, argv) => {
    if (cmd !== "ps") return { code: 1, stdout: "", stderr: "not ps" };
    if (argv.includes("-A")) return { code: 0, stdout: list, stderr: "" };
    const pid = argv[2] ?? "";
    return { code: 0, stdout: envs[pid] ?? "", stderr: "" };
  };

const windowsExec =
  (rows: unknown): Exec =>
  async (cmd) => {
    if (cmd !== "powershell") return { code: 1, stdout: "", stderr: "not powershell" };
    return { code: 0, stdout: JSON.stringify(rows), stderr: "" };
  };

describe("the ensure-up process scan", () => {
  test("only the exact three-token command in this home is returned", async () => {
    const list = [
      ` 101 bun ${ENTRY} ensure-up`,
      ` 102 bun ${ENTRY} ensure-up`,
      ` 103 bun ${ENTRY} update-check`,
      ` 104 bun /elsewhere/src/plugins/run.ts ensure-up`,
      ` 105 bun ${ENTRY}`,
      ` 106 sh "${ENTRY} ensure-up"`,
      ` 107 bun -e "x" ${ENTRY} ensure-up`,
      ` ${process.pid} bun ${ENTRY} ensure-up`,
    ].join("\n");
    const exec = fakeExec(list, {
      "101": `bun ${ENTRY} ensure-up DORI_HOME=${HOME}`,
      "102": `bun ${ENTRY} ensure-up DORI_HOME=/home/u/other`,
      "103": `bun ${ENTRY} update-check DORI_HOME=${HOME}`,
      "104": `bun /elsewhere/src/plugins/run.ts ensure-up DORI_HOME=${HOME}`,
      "105": `bun ${ENTRY} DORI_HOME=${HOME}`,
      "106": `sh "${ENTRY} ensure-up" DORI_HOME=${HOME}`,
      "107": `bun -e "x" ${ENTRY} ensure-up DORI_HOME=${HOME}`,
    });
    expect(
      await scanEnsureUpProcesses({ home: HOME, entry: ENTRY, exec, platform: "linux", started: () => 111 }),
    ).toEqual([{ pid: 101, startedAt: 111 }]);
  });

  test("a command that merely contains the entry and name as other arguments is a decoy", () => {
    expect(isEnsureUpCommand(["/usr/bin/bun", ENTRY, "ensure-up"], ENTRY)).toBe(true);
    expect(isEnsureUpCommand(["bun", "-e", `${ENTRY} ensure-up`], ENTRY)).toBe(false);
    expect(isEnsureUpCommand(["bun", ENTRY, "ensure-up", "--extra"], ENTRY)).toBe(false);
    expect(isEnsureUpCommand(["sh", "-c", `${ENTRY} ensure-up`], ENTRY)).toBe(false);
    expect(isEnsureUpCommand(["bun", "/other/run.ts", "ensure-up"], ENTRY)).toBe(false);
  });

  test("the Windows scan reads Win32_Process command lines and applies the same exact argv", async () => {
    const rows = [
      { ProcessId: 201, CommandLine: `"C:\\bun.exe" "${ENTRY}" ensure-up` },
      { ProcessId: 202, CommandLine: `"C:\\bun.exe" -e "console.log('${ENTRY} ensure-up')"` },
      { ProcessId: 203, CommandLine: `"C:\\bun.exe" "${ENTRY}" update-check` },
      { ProcessId: 204, CommandLine: null },
    ];
    expect(
      await scanEnsureUpProcesses({
        entry: ENTRY,
        exec: windowsExec(rows),
        platform: "win32",
        started: () => 222,
      }),
    ).toEqual([{ pid: 201, startedAt: 222 }]);
  });

  test("Windows command lines with quoted paths survive tokenization", () => {
    expect(parseWindowsArgv(`"C:\\With Space\\bun.exe" "C:\\With Space\\run.ts" ensure-up`)).toEqual([
      "C:\\With Space\\bun.exe",
      "C:\\With Space\\run.ts",
      "ensure-up",
    ]);
  });

  test("defaults use this process home and checkout, so a caller needs no options", async () => {
    const home = process.env["DORI_HOME"] ?? join(homedir(), ".dori");
    const entry = pluginRunEntry();
    const list = ` 301 bun ${entry} ensure-up`;
    const exec = fakeExec(list, { "301": `bun ${entry} ensure-up DORI_HOME=${home}` });
    expect(await scanEnsureUpProcesses({ exec, platform: "linux", started: () => 333 })).toEqual([
      { pid: 301, startedAt: 333 },
    ]);
  });

  test("an unreadable process list or a candidate without its environment is doubt, never a crash", async () => {
    const failed: Exec = async () => ({ code: 1, stdout: "", stderr: "ps failed" });
    expect(await scanEnsureUpProcesses({ home: HOME, entry: ENTRY, exec: failed, platform: "linux" })).toEqual([]);
    const noEnv = fakeExec(` 401 bun ${ENTRY} ensure-up`, {});
    expect(await scanEnsureUpProcesses({ home: HOME, entry: ENTRY, exec: noEnv, platform: "darwin" })).toEqual([]);
  });
});
