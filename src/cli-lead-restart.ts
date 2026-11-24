import { appendFileSync, existsSync, mkdirSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { type Args, one, parse } from "./cli-args.ts";
import { defaultDeps, type Deps } from "./harness.ts";
import { listAllProcesses } from "./lead-process-list.ts";
import { readRuntimeBuild } from "./lead-swap-target.ts";
import { runLeadSwap } from "./lead-swap.ts";
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

export async function leadRestart(d: Deps, a: Args, sessionArg?: string): Promise<number> {
  const lead = d.store.roles().lead;
  if (lead === undefined) throw new Refusal("no lead role in roles.json; run dori up or dori role lead <ref>");
  const runtime = d.runtimes.for(lead);
  const home = d.store.root;
  const sessionsRoot = join(homedir(), ".omo", "agent", "sessions");
  const runtimeRoot = join(homedir(), ".omo", "agent", "runtime");
  const promptDefault = join(home, "prompts", "lead.md");
  const logPath = join(home, "state", "lead-restart.log");
  const log = (line: string) => {
    console.log(line);
    appendLog(logPath, line);
  };
  const platform = process.platform;
  const drainSeconds = one(a, "drain-timeout");
  const drainMs =
    drainSeconds === undefined ? Number(process.env["DORI_DRAIN_TIMEOUT_MS"] ?? 180_000) : Number(drainSeconds) * 1000;
  if (!Number.isFinite(drainMs) || drainMs < 0) throw new Refusal("--drain-timeout must be a number of seconds");
  const session = sessionArg ?? one(a, "session");
  const result = await runLeadSwap({
    pane: lead,
    agentCmd: d.agentCmd,
    ...(session === undefined ? {} : { session }),
    ...(existsSync(promptDefault) ? { promptPath: promptDefault } : {}),
    sessionsRoot,
    dryRun: a.flags.has("dry-run"),
    force: a.flags.has("force"),
    drainMs,
    deathMs: 30_000,
    launchMs: 120_000,
    pollMs: 500,
    platform,
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
