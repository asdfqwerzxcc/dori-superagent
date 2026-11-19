import { mkdirSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { shq } from "./delivery.ts";
import { readJson, writeJson } from "./json-file.ts";
import { Refusal } from "./refusal.ts";
import { KEY_RE } from "./store-types.ts";

/** A machine on the same LAN, reached by plain ssh: no account, relay or cloud service is involved. */
export type RemoteOs = "linux" | "windows";
export type RemoteMachine = { name: string; ssh: string; repo: string; os: RemoteOs; temp: string };
export type RemoteConfig = { machines: RemoteMachine[] };
/** One `dori remote start`: the row the lead reads to know what ran where. */
export type RemoteRow = { machine: string; key: string; started_at: number; ssh: string; repo: string };
export type RemoteState = { rows: RemoteRow[] };

export type RemoteStartPlan = {
  machine: RemoteMachine;
  localBrief: string;
  /** The path scp writes the brief to (forward slashes on windows). */
  remoteBrief: string;
  /** The same file as the remote command names it (the host's own separators). */
  shellBrief: string;
  command: string;
  scpArgv: string[];
  sshArgv: string[];
};

export type NewRemote = { name: string; ssh: string; repo?: string; os?: string; temp?: string };

/** A remote command the user can act on: the CLI prints it and exits, like every other refusal. */
export class RemoteError extends Refusal {}

export const DEFAULT_REMOTE_REPO = "~/.dori/src";
/** Where the brief lands on the remote host. No shell variables: PowerShell never expands `%USERPROFILE%`. */
export const DEFAULT_REMOTE_TEMP: Record<RemoteOs, string> = {
  linux: "/tmp",
  windows: "C:\\Users\\Public\\dori",
};
/** BatchMode fails instead of prompting for a password; ConnectTimeout bounds a dead host's handshake. */
export const SSH_OPTIONS: readonly string[] = ["-o", "BatchMode=yes", "-o", "ConnectTimeout=10"];
const NAME_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,40}$/;

export const remoteConfigPath = (home: string): string => join(home, "config", "remotes.json");
export const remoteStatePath = (home: string): string => join(home, "state", "remotes.json");

const message = (e: unknown): string => (e instanceof Error ? e.message : String(e));
const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);

const text = (v: unknown, at: string): string => {
  if (typeof v !== "string" || v.trim() === "") throw new RemoteError(`${at} must be a non-empty string`);
  return v;
};

const sshTarget = (v: unknown, at: string): string => {
  const value = text(v, at);
  if (value.startsWith("-") || /\s/.test(value))
    throw new RemoteError(`${at} must look like user@host: no whitespace, no leading -`);
  return value;
};

