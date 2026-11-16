import { existsSync, mkdirSync, readdirSync, rmSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import {
  appendQueue,
  forwardOf,
  forwardPending,
  inboxFile,
  inboxRefs,
  mergeForwarded,
  readQueue,
  writeQueue,
} from "./inbox-files.ts";
import { writeJson, readJson } from "./json-file.ts";
import { takeInboxLock } from "./inbox-lock.ts";
import { Receipts } from "./receipts.ts";
import { refFromText, refText, sameSession } from "./refs.ts";
import type { SessionRef } from "./runtime/types.ts";
import {
  KEEP_RUNS,
  KEY_RE,
  type Item,
  type Lane,
  type LaneReceipt,
  type LoopRun,
  type QueuedMessage,
  type ReviewReceipt,
  type Role,
} from "./store-types.ts";

export type { HostLoad } from "./store-types.ts";

/** A lane file as any binary wrote it: one from before runtimes existed has no `sessionRef`. */
type StoredLane = Omit<Lane, "sessionRef"> & { sessionRef?: SessionRef };

/** Reads a record without `sessionRef` as the herdr pane it names; the same input always gives the same lane. */
const upgrade = (raw: StoredLane): Lane =>
  raw.sessionRef !== undefined
    ? (raw as Lane)
    : { ...raw, sessionRef: { runtime: "herdr", id: raw.paneId, ...(raw.tabId ? { container: raw.tabId } : {}) } };

const checkedId = (id: string): string => {
  if (!KEY_RE.test(id)) throw new Error(`invalid id ${JSON.stringify(id)}: must match ${KEY_RE}`);
  return id;
};

export class Store {
  readonly receipts: Receipts;

  constructor(readonly root: string = process.env["DORI_HOME"] ?? join(homedir(), ".dori")) {
    this.receipts = new Receipts(root);
    for (const d of ["lanes", "inbox", "briefs", "receipts", "lane-reviews", "backlog", "loop/runs", "duty"])
      mkdirSync(join(root, d), { recursive: true });
  }

  lane(key: string): Lane | undefined {
    const raw = readJson<StoredLane>(join(this.root, "lanes", `${key}.json`));
    return raw && upgrade(raw);
  }

  /** Writes `paneId`/`tabId` from `sessionRef` beside it, so an older binary still reads the record. */
  saveLane(lane: Lane): void {
    const { id, container } = lane.sessionRef;
    writeJson(join(this.root, "lanes", `${lane.key}.json`), { ...lane, paneId: id, tabId: container ?? "" });
  }

  lanes(): Lane[] {
    return readdirSync(join(this.root, "lanes"))
      .filter((f) => f.endsWith(".json"))
      .map((f) => readJson<StoredLane>(join(this.root, "lanes", f)))
      .filter((l): l is StoredLane => l !== undefined)
      .map(upgrade)
      .sort((a, b) => a.createdAt - b.createdAt || a.key.localeCompare(b.key));
  }

  laneBySession(ref: SessionRef): Lane | undefined {
    return this.lanes().find((l) => sameSession(l.sessionRef, ref) && l.status !== "done" && l.status !== "dropped");
  }

  /** roles.json holds ref strings (refText), so an older binary still parses it; a bare value is a herdr pane. */
  roles(): Partial<Record<Role, SessionRef>> {
    const raw = readJson<Partial<Record<Role, string>>>(join(this.root, "roles.json")) ?? {};
    return Object.fromEntries(Object.entries(raw).map(([role, text]) => [role, refFromText(text)]));
  }

  setRole(role: Role, ref: SessionRef): void {
    const raw = readJson<Partial<Record<Role, string>>>(join(this.root, "roles.json")) ?? {};
    writeJson(join(this.root, "roles.json"), { ...raw, [role]: refText(ref) });
  }

  /** Drops a role whose pane no longer runs it; `dori role <role> -` and `dori up` under supervisors both use this. */
  clearRole(role: Role): void {
    const raw = readJson<Partial<Record<Role, string>>>(join(this.root, "roles.json")) ?? {};
    if (!(role in raw)) return;
    delete raw[role];
    writeJson(join(this.root, "roles.json"), raw);
  }

  briefPath(key: string): string {
    return join(this.root, "briefs", `${key}.md`);
  }

  inboxPath(ref: SessionRef): string {
    return inboxFile(this.root, ref);
  }

  /** Appends to the inbox of the session `ref` was forwarded to, if it was. */
  enqueue(ref: SessionRef, msg: QueuedMessage): void {
    appendQueue(this.inboxPath(this.forwardOf(ref) ?? ref), msg);
  }

  queued(ref: SessionRef): QueuedMessage[] {
    return readQueue(this.inboxPath(ref));
  }

  saveInbox(ref: SessionRef, msgs: readonly QueuedMessage[]): void {
    writeQueue(this.inboxPath(ref), msgs);
  }

  /** The session this one's inbox was forwarded to by a migration (its `.forward` marker), or undefined. */
  forwardOf(ref: SessionRef): SessionRef | undefined {
    return forwardOf(this.root, ref);
  }

  /** True when an old inbox forwarded into `ref` still holds entries. */
  forwardPending(ref: SessionRef): boolean {
    return forwardPending(this.root, ref);
  }

  /** Merges old inboxes forwarded into `ref` into its inbox; call it under ref's inbox lock. */
  mergeForwarded(ref: SessionRef): void {
    mergeForwarded(this.root, ref);
  }

  /**
   * Takes the session's inbox lock (`<inbox>.lock`, created O_EXCL, holding pid, host and time) and returns its release,
   * or undefined while another flush holds it. A lock whose pid is dead on this host, or one from another host (or
   * unreadable) older than INBOX_LOCK_STALE_MS, is taken over: it is renamed aside first, and when what was renamed is not the lock judged stale (another
   * process took it over in between), it is put back and the lock counts as held.
   */
  lockInbox(ref: SessionRef, now: number): (() => void) | undefined {
    return takeInboxLock(`${this.inboxPath(ref)}.lock`, now);
  }

  /** Sessions with queued messages. */
  inboxPanes(): SessionRef[] {
    return inboxRefs(this.root).filter((r) => this.queued(r).length > 0);
  }

  saveReceipt(r: ReviewReceipt): void {
    this.receipts.save(r);
  }

  receipt(pr: string, sha: string): ReviewReceipt | undefined {
    return this.receipts.receipt(pr, sha);
  }

  saveLaneReceipt(r: LaneReceipt): void {
    this.receipts.saveLane(r);
  }

  laneReceipt(key: string, tip: string): LaneReceipt | undefined {
    return this.receipts.lane(key, tip);
  }

  laneDiffPath(key: string, tip: string): string {
    return this.receipts.laneDiffPath(key, tip);
  }

  // ---------- backlog ----------

  itemBrief(id: string): string {
    return join(this.root, "backlog", `${checkedId(id)}.md`);
  }

  item(id: string): Item | undefined {
    return readJson<Item>(join(this.root, "backlog", `${checkedId(id)}.json`));
  }

  saveItem(item: Item): void {
    writeJson(join(this.root, "backlog", `${checkedId(item.id)}.json`), item);
  }

  items(): Item[] {
    return readdirSync(join(this.root, "backlog"))
      .filter((f) => f.endsWith(".json"))
      .map((f) => readJson<Item>(join(this.root, "backlog", f)))
      .filter((i): i is Item => i !== undefined)
      .sort((a, b) => a.createdAt - b.createdAt || a.id.localeCompare(b.id));
  }

  // ---------- hourly loop ----------

  loopPath(name: string): string {
    return join(this.root, "loop", name);
  }

  /** The single-instance lock of the hourly loop (`loop/lock`) or of the duty loop (`duty/lock`). */
  lockPath(of: "loop" | "duty"): string {
    return join(this.root, of, "lock");
  }

  /** The kill switch of the hourly loop (`loop/stop`) or of the duty loop (`duty/stop`). */
  stop(of: "loop" | "duty" = "loop"): { at: number; reason: string } | undefined {
    return readJson(join(this.root, of, "stop"));
  }

  setStop(at: number, reason: string, of: "loop" | "duty" = "loop"): void {
    writeJson(join(this.root, of, "stop"), { at, reason });
  }

  clearStop(of: "loop" | "duty" = "loop"): void {
    rmSync(join(this.root, of, "stop"), { force: true });
  }

  lastRun(): LoopRun | undefined {
    return readJson(this.loopPath("last-run.json"));
  }

  /** Writes the run record and the last-run stamp, keeping the newest KEEP_RUNS records. Pass `name` to rewrite a record. */
  saveRun(run: LoopRun, name?: string): string {
    const dir = this.loopPath("runs");
    if (name === undefined) {
      const stem = new Date(run.at).toISOString().replaceAll(":", "-");
      name = `${stem}.json`;
      for (let n = 2; existsSync(join(dir, name)); n++) name = `${stem}-${n}.json`;
    }
    writeJson(join(dir, name), run);
    writeJson(this.loopPath("last-run.json"), run);
    const files = readdirSync(dir)
      .filter((f) => f.endsWith(".json"))
      .sort();
    for (const f of files.slice(0, Math.max(0, files.length - KEEP_RUNS))) rmSync(join(dir, f), { force: true });
    return name;
  }

  runs(): string[] {
    return readdirSync(this.loopPath("runs"))
      .filter((f) => f.endsWith(".json"))
      .sort();
  }
}
