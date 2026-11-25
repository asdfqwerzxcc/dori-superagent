// Launching the lead swap from outside the lead's process tree. On Windows a killed Bun/Node process takes its job's
// descendants with it (measured: a plain child of a Bun process dies even without `taskkill /T`), so a swap that runs
// inside the lead would kill itself at the first PID. Win32_Process.Create runs the worker under WmiPrvSE: a different
// process tree, no inherited console, and a hidden window.

import { existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { failureDetail } from "./delivery.ts";
import { launcherStillOurs } from "./lead-swap-identity.ts";
import type { Proc } from "./lead-process-list.ts";
import type { Exec } from "./runtime/exec.ts";
import type { SessionRef } from "./runtime/types.ts";
import { refText } from "./refs.ts";

export type LeadSwapPlan = {
  readonly pane: SessionRef;
  readonly session: string;
  readonly prompt: string;
  readonly command: string;
  readonly target: readonly number[];
  readonly matched: readonly number[];
  readonly drainMs: number;
  readonly force: boolean;
};

export type OutOfTreeLaunch = {
  readonly argv: readonly string[];
  readonly env: Readonly<Record<string, string>>;
  readonly cwd: string;
  /** The worker writes this file before its first probe; a missing marker is a failed launch, not a slow one. */
  readonly marker: string;
  /** The parent writes this after logging the handoff; the worker does not probe or kill before it exists. */
  readonly go: string;
  readonly launcherDir: string;
  /** How long to wait for the worker's ready marker; tests shorten it. */
  readonly readyMs?: number;
  /** A test seam for the launcher identity check; production uses the command line and creation time. */
  readonly identity?: (pid: number, startedAt: number) => boolean;
};

export type LaunchedSwap = { readonly pid: number; readonly go: () => void };

const quote = (value: string): string => `'${value.replaceAll("'", "''")}'`;

const safeRemove = (path: string): void => {
  try {
    rmSync(path, { force: true });
  } catch {
    // Best effort: a cleanup failure must not decide the launch result.
  }
};

const removeLauncher = async (path: string): Promise<void> => {
  for (let attempt = 0; attempt < 5; attempt++) {
    try {
      rmSync(path, { force: true });
      return;
    } catch {
      await Bun.sleep(50);
    }
  }
  safeRemove(path);
};

const killLauncher = async (exec: Exec, pid: number, verify: () => Promise<boolean>): Promise<void> => {
  try {
    if (!(await verify())) return;
  } catch {
    return;
  }
  try {
    await exec("taskkill", ["/PID", String(pid), "/T", "/F"], {});
  } catch {
    // Best effort: a worker that never gets go also aborts on its own gate.
  }
};

const powershellPath = (): string =>
  join(process.env["SystemRoot"] ?? "C:\\Windows", "System32", "WindowsPowerShell", "v1.0", "powershell.exe");

const WORKER_ENV = new Set([
  "PATH",
  "Path",
  "PATHEXT",
  "SystemRoot",
  "SystemDrive",
  "windir",
  "ComSpec",
  "USERPROFILE",
  "HOME",
  "TEMP",
  "TMP",
  "APPDATA",
  "LOCALAPPDATA",
  "PROGRAMDATA",
  "PROGRAMFILES",
  "ProgramFiles(x86)",
  "NUMBER_OF_PROCESSORS",
  "OS",
  "PROCESSOR_ARCHITECTURE",
  "DORI_HOME",
  "DORI_HERDR_SESSION",
  "DORI_AGENT_CMD",
  "DORI_RUNTIME",
  "DORI_TELEMETRY",
]);

/** The minimal worker environment: never a blanket DORI_/HERDR_ copy, so unrelated tokens cannot land in the .ps1. */
export function swapWorkerEnv(
  base: Readonly<Record<string, string | undefined>>,
  extra: Readonly<Record<string, string>>,
): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [key, value] of Object.entries(base)) {
    if (value === undefined || value === "" || key.startsWith("=")) continue;
    if (!WORKER_ENV.has(key)) continue;
    if (/[\r\n]/.test(value)) continue;
    out[key] = value;
  }
  for (const [key, value] of Object.entries(extra)) {
    if (key.startsWith("=") || value === "" || /[\r\n]/.test(value)) continue;
    out[key] = value;
  }
  return out;
}

/**
 * Starts the worker through WMI and waits for its ready marker. The returned pid is the PowerShell launcher; the worker
 * it starts is a child of WmiPrvSE, so killing the lead cannot reach it. `go` must be called only after the caller has
 * logged the handoff; the worker holds before its first probe until the go file exists. Throws when WMI refused or the
 * marker never appeared, and the caller then kills nothing.
 */
