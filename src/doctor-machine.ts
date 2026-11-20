import { join } from "node:path";
import type { DoctorProbes, ProbeResult } from "./doctor.ts";
import type { DoctorEnv } from "./doctor-env.ts";
import { atLeast, clip, firstLine, homePath, isRecord, messageOf, nearestExisting, versionOf } from "./doctor-util.ts";

const runtimeCheck = async (e: DoctorEnv): Promise<ProbeResult> => {
  const [bun, node] = await Promise.all([e.run(["bun", "--version"]), e.run(["node", "--version"])]);
  const bunText = bun.code === 0 ? bun.stdout.trim() : "";
  const nodeText = node.code === 0 ? node.stdout.trim() : "";
  const bunVersion = versionOf(bunText) ?? (bunText === "" ? undefined : bunText);
  const nodeVersion = versionOf(nodeText) ?? (nodeText === "" ? undefined : nodeText);
  const nodeNote = nodeVersion === undefined ? "node not found (optional)" : `node ${nodeVersion} (optional)`;
  if (bunVersion === undefined)
    return {
      status: "FAIL",
      detail: `bun is not on PATH; ${nodeNote}`,
      hint: "install bun >= 1.4: https://bun.sh",
    };
  if (!atLeast(bunVersion, 1, 4))
    return {
      status: "FAIL",
      detail: `bun ${bunVersion} is older than 1.4; ${nodeNote}`,
      hint: "upgrade bun: bun upgrade",
    };
  return { status: "PASS", detail: `bun ${bunVersion}; ${nodeNote}` };
};

const gitCheck = async (e: DoctorEnv): Promise<ProbeResult> => {
  const version = await e.run(["git", "--version"]);
  if (version.code !== 0)
    return { status: "FAIL", detail: "git is not on PATH", hint: "install git (Git Bash on Windows)" };
  const inside = await e.run(["git", "rev-parse", "--is-inside-work-tree"], { cwd: e.cwd });
  if (inside.code !== 0 || inside.stdout.trim() !== "true")
    return {
      status: "WARN",
      detail: `not a git repository: ${e.cwd}`,
      hint: "run doctor from a checkout, or clone the project first",
    };
  const [remotes, dirty] = await Promise.all([
    e.run(["git", "remote"], { cwd: e.cwd }),
    e.run(["git", "status", "--porcelain"], { cwd: e.cwd }),
  ]);
  const names =
    remotes.code === 0
      ? remotes.stdout
          .split(/\r?\n/)
          .map((name) => name.trim())
          .filter((name) => name !== "")
      : [];
  const changed = dirty.code === 0 ? dirty.stdout.split(/\r?\n/).filter((line) => line.trim() !== "").length : 0;
  const remoteText = names.length === 0 ? "no remotes" : `remotes: ${names.join(", ")}`;
  if (changed > 0)
    return {
      status: "WARN",
      detail: `${remoteText}; ${changed} uncommitted file(s)`,
      hint: "commit or stash before starting lanes",
    };
  return { status: "PASS", detail: `${remoteText}; clean worktree` };
};

const homeCheck = async (e: DoctorEnv): Promise<ProbeResult> => {
  const root = homePath(e);
  const named = e.env["DORI_HOME"]?.trim() ? "DORI_HOME" : "default";
  if (e.pathExists(root) && !e.isDir(root))
    return {
      status: "FAIL",
      detail: `${root} exists and is not a directory`,
      hint: "remove it or point DORI_HOME elsewhere",
    };
  const writableAt = nearestExisting(e, root);
  if (!e.writable(writableAt))
    return {
      status: "FAIL",
      detail: `${writableAt} is not writable`,
      hint: "fix permissions or set DORI_HOME to a writable path",
    };
  const configPath = join(root, "config.json");
  let configNote = "config.json absent (defaults)";
  if (e.pathExists(configPath)) {
    const text = e.readText(configPath);
    if (text === undefined)
      return { status: "FAIL", detail: `cannot read ${configPath}`, hint: "check the file's permissions" };
    try {
      const parsed: unknown = JSON.parse(text);
      if (!isRecord(parsed))
        return { status: "FAIL", detail: `${configPath} must hold a JSON object`, hint: "fix or remove config.json" };
      configNote = "config.json ok";
    } catch (err) {
      return {
        status: "FAIL",
        detail: `${configPath} is not valid JSON: ${clip(messageOf(err), 90)}`,
        hint: "fix the JSON, or remove the file to use defaults",
      };
    }
  }
  const statePresent = e.isDir(join(root, "state"));
  return {
    status: statePresent ? "PASS" : "WARN",
    detail: `${root} (${named}); ${configNote}; ${statePresent ? "state/ present" : "state/ missing"}`,
    ...(statePresent ? {} : { hint: "run dori up or start a lane once to create it" }),
  };
};

const serverStatus = (text: string): string => {
  const lines = text.split(/\r?\n/);
  const start = lines.findIndex((line) => line.trim() === "server:");
  for (let i = start + 1; start >= 0 && i < lines.length; i++) {
    const status = /^\s+status:\s*(\S+)/.exec(lines[i] ?? "")?.[1];
    if (status !== undefined) return status;
    if (!/^\s/.test(lines[i] ?? "")) break;
  }
  return "unknown";
};

const sessionCheck = async (e: DoctorEnv): Promise<ProbeResult> => {
  const [herdr, hc] = await Promise.all([e.run(["herdr", "--version"]), e.run(["hc", "--version"])]);
  const herdrPresent = herdr.code === 0;
  const hcPresent = hc.code === 0;
  if (!herdrPresent && !hcPresent)
    return {
      status: "FAIL",
      detail: "neither herdr nor hc is on PATH",
      hint: 'install herdr (Doriterm) or hc, then set "runtime" in config.json',
    };
  const hcNote = hcPresent ? `hc ${versionOf(hc.stdout + hc.stderr) ?? "installed"}` : undefined;
  if (herdrPresent) {
    const herdrVersion = versionOf(herdr.stdout + herdr.stderr) ?? "installed";
    const status = await e.run(["herdr", "status"], { timeoutMs: 5000 });
    if (status.code !== 0)
      return {
        status: "WARN",
        detail: `herdr ${herdrVersion}; herdr status failed: ${clip(firstLine(status.stderr || status.stdout), 90)}`,
        hint: "start herdr, or run herdr status to see why",
      };
    return {
      status: "PASS",
      detail: `herdr ${herdrVersion}; server ${serverStatus(status.stdout)}${hcNote === undefined ? "" : `; ${hcNote} also present`}`,
    };
  }
  return { status: "PASS", detail: hcNote ?? "hc installed" };
};

export const machineChecks = (e: DoctorEnv): Pick<DoctorProbes, "runtime" | "git" | "home" | "session"> => ({
  runtime: () => runtimeCheck(e),
  git: () => gitCheck(e),
  home: () => homeCheck(e),
  session: () => sessionCheck(e),
});
