import { afterEach, beforeEach, expect, test } from "bun:test";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { withState } from "./fakes.ts";

// Every round seeds one lock left by a dead holder and starts WAITERS takers behind one barrier file, so they all decide
// at the same instant, ROUNDS times. Each section brackets itself in the log; a second taker inside the first one's
// section writes IN before OUT, which is the double entry a directory lock allowed when two takers removed the same
// stale lock. The legacy directory carries bulk entries: they make one recursive delete last long enough for the
// takeover race to be observable, and a lock document build never reads that directory at all.
const LOCK = join(import.meta.dir, "../src/heavy-lock.ts");
const ROUNDS = 6;
const WAITERS = 6;
const HOLD_MS = 20;
const BULK = 1_200;
const FIXED_START = "2026-01-01T00:00:00.000Z";
const DEAD_PID = 999_999;
const quoted = (value: string | number) => JSON.stringify(value);

const waiterScript = (dir: string, log: string, done: string): string => `
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
    appendFileSync(${quoted(done)}, round + "\\n");
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

const count = (path: string): number =>
  existsSync(path) ? readFileSync(path, "utf8").trim().split(/\r?\n/).length : 0;

test("takers racing one dead holder's lock never enter together", async () => {
  const dir = join(state.dir, "heavy");
  const log = join(state.dir, "turns.log");
  const done = join(state.dir, "done.log");
  mkdirSync(dir, { recursive: true });
  writeFileSync(log, "");
  writeFileSync(done, "");
  const waiters = Array.from({ length: WAITERS }, () =>
    Bun.spawn([process.execPath, "-e", waiterScript(dir, log, done)], {
      stdout: "pipe",
      stderr: "pipe",
      windowsHide: true,
    }),
  );
  for (let round = 0; round < ROUNDS; round++) {
    seed(dir, round);
    writeFileSync(join(dir, `go-${round}`), "");
    for (let waited = 0; count(done) < (round + 1) * WAITERS && waited < 2_000; waited++) {
      const dead = waiters.findIndex((w) => (w.exitCode !== null && w.exitCode !== 0) || w.signalCode !== null);
      if (dead !== -1)
        throw new Error(
          `waiter ${dead} died in round ${round} (exit ${waiters[dead]?.exitCode}/signal ${waiters[dead]?.signalCode}):\n${await new Response(waiters[dead]?.stderr).text()}\nlog so far:\n${readFileSync(log, "utf8")}`,
        );
      await Bun.sleep(25);
    }
  }
  expect(await Promise.all(waiters.map((w) => w.exited))).toEqual(Array(WAITERS).fill(0));
  const expected = Array.from({ length: ROUNDS * WAITERS * 2 }, (_, i) => (i % 2 === 0 ? "IN" : "OUT"));
  expect(readFileSync(log, "utf8").trim().split(/\r?\n/)).toEqual(expected);
}, 120_000);
