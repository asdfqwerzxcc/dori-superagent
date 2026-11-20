import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { generateAgentCert } from "../src/link-cert.ts";
import { CODE_TTL_MS, newToken } from "../src/link-pair.ts";
import {
  type DeviceConfig,
  type LinkDevice,
  agentTokenHashes,
  agentTokensPath,
  authorizeAgentToken,
  consumePairCode,
  countLiveLanes,
  devicesPath,
  findDevice,
  issueAgentToken,
  issuePairCode,
  markSeen,
  pairCodePath,
  parseDeviceConfig,
  readDevices,
  withDevice,
  withoutDevice,
  writeDevices,
} from "../src/link-store.ts";
import { Refusal } from "../src/refusal.ts";

const NOW = 1_700_000_000_000;
const homes: string[] = [];
const home = (): string => {
  const dir = mkdtempSync(join(tmpdir(), "dori-link-"));
  homes.push(dir);
  return dir;
};
afterEach(() => {
  for (const dir of homes.splice(0)) rmSync(dir, { recursive: true, force: true });
});

const device = (name = "box2", address = "192.168.0.12:7799"): LinkDevice => {
  const cert = generateAgentCert(name, NOW);
  return { name, address, fingerprint: cert.fingerprint, cert: cert.cert, token: newToken(), addedAt: NOW };
};

describe("pairing code store", () => {
  test("one code, one use, stored as a digest and removed after it is spent", () => {
    const dir = home();
    const code = issuePairCode(dir, { now: NOW, random: (n) => Buffer.alloc(n, 7) });
    expect(readFileSync(pairCodePath(dir), "utf8")).not.toContain(code);
    expect(consumePairCode(dir, code, NOW)).toBe(true);
    expect(existsSync(pairCodePath(dir))).toBe(false);
    expect(consumePairCode(dir, code, NOW)).toBe(false);
  });

  test("an expired code is refused and cannot be reused later", () => {
    const dir = home();
    const code = issuePairCode(dir, { now: NOW });
    expect(consumePairCode(dir, code, NOW + CODE_TTL_MS)).toBe(false);
    expect(existsSync(pairCodePath(dir))).toBe(false);
    expect(consumePairCode(dir, code, NOW)).toBe(false);
  });

  test("a typo is refused and leaves the good code usable", () => {
    const dir = home();
    const code = issuePairCode(dir, { now: NOW, random: (n) => Buffer.from(Array.from({ length: n }, (_, i) => i)) });
    const typo = `${code.slice(0, 7)}${code[7] === "A" ? "B" : "A"}`;
    expect(consumePairCode(dir, typo, NOW)).toBe(false);
    expect(consumePairCode(dir, code, NOW)).toBe(true);
  });
});

describe("agent tokens", () => {
  test("only the sha256 digest reaches disk, and only the token authorizes", () => {
    const dir = home();
    const token = newToken();
    issueAgentToken(dir, "laptop", token, NOW);
    const raw = readFileSync(agentTokensPath(dir), "utf8");
    expect(raw).not.toContain(token);
    expect(authorizeAgentToken(dir, token)).toBe(true);
    expect(authorizeAgentToken(dir, newToken())).toBe(false);
    expect(agentTokenHashes(dir)).toHaveLength(1);
  });

  test("pairing the same device again replaces its digest instead of piling up", () => {
    const dir = home();
    issueAgentToken(dir, "laptop", newToken(), NOW);
    const second = newToken();
    issueAgentToken(dir, "laptop", second, NOW + 1);
    expect(agentTokenHashes(dir)).toHaveLength(1);
    expect(authorizeAgentToken(dir, second)).toBe(true);
  });
});

describe("devices.json", () => {
  test("roundtrip keeps the pinned cert, fingerprint and token", () => {
    const dir = home();
    expect(readDevices(dir)).toEqual({ devices: [] });
    const box = device();
    writeDevices(dir, { devices: [box] });
    expect(readDevices(dir)).toEqual({ devices: [box] });
    expect(JSON.parse(readFileSync(devicesPath(dir), "utf8"))).toEqual({ devices: [box] });
  });

  test("add, replace, mark seen and remove", () => {
    const box = device();
    const laptop = device("laptop", "192.168.0.20:7799");
    let config: DeviceConfig = withDevice({ devices: [] }, box);
    config = withDevice(config, laptop);
    expect(config.devices.map((d) => d.name)).toEqual(["box2", "laptop"]);
    expect(findDevice(config, "laptop")).toEqual(laptop);
    const seen = markSeen(config, "box2", NOW + 5);
    expect(findDevice(seen, "box2")?.lastSeenAt).toBe(NOW + 5);
    expect(findDevice(config, "box2")?.lastSeenAt).toBeUndefined();
    const removed = withoutDevice(config, "box2");
    expect(removed.devices.map((d) => d.name)).toEqual(["laptop"]);
    expect(() => withoutDevice(config, "nope")).toThrow("no linked device nope");
  });

  test("a device whose cert no longer matches its fingerprint is refused", () => {
    const box = device();
    const wrong = { ...box, fingerprint: `00:${box.fingerprint.slice(3)}` };
    expect(() => parseDeviceConfig({ devices: [wrong] })).toThrow("does not match");
    expect(() => parseDeviceConfig({ devices: [box, { ...box }] })).toThrow("declared twice");
    expect(() => parseDeviceConfig({ devices: [{ ...box, address: "bad addr" }] })).toThrow(Refusal);
    expect(() => parseDeviceConfig({ nope: [] })).toThrow("devices array");
  });

  test("a broken file names itself instead of a bare JSON error", () => {
    const dir = home();
    writeDevices(dir, { devices: [] });
    writeFileSync(devicesPath(dir), "{ nope");
    expect(() => readDevices(dir)).toThrow(devicesPath(dir));
  });
});

describe("lane count", () => {
  test("only live lanes are counted", () => {
    const dir = home();
    expect(countLiveLanes(dir)).toBe(0);
    const lanes = join(dir, "lanes");
    mkdirSync(lanes, { recursive: true });
    writeFileSync(join(lanes, "a.json"), JSON.stringify({ status: "working" }));
    writeFileSync(join(lanes, "b.json"), JSON.stringify({ status: "ready" }));
    writeFileSync(join(lanes, "c.json"), JSON.stringify({ status: "done" }));
    writeFileSync(join(lanes, "d.json"), "{ nope");
    expect(countLiveLanes(dir)).toBe(2);
  });
});
