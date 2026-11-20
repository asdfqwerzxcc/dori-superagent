import { defaultDoctorEnv, type DoctorEnv } from "./doctor-env.ts";
import { machineChecks } from "./doctor-machine.ts";
import { stackChecks } from "./doctor-stack.ts";
import { messageOf } from "./doctor-util.ts";

export type CheckStatus = "PASS" | "WARN" | "FAIL";

export type ProbeResult = {
  readonly status: CheckStatus;
  readonly detail: string;
  readonly hint?: string;
};

export type DoctorCheck = ProbeResult & { readonly id: string; readonly title: string };

export type DoctorOptions = { readonly json: boolean; readonly online: boolean };

export type DoctorProbes = {
  readonly runtime: () => Promise<ProbeResult>;
  readonly git: () => Promise<ProbeResult>;
  readonly home: () => Promise<ProbeResult>;
  readonly session: () => Promise<ProbeResult>;
  readonly agent: () => Promise<ProbeResult>;
  readonly scm: () => Promise<ProbeResult>;
  readonly ssh: () => Promise<ProbeResult>;
  readonly ports: () => Promise<ProbeResult>;
  readonly resources: () => Promise<ProbeResult>;
};

export type DoctorReport = {
  readonly schemaVersion: 1;
  readonly online: boolean;
  readonly ok: boolean;
  readonly checks: readonly DoctorCheck[];
  readonly summary: { readonly pass: number; readonly warn: number; readonly fail: number };
};

const CHECKS = [
  ["runtime", "runtime"],
  ["git", "git"],
  ["home", "dori home"],
  ["session", "session runtime"],
  ["agent", "agent engine"],
  ["scm", "scm tools"],
  ["ssh", "ssh"],
  ["ports", "ports"],
  ["resources", "disk / memory"],
] as const satisfies readonly (readonly [keyof DoctorProbes, string])[];

const allProbes = (env: DoctorEnv): DoctorProbes => ({ ...machineChecks(env), ...stackChecks(env) });

const reportOf = (options: DoctorOptions, checks: readonly DoctorCheck[]): DoctorReport => {
  const summary = {
    pass: checks.filter((check) => check.status === "PASS").length,
    warn: checks.filter((check) => check.status === "WARN").length,
    fail: checks.filter((check) => check.status === "FAIL").length,
  };
  return { schemaVersion: 1, online: options.online, ok: summary.fail === 0, checks, summary };
};

const renderText = (report: DoctorReport): string[] => {
  const width = Math.max(...report.checks.map((check) => check.title.length));
  const lines = [`dori doctor (${report.online ? "online" : "offline"})`];
  for (const check of report.checks) {
    lines.push(`${check.status.padEnd(4)}  ${check.title.padEnd(width)}  ${check.detail}`);
    if (check.hint !== undefined) lines.push(`${" ".repeat(width + 8)}hint: ${check.hint}`);
  }
  lines.push(`SUMMARY pass=${report.summary.pass} warn=${report.summary.warn} fail=${report.summary.fail}`);
  return lines;
};

/**
 * Runs every check in a fixed order and prints a PASS/WARN/FAIL table, or the report as JSON. The exit code is 1 when
 * any check FAILs, so a broken machine stops a script instead of passing silently.
 */
export async function runDoctor(
  options: DoctorOptions,
  probes: DoctorProbes = allProbes(defaultDoctorEnv(options.online)),
  write: (line: string) => void = console.log,
): Promise<number> {
  const checks: DoctorCheck[] = [];
  for (const [id, title] of CHECKS) {
    let result: ProbeResult;
    try {
      result = await probes[id]();
    } catch (e) {
      result = {
        status: "FAIL",
        detail: `check crashed: ${messageOf(e)}`,
        hint: "this is a bug in dori doctor; the JSON output carries the same detail",
      };
    }
    checks.push({ id, title, ...result });
  }
  const report = reportOf(options, checks);
  if (options.json) write(JSON.stringify(report, null, 2));
  else for (const line of renderText(report)) write(line);
  return report.ok ? 0 : 1;
}
