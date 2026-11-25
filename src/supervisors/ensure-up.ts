import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { readJson } from "../json-file.ts";
import { leadRestartBusy } from "../lead-restart-busy.ts";
import { refFromText } from "../refs.ts";
import { spawnExec, type Exec } from "../runtime/exec.ts";
import { HcRuntime } from "../runtime/hc/index.ts";
import { HerdrRuntime } from "../runtime/herdr/index.ts";
import type { AgentStatus, SessionRef } from "../runtime/types.ts";
import { ENSURE_UP_HEARTBEAT, ENSURE_UP_OFF, pidAlive, stateDir, writeEnsureUpRecord } from "../supervisors.ts";

/** True when state/ensure-up.off exists; the loop idles and the ensure-up plugin reports `off`. */
export const ensureUpStopped = (home: string): boolean => existsSync(join(stateDir(home), ENSURE_UP_OFF));

/** The lead role roles.json registers, or undefined when no `dori up` has run in this home. */
export function leadRef(home: string): SessionRef | undefined {
  const raw = readJson<Partial<Record<string, string>>>(join(home, "roles.json")) ?? {};
  const text = raw["lead"];
  return text === undefined || text === "" ? undefined : refFromText(text);
}

/**
 * The lead's own runtime answers for its pane, so a stale role from before a reboot is `gone`; `absent` when no role is
 * registered. A thrown probe is the caller's doubt, never evidence that the lead is down.
 */
export async function leadStatus(
  home: string,
  exec: Exec = spawnExec,
  session: string | undefined = process.env["DORI_HERDR_SESSION"],
): Promise<AgentStatus | "absent"> {
  const ref = leadRef(home);
  if (ref === undefined) return "absent";
  const rt = ref.runtime === "hc" ? new HcRuntime(exec) : new HerdrRuntime(exec, session);
  return (await rt.probe(ref)).status;
}

export type EnsureUpOptions = {
  readonly home?: string;
  readonly once?: boolean;
  readonly exec?: Exec;
  readonly up?: () => Promise<{ readonly code: number; readonly detail: string }>;
  readonly log?: (line: string) => void;
  readonly sleep?: (ms: number) => Promise<void>;
  readonly startedAt?: number;
  /** Called on every check with the state it found; the caller dedupes so a repeated state is logged once. */
  readonly report?: (state: EnsureUpState, line: string) => void;
};

export type EnsureUpState = "alive" | "off" | "down" | "unknown";

const DEFAULT_INTERVAL_MS = 20_000;

const lockPath = (home: string): string => join(stateDir(home), "ensure-up.lock");

const releaseLock = (home: string) => rmSync(lockPath(home), { force: true });

/** One ensure-up loop per home, or two raise two workspaces; a lock whose pid is dead is taken over. */
export function acquireEnsureUpLock(home: string): boolean {
  const path = lockPath(home);
  const write = (): boolean => {
    try {
      writeFileSync(path, JSON.stringify({ pid: process.pid, at: Date.now() }), { flag: "wx" });
      process.once("exit", () => releaseLock(home));
      return true;
    } catch {
      return false;
    }
  };
  if (write()) return true;
  try {
    const held = JSON.parse(readFileSync(path, "utf8")) as { pid?: unknown };
    const pid = Number(held.pid);
    if (Number.isInteger(pid) && pid !== process.pid && pidAlive(pid)) return false;
  } catch {
    // an unreadable lock is no evidence of a running loop
  }
  rmSync(path, { force: true });
  return write();
}

async function defaultUp(): Promise<{ code: number; detail: string }> {
  const cli = join(import.meta.dir, "..", "cli.ts");
  const cwd = process.env["DORI_UP_CWD"] ?? homedir();
  const r = await spawnExec(process.execPath, [cli, "up", "--cwd", cwd], {});
  const line = (
    r.stdout
      .trim()
      .split("\n")
      .find((l) => l.startsWith("UP ")) ??
    r.stderr.trim().split("\n")[0] ??
    ""
  ).slice(0, 220);
  return { code: r.code, detail: line };
}

