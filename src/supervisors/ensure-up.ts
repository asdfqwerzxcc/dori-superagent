import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { spawnExec, type Exec } from "../runtime/exec.ts";
import { ENSURE_UP_HEARTBEAT, ENSURE_UP_OFF, pidAlive, stateDir, writeEnsureUpRecord } from "../supervisors.ts";

/** True when state/ensure-up.off exists; the loop idles and `dori status` prints `ENSURE-UP off`. */
export const ensureUpStopped = (home: string): boolean => existsSync(join(stateDir(home), ENSURE_UP_OFF));

/** `herdr` addresses a named session for every call when one is set, exactly as the runtime CLI does. */
const withSession = (session: string | undefined, argv: readonly string[]): string[] =>
  session === undefined || session === "" ? [...argv] : ["--session", session, ...argv];

/** `herdr workspace list`: the workspaces labelled `dori`. */
export async function doriWorkspaces(
  exec: Exec,
  session: string | undefined = process.env["DORI_HERDR_SESSION"],
): Promise<string[]> {
  const r = await exec("herdr", withSession(session, ["workspace", "list"]));
  if (r.code !== 0) throw new Error(`herdr workspace list failed: ${r.stderr.slice(0, 200)}`);
  const data = JSON.parse(r.stdout) as { result?: { workspaces?: { workspace_id: string; label?: string }[] } };
  return (data.result?.workspaces ?? []).filter((w) => w.label === "dori").map((w) => w.workspace_id);
}

/** The workspace counts as up when one dori workspace holds at least two panes with a live agent. */
export async function workspaceAlive(
  exec: Exec,
  session: string | undefined = process.env["DORI_HERDR_SESSION"],
): Promise<boolean> {
  const workspaces = await doriWorkspaces(exec, session);
  if (workspaces.length === 0) return false;
  const r = await exec("herdr", withSession(session, ["pane", "list"]));
  if (r.code !== 0) return false;
  const data = JSON.parse(r.stdout) as {
    result?: { panes?: { workspace_id: string; agent?: string; agent_status?: string }[] };
  };
  const panes = data.result?.panes ?? [];
  return workspaces.some(
    (ws) => panes.filter((p) => p.workspace_id === ws && p.agent && p.agent_status !== "unknown").length >= 2,
  );
}

export type EnsureUpOptions = {
  readonly home?: string;
  readonly once?: boolean;
  readonly exec?: Exec;
  readonly up?: () => Promise<{ readonly code: number; readonly detail: string }>;
  readonly log?: (line: string) => void;
  readonly sleep?: (ms: number) => Promise<void>;
};

const DEFAULT_INTERVAL_MS = 20_000;

function lockPath(home: string): string {
  return join(stateDir(home), "ensure-up.lock");
}

/** One ensure-up loop per home, or two raise two workspaces; a lock whose pid is dead is taken over. */
function acquireLock(home: string): boolean {
  const path = lockPath(home);
  const write = (): boolean => {
    try {
      writeFileSync(path, JSON.stringify({ pid: process.pid, at: Date.now() }), { flag: "wx" });
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

/**
 * The self-healing loop: while a dori workspace is up it only beats; when the workspace is gone (a herdr restart, a
 * closed tab) it runs `dori up` and waits for the new panes to settle. `--once` makes it a single check.
 */
export async function runEnsureUp(opts: EnsureUpOptions = {}): Promise<number> {
  const home = opts.home ?? process.env["DORI_HOME"] ?? join(homedir(), ".dori");
  const exec = opts.exec ?? spawnExec;
  const sleep = opts.sleep ?? ((ms: number) => Bun.sleep(ms));
  const log =
    opts.log ?? ((line: string) => process.stdout.write(`${new Date().toISOString().slice(11, 19)} ${line}\n`));
  const up = opts.up ?? (() => defaultUp());
  const startedAt = Date.now();
  mkdirSync(stateDir(home), { recursive: true });

  if (!acquireLock(home)) {
    log("ENSURE_UP already running");
    return 0;
  }
  const release = () => rmSync(lockPath(home), { force: true });
  process.on("exit", release);

  const beat = () => {
    try {
      writeFileSync(join(stateDir(home), ENSURE_UP_HEARTBEAT), new Date().toISOString());
    } catch {}
    writeEnsureUpRecord(home, { pid: process.pid, startedAt, at: Date.now() });
  };
  beat();
  const beatTimer = setInterval(beat, DEFAULT_INTERVAL_MS);
  beatTimer.unref();

  let last = "unknown";
  const report = (state: string, line: string) => {
    if (state === last) return;
    last = state;
    log(line);
  };

  for (;;) {
    try {
      if (ensureUpStopped(home)) {
        report("off", `ENSURE_UP off (${ENSURE_UP_OFF})`);
      } else if (await workspaceAlive(exec)) {
        report("alive", "ENSURE_UP alive");
      } else {
        report("raising", "ENSURE_UP dori workspace is down; running dori up");
        const r = await up();
        log(`DORI_UP exit=${r.code} ${r.detail}`);
        if (opts.once) break;
        await sleep(DEFAULT_INTERVAL_MS);
      }
    } catch (e) {
      log(`DORI_ENSURE_WARN ${String(e).slice(0, 220)}`);
    }
    if (opts.once) break;
    await sleep(DEFAULT_INTERVAL_MS);
  }
  clearInterval(beatTimer);
  release();
  return 0;
}

if (import.meta.main) process.exit(await runEnsureUp({ once: process.argv.includes("--once") }));
