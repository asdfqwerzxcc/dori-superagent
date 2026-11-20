import { connect, type TLSSocket } from "node:tls";
import { request as httpsRequest } from "node:https";
import { fingerprintOfDer, fingerprintOfPem, pemFromDer } from "./link-cert.ts";
import { type Addr, formatAddr, normalizeCode, parseAddr } from "./link-pair.ts";
import { type LinkDevice, NAME_RE } from "./link-store.ts";
import { type LinkStatus, parseStatus } from "./link-status.ts";
import { Refusal } from "./refusal.ts";

export type Peer = { cert: string; fingerprint: string };
export type Pin = { cert: string; fingerprint: string };
export type HttpAnswer = { status: number; body: string };
export type PairRequest = {
  code: string;
  name?: string;
  expected?: string;
  confirm?: (peer: Peer) => Promise<boolean>;
  now: number;
  timeoutMs?: number;
};
export type Paired = { peer: Peer; device: LinkDevice; host: string };

const DEFAULT_TIMEOUT_MS = 3000;

export const assertFingerprint = (expected: string, presented: string): void => {
  if (expected.toLowerCase() !== presented.toLowerCase())
    throw new Refusal(
      `fingerprint mismatch: expected ${expected.toLowerCase()} but the agent presented ${presented.toLowerCase()}; refusing to connect`,
    );
};

export const assertPinnedDevice = (device: LinkDevice, peer: Peer): void => {
  if (fingerprintOfPem(device.cert) !== device.fingerprint)
    throw new Refusal(`stored cert for ${device.name} no longer matches its pinned fingerprint; remove and pair again`);
  assertFingerprint(device.fingerprint, peer.fingerprint);
};

/** Opens TLS without trusting anyone and reads the identity the person is about to compare. No HTTP is sent. */
export const probePeer = (address: string, timeoutMs = DEFAULT_TIMEOUT_MS): Promise<Peer> =>
  new Promise((resolve, reject) => {
    const addr = parseAddr(address);
    const socket = connect({ host: addr.host, port: addr.port, rejectUnauthorized: false });
    let settled = false;
    const fail = (e: unknown): void => {
      if (settled) return;
      settled = true;
      socket.destroy();
      reject(
        e instanceof Refusal
          ? e
          : new Refusal(`cannot reach ${address}: ${e instanceof Error ? e.message : String(e)}`),
      );
    };
    socket.setTimeout(timeoutMs, () => fail(new Refusal(`timed out reaching ${address}`)));
    socket.once("error", fail);
    socket.once("secureConnect", () => {
      if (settled) return;
      settled = true;
      const raw = socket.getPeerCertificate().raw;
      socket.destroy();
      if (raw === undefined || raw.length === 0) {
        reject(new Refusal(`${address} presented no certificate`));
        return;
      }
      resolve({ cert: pemFromDer(raw), fingerprint: fingerprintOfDer(raw) });
    });
  });

const ask = async (
  address: string,
  pin: Pin,
  req: { method: "GET" | "POST"; path: string; body?: unknown; headers?: Record<string, string> },
  timeoutMs: number,
): Promise<HttpAnswer> => {
  const addr: Addr = parseAddr(address);
  const payload = req.body === undefined ? undefined : JSON.stringify(req.body);
  return new Promise((resolve, reject) => {
    let settled = false;
    const fail = (e: unknown): void => {
      if (settled) return;
      settled = true;
      reject(
        e instanceof Refusal
          ? e
          : new Refusal(`cannot reach ${address}: ${e instanceof Error ? e.message : String(e)}`),
      );
    };
    const headers: Record<string, string> = { ...req.headers };
    if (payload !== undefined) {
      headers["content-type"] = "application/json";
      headers["content-length"] = String(Buffer.byteLength(payload));
    }
    const request = httpsRequest(
      {
        host: addr.host,
        port: addr.port,
        method: req.method,
        path: req.path,
        ca: [pin.cert],
        checkServerIdentity: () => undefined,
        headers,
        timeout: timeoutMs,
      },
      (res) => {
        const socket = res.socket as TLSSocket | null;
        const raw = socket === null ? undefined : socket.getPeerCertificate().raw;
        if (raw === undefined || fingerprintOfDer(raw) !== pin.fingerprint.toLowerCase()) {
          res.destroy();
          fail(new Refusal(`fingerprint changed while talking to ${address}: refusing the response`));
          return;
        }
        let body = "";
        res.setEncoding("utf8");
        res.on("data", (chunk: string) => {
          body += chunk;
        });
        res.on("end", () => {
          if (settled) return;
          settled = true;
          resolve({ status: res.statusCode ?? 0, body });
        });
        res.on("error", fail);
      },
    );
    request.on("timeout", () => {
      request.destroy();
      fail(new Refusal(`timed out talking to ${address}`));
    });
    request.on("error", fail);
    if (payload !== undefined) request.write(payload);
    request.end();
  });
};