const defaultLog = (line: string) => process.stdout.write(`${new Date().toISOString().slice(11, 19)} ${line}\n`);

function beat(home: string, startedAt: number): void {
  try {
    writeFileSync(join(stateDir(home), ENSURE_UP_HEARTBEAT), new Date().toISOString());
  } catch {}
  writeEnsureUpRecord(home, { pid: process.pid, startedAt, at: Date.now() });
}

/** Keeps the ensure-up heartbeat fresh while a `dori up` raise runs longer than the 90 s stale window. */
export function startEnsureUpBeat(home: string, startedAt: number): () => void {
  mkdirSync(stateDir(home), { recursive: true });
  beat(home, startedAt);
  const timer = setInterval(() => beat(home, startedAt), DEFAULT_INTERVAL_MS);
  timer.unref();
  return () => clearInterval(timer);
}

/** One beat and one decision; no lock and no sleep, so both the loop and the plugin tick call exactly this. */
export async function ensureUpCheck(opts: EnsureUpOptions = {}): Promise<EnsureUpState> {
  const home = opts.home ?? process.env["DORI_HOME"] ?? join(homedir(), ".dori");
  const exec = opts.exec ?? spawnExec;
  const log = opts.log ?? defaultLog;
  const up = opts.up ?? (() => defaultUp());
  mkdirSync(stateDir(home), { recursive: true });
  beat(home, opts.startedAt ?? Date.now());
  if (ensureUpStopped(home)) {
    opts.report?.("off", `ENSURE_UP off (${ENSURE_UP_OFF})`);
    return "off";
  }
  if (leadRestartBusy(home)) {
    opts.report?.("alive", "ENSURE_UP lead restart in progress");
    return "alive";
  }
  try {
    const lead = await leadStatus(home, exec);
    // A lead pane that answers `shell` has no agent: it is as down as a gone pane, and waiting for `gone` left a bare
    // shell unrepaired for 33 minutes (2026-11-25).
    if (lead !== "gone" && lead !== "absent" && lead !== "shell") {
      opts.report?.("alive", "ENSURE_UP alive");
      return "alive";
    }
    const why =
      lead === "absent"
        ? "no lead role"
        : lead === "shell"
          ? "lead pane has a shell, not an agent"
          : "lead pane is gone";
    opts.report?.("down", `ENSURE_UP ${why}; running dori up`);
    const r = await up();
    log(`DORI_UP exit=${r.code} ${r.detail}`);
    return "down";
  } catch (e) {
    log(`DORI_ENSURE_WARN ${String(e).slice(0, 220)}`);
    return "unknown";
  }
}

/** The self-healing loop kept for `~/.dori/bin/dori-ensure-up.ts`; the supervisor runs the plugin child instead. */
export async function runEnsureUp(opts: EnsureUpOptions = {}): Promise<number> {
  const home = opts.home ?? process.env["DORI_HOME"] ?? join(homedir(), ".dori");
  const log = opts.log ?? defaultLog;
  const sleep = opts.sleep ?? ((ms: number) => Bun.sleep(ms));
  if (!acquireEnsureUpLock(home)) {
    log("ENSURE_UP already running");
    return 0;
  }
  const startedAt = Date.now();
  const stopBeat = startEnsureUpBeat(home, startedAt);
  let last: EnsureUpState | "" = "";
  const report = (state: EnsureUpState, line: string): void => {
    if (state === last) return;
    last = state;
    log(line);
  };
  for (;;) {
    await ensureUpCheck({ ...opts, home, startedAt, log, report });
    if (opts.once) break;
    await sleep(DEFAULT_INTERVAL_MS);
  }
  stopBeat();
  releaseLock(home);
  return 0;
}

if (import.meta.main) process.exit(await runEnsureUp({ once: process.argv.includes("--once") }));
