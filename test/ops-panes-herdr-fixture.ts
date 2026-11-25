import type { Exec, ExecResult } from "../src/runtime/exec.ts";
import type { ProcNode } from "../src/process-tree.ts";
import type { PaneUnit } from "../src/supervisors/panes.ts";
import { HerdrPanes } from "../src/supervisors/panes-herdr.ts";

type Row = Record<string, unknown>;
const ok = (result: unknown): ExecResult => ({ code: 0, stdout: JSON.stringify({ result }), stderr: "" });

export type HerdrWorld = {
  panes: Row[];
  workspaces: Row[];
  calls: string[][];
  shells: Map<string, number>;
  foreground: Map<string, Row[]>;
  tree: ProcNode[] | undefined;
  next: number;
};

export const herdrWorld = (): HerdrWorld => ({
  panes: [],
  workspaces: [],
  calls: [],
  shells: new Map(),
  foreground: new Map(),
  tree: [],
  next: 1,
});

function herdrExec(w: HerdrWorld): Exec {
  return async (cmd, argv) => {
    if (cmd !== "herdr") throw new Error(`unexpected command ${cmd}`);
    w.calls.push([...argv]);
    const [verb, sub] = argv;
    if (verb === "workspace" && sub === "list") return ok({ workspaces: w.workspaces });
    if (verb === "workspace" && sub === "create") {
      const pane = { pane_id: "w1:p1", workspace_id: "w1", tab_id: "w1:t1", label: "1" };
      w.workspaces.push({ workspace_id: "w1", label: "dori-ops" });
      w.panes.push(pane);
      w.shells.set("w1:p1", 101);
      return ok({ root_pane: pane });
    }
    if (verb === "tab" && sub === "create") {
      const n = ++w.next;
      const label = argv[argv.indexOf("--label") + 1] ?? "";
      const pane = { pane_id: `w1:p${n}`, workspace_id: "w1", tab_id: `w1:t${n}`, label };
      w.panes.push(pane);
      w.shells.set(`w1:p${n}`, 100 + n);
      return ok({ root_pane: pane });
    }
    if (verb === "pane" && sub === "process-info") {
      const paneId = argv[argv.indexOf("--pane") + 1] ?? "";
      const shell = w.shells.get(paneId);
      const foreground = w.foreground.get(paneId);
      return shell === undefined
        ? { code: 1, stdout: "", stderr: "pane not found" }
        : ok({
            process_info: {
              pane_id: paneId,
              shell_pid: shell,
              ...(foreground === undefined ? {} : { foreground_processes: foreground }),
            },
          });
    }
    if (verb === "pane" && sub === "list") return ok({ panes: w.panes });
    if (verb === "pane" && sub === "rename") {
      const pane = w.panes.find((p) => p["pane_id"] === argv[2]);
      if (pane !== undefined) pane["label"] = argv[3];
      return ok({});
    }
    if (verb === "pane" && (sub === "run" || sub === "close")) return ok({});
    if (verb === "tab" && (sub === "rename" || sub === "close")) return ok({});
    return { code: 1, stdout: "", stderr: `unexpected herdr ${argv.join(" ")}` };
  };
}

export const herdrAdapter = (w: HerdrWorld): HerdrPanes =>
  new HerdrPanes({ home: "C:/home", env: { DORI_HOME: "C:/home" }, exec: herdrExec(w), tree: async () => w.tree });

export const duty: PaneUnit = { name: "duty", command: "run duty", marker: ["cli.ts", "duty"] };
