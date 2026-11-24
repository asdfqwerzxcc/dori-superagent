import type { SessionRef } from "../src/runtime/types.ts";
import { PaneUnits, type PaneAdapter, type PaneProbe, type PaneUnit } from "../src/supervisors/panes.ts";

export const pref = (id: string): SessionRef => ({ runtime: "herdr", id, group: "w1", container: `t-${id}` });

export class FakeAdapter implements PaneAdapter {
  readonly kind = "herdr" as const;
  readonly opened: string[] = [];
  readonly started: { ref: SessionRef; command: string }[] = [];
  readonly closed: SessionRef[] = [];
  readonly closeAttempts = new Map<string, number>();
  readonly panesList: { name: string; ref: SessionRef }[] = [];
  readonly probes = new Map<string, PaneProbe>();
  readonly failStart = new Set<string>();
  readonly failClose = new Set<string>();
  private nextPid = 100;
  private nextPane = 1;

  async ready(): Promise<void> {}

  async panes(name: string): Promise<readonly SessionRef[]> {
    return this.panesList.filter((p) => p.name === name).map((p) => p.ref);
  }

  async open(name: string): Promise<SessionRef> {
    const pane = pref(`p${this.nextPane++}`);
    this.panesList.push({ name, ref: pane });
    this.opened.push(name);
    this.probes.set(pane.id, { kind: "stopped" });
    return pane;
  }

  async start(pane: SessionRef, command: string): Promise<void> {
    this.started.push({ ref: pane, command });
    if (this.failStart.has(pane.id)) {
      this.probes.set(pane.id, { kind: "stopped" });
      throw new Error("pane refused the command");
    }
    this.probes.set(pane.id, { kind: "running", pid: this.nextPid++ });
  }

  async pid(pane: SessionRef): Promise<PaneProbe> {
    return this.probes.get(pane.id) ?? { kind: "stopped" };
  }

  async close(pane: SessionRef): Promise<void> {
    this.closeAttempts.set(pane.id, (this.closeAttempts.get(pane.id) ?? 0) + 1);
    if (this.failClose.has(pane.id)) throw new Error("pane close refused");
    this.closed.push(pane);
    const at = this.panesList.findIndex((p) => p.ref.id === pane.id);
    if (at >= 0) this.panesList.splice(at, 1);
    this.probes.delete(pane.id);
  }
}

export const DUTY: PaneUnit = { name: "duty", command: "'bun' 'cli.ts' 'duty'", marker: ["cli.ts", "duty"] };

export const unitsOf = (adapter: PaneAdapter, log: (line: string) => void = () => {}): PaneUnits =>
  new PaneUnits({ adapter, log, sleep: async () => {}, pidTimeoutMs: 0 });
