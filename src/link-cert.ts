import { createHash, createPrivateKey, generateKeyPairSync, randomBytes, sign, X509Certificate } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { Refusal } from "./refusal.ts";

/** The agent's identity: a self-signed cert, its key, and the fingerprint a person compares at pairing time. */
export type AgentCert = { cert: string; key: string; fingerprint: string };

export type AgentCertPaths = { cert: string; key: string };

export const agentCertPaths = (home: string): AgentCertPaths => ({
  cert: join(home, "state", "agent-cert.pem"),
  key: join(home, "state", "agent-key.pem"),
});

/* DER assembly for the X.509 container only: the key pair and the ECDSA signature come from node:crypto, so no cipher or
 * signature code lives here, just the standard structure a TLS stack parses. */

const derLength = (n: number): Buffer => {
  if (n < 0x80) return Buffer.from([n]);
  const bytes: number[] = [];
  for (let v = n; v > 0; v = Math.floor(v / 256)) bytes.unshift(v & 0xff);
  return Buffer.from([0x80 | bytes.length, ...bytes]);
};

const tlv = (tag: number, body: Buffer): Buffer => Buffer.concat([Buffer.from([tag]), derLength(body.length), body]);
const seq = (...parts: Buffer[]): Buffer => tlv(0x30, Buffer.concat(parts));
const set = (...parts: Buffer[]): Buffer => tlv(0x31, Buffer.concat(parts));
const integer = (body: Buffer): Buffer => {
  const signed = (body[0] ?? 0) & 0x80 ? Buffer.concat([Buffer.from([0]), body]) : body;
  return tlv(0x02, signed);
};
const explicit = (n: number, body: Buffer): Buffer => tlv(0xa0 | n, body);
const octet = (body: Buffer): Buffer => tlv(0x04, body);
const bitString = (body: Buffer): Buffer => tlv(0x03, Buffer.concat([Buffer.from([0]), body]));
const utf8 = (text: string): Buffer => tlv(0x0c, Buffer.from(text, "utf8"));

const oid = (dotted: string): Buffer => {
  const parts = dotted.split(".").map(Number);
  const out: number[] = [(parts[0] ?? 0) * 40 + (parts[1] ?? 0)];
  for (const arc of parts.slice(2)) {
    const bytes: number[] = [];
    for (let v = arc; v > 0; v = Math.floor(v / 128)) bytes.unshift(v & 0x7f);
    for (let i = 0; i < bytes.length - 1; i++) bytes[i] = (bytes[i] ?? 0) | 0x80;
    out.push(...(bytes.length === 0 ? [0] : bytes));
  }
  return tlv(0x06, Buffer.from(out));
};

/** UTCTime through 2049, GeneralizedTime after it: a cert with a 2036 expiry still parses in every TLS stack. */
const time = (at: Date): Buffer => {
  const digits = at.toISOString().replace(/[-:T]/g, "").split(".")[0] ?? "";
  return at.getUTCFullYear() < 2050
    ? tlv(0x17, Buffer.from(`${digits.slice(2, 14)}Z`))
    : tlv(0x18, Buffer.from(`${digits.slice(0, 14)}Z`));
};

const nameOf = (commonName: string): Buffer => seq(set(seq(oid("2.5.4.3"), utf8(commonName))));

const sanOf = (hostname: string): Buffer =>
  seq(
    tlv(0x82, Buffer.from(hostname, "ascii")),
    tlv(0x87, Buffer.from([127, 0, 0, 1])),
    tlv(0x87, Buffer.alloc(16, 0).fill(1, 15)),
  );

/**
 * A self-signed P-256 certificate for the agent. It is a CA in the sense every self-signed dev cert is: clients pin
 * its fingerprint and pass the PEM as their only trust anchor, so no public CA is involved and no name is resolved.
 */
export const generateAgentCert = (hostname: string, now: number): AgentCert => {
  const { privateKey, publicKey } = generateKeyPairSync("ec", { namedCurve: "P-256" });
  const algorithm = seq(oid("1.2.840.10045.4.3.2"));
  const name = nameOf(hostname);
  const serial = randomBytes(8);
  serial[0] = (serial[0] ?? 0) & 0x7f || 1;
  const extensions = explicit(
    3,
    seq(
      seq(oid("2.5.29.17"), octet(sanOf(hostname))),
      seq(oid("2.5.29.19"), tlv(0x01, Buffer.from([0xff])), octet(seq())),
    ),
  );
  const tbs = seq(
    explicit(0, integer(Buffer.from([2]))),
    integer(serial),
    algorithm,
    name,
    seq(time(new Date(Math.max(0, now - 86_400_000))), time(new Date(now + 10 * 365 * 86_400_000))),
    name,
    publicKey.export({ type: "spki", format: "der" }),
    extensions,
  );
  const der = seq(tbs, algorithm, bitString(sign("sha256", tbs, privateKey)));
  const cert = pemFromDer(der);
  const key = privateKey.export({ type: "pkcs8", format: "pem" }).toString();
  return { cert, key, fingerprint: fingerprintOfDer(der) };
};

export const pemFromDer = (der: Buffer): string =>
  `-----BEGIN CERTIFICATE-----\n${(der.toString("base64").match(/.{1,64}/g) ?? []).join("\n")}\n-----END CERTIFICATE-----\n`;

/** SHA-256 of the DER, lowercase colon pairs: the value a person reads aloud and a devices.json keeps. */
export const fingerprintOfDer = (der: Buffer): string =>
  createHash("sha256")
    .update(der)
    .digest("hex")
    .replace(/(..)(?=.)/g, "$1:");

export const fingerprintOfPem = (pem: string): string => {
  try {
    return fingerprintOfDer(new X509Certificate(pem).raw);
  } catch (e) {
    throw new Refusal(`not a usable certificate: ${e instanceof Error ? e.message : String(e)}`);
  }
};

const validPair = (cert: string, key: string): boolean => {
  try {
    const x509 = new X509Certificate(cert);
    return x509.subjectAltName !== undefined && x509.checkPrivateKey(createPrivateKey(key));
  } catch {
    return false;
  }
};

/**
 * Reads the agent's cert and key, generating both when either is missing, unreadable or no longer matches its key.
 * The first `dori link` generates them too, so a code can be printed before the agent starts.
 */
export const ensureAgentCert = (home: string, opts: { hostname?: string; now?: number } = {}): AgentCert => {
  const paths = agentCertPaths(home);
  if (existsSync(paths.cert) && existsSync(paths.key)) {
    const cert = readFileSync(paths.cert, "utf8");
    const key = readFileSync(paths.key, "utf8");
    if (validPair(cert, key)) return { cert, key, fingerprint: fingerprintOfPem(cert) };
  }
  const made = generateAgentCert(opts.hostname ?? "dori-agent", opts.now ?? Date.now());
  if (!validPair(made.cert, made.key)) throw new Refusal("the generated agent certificate failed its own validation");
  mkdirSync(dirname(paths.cert), { recursive: true });
  writeFileSync(paths.cert, made.cert, { mode: 0o600 });
  writeFileSync(paths.key, made.key, { mode: 0o600 });
  return made;
};
