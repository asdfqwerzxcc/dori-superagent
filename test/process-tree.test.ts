import { describe, expect, test } from "bun:test";
import { bunChildren, listProcessTree, normalizeExe, parsePsTree } from "../src/process-tree.ts";

describe("process tree", () => {
  test("ps rows keep pid, parent and executable", () => {
    expect(parsePsTree("  10  5 bun\n  11  1 omo\n")).toEqual([
      { pid: 10, parent: 5, exe: "bun" },
      { pid: 11, parent: 1, exe: "omo" },
    ]);
  });

  test("executable names normalize across directories, case and .exe", () => {
    expect(normalizeExe("C:\\bun\\bun.exe")).toBe("bun");
    expect(normalizeExe("/usr/local/bin/bun")).toBe("bun");
    expect(normalizeExe("powershell.exe")).toBe("powershell");
  });

  test("only direct bun children of the shell count", () => {
    const nodes = [
      { pid: 1, parent: 0, exe: "herdr.exe" },
      { pid: 101, parent: 1, exe: "powershell.exe" },
      { pid: 202, parent: 101, exe: "bun.exe" },
      { pid: 303, parent: 202, exe: "bun.exe" },
    ];
    expect(bunChildren(nodes, 101)).toEqual([202]);
  });

  test.skipIf(process.platform !== "win32")("the Windows snapshot reads the kernel without spawning", async () => {
    let calls = 0;
    const exec = async () => {
      calls++;
      return { code: 1, stdout: "", stderr: "must not run" };
    };
    const nodes = await listProcessTree(exec);
    expect(calls).toBe(0);
    expect(nodes?.some((node) => node.pid === process.pid)).toBe(true);
  });
});
