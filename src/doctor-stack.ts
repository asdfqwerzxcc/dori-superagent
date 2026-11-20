import { join } from "node:path";
import type { DoctorProbes, ProbeResult } from "./doctor.ts";
import type { DoctorEnv } from "./doctor-env.ts";
import {
  GIB,
  clip,
  hasCredentials,
  hasModel,
  homePath,
  isRecord,
  messageOf,
  nearestExisting,
  versionOf,
} from "./doctor-util.ts";

const agentCheck = async (e: DoctorEnv): Promise<ProbeResult> => {
  const [omo, senpi] = await Promise.all([e.run(["omo", "--version"]), e.run(["senpi", "--version"])]);
  const omoVersion = omo.code === 0 ? (versionOf(omo.stdout + omo.stderr) ?? "installed") : undefined;
  const senpiVersion = senpi.code === 0 ? (versionOf(senpi.stdout + senpi.stderr) ?? "installed") : undefined;
  if (omoVersion === undefined && senpiVersion === undefined)
    return {
      status: "FAIL",
      detail: "neither omo nor senpi is on PATH",
      hint: "install omo, then run omo login",
    };
  const engine = omoVersion !== undefined ? `omo ${omoVersion}` : `senpi ${senpiVersion}`;
  const configPath = join(e.homeDir, ".omo", "omo.json");
  if (!e.pathExists(configPath))
    return {
      status: "WARN",
      detail: `${engine}; no ${configPath}`,
      hint: "run omo login and configure at least one category model",
    };
  const text = e.readText(configPath);
  if (text === undefined)
    return { status: "FAIL", detail: `cannot read ${configPath}`, hint: "check the file's permissions" };
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch (err) {
    return {
      status: "FAIL",
      detail: `${configPath} is not valid JSON: ${clip(messageOf(err), 90)}`,
      hint: "fix the JSON before starting an agent",
    };
  }
  if (!isRecord(parsed))
    return {
      status: "FAIL",
      detail: `${configPath} must hold a JSON object`,
      hint: "fix the JSON before starting an agent",
    };
  const categories = isRecord(parsed["categories"])
    ? Object.values(parsed["categories"]).filter((entry) => hasModel(entry)).length
    : 0;
  const credentials = hasCredentials(parsed);
  const hints: string[] = [];
  if (categories === 0) hints.push("set at least one categories.<name>.model in omo.json");
  if (credentials) hints.push("credentials live in this machine's omo.json: never copy or commit it");
  return {
    status: categories === 0 || credentials ? "WARN" : "PASS",
    detail: `${engine}; ${categories} category model(s) in ${configPath}${credentials ? "; credentials present (machine-local, not shown)" : ""}`,
    ...(hints.length === 0 ? {} : { hint: hints.join("; ") }),
  };
};

const scmCheck = async (e: DoctorEnv): Promise<ProbeResult> => {
  const [gh, glab] = await Promise.all([e.run(["gh", "--version"]), e.run(["glab", "--version"])]);
  const tools = [
    { name: "gh", present: gh.code === 0, version: versionOf(gh.stdout + gh.stderr) },
    { name: "glab", present: glab.code === 0, version: versionOf(glab.stdout + glab.stderr) },
  ];
  const present = tools.filter((tool) => tool.present);
  if (present.length === 0)
    return {
      status: "WARN",
      detail: "neither gh nor glab is on PATH",
      hint: "install gh for GitHub or glab for GitLab to open PRs/MRs",
    };
  const parts = tools.map((tool) =>
    tool.present ? `${tool.name} ${tool.version ?? "installed"}` : `${tool.name} missing`,
  );
  if (!e.online)
    return {
      status: "PASS",
      detail: `${parts.join("; ")}; auth not checked (offline)`,
      hint: "run dori doctor --online to check gh/glab auth",
    };
  const auth: string[] = [];
  let failed = false;
  for (const tool of present) {
    const result = await e.run([tool.name, "auth", "status"], { timeoutMs: 15_000 });
    if (result.code !== 0) failed = true;
    auth.push(`${tool.name} ${result.code === 0 ? "authenticated" : "not authenticated"}`);
  }
  return {
    status: failed ? "WARN" : "PASS",
    detail: `${parts.join("; ")}; ${auth.join("; ")}`,
    ...(failed ? { hint: "run gh auth login or glab auth login on this machine" } : {}),
  };
};

