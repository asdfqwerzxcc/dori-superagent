import { randomBytes } from "node:crypto";
import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { readJson } from "./json-file.ts";
import { fingerprintOfPem } from "./link-cert.ts";
import {
  CODE_TTL_MS,
  type PairCode,
  codeHash,
  newPairCode,
  pairCodeMatches,
  parseAddr,
  tokenHash,
  tokenMatches,
} from "./link-pair.ts";
import { Refusal } from "./refusal.ts";

export type LinkDevice = {
  name: string;
  address: string;
  fingerprint: string;
  cert: string;
  token: string;
  addedAt: number;
  lastSeenAt?: number;
};
export type DeviceConfig = { devices: LinkDevice[] };
export type AgentToken = { name: string; hash: string; issuedAt: number };
export type AgentTokens = { tokens: AgentToken[] };

export const NAME_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,40}$/;
const FINGERPRINT_RE = /^[0-9a-f]{2}(?::[0-9a-f]{2}){31}$/;
const TOKEN_RE = /^[A-Za-z0-9_-]{40,}$/;
const PEM_RE = /^-----BEGIN CERTIFICATE-----[\s\S]+-----END CERTIFICATE-----\s*$/;

export const devicesPath = (home: string): string => join(home, "config", "devices.json");
export const agentTokensPath = (home: string): string => join(home, "state", "agent-tokens.json");
export const pairCodePath = (home: string): string => join(home, "state", "agent-pair.json");

const message = (e: unknown): string => (e instanceof Error ? e.message : String(e));
const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);

/** Secrets stay owner-only wherever the filesystem honours modes; a failed chmod is never a reason to write plainly. */
const writeSecret = (path: string, value: unknown): void => {
  mkdirSync(dirname(path), { recursive: true });
  const tmp = `${path}.${process.pid}.tmp`;
  writeFileSync(tmp, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 });
  renameSync(tmp, path);
};

const text = (v: unknown, at: string): string => {
  if (typeof v !== "string" || v.trim() === "") throw new Refusal(`${at} must be a non-empty string`);
  return v;
};

const finite = (v: unknown, at: string): number => {
  if (typeof v !== "number" || !Number.isFinite(v)) throw new Refusal(`${at} must be a finite number`);
  return v;
};

const parseDevice = (raw: unknown, at: string): LinkDevice => {
  if (!isRecord(raw)) throw new Refusal(`${at} must be an object`);
  const name = text(raw["name"], `${at}.name`);
  if (!NAME_RE.test(name)) throw new Refusal(`${at}.name must match ${NAME_RE}`);
  const address = text(raw["address"], `${at}.address`);
  parseAddr(address);
  const fingerprint = text(raw["fingerprint"], `${at}.fingerprint`).toLowerCase();
  if (!FINGERPRINT_RE.test(fingerprint)) throw new Refusal(`${at}.fingerprint must be 32 colon-separated hex bytes`);
  const cert = text(raw["cert"], `${at}.cert`);
  if (!PEM_RE.test(cert)) throw new Refusal(`${at}.cert must be a PEM certificate`);
  if (fingerprintOfPem(cert) !== fingerprint)
    throw new Refusal(`${at}.cert does not match ${at}.fingerprint: refusing a pinned device whose cert changed`);
  const token = text(raw["token"], `${at}.token`);
  if (!TOKEN_RE.test(token)) throw new Refusal(`${at}.token is not a dori pairing token`);
  const lastSeenAt = raw["lastSeenAt"] === undefined ? undefined : finite(raw["lastSeenAt"], `${at}.lastSeenAt`);
  return {
    name,
    address,
    fingerprint,
    cert,
    token,
    addedAt: finite(raw["addedAt"], `${at}.addedAt`),
    ...(lastSeenAt === undefined ? {} : { lastSeenAt }),
  };
};

export const parseDeviceConfig = (raw: unknown): DeviceConfig => {
  if (!isRecord(raw) || !Array.isArray(raw["devices"]))
    throw new Refusal("devices.json must be an object with a devices array");
  const devices = raw["devices"].map((d, i) => parseDevice(d, `devices[${i}]`));
  const seen = new Set<string>();
  for (const d of devices) {
    if (seen.has(d.name)) throw new Refusal(`device ${d.name} is declared twice`);
    seen.add(d.name);
  }
  return { devices };
};

export const readDevices = (home: string): DeviceConfig => {
  const path = devicesPath(home);
  if (!existsSync(path)) return { devices: [] };
  try {
    return parseDeviceConfig(readJson<unknown>(path));
  } catch (e) {
    throw e instanceof Refusal ? new Refusal(`${path}: ${e.message}`) : new Refusal(`${path}: ${message(e)}`);
  }
};

