import { appendFileSync, existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { type Args, one, parse } from "./cli-args.ts";
import { defaultDeps, type Deps } from "./harness.ts";
import { clearLeadRestartBusy, markLeadRestartBusy } from "./lead-restart-busy.ts";
import { listAllProcesses } from "./lead-process-list.ts";
import { launchOutOfTree, type LeadSwapPlan, swapWorkerArgv, swapWorkerEnv } from "./lead-swap-detach.ts";
import { readRuntimeBuild } from "./lead-swap-target.ts";
import { runLeadSwap, type LeadSwapResult } from "./lead-swap.ts";
import { pidAlive } from "./process-liveness.ts";
import { refFromText, refText } from "./refs.ts";
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

/** The worker holds before its first probe until the parent has logged the handoff and written the go file. */
async function waitForGo(
  path: string | undefined,
  timeoutMs: number,
  log: (line: string) => void,
): Promise<"go" | "timeout"> {
  if (path === undefined) return "go";
  const deadline = Date.now() + timeoutMs;
  while (!existsSync(path)) {
    if (Date.now() >= deadline) return "timeout";
    await Bun.sleep(100);
  }
  try {
    rmSync(path, { force: true });
  } catch {
    log("LEADSWAP WARN go file not removed");
  }
  return "go";
}

export async function leadRestart(d: Deps, a: Args, sessionArg?: string): Promise<number> {
  const home = d.store.root;
  const logPath = join(home, "state", "lead-restart.log");
  const log = (line: string) => {
    appendLog(logPath, line);
    try {
      console.log(line);
    } catch {
      // The worker runs without a console; the file above is the record.
    }
  };
  writeMarker(one(a, "marker"));
  const goTimeoutArg = one(a, "go-timeout-ms");
  const goTimeoutMs = goTimeoutArg === undefined ? 30_000 : Number(goTimeoutArg);
  if (!Number.isFinite(goTimeoutMs) || goTimeoutMs < 0)
    throw new Refusal("--go-timeout-ms must be a non-negative number");
  const parentPidArg = one(a, "parent-pid");
  const parentPid = parentPidArg === undefined ? undefined : Number(parentPidArg);
  const goResult = await waitForGo(one(a, "go"), goTimeoutMs, log);
  if (goResult === "timeout") {
    appendLog(
      logPath,
      `LEADSWAP worker aborted: go timeout parent=${parentPid ?? "?"} alive=${parentPid !== undefined && Number.isInteger(parentPid) && pidAlive(parentPid)}`,
    );
    clearLeadRestartBusy(home);
    return 2;
  }
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
  const sessionsRoot = join(homedir(), ".omo", "agent", "sessions");
  const runtimeRoot = join(homedir(), ".omo", "agent", "runtime");
  const promptDefault = join(home, "prompts", "lead.md");
  const promptArg = one(a, "prompt");
  const promptPath = promptArg ?? (existsSync(promptDefault) ? promptDefault : undefined);
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
  const session = sessionArg ?? one(a, "session");
  const worker = a.flags.has("swap-worker");
  // A Windows swap started inside the lead's own tree is handed to WMI: a killed Bun/Node ancestor takes the whole
  // job down, so the worker must not share the tree it is about to kill.
  const delegate =
    worker || platform !== "win32"
      ? undefined
      : async (plan: LeadSwapPlan) => {
          const suffix = `${process.pid}-${Date.now()}`;
          const marker = join(home, "state", `lead-swap-${suffix}.ready`);
          const go = join(home, "state", `lead-swap-${suffix}.go`);
          const argv = swapWorkerArgv(process.execPath, join(import.meta.dir, "cli.ts"), plan, marker, go, process.pid);
          const env = swapWorkerEnv(process.env, { DORI_HOME: home, DORI_AGENT_CMD: d.agentCmd });
          return launchOutOfTree(d.exec, {
            argv,
            env,
            cwd: process.cwd(),
            marker,
            go,
            launcherDir: join(home, "state"),
          });
        };
  markLeadRestartBusy(home, refText(lead));
  let result: LeadSwapResult | undefined;
  try {
    result = await runLeadSwap({
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
      ...(worker ? { worker: true } : {}),
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
  } finally {
    if (worker || result?.outcome !== "delegated") clearLeadRestartBusy(home);
  }
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
