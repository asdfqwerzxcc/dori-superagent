import { describe, expect, test } from "bun:test";
import {
  CODE_TTL_MS,
  codeHash,
  formatAddr,
  formatPairCode,
  isPairCode,
  lanIPv4,
  newPairCode,
  newToken,
  normalizeCode,
  pairCodeMatches,
  parseAddr,
  parsePort,
  tokenHash,
  tokenMatches,
} from "../src/link-pair.ts";
import { Refusal } from "../src/refusal.ts";

const fixedRandom =
  (bytes: number[]) =>
  (size: number): Buffer =>
    Buffer.from(bytes.slice(0, size));

describe("pairing codes", () => {
  test("eight characters from the unambiguous alphabet, shown as two groups", () => {
    const code = newPairCode(fixedRandom([0, 1, 31, 2, 30, 3, 29, 4]));
    expect(code).toBe("AB9C8D7E");
    expect(code).toHaveLength(8);
    expect(formatPairCode(code)).toBe("AB9C-8D7E");
    expect(isPairCode(code)).toBe(true);
    expect(isPairCode(`${code.slice(0, 4)}-${code.slice(4)}`)).toBe(true);
  });

  test("the alphabet has no O, 0, I or 1, so a typed glance has one spelling", () => {
    const code = newPairCode((size) => Buffer.alloc(size, 255));
    for (const ch of code) expect("ABCDEFGHJKLMNPQRSTUVWXYZ23456789").toContain(ch);
    expect(normalizeCode("abcd-efgh")).toBe("ABCDEFGH");
    expect(isPairCode("ABCD-EFG")).toBe(false);
    expect(isPairCode("ABCD-EF0H")).toBe(false);
  });

  test("a record matches only before its expiry and only for the same code", () => {
    const code = newPairCode(fixedRandom([1, 2, 3, 4, 5, 6, 7, 8]));
    const record = { hash: codeHash(code), expiresAt: 1000 + CODE_TTL_MS };
    expect(pairCodeMatches(record, code, 1000)).toBe(true);
    expect(pairCodeMatches(record, formatPairCode(code).toLowerCase(), 1000)).toBe(true);
    const typo = `${code.slice(0, 7)}${code[7] === "A" ? "B" : "A"}`;
    expect(pairCodeMatches(record, typo, 1000)).toBe(false);
    expect(pairCodeMatches(record, code, record.expiresAt)).toBe(false);
  });

  test("a token is 32 random bytes and only its digest matches", () => {
    const token = newToken();
    expect(token.length).toBeGreaterThanOrEqual(43);
    expect(tokenMatches([codeHash("nope"), tokenHash(token)], token)).toBe(true);
    expect(tokenMatches([codeHash("nope")], token)).toBe(false);
    expect(tokenMatches([], token)).toBe(false);
  });
});

describe("addresses", () => {
  test("host, host:port and a bracketed IPv6 address parse and format back", () => {
    expect(parseAddr("192.168.0.12")).toEqual({ host: "192.168.0.12", port: 7799 });
    expect(parseAddr("192.168.0.12:9000")).toEqual({ host: "192.168.0.12", port: 9000 });
    expect(parseAddr("[::1]:9000")).toEqual({ host: "::1", port: 9000 });
    expect(parseAddr("::1")).toEqual({ host: "::1", port: 7799 });
    expect(formatAddr({ host: "::1", port: 9000 })).toBe("[::1]:9000");
    expect(formatAddr({ host: "box2", port: 7799 })).toBe("box2:7799");
  });

  test("a bad port or a space is refused", () => {
    for (const bad of ["box:0", "box:70000", "box:abc", "two words", "a/b"])
      expect(() => parseAddr(bad)).toThrow(Refusal);
    expect(() => parsePort(0)).toThrow("invalid port");
  });

  test("the LAN address skips loopback and IPv6 and falls back to loopback", () => {
    const ifaces = {
      lo: [{ address: "127.0.0.1", family: "IPv4", internal: true }],
      wifi: [
        { address: "fe80::1", family: "IPv6", internal: false },
        { address: "192.168.0.4", family: "IPv4", internal: false },
      ],
    } as unknown as ReturnType<typeof import("node:os").networkInterfaces>;
    expect(lanIPv4(ifaces)).toBe("192.168.0.4");
    expect(lanIPv4({ lo: [{ address: "127.0.0.1", family: "IPv4", internal: true }] } as never)).toBe("127.0.0.1");
  });
});