const sshCheck = async (e: DoctorEnv): Promise<ProbeResult> => {
  const result = await e.run(["ssh", "-V"]);
  const output = result.stderr + result.stdout;
  const present = result.code === 0 || /OpenSSH/i.test(output);
  if (!present)
    return {
      status: "WARN",
      detail: "ssh is not on PATH",
      hint: "install OpenSSH; dori remote lanes need it",
    };
  const openssh = /OpenSSH[_\s]([0-9][0-9A-Za-z.]*)/.exec(output)?.[1] ?? versionOf(output) ?? "installed";
  const sshDir = join(e.homeDir, ".ssh");
  const dirPresent = e.isDir(sshDir);
  const text = dirPresent ? e.readText(join(sshDir, "config")) : undefined;
  const hosts = text === undefined ? 0 : text.split(/\r?\n/).filter((line) => /^\s*Host\s+/i.test(line)).length;
  const configNote = !dirPresent
    ? ".ssh/ missing"
    : text === undefined
      ? "no ~/.ssh/config"
      : `${hosts} Host ${hosts === 1 ? "entry" : "entries"}`;
  return {
    status: dirPresent ? "PASS" : "WARN",
    detail: `ssh ${openssh}; ${configNote}`,
    ...(dirPresent ? {} : { hint: "create ~/.ssh and add a key before using dori remote" }),
  };
};

const PORTS = [
  [8084, "gateway"],
  [7799, "pairing (planned)"],
] as const;

const portsCheck = async (e: DoctorEnv): Promise<ProbeResult> => {
  const readings = await Promise.all(
    PORTS.map(async ([port, label]) => ({ port, label, open: await e.portOpen(port) })),
  );
  const parts = readings.map(({ port, label, open }) => {
    const state = open === true ? `in use (${label})` : open === false ? "free" : "unchecked";
    return `${port} ${state}`;
  });
  const used = readings.filter((reading) => reading.open === true);
  const unknown = readings.filter((reading) => reading.open === undefined);
  if (used.length > 0)
    return {
      status: "WARN",
      detail: parts.join("; "),
      hint: "stop the other dori/gateway listening there, or change its port",
    };
  if (unknown.length > 0)
    return {
      status: "WARN",
      detail: parts.join("; "),
      hint: "a local port probe timed out; check the firewall",
    };
  return { status: "PASS", detail: parts.join("; ") };
};

const resourcesCheck = async (e: DoctorEnv): Promise<ProbeResult> => {
  const path = nearestExisting(e, homePath(e));
  const free = e.diskFreeBytes(path);
  const total = e.totalMemBytes();
  const parts = [
    free === undefined ? "free disk unknown" : `free disk ${(free / GIB).toFixed(1)} GiB`,
    `memory ${(total / GIB).toFixed(1)} GiB total`,
  ];
  const hints: string[] = [];
  if (free === undefined) hints.push("free disk could not be read");
  else if (free < 2 * GIB) hints.push("less than 2 GiB free disk");
  if (total < 8 * GIB) hints.push("less than 8 GiB total memory");
  return {
    status: hints.length === 0 ? "PASS" : "WARN",
    detail: parts.join("; "),
    ...(hints.length === 0 ? {} : { hint: hints.join("; ") }),
  };
};

export const stackChecks = (e: DoctorEnv): Pick<DoctorProbes, "agent" | "scm" | "ssh" | "ports" | "resources"> => ({
  agent: () => agentCheck(e),
  scm: () => scmCheck(e),
  ssh: () => sshCheck(e),
  ports: () => portsCheck(e),
  resources: () => resourcesCheck(e),
});