const repoPath = (v: unknown, at: string, os: RemoteOs): string => {
  const value = text(v, at);
  if (/[\r\n\0]/.test(value)) throw new RemoteError(`${at} must be one line`);
  if (os === "windows" && value.includes('"')) throw new RemoteError(`${at} cannot contain a double quote on windows`);
  if (os === "windows" && /[$%`]/.test(value)) throw new RemoteError(`${at} cannot contain $, % or \` on windows`);
  return value;
};

const osOf = (v: unknown, at: string): RemoteOs => {
  const value = v ?? "linux";
  if (value !== "linux" && value !== "windows") throw new RemoteError(`${at} must be linux or windows`);
  return value;
};

const tempPath = (v: unknown, at: string, os: RemoteOs): string => {
  const value = text(v ?? DEFAULT_REMOTE_TEMP[os], at);
  if (/[\r\n\0]/.test(value)) throw new RemoteError(`${at} must be one line`);
  if (os === "windows" && /["$%`]/.test(value))
    throw new RemoteError(`${at} cannot contain a double quote, $, % or \` on windows`);
  return value;
};

const parseMachine = (raw: unknown, at: string): RemoteMachine => {
  if (!isRecord(raw)) throw new RemoteError(`${at} must be an object`);
  const os = osOf(raw["os"], `${at}.os`);
  const name = text(raw["name"], `${at}.name`);
  if (!NAME_RE.test(name)) throw new RemoteError(`${at}.name must match ${NAME_RE}`);
  const repo = repoPath(raw["repo"] ?? DEFAULT_REMOTE_REPO, `${at}.repo`, os);
  if (os === "windows" && repo.startsWith("~/"))
    throw new RemoteError(`${at}.repo must be a windows path when os=windows; pass --repo`);
  return {
    name,
    ssh: sshTarget(raw["ssh"], `${at}.ssh`),
    repo,
    os,
    temp: tempPath(raw["temp"], `${at}.temp`, os),
  };
};

export const parseRemoteConfig = (raw: unknown): RemoteConfig => {
  if (!isRecord(raw) || !Array.isArray(raw["machines"]))
    throw new RemoteError("must be an object with a machines array");
  const machines = raw["machines"].map((m, i) => parseMachine(m, `machines[${i}]`));
  const seen = new Set<string>();
  for (const m of machines) {
    if (seen.has(m.name)) throw new RemoteError(`machine ${m.name} is declared twice`);
    seen.add(m.name);
  }
  return { machines };
};

const readJsonOr = <T>(path: string): T | undefined => {
  try {
    return readJson<T>(path);
  } catch (e) {
    throw new RemoteError(`${path} is not valid JSON: ${message(e)}`);
  }
};

const readChecked = <T>(path: string, parse: (raw: unknown) => T, empty: T): T => {
  const raw = readJsonOr<unknown>(path);
  if (raw === undefined) return empty;
  try {
    return parse(raw);
  } catch (e) {
    throw e instanceof RemoteError ? new RemoteError(`${path}: ${e.message}`) : e;
  }
};

export const readRemoteConfig = (home: string): RemoteConfig =>
  readChecked(remoteConfigPath(home), parseRemoteConfig, { machines: [] });

export const writeRemoteConfig = (home: string, config: RemoteConfig): void => {
  const path = remoteConfigPath(home);
  mkdirSync(dirname(path), { recursive: true });
  writeJson(path, config);
};

export const addRemoteMachine = (config: RemoteConfig, input: NewRemote): RemoteConfig => {
  const machine = parseMachine(
    {
      name: input.name,
      ssh: input.ssh,
      repo: input.repo ?? DEFAULT_REMOTE_REPO,
      os: input.os ?? "linux",
      temp: input.temp,
    },
    "remote",
  );
  if (config.machines.some((m) => m.name === machine.name))
    throw new RemoteError(`remote ${machine.name} already exists`);
  return { machines: [...config.machines, machine] };
};

export const findRemoteMachine = (config: RemoteConfig, name: string): RemoteMachine => {
  const machine = config.machines.find((m) => m.name === name);
  if (!machine) throw new RemoteError(`no remote machine ${name}; add it: dori remote add ${name} --ssh user@host`);
  return machine;
};

const finite = (v: unknown, at: string): number => {
  if (typeof v !== "number" || !Number.isFinite(v)) throw new RemoteError(`${at} must be a finite number`);
  return v;
};

const parseRow = (raw: unknown, at: string): RemoteRow => {
  if (!isRecord(raw)) throw new RemoteError(`${at} must be an object`);
  return {
    machine: text(raw["machine"], `${at}.machine`),
    key: text(raw["key"], `${at}.key`),
    started_at: finite(raw["started_at"], `${at}.started_at`),
    ssh: sshTarget(raw["ssh"], `${at}.ssh`),
    repo: text(raw["repo"], `${at}.repo`),
  };
};

export const parseRemoteState = (raw: unknown): RemoteState => {
  if (!isRecord(raw) || !Array.isArray(raw["rows"])) throw new RemoteError("must be an object with a rows array");
  return { rows: raw["rows"].map((r, i) => parseRow(r, `rows[${i}]`)) };
};

export const readRemoteState = (home: string): RemoteState =>
  readChecked(remoteStatePath(home), parseRemoteState, { rows: [] });

export const appendRemoteRow = (state: RemoteState | undefined, row: RemoteRow): RemoteState => ({
  rows: [...(state?.rows ?? []), row],
});

export const recordRemoteStart = (home: string, row: RemoteRow): RemoteState => {
  const state = appendRemoteRow(readRemoteState(home), row);
  const path = remoteStatePath(home);
  mkdirSync(dirname(path), { recursive: true });
  writeJson(path, state);
  return state;
};

/** scp speaks forward slashes; the remote command keeps the host's own separators. */
export const remoteBriefPaths = (
  machine: Pick<RemoteMachine, "os" | "temp">,
  key: string,
): { scp: string; shell: string } => {
  const temp = machine.temp.replace(/[\\/]+$/, "");
  return machine.os === "linux"
    ? { scp: `${temp}/dori-${key}.md`, shell: `${temp}/dori-${key}.md` }
    : { scp: `${temp.replace(/\\/g, "/")}/dori-${key}.md`, shell: `${temp}\\dori-${key}.md` };
};

/** A Windows command the two possible login shells (cmd, PowerShell) run identically: no quotes, no `&&`, no vars. */
export const windowsCommand = (machine: RemoteMachine, key: string, brief: string): string => {
  const script = `& bun "${machine.repo}\\src\\cli.ts" start ${key} --brief "${brief}" --cwd "${machine.repo}"`;
  return `powershell -NoProfile -EncodedCommand ${Buffer.from(script, "utf16le").toString("base64")}`;
};

/** One POSIX word for a path the remote shell reads; a leading ~/ stays unquoted so the shell expands it. */
const linuxPath = (path: string): string =>
  path === "~" ? "~" : path.startsWith("~/") ? `~/${shq(path.slice(2))}` : shq(path);

export const planRemoteStart = (machine: RemoteMachine, key: string, briefFile: string): RemoteStartPlan => {
  if (!KEY_RE.test(key)) throw new RemoteError(`lane key must match ${KEY_RE}`);
  const localBrief = resolve(briefFile);
  const paths = remoteBriefPaths(machine, key);
  // Linux: one POSIX line. Windows: a base64 -EncodedCommand, so neither cmd.exe nor PowerShell ever parses a quote.
  const command =
    machine.os === "linux"
      ? `cd ${linuxPath(machine.repo)} && bun src/cli.ts start ${shq(key)} --brief ${shq(paths.shell)}`
      : windowsCommand(machine, key, paths.shell);
  return {
    machine,
    localBrief,
    remoteBrief: paths.scp,
    shellBrief: paths.shell,
    command,
    scpArgv: [...SSH_OPTIONS, "--", localBrief, `${machine.ssh}:${paths.scp}`],
    sshArgv: [...SSH_OPTIONS, machine.ssh, command],
  };
};
