import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { startRemote } from "../src/remote-run.ts";
import {
  RemoteError,
  addRemoteMachine,
  appendRemoteRow,
  parseRemoteConfig,
  planRemoteStart,
  readRemoteConfig,
  readRemoteState,
  recordRemoteStart,
  remoteBriefPaths,
  remoteConfigPath,
  remoteStatePath,
  writeRemoteConfig,
} from "../src/remotes.ts";
import { cleanupHomes, fake, home, linux, sinks, windows } from "./remotes-setup.ts";

afterEach(cleanupHomes);

describe("config", () => {
  test("parsing fills the documented defaults and rejects malformed machines", () => {
    expect(parseRemoteConfig({ machines: [{ name: "box2", ssh: "user@192.168.0.12" }] })).toEqual({
      machines: [{ name: "box2", ssh: "user@192.168.0.12", repo: "~/.dori/src", os: "linux", temp: "/tmp" }],
    });
    for (const bad of [
      { machines: [{ name: "box2", ssh: "user@host", os: "solaris" }] },
      { machines: [{ name: "box2", ssh: "-oProxyCommand=rm" }] },
      { machines: [{ name: "box2", ssh: "user@host", repo: "" }] },
      {
        machines: [
          { name: "a", ssh: "u@h" },
          { name: "a", ssh: "u@h2" },
        ],
      },
      { machines: {} },
    ])
      expect(() => parseRemoteConfig(bad)).toThrow(RemoteError);
  });

  test("add appends once, validates os and repo quoting, and refuses a duplicate name", () => {
    const base = { machines: [] };
    const added = addRemoteMachine(base, { name: "box2", ssh: "user@192.168.0.12", os: "linux" });
    expect(added.machines).toEqual([
      { name: "box2", ssh: "user@192.168.0.12", repo: "~/.dori/src", os: "linux", temp: "/tmp" },
    ]);
    expect(base.machines).toEqual([]);
    expect(() => addRemoteMachine(added, { name: "box2", ssh: "u@h" })).toThrow("already exists");
    expect(() => addRemoteMachine(base, { name: "win", ssh: "u@h", os: "beos" })).toThrow("linux or windows");
    expect(() => addRemoteMachine(base, { name: "win", ssh: "u@h", os: "windows", repo: 'C:\\a"b' })).toThrow(
      "double quote",
    );
  });

  test("a broken config file names the file, not a bare JSON error", () => {
    const dir = home();
    mkdirSync(join(dir, "config"), { recursive: true });
    writeFileSync(remoteConfigPath(dir), "{ nope");
    expect(() => readRemoteConfig(dir)).toThrow(remoteConfigPath(dir));
  });
});

describe("argv", () => {
  test("linux: BatchMode scp to /tmp, tilde repo expanded, key and brief cited", () => {
    const plan = planRemoteStart(linux, "fix-login", "C:/briefs/fix-login.md");
    expect(plan.scpArgv).toEqual([
      "-o",
      "BatchMode=yes",
      "-o",
      "ConnectTimeout=10",
      "--",
      plan.localBrief,
      "user@192.168.0.12:/tmp/dori-fix-login.md",
    ]);
    expect(plan.sshArgv).toEqual([
      "-o",
      "BatchMode=yes",
      "-o",
      "ConnectTimeout=10",
      "user@192.168.0.12",
      "cd ~/'.dori/src' && bun src/cli.ts start 'fix-login' --brief '/tmp/dori-fix-login.md'",
    ]);
  });

  test("windows: one quote-free EncodedCommand both login shells run", () => {
    const plan = planRemoteStart(windows, "fix-login", "brief.md");
    expect(plan.scpArgv.at(-1)).toBe("lee@192.168.0.20:C:/Users/Public/dori/dori-fix-login.md");
    expect(plan.command).toStartWith("powershell -NoProfile -EncodedCommand ");
    const b64 = plan.command.slice("powershell -NoProfile -EncodedCommand ".length);
    expect(Buffer.from(b64, "base64").toString("utf16le")).toBe(
      '& bun "C:\\work\\dori repo\\src\\cli.ts" start fix-login --brief "C:\\Users\\Public\\dori\\dori-fix-login.md" --cwd "C:\\work\\dori repo"',
    );
    expect(plan.command).not.toContain('"');
    expect(plan.command).not.toContain("&&");
    expect(plan.command).not.toContain("%");
    expect(remoteBriefPaths(windows, "x")).toEqual({
      scp: "C:/Users/Public/dori/dori-x.md",
      shell: "C:\\Users\\Public\\dori\\dori-x.md",
    });
  });

  test("windows: a custom temp is honoured and a windows target cannot keep the linux ~ default", () => {
    const plan = planRemoteStart({ ...windows, temp: "D:\\builds\\tmp" }, "fix-login", "brief.md");
    const b64 = plan.command.slice("powershell -NoProfile -EncodedCommand ".length);
    expect(Buffer.from(b64, "base64").toString("utf16le")).toContain('--brief "D:\\builds\\tmp\\dori-fix-login.md"');
    expect(() => parseRemoteConfig({ machines: [{ name: "w", ssh: "u@h", os: "windows" }] })).toThrow("windows path");
  });

  test("a key that is not a lane key never reaches ssh", () => {
    expect(() => planRemoteStart(linux, "Fix Login", "brief.md")).toThrow(/lane key/);
  });
});

