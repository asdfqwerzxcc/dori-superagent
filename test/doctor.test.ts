import { expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { existsSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { main } from "../src/cli.ts";
import { parse } from "../src/cli-args.ts";
import { runDoctor, type DoctorProbes, type DoctorReport } from "../src/doctor.ts";
import { machineChecks } from "../src/doctor-machine.ts";
import { stackChecks } from "../src/doctor-stack.ts";
import { defaultDeps } from "../src/harness.ts";
import { bad, fakeDoctorEnv, ok } from "./doctor-setup.ts";
import { setup } from "./harness-setup.ts";

const passing = (): DoctorProbes => ({
  runtime: async () => ({ status: "PASS", detail: "bun 1.4.4" }),
  git: async () => ({ status: "PASS", detail: "clean worktree" }),
  home: async () => ({ status: "PASS", detail: "home ok" }),
  session: async () => ({ status: "PASS", detail: "herdr running" }),
  agent: async () => ({ status: "PASS", detail: "omo configured" }),
  scm: async () => ({ status: "PASS", detail: "gh authenticated" }),
  ssh: async () => ({ status: "PASS", detail: "ssh ok" }),
  ports: async () => ({ status: "PASS", detail: "ports free" }),
  resources: async () => ({ status: "PASS", detail: "resources ok" }),
});

const runJson = async (probes: DoctorProbes): Promise<{ code: number; report: DoctorReport }> => {
  const lines: string[] = [];
  const code = await runDoctor({ json: true, online: false }, probes, (line) => lines.push(line));
  expect(lines).toHaveLength(1);
  return { code, report: JSON.parse(lines[0] ?? "") as DoctorReport };
};

test("--json prints one report with the documented shape and exits 0 when nothing FAILs", async () => {
  const { code, report } = await runJson(passing());
  expect(code).toBe(0);
  expect(report.schemaVersion).toBe(1);
  expect(report.online).toBe(false);
  expect(report.ok).toBe(true);
  expect(report.summary).toEqual({ pass: 9, warn: 0, fail: 0 });
  expect(report.checks.map((check) => check.id)).toEqual([
    "runtime",
    "git",
    "home",
    "session",
    "agent",
    "scm",
    "ssh",
    "ports",
    "resources",
  ]);
  for (const check of report.checks) {
    expect(["PASS", "WARN", "FAIL"]).toContain(check.status);
    expect(typeof check.title).toBe("string");
    expect(typeof check.detail).toBe("string");
  }
});

test("a FAIL check exits 1 and a WARN check still exits 0", async () => {
  const failed = await runJson({ ...passing(), runtime: async () => ({ status: "FAIL", detail: "bun missing" }) });
  expect(failed.code).toBe(1);
  expect(failed.report.ok).toBe(false);
  expect(failed.report.summary).toEqual({ pass: 8, warn: 0, fail: 1 });

  const warned = await runJson({ ...passing(), git: async () => ({ status: "WARN", detail: "not a repo" }) });
  expect(warned.code).toBe(0);
  expect(warned.report.ok).toBe(true);
  expect(warned.report.summary).toEqual({ pass: 8, warn: 1, fail: 0 });
});

test("text output is a PASS/WARN/FAIL table with hints and a summary", async () => {
  const lines: string[] = [];
  const probes: DoctorProbes = {
    ...passing(),
    git: async () => ({ status: "WARN", detail: "not a repo", hint: "cd into one" }),
  };
  const code = await runDoctor({ json: false, online: false }, probes, (line) => lines.push(line));
  expect(code).toBe(0);
  expect(lines[0]).toBe("dori doctor (offline)");
  expect(lines.some((line) => line.startsWith("WARN  git"))).toBe(true);
  expect(lines.some((line) => line.includes("hint: cd into one"))).toBe(true);
  expect(lines.at(-1)).toBe("SUMMARY pass=8 warn=1 fail=0");
});

test("a probe that throws becomes a FAIL check instead of ending the run", async () => {
  const probes = {
    ...passing(),
    ports: async () => {
      throw new Error("probe exploded");
    },
  };
  const { code, report } = await runJson(probes);
  expect(code).toBe(1);
  const ports = report.checks.find((check) => check.id === "ports");
  expect(ports?.status).toBe("FAIL");
  expect(ports?.detail).toContain("probe exploded");
});

test("offline defaults never call gh/glab auth and never print a token", async () => {
  const home = join("/home", "me");
  const root = join(home, ".dori");
  const { env, calls } = fakeDoctorEnv({
    homeDir: home,
    env: { DORI_HOME: root },
    dirs: [root, join(root, "state"), join(home, ".ssh")],
    files: { [join(home, ".omo", "omo.json")]: JSON.stringify({ categories: { quick: { model: "fast" } } }) },
    commands: {
      "bun --version": ok("1.4.4"),
      "node --version": ok("v22.0.0"),
      "git --version": ok("git version 2.43.0"),
      "git rev-parse --is-inside-work-tree": ok("true"),
      "git remote": ok("origin"),
      "git status --porcelain": ok(""),
      "herdr --version": ok("herdr 0.9.5"),
      "herdr status": ok("client:\n  version: 0.9.5\nserver:\n  status: running"),
      "hc --version": bad(),
      "omo --version": ok("omo 5.1.79"),
      "senpi --version": bad(),
      "gh --version": ok("gh version 2.40.0"),
      "glab --version": bad(),
      "ssh -V": ok("", "OpenSSH_9.2p1, OpenSSL 3.0"),
      "gh auth status": ok("token gho_SHOULD_NOT_RUN"),
      "glab auth status": ok("token SHOULD_NOT_RUN"),
    },
  });
  const lines: string[] = [];
  const code = await runDoctor({ json: true, online: false }, { ...machineChecks(env), ...stackChecks(env) }, (line) =>
    lines.push(line),
  );
  expect(code).toBe(0);
  const called = calls.map((argv) => argv.join(" "));
  expect(called).not.toContain("gh auth status");
  expect(called).not.toContain("glab auth status");
  expect(lines.join("\n")).not.toContain("gho_SHOULD_NOT_RUN");
  const report = JSON.parse(lines[0] ?? "") as DoctorReport;
  expect(report.checks.find((check) => check.id === "scm")?.detail).toContain("auth not checked (offline)");
});

test("--online checks auth, warns on failure, and never echoes its output", async () => {
  const { env, calls } = fakeDoctorEnv({
    online: true,
    commands: {
      "gh --version": ok("gh version 2.40.0"),
      "gh auth status": bad(1, "invalid token gho_SECRET"),
      "glab --version": bad(),
    },
  });
  const result = await stackChecks(env).scm();
  expect(result.status).toBe("WARN");
  expect(calls.map((argv) => argv.join(" "))).toContain("gh auth status");
  expect(JSON.stringify(result)).not.toContain("gho_SECRET");
});

test("doctor flags are boolean and extra arguments are refused", async () => {
  const args = parse(["doctor", "--json", "--online"]);
  expect(args.pos).toEqual(["doctor"]);
  expect(args.flags.get("json")).toEqual(["true"]);
  expect(args.flags.get("online")).toEqual(["true"]);
  const { d } = setup();
  await expect(main(["doctor", "extra"], d)).rejects.toThrow("doctor takes no arguments");
});

test("default deps leave DORI_HOME alone until the store is used, so doctor can report a broken home", () => {
  const home = join(tmpdir(), `dori-doctor-lazy-${randomUUID()}`);
  const saved = process.env["DORI_HOME"];
  process.env["DORI_HOME"] = home;
  try {
    const d = defaultDeps();
    expect(existsSync(home)).toBe(false);
    expect(d.store.root).toBe(home);
    expect(existsSync(home)).toBe(true);
  } finally {
    if (saved === undefined) delete process.env["DORI_HOME"];
    else process.env["DORI_HOME"] = saved;
    rmSync(home, { recursive: true, force: true });
  }
});
