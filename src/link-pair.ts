import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { networkInterfaces } from "node:os";
import { Refusal } from "./refusal.ts";

export const LINK_PORT = 7799;
export const CODE_TTL_MS = 10 * 60 * 1000;
/** No O/0 or I/1: a code read off one screen and typed on another must not have two spellings. */
export const CODE_ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
export const CODE_RE = /^[A-HJ-NP-Z2-9]{8}$/;
export const CODE_LENGTH = 8;

export type PairCode = { hash: string; expiresAt: number };
export type Addr = { host: string; port: number };

export const newPairCode = (random: (size: number) => Buffer = randomBytes): string => {
  const bytes = random(CODE_LENGTH);
  return [...bytes].map((b) => CODE_ALPHABET[b % CODE_ALPHABET.length]).join("");
};

export const newToken = (random: (size: number) => Buffer = randomBytes): string => random(32).toString("base64url");

const sha256Hex = (text: string): string => createHash("sha256").update(text).digest("hex");

/** Strips the dash and spaces a human types; it never corrects a character, so a typo is a typo. */
export const normalizeCode = (input: string): string => input.toUpperCase().replace(/[^A-Z0-9]/g, "");

export const isPairCode = (input: string): boolean => CODE_RE.test(normalizeCode(input));

export const formatPairCode = (code: string): string => `${code.slice(0, 4)}-${code.slice(4)}`;

export const codeHash = (code: string): string => sha256Hex(normalizeCode(code));

export const tokenHash = (token: string): string => sha256Hex(token);

const sameDigest = (a: string, b: string): boolean => {
  const left = Buffer.from(a, "hex");
  const right = Buffer.from(b, "hex");
  return left.length === right.length && left.length > 0 && timingSafeEqual(left, right);
};

/** One record, one code: an expired or already consumed hash never matches, and no plaintext code is stored. */
export const pairCodeMatches = (record: PairCode, code: string, now: number): boolean =>
  now < record.expiresAt && sameDigest(record.hash, codeHash(code));

export const tokenMatches = (hashes: readonly string[], token: string): boolean => {
  const digest = tokenHash(token);
  return hashes.some((hash) => sameDigest(hash, digest));
};

export const parsePort = (n: number): number => {
  if (!Number.isInteger(n) || n < 1 || n > 65535) throw new Refusal(`invalid port ${n}: use 1-65535`);
  return n;
};

/** `host`, `host:port`, or `[::1]:port`: the form every LAN address in a terminal takes. */
export const parseAddr = (input: string, fallbackPort = LINK_PORT): Addr => {
  const text = input.trim();
  if (text === "" || /[\s/\\]/.test(text)) throw new Refusal(`invalid address ${JSON.stringify(input)}: use host:port`);
  if (text.startsWith("[")) {
    const end = text.indexOf("]");
    if (end < 0) throw new Refusal(`invalid address ${JSON.stringify(input)}: close the IPv6 bracket`);
    const rest = text.slice(end + 1);
    if (rest === "") return { host: text.slice(1, end), port: fallbackPort };
    if (!rest.startsWith(":")) throw new Refusal(`invalid address ${JSON.stringify(input)}: use [addr]:port`);
    return { host: text.slice(1, end), port: parsePort(Number(rest.slice(1))) };
  }
  const colons = text.split(":").length - 1;
  if (colons === 0) return { host: text, port: fallbackPort };
  if (colons > 1) return { host: text, port: fallbackPort };
  const [host, port] = text.split(":");
  return { host: host ?? text, port: parsePort(Number(port)) };
};

export const formatAddr = (addr: Addr): string =>
  addr.host.includes(":") ? `[${addr.host}]:${addr.port}` : `${addr.host}:${addr.port}`;

/** The address a device on the same network reaches: the first non-loopback IPv4, loopback when none exists. */
export const lanIPv4 = (interfaces = networkInterfaces()): string => {
  for (const entries of Object.values(interfaces)) {
    for (const entry of entries ?? []) {
      const v4 = entry.family === "IPv4" || (entry.family as unknown) === 4;
      if (v4 && !entry.internal) return entry.address;
    }
  }
  return "127.0.0.1";
};