describe("state", () => {
  test("config and the start table round-trip under DORI_HOME", () => {
    const dir = home();
    const config = addRemoteMachine(readRemoteConfig(dir), { name: "box2", ssh: "user@192.168.0.12" });
    writeRemoteConfig(dir, config);
    expect(readRemoteConfig(dir)).toEqual(config);
    expect(JSON.parse(readFileSync(remoteConfigPath(dir), "utf8"))).toEqual(config);
    const row = {
      machine: "box2",
      key: "fix-login",
      started_at: 1234,
      ssh: "user@192.168.0.12",
      repo: "~/.dori/src",
    };
    recordRemoteStart(dir, row);
    recordRemoteStart(dir, { ...row, key: "next" });
    expect(readRemoteState(dir).rows.map((r) => r.key)).toEqual(["fix-login", "next"]);
    expect(appendRemoteRow(undefined, row)).toEqual({ rows: [row] });
  });
});

describe("start", () => {
  test("--dry-run prints both commands, spawns nothing and writes no row", async () => {
    const dir = home();
    const { exec, calls } = fake(() => ({ code: 0, stdout: "", stderr: "" }));
    const s = sinks();
    const result = await startRemote({ home: dir, exec, now: () => 1 }, linux, "fix-login", "missing-brief.md", {
      dryRun: true,
      ...s,
    });
    expect(result).toBeUndefined();
    expect(calls).toEqual([]);
    expect(existsSync(remoteStatePath(dir))).toBe(false);
    expect(s.printed()).toContain("DRY-RUN box2 fix-login (linux)");
    expect(s.printed()).toContain("scp -o BatchMode=yes");
    expect(s.printed()).toContain("ssh -o BatchMode=yes");
  });

  test("a start copies, prints the remote output verbatim and records the row", async () => {
    const dir = home();
    const brief = join(dir, "brief.md");
    writeFileSync(brief, "fix it");
    const { exec, calls } = fake((cmd) =>
      cmd === "ssh"
        ? { code: 0, stdout: "STARTED fix-login pane=w1:p2\n", stderr: "warning: remote\n" }
        : { code: 0, stdout: "", stderr: "" },
    );
    const s = sinks();
    const row = await startRemote({ home: dir, exec, now: () => 777 }, linux, "fix-login", brief, s);
    expect(calls.map((c) => c.cmd)).toEqual(["scp", "ssh"]);
    expect(s.printed()).toBe("STARTED fix-login pane=w1:p2\n");
    expect(s.errors()).toBe("warning: remote\n");
    expect(row).toEqual({
      machine: "box2",
      key: "fix-login",
      started_at: 777,
      ssh: "user@192.168.0.12",
      repo: "~/.dori/src",
    });
    expect(readRemoteState(dir).rows).toEqual([row!]);
  });

  test("an scp failure throws its own reason and never runs ssh or writes a row", async () => {
    const dir = home();
    const brief = join(dir, "brief.md");
    writeFileSync(brief, "x");
    const { exec, calls } = fake(() => ({ code: 255, stdout: "", stderr: "Permission denied (publickey)." }));
    await expect(startRemote({ home: dir, exec, now: () => 1 }, linux, "fix-login", brief, sinks())).rejects.toThrow(
      "Permission denied (publickey).",
    );
    expect(calls.map((c) => c.cmd)).toEqual(["scp"]);
    expect(readRemoteState(dir).rows).toEqual([]);
  });

  test("a failed remote start reports the remote stderr and records nothing", async () => {
    const dir = home();
    const brief = join(dir, "brief.md");
    writeFileSync(brief, "x");
    const { exec, calls } = fake((cmd) =>
      cmd === "scp"
        ? { code: 0, stdout: "", stderr: "" }
        : { code: 2, stdout: "", stderr: "error: lane fix-login is already open" },
    );
    await expect(startRemote({ home: dir, exec, now: () => 1 }, linux, "fix-login", brief, sinks())).rejects.toThrow(
      "error: lane fix-login is already open",
    );
    expect(calls.map((c) => c.cmd)).toEqual(["scp", "ssh"]);
    expect(readRemoteState(dir).rows).toEqual([]);
  });

  test("a missing brief is refused before any process starts", async () => {
    const { exec, calls } = fake(() => ({ code: 0, stdout: "", stderr: "" }));
    await expect(
      startRemote({ home: home(), exec, now: () => 1 }, linux, "fix-login", "nope.md", sinks()),
    ).rejects.toThrow("brief not found");
    expect(calls).toEqual([]);
  });
});