export async function launchOutOfTree(exec: Exec, launch: OutOfTreeLaunch): Promise<LaunchedSwap> {
  mkdirSync(dirname(launch.marker), { recursive: true });
  mkdirSync(launch.launcherDir, { recursive: true });
  safeRemove(launch.marker);
  safeRemove(launch.go);
  const launcher = join(launch.launcherDir, `lead-swap-${process.pid}-${Date.now()}.ps1`);
  try {
    const body = [
      "$ErrorActionPreference = 'Stop'",
      `Remove-Item -LiteralPath ${quote(launcher)} -Force -ErrorAction SilentlyContinue`,
      ...Object.entries(launch.env).map(
        ([key, value]) => `[Environment]::SetEnvironmentVariable(${quote(key)}, ${quote(value)})`,
      ),
      `Set-Location -LiteralPath ${quote(launch.cwd)} -ErrorAction SilentlyContinue`,
      `& ${launch.argv.map(quote).join(" ")}`,
      "exit $LASTEXITCODE",
    ];
    writeFileSync(launcher, `\uFEFF${body.join("\r\n")}\r\n`, "utf8");
    const commandLine = `"${powershellPath()}" -NoProfile -NonInteractive -ExecutionPolicy Bypass -File "${launcher}"`;
    const script = [
      "$startup = New-CimInstance -ClassName Win32_ProcessStartup -Namespace root/cimv2 -Property @{ ShowWindow = [uint16]0 } -ClientOnly",
      `$r = Invoke-CimMethod -ClassName Win32_Process -MethodName Create -Arguments @{ CommandLine = ${quote(commandLine)}; ProcessStartupInformation = $startup }`,
      "if ($r.ReturnValue -ne 0) { Write-Output ('RET=' + $r.ReturnValue); exit 1 }",
      "Write-Output ('PID=' + $r.ProcessId)",
    ].join("; ");
    const startedAt = Date.now();
    const result = await exec(powershellPath(), ["-NoProfile", "-NonInteractive", "-Command", script], {});
    const pid = Number(/PID=(\d+)/.exec(result.stdout)?.[1]);
    if (result.code !== 0 || !Number.isInteger(pid) || pid <= 0) {
      const why = (result.stderr || result.stdout).trim().replaceAll(/\s+/g, " ").slice(0, 300);
      throw new Error(`Win32_Process.Create failed (${result.code}): ${why}`);
    }
    const deadline = Date.now() + (launch.readyMs ?? 5000);
    while (Date.now() < deadline) {
      if (existsSync(launch.marker)) {
        safeRemove(launch.marker);
        return { pid, go: () => writeFileSync(launch.go, String(pid)) };
      }
      await Bun.sleep(100);
    }
    await killLauncher(
      exec,
      pid,
      launch.identity === undefined
        ? () => launcherStillOurs(exec, pid, startedAt, launcher)
        : async () => launch.identity!(pid, startedAt),
    );
    throw new Error(`the out-of-tree swap pid=${pid} did not report ready within ${launch.readyMs ?? 5000}ms`);
  } finally {
    // The launcher carries the worker env in plaintext; it must not outlive any failed or completed start.
    await removeLauncher(launcher);
  }
}

/** The rows the target matcher may see: never the caller itself and never a swap worker's own argv. */
export function targetScope(procs: readonly Proc[], selfPid: number): readonly Proc[] {
  return procs.filter((p) => p.pid !== selfPid && !/(?:^|\s)--swap-worker(?:\s|$)/.test(p.command));
}

/** Releases the worker only after the caller logged the handoff; a write failure leaves it to its timeout. */
export function releaseSwap(started: LaunchedSwap, log: (line: string) => void): void {
  try {
    started.go();
  } catch (e) {
    log(`LEADSWAP WARN go not written: ${failureDetail(e)}`);
  }
}

/** True when the caller itself is inside the lead stack the swap is about to kill, judged by parent pids. */
export function insideLeadTree(
  procs: readonly { readonly pid: number; readonly parent?: number }[],
  leadPids: ReadonlySet<number>,
  selfPid: number,
): boolean {
  const byPid = new Map(procs.map((p) => [p.pid, p]));
  const seen = new Set<number>();
  let current: number | undefined = selfPid;
  while (current !== undefined && current > 0 && !seen.has(current)) {
    if (leadPids.has(current)) return true;
    seen.add(current);
    current = byPid.get(current)?.parent;
  }
  return false;
}

/** The worker's argv: the same CLI, the resolved plan as explicit flags, the go gate, and no second delegation. */
export function swapWorkerArgv(
  argv0: string,
  cli: string,
  plan: LeadSwapPlan,
  marker: string,
  go: string,
  parentPid: number,
  busyToken?: string,
): string[] {
  return [
    argv0,
    cli,
    "lead-restart",
    "--swap-worker",
    "--pane",
    refText(plan.pane),
    "--session",
    plan.session,
    "--drain-ms",
    String(plan.drainMs),
    ...(plan.force ? ["--force"] : []),
    ...(plan.prompt === "" ? [] : ["--prompt", plan.prompt]),
    "--marker",
    marker,
    "--go",
    go,
    "--parent-pid",
    String(parentPid),
    ...(busyToken === undefined ? [] : ["--busy-token", busyToken]),
  ];
}
