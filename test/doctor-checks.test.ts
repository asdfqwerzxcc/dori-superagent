import { expect, test } from "bun:test";
import { join } from "node:path";
import { machineChecks } from "../src/doctor-machine.ts";
import { stackChecks } from "../src/doctor-stack.ts";
import { bad, fakeDoctorEnv, GIB, ok } from "./doctor-setup.ts";

test("runtime: missing bun and bun below 1.4 are FAIL; node stays optional", async () => {
  const missing = fakeDoctorEnv({ commands: { "node --version": ok("v22.0.0") } });
  expect((await machineChecks(missing.env).runtime()).status).toBe("FAIL");

  const old = fakeDoctorEnv({ commands: { "bun --version": ok("1.3.9"), "node --version": ok("v22.0.0") } });
  const oldResult = await machineChecks(old.env).runtime();
  expect(oldResult.status).toBe("FAIL");
  expect(oldResult.detail).toContain("1.3.9");

  const good = fakeDoctorEnv({ commands: { "bun --version": ok("1.4.4") } });
  const goodResult = await machineChecks(good.env).runtime();
  expect(goodResult.status).toBe("PASS");
  expect(goodResult.detail).toContain("node not found (optional)");
});

test("git: outside a repo is WARN, a dirty checkout is WARN, a clean one names its remotes", async () => {
  const version = { "git --version": ok("git version 2.43.0") };
  const outside = fakeDoctorEnv({
    commands: { ...version, "git rev-parse --is-inside-work-tree": bad(128) },
  });
  expect((await machineChecks(outside.env).git()).status).toBe("WARN");

  const dirty = fakeDoctorEnv({
    commands: {
      ...version,
      "git rev-parse --is-inside-work-tree": ok("true"),
      "git remote": ok("origin\nfork\n"),
      "git status --porcelain": ok(" M a.ts\n?? b.ts\n"),
    },
  });
  const dirtyResult = await machineChecks(dirty.env).git();
  expect(dirtyResult.status).toBe("WARN");
  expect(dirtyResult.detail).toContain("2 uncommitted");
  expect(dirtyResult.detail).toContain("origin, fork");

  const clean = fakeDoctorEnv({
    commands: {
      ...version,
      "git rev-parse --is-inside-work-tree": ok("true"),
      "git remote": ok("origin\n"),
      "git status --porcelain": ok(""),
    },
  });
  expect((await machineChecks(clean.env).git()).status).toBe("PASS");
  expect((await machineChecks(fakeDoctorEnv().env).git()).status).toBe("FAIL");
});

test("dori home: invalid config FAILs, missing state WARNs, an unwritable home FAILs", async () => {
  const home = join("/home", "me");
  const root = join(home, ".dori");

  const invalid = fakeDoctorEnv({
    homeDir: home,
    env: { DORI_HOME: root },
    dirs: [root],
    files: { [join(root, "config.json")]: "{" },
  });
  const invalidResult = await machineChecks(invalid.env).home();
  expect(invalidResult.status).toBe("FAIL");
  expect(invalidResult.detail).toContain("not valid JSON");

  const fresh = fakeDoctorEnv({ homeDir: home, env: { DORI_HOME: root }, dirs: [root] });
  const freshResult = await machineChecks(fresh.env).home();
  expect(freshResult.status).toBe("WARN");
  expect(freshResult.detail).toContain("state/ missing");

  const readOnly = fakeDoctorEnv({
    homeDir: home,
    env: { DORI_HOME: root },
    dirs: [root, join(root, "state")],
    writable: false,
  });
  expect((await machineChecks(readOnly.env).home()).status).toBe("FAIL");
});

test("session runtime: neither binary FAILs, a failed herdr status WARNs, a running server passes", async () => {
  expect((await machineChecks(fakeDoctorEnv().env).session()).status).toBe("FAIL");

  const broken = fakeDoctorEnv({
    commands: { "herdr --version": ok("herdr 0.9.5"), "herdr status": bad(1, "socket down") },
  });
  const brokenResult = await machineChecks(broken.env).session();
  expect(brokenResult.status).toBe("WARN");
  expect(brokenResult.detail).toContain("socket down");

  const good = fakeDoctorEnv({
    commands: {
      "herdr --version": ok("herdr 0.9.5"),
      "herdr status": ok("client:\n  version: 0.9.5\nserver:\n  status: running\n"),
    },
  });
  const goodResult = await machineChecks(good.env).session();
  expect(goodResult.status).toBe("PASS");
  expect(goodResult.detail).toContain("server running");

  const hcOnly = fakeDoctorEnv({ commands: { "hc --version": ok("hc 0.2.0") } });
  const hcResult = await machineChecks(hcOnly.env).session();
  expect(hcResult.status).toBe("PASS");
  expect(hcResult.detail).toContain("hc 0.2.0");
});

