import { hostname } from "node:os";
import { createInterface } from "node:readline/promises";
import { type Args, need, one } from "./cli-args.ts";
import type { Deps } from "./harness.ts";
import { startAgent } from "./link-agent.ts";
import { agentCertPaths, ensureAgentCert } from "./link-cert.ts";
import { type Peer, pairDevice, readStatus } from "./link-client.ts";
import { LINK_PORT, formatAddr, formatPairCode, isPairCode, lanIPv4, parsePort } from "./link-pair.ts";
import {
  NAME_RE,
  findDevice,
  issuePairCode,
  markSeen,
  readDevices,
  withDevice,
  withoutDevice,
  writeDevices,
} from "./link-store.ts";
import { formatDeviceTable } from "./link-table.ts";
import { Refusal } from "./refusal.ts";

const POLL_TIMEOUT_MS = 3000;

const ask = async (prompt: string): Promise<string> => {
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  try {
    return (await rl.question(prompt)).trim();
  } finally {
    rl.close();
  }
};

const portFlag = (a: Args, fallback: number): number => {
  const given = one(a, "port");
  return given === undefined ? fallback : parsePort(Number(given));
};

const runAgent = async (d: Deps, a: Args): Promise<number> => {
  const port = portFlag(a, LINK_PORT);
  const bind = one(a, "host") ?? "0.0.0.0";
  const agent = startAgent({
    home: d.store.root,
    host: bind,
    port,
    hostname: hostname(),
    log: (line) => console.error(line),
  });
  console.log(`AGENT listening on ${bind}:${port}  host=${hostname()}`);
  console.log(`FINGERPRINT ${agent.cert.fingerprint}`);
  console.log(`CERT ${agentCertPaths(d.store.root).cert}`);
  console.log("LAN only: never expose this port to the internet; pairing tokens are the only lock on it.");
  await new Promise<void>((resolve) => {
    const stop = (): void => resolve();
    process.once("SIGINT", stop);
    process.once("SIGTERM", stop);
  });
  agent.server.stop(true);
  console.log("AGENT stopped");
  return 0;
};

const printCode = (d: Deps, a: Args): number => {
  const port = portFlag(a, LINK_PORT);
  const cert = ensureAgentCert(d.store.root, { hostname: hostname() });
  const code = issuePairCode(d.store.root, { now: d.now() });
  const address = formatAddr({ host: lanIPv4(), port });
  console.log(`CODE ${formatPairCode(code)}  FINGERPRINT ${cert.fingerprint}  ADDR ${address}`);
  console.log(`On the other machine: dori link ${address}   (compare the fingerprint, then enter this code)`);
  return 0;
};

const confirmOnTerminal =
  (address: string) =>
  async (peer: Peer): Promise<boolean> => {
    console.log(`FINGERPRINT ${peer.fingerprint}`);
    console.log(`Compare this with the FINGERPRINT printed by \`dori link\` on ${address}.`);
    return /^(y|yes)$/i.test(await ask("Trust this fingerprint? [y/N] "));
  };

const pairFromCli = async (d: Deps, a: Args, address: string): Promise<number> => {
  const home = d.store.root;
  const givenFingerprint = one(a, "fingerprint");
  const givenName = one(a, "name");
  if (givenName !== undefined && !NAME_RE.test(givenName)) throw new Refusal(`--name must match ${NAME_RE}`);
  if (givenFingerprint === undefined && !process.stdin.isTTY)
    throw new Refusal(
      `no --fingerprint given and stdin is not a terminal: print the agent's fingerprint on it with \`dori link\` and pass it here`,
    );
  let code = one(a, "code");
  if (code === undefined) {
    if (!process.stdin.isTTY) throw new Refusal("give --code <code> when stdin is not a terminal");
    code = await ask("Pairing code: ");
  }
  if (!isPairCode(code)) throw new Refusal(`${code} is not an 8-character pairing code`);

  const paired = await pairDevice(address, {
    code,
    ...(givenName === undefined ? {} : { name: givenName }),
    ...(givenFingerprint === undefined ? { confirm: confirmOnTerminal(address) } : { expected: givenFingerprint }),
    now: d.now(),
    timeoutMs: POLL_TIMEOUT_MS,
  });

  const config = readDevices(home);
  const existing = findDevice(config, paired.device.name);
  if (existing !== undefined && existing.fingerprint !== paired.device.fingerprint && !a.flags.has("replace"))
    throw new Refusal(
      `device ${existing.name} is linked with fingerprint ${existing.fingerprint}; pass --replace to accept ${paired.device.fingerprint} (and pair with a fresh code)`,
    );
  writeDevices(home, withDevice(config, paired.device));
  console.log(
    `LINKED ${paired.device.name} ${paired.device.address} fingerprint=${paired.device.fingerprint} host=${paired.host}`,
  );
  return 0;
};

const listDevices = async (d: Deps): Promise<number> => {
  const config = readDevices(d.store.root);
  if (config.devices.length === 0) {
    console.log("No linked devices: run dori link <host:port> on the new machine");
    return 0;
  }
  const answered = await Promise.all(
    config.devices.map(async (device) => {
      try {
        return { device, status: await readStatus(device, POLL_TIMEOUT_MS) };
      } catch {
        return { device, status: undefined };
      }
    }),
  );
  let next = config;
  const rows = answered.map(({ device, status }) => {
    if (status !== undefined) next = markSeen(next, device.name, d.now());
    return {
      name: device.name,
      address: device.address,
      online: status !== undefined,
      ...(status === undefined ? {} : { status }),
      ...(device.lastSeenAt === undefined ? {} : { lastSeenAt: device.lastSeenAt }),
    };
  });
  if (answered.some((r) => r.status !== undefined)) writeDevices(d.store.root, next);
  for (const line of formatDeviceTable(rows)) console.log(line);
  return 0;
};

const runDevices = async (d: Deps, a: Args, sub: string | undefined): Promise<number> => {
  if (sub === "remove") {
    const name = need(a.pos[2], "device name");
    writeDevices(d.store.root, withoutDevice(readDevices(d.store.root), name));
    console.log(`DEVICE_REMOVED ${name}`);
    return 0;
  }
  if (sub !== undefined) throw new Refusal(`unknown devices command ${sub}: dori devices | dori devices remove <name>`);
  return listDevices(d);
};

export const runLink = async (d: Deps, a: Args, cmd: "agent" | "link" | "devices"): Promise<number> => {
  if (cmd === "agent") return runAgent(d, a);
  if (cmd === "link") {
    const address = a.pos[1];
    if (address === undefined) return printCode(d, a);
    return pairFromCli(d, a, address);
  }
  return runDevices(d, a, a.pos[1]);
};
