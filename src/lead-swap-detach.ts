// Launching the lead swap from outside the lead's process tree. On Windows a killed Bun/Node process takes its job's
// descendants with it (measured: a plain child of a Bun process dies even without `taskkill /T`), so a swap that runs
// inside the lead would kill itself at the first PID. Win32_Process.Create runs the worker under WmiPrvSE: a different
// process tree, no inherited console, and a hidden window.

import { existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
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
  readonly launcherDir: string;
};

const quote = (value: string): string => `'${value.replaceAll("'", "''")}'`;

const powershellPath = (): string =>
  join(process.env["SystemRoot"] ?? "C:\\Windows", "System32", "WindowsPowerShell", "v1.0", "powershell.exe");

const PASS_ENV = new Set([
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
]);

/** The environment the out-of-tree worker needs: the OS basics, every DORI_/HERDR_ setting, then the caller's own. */
export function swapWorkerEnv(
  base: Readonly<Record<string, string | undefined>>,
  extra: Readonly<Record<string, string>>,
): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [key, value] of Object.entries(base)) {
    if (value === undefined || value === "" || key.startsWith("=")) continue;
    if (!key.startsWith("DORI_") && !key.startsWith("HERDR_") && !PASS_ENV.has(key)) continue;
    if (/[\r\n]/.test(value)) continue;
    out[key] = value;
  }
  return { ...out, ...extra };
}

/**
 * Starts the worker through WMI and waits for its ready marker. The returned pid is the PowerShell launcher; the worker
 * it starts is a child of WmiPrvSE, so killing the lead cannot reach it. Throws when WMI refused or the marker never
 * appeared, and the caller then kills nothing.
 */
export async function launchOutOfTree(exec: Exec, launch: OutOfTreeLaunch): Promise<number> {
  mkdirSync(dirname(launch.marker), { recursive: true });
  mkdirSync(launch.launcherDir, { recursive: true });
  rmSync(launch.marker, { force: true });
  const launcher = join(launch.launcherDir, `lead-swap-${process.pid}-${Date.now()}.ps1`);
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
  let result: Awaited<ReturnType<Exec>>;
  try {
    result = await exec(powershellPath(), ["-NoProfile", "-NonInteractive", "-Command", script], {});
  } catch (e) {
    rmSync(launcher, { force: true });
    throw e;
  }
  const pid = Number(/PID=(\d+)/.exec(result.stdout)?.[1]);
  if (result.code !== 0 || !Number.isInteger(pid) || pid <= 0) {
    rmSync(launcher, { force: true });
    const why = (result.stderr || result.stdout).trim().replaceAll(/\s+/g, " ").slice(0, 300);
    throw new Error(`Win32_Process.Create failed (${result.code}): ${why}`);
  }
  const deadline = Date.now() + 5000;
  while (Date.now() < deadline) {
    if (existsSync(launch.marker)) return pid;
    await Bun.sleep(100);
  }
  throw new Error(`the out-of-tree swap pid=${pid} did not report ready within 5000ms`);
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

/** The worker's argv: the same CLI, the resolved plan as explicit flags, and no second delegation. */
export function swapWorkerArgv(argv0: string, cli: string, plan: LeadSwapPlan, marker: string): string[] {
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
  ];
}
