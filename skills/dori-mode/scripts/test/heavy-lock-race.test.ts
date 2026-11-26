import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { withState } from "./fakes.ts";

// Every round seeds one lock left by a dead holder and starts WAITERS takers behind one barrier file, so they all decide
// at the same instant, ROUNDS times. Each section brackets itself in the log; a second taker inside the first one's
// section writes IN before OUT, which is the double entry a directory lock allowed when two takers removed the same
// stale lock. The legacy directory carries bulk entries: they make one recursive delete last long enough for the
// takeover race to be observable, and a lock document build never reads that directory. Each taker reports a finished
// round on stdout, so the parent advances on that line instead of polling.
const LOCK = join(import.meta.dir, "../src/heavy-lock.ts");
const ROUNDS = 4;
const WAITERS = 8;
const HOLD_MS = 20;
const BULK = 1_200;
const FIXED_START = "2026-01-01T00:00:00.000Z";
const DEAD_PID = 999_999;
const quoted = (value: string | number) => JSON.stringify(value);

const waiterScript = (dir: string, log: string): string => `
  const { underLock } = await import(${quoted(LOCK)});
  const { appendFileSync, existsSync } = await import("node:fs");
  const go = (round) => ${quoted(join(dir, "go-"))} + round;
  for (let round = 0; round < ${ROUNDS}; round++) {
    while (!existsSync(go(round))) await Bun.sleep(1);
    await underLock(${quoted(dir)}, async () => {
      appendFileSync(${quoted(log)}, "IN\\n");
      await Bun.sleep(${HOLD_MS});
      appendFileSync(${quoted(log)}, "OUT\\n");
    }, () => undefined, () => ${quoted(FIXED_START)});
    console.log("done");
  }
`;

// Both shapes a lock left by a dead holder can have: the lock document and the lock directory with its owner file.
const seed = (dir: string, round: number): void => {
  writeFileSync(join(dir, ".lock"), JSON.stringify({ pid: DEAD_PID, start: FIXED_START, nonce: `round-${round}` }));
  const legacy = join(dir, ".lock.dir");
  rmSync(legacy, { recursive: true, force: true });
  mkdirSync(legacy);
  writeFileSync(join(legacy, "owner"), `${DEAD_PID}`);
  for (let i = 0; i < BULK; i++) writeFileSync(join(legacy, `bulk-${i}`), "");
};

let state: ReturnType<typeof withState>;
beforeEach(() => {
  state = withState();
});
afterEach(() => state.done());

test("takers racing one dead holder's lock never enter together", async () => {
  const dir = join(state.dir, "heavy");
  const log = join(state.dir, "turns.log");
  mkdirSync(dir, { recursive: true });
  writeFileSync(log, "");
  const waiters = Array.from({ length: WAITERS }, () =>
    Bun.spawn([process.execPath, "-e", waiterScript(dir, log)], {
      stdout: "pipe",
      stderr: "pipe",
      windowsHide: true,
    }),
  );
  const finished = new Array<number>(WAITERS).fill(0);
  let failure: string | undefined;
  const listeners = new Set<() => void>();
  const advance = () => {
    for (const listener of listeners) listener();
  };
  const until = (ready: () => boolean) =>
    new Promise<void>((resolve) => {
      const check = () => {
        if (!ready()) return;
        listeners.delete(check);
        resolve();
      };
      listeners.add(check);
      check();
    });
  waiters.forEach((waiter, index) => {
    void (async () => {
      const decoder = new TextDecoder();
      let buffer = "";
      for await (const chunk of waiter.stdout) {
        buffer += decoder.decode(chunk as Uint8Array);
        for (let at = buffer.indexOf("\n"); at >= 0; at = buffer.indexOf("\n")) {
          buffer = buffer.slice(at + 1);
          if (finished[index] !== undefined) finished[index] = (finished[index] ?? 0) + 1;
          advance();
        }
      }
    })();
    void waiter.exited.then(async (code) => {
      if (code === 0) return;
      failure = `waiter ${index} exited ${code}: ${await new Response(waiter.stderr).text()}`;
      advance();
    });
  });
  for (let round = 0; round < ROUNDS; round++) {
    seed(dir, round);
    writeFileSync(join(dir, `go-${round}`), "");
    await until(() => failure !== undefined || finished.every((done) => done > round));
    if (failure !== undefined) throw new Error(`${failure}\nlog so far:\n${readFileSync(log, "utf8")}`);
  }
  expect(await Promise.all(waiters.map((w) => w.exited))).toEqual(Array(WAITERS).fill(0));
  const expected = Array.from({ length: ROUNDS * WAITERS * 2 }, (_, i) => (i % 2 === 0 ? "IN" : "OUT"));
  expect(readFileSync(log, "utf8").trim().split(/\r?\n/)).toEqual(expected);
});
