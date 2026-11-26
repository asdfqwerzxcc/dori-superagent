import { mkdirSync, readdirSync, rmSync } from "node:fs";
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
import { takeInboxLock, takeLock } from "./inbox-lock.ts";
import { Receipts } from "./receipts.ts";
import { refFromText, refText, sameSession } from "./refs.ts";
import { Refusal } from "./refusal.ts";
import type { SessionRef } from "./runtime/types.ts";
import { StoreRecords } from "./store-records.ts";
import {
  HEAD_LOCK_STALE_MS,
  type Lane,
  type LaneReceipt,
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

/** A lane record that is closed for good: `done` (landed) or `dropped` (abandoned). */
const closed = (status: Lane["status"]): boolean => status === "done" || status === "dropped";

export class Store extends StoreRecords {
  readonly receipts: Receipts;

  constructor(root: string = process.env["DORI_HOME"] ?? join(homedir(), ".dori")) {
    super(root);
    this.receipts = new Receipts(root);
    for (const d of ["lanes", "inbox", "briefs", "receipts", "lane-reviews", "backlog", "duty"])
      mkdirSync(join(root, d), { recursive: true });
    mkdirSync(join(root, "loop", "runs"), { recursive: true });
    mkdirSync(join(root, "state", "reviews"), { recursive: true });
    mkdirSync(join(root, "state", "bundles"), { recursive: true });
  }

  lane(key: string): Lane | undefined {
    const raw = readJson<StoredLane>(join(this.root, "lanes", `${key}.json`));
    return raw && upgrade(raw);
  }

  /**
   * Writes a lane record, with `paneId`/`tabId` from `sessionRef` beside it so an older binary still reads it. A record
   * that is already closed on disk never goes back to an open status: a `ready`, a `report` or any stale snapshot that
   * read the record before the close is refused instead of silently dropping the close from the log. Only `revive`
   * writes over it — `dori start` reusing a finished key is a new lane.
   */
  saveLane(lane: Lane, opts: { revive?: boolean } = {}): void {
    const current = this.lane(lane.key);
    if (opts.revive !== true && current !== undefined && closed(current.status) && !closed(lane.status))
      throw new Refusal(
        `lane ${lane.key} is already ${current.status}; a closed lane cannot go back to ${lane.status}. ` +
          `Start a new lane with dori start ${lane.key}.`,
      );
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

  /** Deletes a lane record. Only `dori lanes prune` calls this, and only for a finished lane with no worktree. */
  removeLane(key: string): void {
    rmSync(join(this.root, "lanes", `${key}.json`), { force: true });
  }

  /**
   * The lane that can still take a message for this session. `lost` is terminal like `done`/`dropped`: the pane is
   * gone and `dori start` refuses the key, so only a run of the duty loop would keep retrying its inbox.
   */
  laneBySession(ref: SessionRef): Lane | undefined {
    return this.lanes().find(
      (l) => sameSession(l.sessionRef, ref) && l.status !== "done" && l.status !== "dropped" && l.status !== "lost",
    );
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

  /** A failed review at this head must not leave an earlier receipt that the merge gate would still trust. */
  clearReceipt(pr: string, sha: string): void {
    this.receipts.clear(pr, sha);
  }

  /** One review or merge at a time per (pr, sha); a held lock is a live attempt the gate must not ignore. */
  lockReceipt(pr: string, sha: string, now: number): (() => void) | undefined {
    return takeLock(`${this.receipts.receiptPath(pr, sha)}.lock`, now, HEAD_LOCK_STALE_MS);
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
}
