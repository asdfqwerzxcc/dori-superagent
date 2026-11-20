import { describe, expect, test } from "bun:test";
import { generateAgentCert } from "../src/link-cert.ts";
import { assertFingerprint, assertPinnedDevice } from "../src/link-client.ts";
import { newToken } from "../src/link-pair.ts";
import type { LinkDevice } from "../src/link-store.ts";
import type { LinkStatus } from "../src/link-status.ts";
import { formatDeviceTable } from "../src/link-table.ts";
import { Refusal } from "../src/refusal.ts";

const NOW = 1_700_000_000_000;

const fingerprintOf = (byte: string): string => Array.from({ length: 32 }, () => byte).join(":");

const pinnedDevice = (): LinkDevice => {
  const cert = generateAgentCert("box2", NOW);
  return {
    name: "box2",
    address: "192.168.0.12:7799",
    fingerprint: cert.fingerprint,
    cert: cert.cert,
    token: newToken(),
    addedAt: NOW,
  };
};

const status: LinkStatus = {
  host: "box2",
  os: "linux",
  arch: "x64",
  cpuPct: 33,
  memFreePct: 61,
  load: 0.2,
  uptimeSec: 100,
  sessions: 2,
  doriVersion: "0.1.0",
  now: new Date(NOW).toISOString(),
};

describe("pinning", () => {
  test("a matching fingerprint passes and a changed one is refused with both values", () => {
    expect(() => assertFingerprint("ab:cd", "AB:CD")).not.toThrow();
    expect(() => assertFingerprint(fingerprintOf("11"), fingerprintOf("22"))).toThrow(Refusal);
    expect(() => assertFingerprint(fingerprintOf("11"), fingerprintOf("22"))).toThrow("fingerprint mismatch");
  });

  test("a stored device is checked against both its cert and the peer it just met", () => {
    const device = pinnedDevice();
    const peer = { cert: device.cert, fingerprint: device.fingerprint };
    expect(() => assertPinnedDevice(device, peer)).not.toThrow();
    expect(() => assertPinnedDevice(device, { ...peer, fingerprint: fingerprintOf("22") })).toThrow(
      "fingerprint mismatch",
    );
    const other = generateAgentCert("other", NOW);
    expect(() => assertPinnedDevice(device, { cert: other.cert, fingerprint: other.fingerprint })).toThrow(
      "fingerprint mismatch",
    );
    expect(() => assertPinnedDevice({ ...device, cert: other.cert }, peer)).toThrow("no longer matches");
  });
});

describe("device table", () => {
  test("online rows show cpu, ram and sessions; offline rows keep the last answer time", () => {
    const lines = formatDeviceTable([
      { name: "box2", address: "192.168.0.12:7799", online: true, status },
      { name: "old", address: "192.168.0.30:7799", online: false, lastSeenAt: NOW - 60_000 },
      { name: "fresh", address: "192.168.0.40:7799", online: false },
    ]);
    expect(lines[0]).toContain("NAME");
    expect(lines[0]).toContain("SESSIONS");
    expect(lines[1]).toContain("box2");
    expect(lines[1]).toContain("online");
    expect(lines[1]).toContain("33%");
    expect(lines[1]).toContain("61% free");
    expect(lines[1]).toContain("2");
    expect(lines[2]).toContain("offline");
    expect(lines[2]).toContain(new Date(NOW - 60_000).toISOString());
    expect(lines[3]).toContain("never");
  });
});
