import { afterEach, describe, expect, test } from "bun:test";
import { createPrivateKey, X509Certificate } from "node:crypto";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type AgentContext, handleAgentRequest } from "../src/link-agent.ts";
import { agentCertPaths, ensureAgentCert } from "../src/link-cert.ts";
import { CODE_TTL_MS, formatPairCode } from "../src/link-pair.ts";
import { agentTokensPath, issuePairCode } from "../src/link-store.ts";
import type { LinkStatus } from "../src/link-status.ts";

const NOW = 1_700_000_000_000;
const homes: string[] = [];
const home = (): string => {
  const dir = mkdtempSync(join(tmpdir(), "dori-agent-"));
  homes.push(dir);
  return dir;
};
afterEach(() => {
  for (const dir of homes.splice(0)) rmSync(dir, { recursive: true, force: true });
});

const status: LinkStatus = {
  host: "box2",
  os: "win32",
  arch: "x64",
  cpuPct: 12,
  memFreePct: 44,
  load: null,
  uptimeSec: 5000,
  sessions: 3,
  doriVersion: "0.1.0",
  now: new Date(NOW).toISOString(),
};

const setup = () => {
  const dir = home();
  const cert = ensureAgentCert(dir, { hostname: "box2", now: NOW });
  const ctx: AgentContext = {
    home: dir,
    host: "box2",
    fingerprint: cert.fingerprint,
    now: () => NOW,
    status: async () => status,
  };
  return { dir, cert, ctx };
};

const pairRequest = (body: unknown): Request =>
  new Request("http://box2/pair", { method: "POST", body: JSON.stringify(body) });
const getRequest = (path: string, token?: string): Request =>
  new Request(`http://box2${path}`, {
    method: "GET",
    ...(token === undefined ? {} : { headers: { authorization: `Bearer ${token}` } }),
  });

describe("certificate", () => {
  test("the generated cert parses, matches its key and keeps its fingerprint across restarts", () => {
    const dir = home();
    const first = ensureAgentCert(dir, { hostname: "box2", now: NOW });
    expect(existsSync(agentCertPaths(dir).cert)).toBe(true);
    expect(existsSync(agentCertPaths(dir).key)).toBe(true);
    const x509 = new X509Certificate(first.cert);
    expect(x509.subject).toContain("box2");
    expect(x509.subjectAltName).toContain("DNS:box2");
    expect(x509.subjectAltName).toContain("IP Address:127.0.0.1");
    expect(x509.fingerprint256.toLowerCase()).toBe(first.fingerprint);
    expect(x509.checkPrivateKey(createPrivateKey(first.key))).toBe(true);
    const second = ensureAgentCert(dir, { hostname: "renamed", now: NOW + 1 });
    expect(second.fingerprint).toBe(first.fingerprint);
    expect(second.cert).toBe(first.cert);
  });
});

describe("pairing and auth", () => {
  test("a good code issues a token, and only that token opens /status", async () => {
    const { dir, ctx } = setup();
    const code = issuePairCode(dir, { now: NOW, random: (n) => Buffer.alloc(n, 5) });
    const answer = await handleAgentRequest(pairRequest({ code: formatPairCode(code), name: "laptop" }), ctx);
    expect(answer.status).toBe(200);
    const body = (await answer.json()) as { token: string; name: string; host: string; fingerprint: string };
    expect(body.name).toBe("laptop");
    expect(body.host).toBe("box2");
    expect(body.fingerprint).toBe(ctx.fingerprint);
    expect(readFileSync(agentTokensPath(dir), "utf8")).not.toContain(body.token);

    const authed = await handleAgentRequest(getRequest("/status", body.token), ctx);
    expect(authed.status).toBe(200);
    expect(await authed.json()).toEqual(status);
    for (const token of [undefined, "not-a-token", `${body.token}x`])
      expect((await handleAgentRequest(getRequest("/status", token), ctx)).status).toBe(401);
    expect((await handleAgentRequest(getRequest("/status", body.token).clone(), ctx)).status).toBe(200);
  });

  test("a code is one use: a replay, a typo and an expired code all answer 403", async () => {
    const { dir, ctx } = setup();
    const code = issuePairCode(dir, { now: NOW });
    const first = await handleAgentRequest(pairRequest({ code, name: "laptop" }), ctx);
    expect(first.status).toBe(200);
    expect((await handleAgentRequest(pairRequest({ code, name: "laptop" }), ctx)).status).toBe(403);

    const typoCode = issuePairCode(dir, { now: NOW, random: (n) => Buffer.alloc(n, 3) });
    const typo = `${typoCode.slice(0, 7)}${typoCode[7] === "A" ? "B" : "A"}`;
    expect((await handleAgentRequest(pairRequest({ code: typo }), ctx)).status).toBe(403);

    const expired = issuePairCode(dir, { now: NOW });
    const later: AgentContext = { ...ctx, now: () => NOW + CODE_TTL_MS };
    expect((await handleAgentRequest(pairRequest({ code: expired }), later)).status).toBe(403);
    expect((await handleAgentRequest(pairRequest({ code: "SHORT" }), ctx)).status).toBe(403);
  });

  test("a device name with a space is refused, unknown routes are 404 and wrong methods 405", async () => {
    const { dir, ctx } = setup();
    const code = issuePairCode(dir, { now: NOW });
    expect((await handleAgentRequest(pairRequest({ code, name: "my laptop" }), ctx)).status).toBe(400);
    expect((await handleAgentRequest(pairRequest({ code }), ctx)).status).toBe(200);
    expect((await handleAgentRequest(getRequest("/nope"), ctx)).status).toBe(404);
    expect((await handleAgentRequest(getRequest("/pair"), ctx)).status).toBe(405);
    expect((await handleAgentRequest(new Request("http://box2/status", { method: "POST" }), ctx)).status).toBe(405);
    expect(
      (await handleAgentRequest(new Request("http://box2/pair", { method: "POST", body: "not json" }), ctx)).status,
    ).toBe(400);
  });

  test("a second device gets its own token and the first keeps working", async () => {
    const { dir, ctx } = setup();
    const one = (await (
      await handleAgentRequest(pairRequest({ code: issuePairCode(dir, { now: NOW }), name: "laptop" }), ctx)
    ).json()) as { token: string };
    const two = (await (
      await handleAgentRequest(pairRequest({ code: issuePairCode(dir, { now: NOW }), name: "desk" }), ctx)
    ).json()) as { token: string };
    expect(two.token).not.toBe(one.token);
    expect((await handleAgentRequest(getRequest("/status", one.token), ctx)).status).toBe(200);
    expect((await handleAgentRequest(getRequest("/status", two.token), ctx)).status).toBe(200);
  });
});
