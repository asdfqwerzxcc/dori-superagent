import { describe, expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { main } from "../src/cli.ts";
import { generateAgentCert } from "../src/link-cert.ts";
import { newToken } from "../src/link-pair.ts";
import { devicesPath, pairCodePath, readDevices, writeDevices } from "../src/link-store.ts";
import { setup } from "./harness-setup.ts";

const captured: string[] = [];
const capture = async (fn: () => Promise<unknown>): Promise<string[]> => {
  captured.length = 0;
  const log = console.log;
  console.log = (...args: unknown[]) => {
    captured.push(args.join(" "));
  };
  try {
    await fn();
  } finally {
    console.log = log;
  }
  return [...captured];
};

describe("dori link", () => {
  test("prints one CODE / FINGERPRINT / ADDR line and leaves a spent-once code behind", async () => {
    const { d } = setup();
    const lines = await capture(() => main(["link"], d));
    expect(lines[0]).toMatch(
      /^CODE [A-Z2-9]{4}-[A-Z2-9]{4} {2}FINGERPRINT [0-9a-f]{2}(:[0-9a-f]{2}){31} {2}ADDR \S+:\d+$/,
    );
    expect(lines[1]).toContain("dori link");
    expect(existsSync(pairCodePath(d.store.root))).toBe(true);
    expect(existsSync(devicesPath(d.store.root))).toBe(false);
  });

  test("a pairing attempt with no fingerprint on a non-terminal is refused before any connection", async () => {
    const { d } = setup();
    const stdin = process.stdin as { isTTY?: boolean };
    const had = Object.getOwnPropertyDescriptor(stdin, "isTTY");
    Object.defineProperty(stdin, "isTTY", { value: false, configurable: true });
    try {
      await expect(main(["link", "127.0.0.1:7799"], d)).rejects.toThrow("--fingerprint");
      await expect(main(["link", "127.0.0.1:7799", "--fingerprint", "00"], d)).rejects.toThrow("--code");
      await expect(main(["link", "127.0.0.1:7799", "--fingerprint", "00", "--code", "SHORT"], d)).rejects.toThrow(
        "8-character pairing code",
      );
    } finally {
      if (had === undefined) delete stdin.isTTY;
      else Object.defineProperty(stdin, "isTTY", had);
    }
  });
});

describe("dori devices", () => {
  test("an empty list names the way to add one", async () => {
    const { d } = setup();
    const lines = await capture(() => main(["devices"], d));
    expect(lines).toEqual(["No linked devices: run dori link <host:port> on the new machine"]);
  });

  test("remove forgets a linked device and refuses an unknown one", async () => {
    const { d } = setup();
    const cert = generateAgentCert("box2", d.now());
    writeDevices(d.store.root, {
      devices: [
        {
          name: "box2",
          address: "192.168.0.12:7799",
          fingerprint: cert.fingerprint,
          cert: cert.cert,
          token: newToken(),
          addedAt: d.now(),
        },
      ],
    });
    expect(readDevices(d.store.root).devices).toHaveLength(1);
    const lines = await capture(() => main(["devices", "remove", "box2"], d));
    expect(lines).toEqual(["DEVICE_REMOVED box2"]);
    expect(readDevices(d.store.root).devices).toEqual([]);
    await expect(main(["devices", "remove", "box2"], d)).rejects.toThrow("no linked device box2");
  });
});
