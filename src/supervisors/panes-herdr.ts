import type { Exec } from "../runtime/exec.ts";
import { ToolError } from "../runtime/exec.ts";
import { HerdrCli } from "../runtime/herdr/exec.ts";
import type { SessionRef } from "../runtime/types.ts";
import { bunChildren, listProcessTree, type ProcNode } from "../process-tree.ts";
import type { PaneAdapter, PaneProbe } from "./panes.ts";

const OPS_LABEL = "dori-ops";

type Row = Record<string, unknown>;
const asRow = (value: unknown): Row | undefined =>
  typeof value === "object" && value !== null && !Array.isArray(value) ? (value as Row) : undefined;
const str = (value: unknown): string => (typeof value === "string" ? value : "");
const rows = (value: unknown): Row[] =>
  Array.isArray(value) ? value.filter((r): r is Row => typeof r === "object" && r !== null) : [];
const titled = (pane: Row, name: string): boolean => str(pane["label"]) === name || str(pane["title"]) === name;

const toRef = (pane: Row): SessionRef => ({
  runtime: "herdr",
  id: str(pane["pane_id"]),
  ...(str(pane["workspace_id"]) === "" ? {} : { group: str(pane["workspace_id"]) }),
  ...(str(pane["tab_id"]) === "" ? {} : { container: str(pane["tab_id"]) }),
});

export type HerdrPanesOptions = {
  readonly home: string;
  readonly env: Readonly<Record<string, string>>;
  readonly exec?: Exec;
  readonly session?: string;
  /** Test seam: the process tree the probe reads; production takes the kernel snapshot (or ps) without a console app. */
  readonly tree?: () => Promise<readonly ProcNode[] | undefined>;
};

/**
 * herdr's half of pane placement: one workspace labelled `dori-ops`, one tab and pane per unit. The workspace's first
 * shell becomes the first unit's pane; every later unit gets a tab created without focus. A unit is the direct bun child
 * of its pane's shell, so the probe reads the shell pid from herdr and the parent links from the OS process tree, never
 * a command-line query.
 */
export class HerdrPanes implements PaneAdapter {
  readonly kind = "herdr" as const;
  private readonly cli: HerdrCli;
  private readonly tree: () => Promise<readonly ProcNode[] | undefined>;
  private workspace: string | undefined;
  private spare: Row | undefined;

  constructor(private readonly options: HerdrPanesOptions) {
    this.cli = new HerdrCli(options.exec, options.session);
    this.tree = options.tree ?? (() => listProcessTree());
  }

  async ready(): Promise<void> {
    if (this.workspace !== undefined) return;
    const listed = rows((await this.cli.call(["workspace", "list"]))["workspaces"]);
    const found = listed.find((w) => str(w["label"]) === OPS_LABEL);
    if (found !== undefined) {
      this.workspace = str(found["workspace_id"]);
      return;
    }
    const created = await this.cli.call([
      "workspace",
      "create",
      "--label",
      OPS_LABEL,
      "--cwd",
      this.options.home,
      ...this.envFlags(),
      "--no-focus",
    ]);
    const root = asRow(created["root_pane"]);
    const id = str(root?.["workspace_id"]);
    if (id === "") throw new Error("herdr did not return the ops workspace id");
    this.workspace = id;
    this.spare = root;
  }

  async panes(name: string): Promise<readonly SessionRef[]> {
    if (this.workspace === undefined) return [];
    const listed = rows((await this.cli.call(["pane", "list"]))["panes"]);
    return listed.filter((p) => str(p["workspace_id"]) === this.workspace && titled(p, name)).map(toRef);
  }

  async open(name: string): Promise<SessionRef> {
    if (this.workspace === undefined) throw new Error("the ops workspace is not resolved");
    let pane = this.spare;
    this.spare = undefined;
    if (pane === undefined) {
      const created = await this.cli.call([
        "tab",
        "create",
        "--label",
        name,
        "--cwd",
        this.options.home,
        "--workspace",
        this.workspace,
        ...this.envFlags(),
        "--no-focus",
      ]);
      pane = asRow(created["root_pane"]);
    }
    if (pane === undefined) throw new Error("herdr did not return a pane for the unit");
    const tab = str(pane["tab_id"]);
    // The tab label is cosmetic; the pane label below is the title the duplicate check matches.
    if (tab !== "") await this.cli.call(["tab", "rename", tab, name]).catch(() => undefined);
    await this.cli.call(["pane", "rename", str(pane["pane_id"]), name]);
    return toRef(pane);
  }

  async start(ref: SessionRef, command: string): Promise<void> {
    await this.cli.call(["pane", "run", ref.id, command]);
  }

  async pid(ref: SessionRef, _marker: readonly string[]): Promise<PaneProbe> {
    const shell = await this.paneShell(ref.id);
    if (shell === undefined) return { kind: "unknown", why: `pane ${ref.id} process-info is unreadable` };
    const nodes = await this.tree();
    if (nodes === undefined) return { kind: "unknown", why: "process tree unavailable" };
    const children = bunChildren(nodes, shell);
    const [only] = children;
    if (children.length === 1 && only !== undefined) return { kind: "running", pid: only };
    if (children.length === 0) return { kind: "stopped" };
    return { kind: "unknown", why: `${children.length} bun processes under pane ${ref.id}` };
  }

  async close(ref: SessionRef): Promise<void> {
    try {
      if (ref.container !== undefined) await this.cli.call(["tab", "close", ref.container]);
      else await this.cli.call(["pane", "close", ref.id]);
    } catch (e) {
      if (e instanceof ToolError && /not.?found/i.test(e.message)) return;
      throw e;
    }
  }

  private async paneShell(paneId: string): Promise<number | undefined> {
    try {
      const info = asRow((await this.cli.call(["pane", "process-info", "--pane", paneId]))["process_info"]);
      const shell = info?.["shell_pid"];
      return typeof shell === "number" && Number.isInteger(shell) && shell > 0 ? shell : undefined;
    } catch {
      return undefined;
    }
  }

  private envFlags(): string[] {
    return Object.entries(this.options.env).flatMap(([k, v]) => ["--env", `${k}=${v}`]);
  }
}
