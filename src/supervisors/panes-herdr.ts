import type { Exec } from "../runtime/exec.ts";
import { ToolError } from "../runtime/exec.ts";
import { HerdrCli } from "../runtime/herdr/exec.ts";
import type { SessionRef } from "../runtime/types.ts";
import { listProcesses, type Proc } from "../supervisor-run.ts";
import type { PaneAdapter } from "./panes.ts";

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

const normalized = (text: string): string => text.replaceAll("\\", "/");
const matches = (command: string, marker: readonly string[]): boolean => {
  const text = normalized(command);
  return marker.every((part) => text.includes(normalized(part)));
};

export type HerdrPanesOptions = {
  readonly home: string;
  readonly env: Readonly<Record<string, string>>;
  readonly exec?: Exec;
  readonly session?: string;
  readonly procs?: () => Promise<readonly Proc[]>;
};

/**
 * herdr's half of pane placement: one workspace labelled `dori-ops`, one tab and pane per unit. The workspace's first
 * shell becomes the first unit's pane; every later unit gets a tab created without focus. A process is found by its
 * command line because herdr's process-info reports only the pane's shell on Windows.
 */
export class HerdrPanes implements PaneAdapter {
  readonly kind = "herdr" as const;
  private readonly cli: HerdrCli;
  private readonly procs: () => Promise<readonly Proc[]>;
  private workspace: string | undefined;
  private spare: Row | undefined;
  private cached: { at: number; procs: readonly Proc[] } | undefined;

  constructor(private readonly options: HerdrPanesOptions) {
    this.cli = new HerdrCli(options.exec, options.session);
    this.procs = options.procs ?? (() => listProcesses(options.exec));
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

  async find(name: string): Promise<SessionRef | undefined> {
    const listed = rows((await this.cli.call(["pane", "list"]))["panes"]);
    const pane = listed.find((p) => str(p["workspace_id"]) === this.workspace && titled(p, name));
    return pane === undefined ? undefined : toRef(pane);
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

  async pid(_ref: SessionRef, marker: readonly string[]): Promise<number | undefined> {
    const procs = await this.list();
    return procs.find((p) => matches(p.command, marker))?.pid;
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

  private envFlags(): string[] {
    return Object.entries(this.options.env).flatMap(([k, v]) => ["--env", `${k}=${v}`]);
  }

  private async list(): Promise<readonly Proc[]> {
    const now = Date.now();
    if (this.cached !== undefined && now - this.cached.at < 500) return this.cached.procs;
    const procs = await this.procs();
    this.cached = { at: now, procs };
    return procs;
  }
}
