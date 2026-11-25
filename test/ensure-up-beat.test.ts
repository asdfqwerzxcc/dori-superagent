import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { processStartTimeMs } from "../src/process-liveness.ts";
import { startEnsureUpBeat } from "../src/supervisors/ensure-up.ts";
import { ensureUpRecord } from "../src/supervisors.ts";

describe("the ensure-up loop record", () => {
  test("carries the pid's OS start, so the 2 s identity compares OS clocks", () => {
    const home = mkdtempSync(join(tmpdir(), "dori-beat-"));
    mkdirSync(join(home, "state"), { recursive: true });
    const stop = startEnsureUpBeat(home, Date.now() - 60_000);
    try {
      const osStart = processStartTimeMs(process.pid);
      if (osStart === null) throw new Error("this process has no readable OS start");
      const record = ensureUpRecord(home);
      expect(record?.pid).toBe(process.pid);
      expect(record?.startedAt).toBe(osStart);
    } finally {
      stop();
    }
  });
});