const jsonOf = (address: string, answer: HttpAnswer): Record<string, unknown> => {
  try {
    const body = JSON.parse(answer.body) as unknown;
    if (typeof body !== "object" || body === null || Array.isArray(body))
      throw new Refusal(`${address} answered ${answer.status} with a non-object body`);
    return body as Record<string, unknown>;
  } catch (e) {
    if (e instanceof Refusal) throw e;
    throw new Refusal(`${address} answered ${answer.status} with invalid JSON`);
  }
};

export const readStatus = async (device: LinkDevice, timeoutMs = DEFAULT_TIMEOUT_MS): Promise<LinkStatus> => {
  const pin: Pin = { cert: device.cert, fingerprint: device.fingerprint };
  const answer = await ask(
    device.address,
    pin,
    { method: "GET", path: "/status", headers: { authorization: `Bearer ${device.token}` } },
    timeoutMs,
  );
  if (answer.status === 401) throw new Refusal(`${device.name} rejected the token: pair it again`);
  if (answer.status !== 200) throw new Refusal(`${device.name} /status answered ${answer.status}`);
  return parseStatus(jsonOf(device.address, answer));
};

export const pairDevice = async (address: string, opts: PairRequest): Promise<Paired> => {
  const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const peer = await probePeer(address, timeoutMs);
  if (opts.expected !== undefined) assertFingerprint(opts.expected, peer.fingerprint);
  else if (opts.confirm === undefined)
    throw new Refusal("no fingerprint to check against and no terminal to confirm it on: pass --fingerprint");
  else if (!(await opts.confirm(peer))) throw new Refusal("pairing cancelled: the fingerprint was not confirmed");

  const answer = await ask(
    address,
    peer,
    {
      method: "POST",
      path: "/pair",
      body: { code: normalizeCode(opts.code), ...(opts.name === undefined ? {} : { name: opts.name }) },
    },
    timeoutMs,
  );
  const body = jsonOf(address, answer);
  if (answer.status === 403)
    throw new Refusal(`${address} rejected the pairing code: it expired, was already used, or was mistyped`);
  if (answer.status !== 200) throw new Refusal(`${address} /pair answered ${answer.status}`);

  const token = body["token"];
  if (typeof token !== "string" || token === "") throw new Refusal(`${address} answered /pair without a token`);
  const presented = body["fingerprint"];
  if (typeof presented !== "string") throw new Refusal(`${address} answered /pair without its fingerprint`);
  assertFingerprint(peer.fingerprint, presented);
  const claimed = typeof body["name"] === "string" ? body["name"] : opts.name;
  const name = claimed !== undefined && NAME_RE.test(claimed) ? claimed : "device";
  return {
    peer,
    host: typeof body["host"] === "string" ? body["host"] : name,
    device: {
      name,
      address: formatAddr(parseAddr(address)),
      fingerprint: peer.fingerprint,
      cert: peer.cert,
      token,
      addedAt: opts.now,
    },
  };
};
