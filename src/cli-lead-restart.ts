import { appendFileSync, existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { type Args, one, parse } from "./cli-args.ts";
import { defaultDeps, type Deps } from "./harness.ts";
import { listAllProcesses } from "./lead-process-list.ts";
import { launchOutOfTree, type LeadSwapPlan, swapWorkerArgv, swapWorkerEnv } from "./lead-swap-detach.ts";
import { readRuntimeBuild } from "./lead-swap-target.ts";
import { runLeadSwap } from "./lead-swap.ts";
import { refFromText } from "./refs.ts";
import { Refusal } from "./refusal.ts";

function appendLog(path: string, line: string): void {
  try {
    mkdirSync(dirname(path), { recursive: true });
    const stamp = new Date().toISOString().slice(0, 19).replace("T", " ");
    appendFileSync(path, `${stamp} ${line}\n`);
  } catch {
    // The stdout line is the contract; the log is best effort.
  }
}

/** The worker's ready marker: written before its first probe, so the delegating process never reports a failed launch. */
function writeMarker(path: string | undefined): void {
  if (path === undefined) return;
  try {
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, String(process.pid));
  } catch {
    // The launcher's 5 s gate turns a missing marker into a failure; nothing was killed.
  }
}

export async function leadRestart(d: Deps, a: Args, sessionArg?: string): Promise<number> {
  writeMarker(one(a, "marker"));
  const paneArg = one(a, "pane");
  const lead = paneArg === undefined ? d.store.roles().lead : refFromText(paneArg);
  if (lead === undefined)
    throw new Refusal(
      paneArg === undefined
        ? "no lead role in roles.json; run dori up or dori role lead <ref>"
        : `--pane is not a session ref: ${paneArg}`,
    );
  const runtime = d.runtimes.for(lead);
  const selfInLeadPane = (() => {
    try {
      const self = runtime.self();
      return self !== undefined && self.runtime === lead.runtime && self.id === lead.id;
    } catch {
      return false;
    }
  })();
  const home = d.store.root;
  const sessionsRoot = join(homedir(), ".omo", "agent", "sessions");
  const runtimeRoot = join(homedir(), ".omo", "agent", "runtime");
  const promptDefault = join(home, "prompts", "lead.md");
  const promptArg = one(a, "prompt");
  const promptPath = promptArg ?? (existsSync(promptDefault) ? promptDefault : undefined);
  const logPath = join(home, "state", "lead-restart.log");
  // The log file first: the out-of-tree worker has no console, and a dying swap must still leave its last line.
  const log = (line: string) => {
    appendLog(logPath, line);
    try {
      console.log(line);
    } catch {
      // The worker runs without a console; the file above is the record.
    }
  };
  const platform = process.platform;
  const drainMsArg = one(a, "drain-ms");
  const drainSeconds = one(a, "drain-timeout");
  const drainMs =
    drainMsArg !== undefined
      ? Number(drainMsArg)
      : drainSeconds === undefined
        ? Number(process.env["DORI_DRAIN_TIMEOUT_MS"] ?? 180_000)
        : Number(drainSeconds) * 1000;
  if (!Number.isFinite(drainMs) || drainMs < 0)
    throw new Refusal("--drain-ms or --drain-timeout must be a non-negative number");
  const session = one(a, "session") ?? sessionArg;
  const worker = a.flags.has("swap-worker");
  // A Windows swap started inside the lead's own tree is handed to WMI: a killed Bun/Node ancestor takes the whole
  // job down, so the worker must not share the tree it is about to kill.
  const delegate =
    worker || platform !== "win32"
      ? undefined
      : async (plan: LeadSwapPlan) => {
          const marker = join(home, "state", `lead-swap-${process.pid}.ready`);
          const argv = swapWorkerArgv(process.execPath, join(import.meta.dir, "cli.ts"), plan, marker);
          const env = swapWorkerEnv(process.env, { DORI_HOME: home, DORI_AGENT_CMD: d.agentCmd });
          const pid = await launchOutOfTree(d.exec, {
            argv,
            env,
            cwd: process.cwd(),
            marker,
            launcherDir: join(home, "state"),
          });
          rmSync(marker, { force: true });
          return { pid };
        };
  const result = await runLeadSwap({
    pane: lead,
    agentCmd: d.agentCmd,
    ...(session === undefined ? {} : { session }),
    ...(promptPath === undefined ? {} : { promptPath }),
    sessionsRoot,
    dryRun: a.flags.has("dry-run"),
    force: a.flags.has("force"),
    drainMs,
    deathMs: 30_000,
    launchMs: 120_000,
    pollMs: 500,
    platform,
    ...(selfInLeadPane ? { selfInPane: true } : {}),
    ...(delegate === undefined ? {} : { delegate }),
    list: () => listAllProcesses(d.exec),
    probe: () => runtime.probe(lead),
    kill: async (pid) => {
      if (platform === "win32") await d.exec("taskkill", ["/PID", String(pid), "/T", "/F"]);
      else {
        try {
          process.kill(pid, "SIGTERM");
        } catch {
          // Already gone: the death wait is what decides.
        }
      }
    },
    typeShell: (text) => runtime.typeIntoShell(lead, text),
    version: async () => {
      const r = await d.exec(d.agentCmd, ["--version"]);
      if (r.code !== 0) return undefined;
      const line = (r.stdout || r.stderr).trim().split("\n")[0] ?? "";
      return line !== "" && /\d/.test(line) ? line : undefined;
    },
    runtimeBuild: () => readRuntimeBuild(runtimeRoot),
    sleep: (ms) => Bun.sleep(ms),
    now: () => Date.now(),
    log,
  });
  return result.code;
}

/** The entry the installed `bin/lead-restart.ts` delegate calls (it runs outside the repository). */
export async function leadRestartCli(argv: readonly string[]): Promise<number> {
  const d = defaultDeps();
  const a = parse(argv);
  try {
    return await leadRestart(d, a, a.pos[1]);
  } catch (e) {
    if (e instanceof Refusal) {
      console.error(e.message);
      return 2;
    }
    throw e;
  }
}

if (import.meta.main) process.exit(await leadRestartCli(process.argv.slice(2)));
