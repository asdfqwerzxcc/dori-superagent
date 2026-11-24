import { describe, expect, test } from "bun:test";
import { pidAlive, processStartTimeMs, startedNear, terminateProcess } from "../src/process-liveness.ts";

const UNUSED = 4_294_967_294;

describe("kernel32 liveness", () => {
  test("this process is alive and its start time is readable", () => {
    expect(pidAlive(process.pid)).toBe(true);
    const started = processStartTimeMs(process.pid);
    expect(started).not.toBeNull();
    expect(Math.abs((started ?? 0) - Date.now())).toBeLessThan(24 * 60 * 60 * 1000);
    expect(startedNear(process.pid, started ?? 0)).toBe(true);
    expect(startedNear(process.pid, 0)).toBe(false);
  });

  test("zero and an unused pid are dead", () => {
    expect(pidAlive(0)).toBe(false);
    expect(pidAlive(-1)).toBe(false);
    expect(pidAlive(UNUSED)).toBe(false);
    expect(processStartTimeMs(UNUSED)).toBeNull();
  });

  test("a child that exited is dead even while its handle is retained", async () => {
    const child = Bun.spawn([process.execPath, "-e", ""], {
      stdout: "ignore",
      stderr: "ignore",
      windowsHide: true,
    });
    await child.exited;
    expect(pidAlive(child.pid)).toBe(false);
  });

  test("terminate refuses this process and an unused pid", () => {
    expect(terminateProcess(process.pid)).toBe(false);
    expect(terminateProcess(UNUSED)).toBe(false);
  });
});