test("agent engine: unparsable config FAILs, no category model WARNs, credentials WARN without leaking", async () => {
  const home = join("/home", "me");
  const config = join(home, ".omo", "omo.json");
  const base = { "omo --version": ok("omo 5.1.79"), "senpi --version": bad() };

  expect((await stackChecks(fakeDoctorEnv().env).agent()).status).toBe("FAIL");

  const malformed = fakeDoctorEnv({ homeDir: home, commands: base, files: { [config]: "{" } });
  expect((await stackChecks(malformed.env).agent()).status).toBe("FAIL");

  const empty = fakeDoctorEnv({
    homeDir: home,
    commands: base,
    files: { [config]: JSON.stringify({ categories: {} }) },
  });
  expect((await stackChecks(empty.env).agent()).status).toBe("WARN");

  const credentials = fakeDoctorEnv({
    homeDir: home,
    commands: base,
    files: { [config]: JSON.stringify({ categories: { quick: { model: "fast" } }, token: "sekret" }) },
  });
  const credentialResult = await stackChecks(credentials.env).agent();
  expect(credentialResult.status).toBe("WARN");
  expect(credentialResult.detail).toContain("credentials present");
  expect(JSON.stringify(credentialResult)).not.toContain("sekret");

  const good = fakeDoctorEnv({
    homeDir: home,
    commands: base,
    files: { [config]: JSON.stringify({ categories: { quick: { model: "fast" } } }) },
  });
  expect((await stackChecks(good.env).agent()).status).toBe("PASS");
});

test("scm tools: no binary WARNs, offline presence skips auth, online auth failure WARNs", async () => {
  expect((await stackChecks(fakeDoctorEnv().env).scm()).status).toBe("WARN");

  const offline = fakeDoctorEnv({ commands: { "gh --version": ok("gh version 2.40.0") } });
  const offlineResult = await stackChecks(offline.env).scm();
  expect(offlineResult.status).toBe("PASS");
  expect(offlineResult.detail).toContain("auth not checked");
  expect(offline.calls.map((argv) => argv.join(" "))).not.toContain("gh auth status");

  const online = fakeDoctorEnv({
    online: true,
    commands: { "gh --version": ok("gh version 2.40.0"), "gh auth status": ok() },
  });
  expect((await stackChecks(online.env).scm()).status).toBe("PASS");

  const failed = fakeDoctorEnv({
    online: true,
    commands: { "glab --version": ok("glab version 1.36.0"), "glab auth status": bad(1) },
  });
  expect((await stackChecks(failed.env).scm()).status).toBe("WARN");
});

test("ssh: missing is WARN, Host entries are counted, a missing .ssh dir WARNs", async () => {
  const home = join("/home", "me");
  expect((await stackChecks(fakeDoctorEnv().env).ssh()).status).toBe("WARN");

  const good = fakeDoctorEnv({
    homeDir: home,
    commands: { "ssh -V": ok("", "OpenSSH_9.2p1, OpenSSL 3.0") },
    dirs: [join(home, ".ssh")],
    files: { [join(home, ".ssh", "config")]: "Host a\n  HostName a\nHost b\n  HostName b\n" },
  });
  const goodResult = await stackChecks(good.env).ssh();
  expect(goodResult.status).toBe("PASS");
  expect(goodResult.detail).toContain("2 Host entries");

  const noDir = fakeDoctorEnv({ homeDir: home, commands: { "ssh -V": ok("", "OpenSSH_9.2p1") } });
  expect((await stackChecks(noDir.env).ssh()).status).toBe("WARN");
});

test("ports: a listener WARNs, both free passes, an unknown probe WARNs", async () => {
  const used = fakeDoctorEnv({ ports: { 8084: true, 7799: false } });
  const usedResult = await stackChecks(used.env).ports();
  expect(usedResult.status).toBe("WARN");
  expect(usedResult.detail).toContain("8084 in use (gateway)");

  expect((await stackChecks(fakeDoctorEnv().env).ports()).status).toBe("PASS");

  const unknown = fakeDoctorEnv({ ports: { 8084: undefined, 7799: false } });
  expect((await stackChecks(unknown.env).ports()).status).toBe("WARN");
});

test("resources: low disk or low memory WARNs, plenty passes, an unknown disk WARNs", async () => {
  const lowDisk = fakeDoctorEnv({ diskFree: 1 * GIB, totalMem: 16 * GIB });
  const diskResult = await stackChecks(lowDisk.env).resources();
  expect(diskResult.status).toBe("WARN");
  expect(diskResult.hint).toContain("less than 2 GiB");

  const lowMemory = fakeDoctorEnv({ diskFree: 20 * GIB, totalMem: 4 * GIB });
  const memoryResult = await stackChecks(lowMemory.env).resources();
  expect(memoryResult.status).toBe("WARN");
  expect(memoryResult.hint).toContain("less than 8 GiB");

  expect((await stackChecks(fakeDoctorEnv().env).resources()).status).toBe("PASS");
  expect((await stackChecks(fakeDoctorEnv({ diskFree: "unknown" }).env).resources()).status).toBe("WARN");
});