export const writeDevices = (home: string, config: DeviceConfig): void => writeSecret(devicesPath(home), config);

export const findDevice = (config: DeviceConfig, name: string): LinkDevice | undefined =>
  config.devices.find((d) => d.name === name);

export const withDevice = (config: DeviceConfig, device: LinkDevice): DeviceConfig =>
  parseDeviceConfig({
    devices: [...config.devices.filter((d) => d.name !== device.name), device],
  });

export const withoutDevice = (config: DeviceConfig, name: string): DeviceConfig => {
  if (!config.devices.some((d) => d.name === name)) throw new Refusal(`no linked device ${name}`);
  return { devices: config.devices.filter((d) => d.name !== name) };
};

export const markSeen = (config: DeviceConfig, name: string, at: number): DeviceConfig => ({
  devices: config.devices.map((d) => (d.name === name ? { ...d, lastSeenAt: at } : d)),
});

const parseAgentTokens = (raw: unknown): AgentTokens => {
  if (!isRecord(raw) || !Array.isArray(raw["tokens"]))
    throw new Refusal("agent-tokens.json must be an object with a tokens array");
  return {
    tokens: raw["tokens"].map((t, i) => {
      if (!isRecord(t)) throw new Refusal(`tokens[${i}] must be an object`);
      const hash = text(t["hash"], `tokens[${i}].hash`);
      if (!/^[0-9a-f]{64}$/.test(hash)) throw new Refusal(`tokens[${i}].hash must be a sha256 hex digest`);
      return {
        name: text(t["name"], `tokens[${i}].name`),
        hash,
        issuedAt: finite(t["issuedAt"], `tokens[${i}].issuedAt`),
      };
    }),
  };
};

export const readAgentTokens = (home: string): AgentTokens => {
  const path = agentTokensPath(home);
  if (!existsSync(path)) return { tokens: [] };
  try {
    return parseAgentTokens(readJson<unknown>(path));
  } catch (e) {
    throw e instanceof Refusal ? new Refusal(`${path}: ${e.message}`) : new Refusal(`${path}: ${message(e)}`);
  }
};

/** The agent keeps only the digest: a copy of agent-tokens.json never authenticates anyone. */
export const issueAgentToken = (home: string, name: string, token: string, now: number): void => {
  const config = readAgentTokens(home);
  writeSecret(agentTokensPath(home), {
    tokens: [...config.tokens.filter((t) => t.name !== name), { name, hash: tokenHash(token), issuedAt: now }],
  });
};

export const agentTokenHashes = (home: string): string[] => readAgentTokens(home).tokens.map((t) => t.hash);

export const authorizeAgentToken = (home: string, token: string): boolean =>
  tokenMatches(agentTokenHashes(home), token);

export const issuePairCode = (
  home: string,
  opts: { now: number; random?: (size: number) => Buffer } = { now: Date.now() },
): string => {
  const code = newPairCode(opts.random ?? randomBytes);
  writeSecret(pairCodePath(home), { hash: codeHash(code), expiresAt: opts.now + CODE_TTL_MS });
  return code;
};

export const readPairCode = (home: string): PairCode | undefined => {
  const path = pairCodePath(home);
  if (!existsSync(path)) return undefined;
  const raw = readJson<unknown>(path);
  if (!isRecord(raw)) throw new Refusal(`${path} must be an object`);
  const hash = text(raw["hash"], "hash");
  if (!/^[0-9a-f]{64}$/.test(hash)) throw new Refusal(`${path}: hash must be a sha256 hex digest`);
  return { hash, expiresAt: finite(raw["expiresAt"], "expiresAt") };
};

/** True exactly once per issued code: the record is removed on success, so a replay finds nothing to match. */
export const consumePairCode = (home: string, code: string, now: number): boolean => {
  const record = readPairCode(home);
  if (record === undefined) return false;
  if (now >= record.expiresAt) {
    rmSync(pairCodePath(home), { force: true });
    return false;
  }
  if (!pairCodeMatches(record, code, now)) return false;
  rmSync(pairCodePath(home), { force: true });
  return true;
};

const ACTIVE_LANE = new Set(["working", "waiting", "ready"]);

export const countLiveLanes = (home: string): number => {
  const dir = join(home, "lanes");
  if (!existsSync(dir)) return 0;
  let live = 0;
  for (const file of readdirSync(dir)) {
    if (!file.endsWith(".json")) continue;
    try {
      const lane = JSON.parse(readFileSync(join(dir, file), "utf8")) as { status?: unknown };
      if (ACTIVE_LANE.has(String(lane.status))) live += 1;
    } catch {
      // A half-written lane file is not a session.
    }
  }
  return live;
};
