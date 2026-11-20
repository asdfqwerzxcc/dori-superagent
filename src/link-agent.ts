import { hostname } from "node:os";
import { type AgentCert, ensureAgentCert } from "./link-cert.ts";
import { isPairCode, newToken } from "./link-pair.ts";
import { NAME_RE, authorizeAgentToken, consumePairCode, issueAgentToken } from "./link-store.ts";
import { type LinkStatus, collectStatus, systemProbe } from "./link-status.ts";
import { Refusal } from "./refusal.ts";

export type AgentContext = {
  home: string;
  host: string;
  fingerprint: string;
  now: () => number;
  status: () => Promise<LinkStatus>;
  log?: (line: string) => void;
};

export type AgentOptions = {
  home: string;
  host: string;
  port: number;
  hostname?: string;
  now?: () => number;
  status?: () => Promise<LinkStatus>;
  log?: (line: string) => void;
};

const json = (status: number, body: unknown): Response =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

const bearer = (req: Request): string | undefined => {
  const header = req.headers.get("authorization");
  if (header === null) return undefined;
  const [scheme, token] = header.split(" ");
  return scheme?.toLowerCase() === "bearer" && token !== undefined && token !== "" ? token : undefined;
};

const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);

const pair = async (req: Request, ctx: AgentContext): Promise<Response> => {
  let body: Record<string, unknown> = {};
  try {
    const parsed = (await req.json()) as unknown;
    if (isRecord(parsed)) body = parsed;
  } catch {
    return json(400, { error: "body must be JSON" });
  }
  const code = typeof body["code"] === "string" ? body["code"] : "";
  const claimed = typeof body["name"] === "string" && body["name"] !== "" ? body["name"] : ctx.host;
  if (!NAME_RE.test(claimed)) return json(400, { error: `device name must match ${NAME_RE}` });
  if (!isPairCode(code) || !consumePairCode(ctx.home, code, ctx.now()))
    return json(403, { error: "pairing code rejected" });
  const token = newToken();
  issueAgentToken(ctx.home, claimed, token, ctx.now());
  return json(200, { token, name: claimed, host: ctx.host, fingerprint: ctx.fingerprint });
};

/** No token, no answer but the pairing route: /status is as closed as anything else the agent may grow later. */
export const handleAgentRequest = async (req: Request, ctx: AgentContext): Promise<Response> => {
  const path = new URL(req.url).pathname;
  try {
    if (path === "/pair") {
      if (req.method !== "POST") return json(405, { error: "POST /pair" });
      return await pair(req, ctx);
    }
    if (path === "/status") {
      if (req.method !== "GET") return json(405, { error: "GET /status" });
      const token = bearer(req);
      if (token === undefined || !authorizeAgentToken(ctx.home, token)) return json(401, { error: "unauthorized" });
      return json(200, await ctx.status());
    }
    return json(404, { error: "not found" });
  } catch (e) {
    ctx.log?.(`agent error: ${e instanceof Error ? e.message : String(e)}`);
    return json(500, { error: "internal" });
  }
};

export type AgentServer = { server: ReturnType<typeof Bun.serve>; cert: AgentCert; url: string };

export const startAgent = (opts: AgentOptions): AgentServer => {
  const host = opts.hostname ?? hostname();
  const cert = ensureAgentCert(opts.home, { hostname: host });
  const ctx: AgentContext = {
    home: opts.home,
    host,
    fingerprint: cert.fingerprint,
    now: opts.now ?? Date.now,
    status: opts.status ?? (() => collectStatus(systemProbe(opts.home))),
    ...(opts.log === undefined ? {} : { log: opts.log }),
  };
  let server: ReturnType<typeof Bun.serve>;
  try {
    server = Bun.serve({
      hostname: opts.host,
      port: opts.port,
      tls: { cert: cert.cert, key: cert.key },
      fetch: (req) => handleAgentRequest(req, ctx),
    });
  } catch (e) {
    throw new Refusal(`cannot listen on ${opts.host}:${opts.port}: ${e instanceof Error ? e.message : String(e)}`);
  }
  const shown = opts.host.includes(":") ? `[${opts.host}]` : opts.host;
  return { server, cert, url: `https://${shown}:${server.port}` };
};
