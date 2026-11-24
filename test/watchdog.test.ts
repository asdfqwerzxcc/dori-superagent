import { describe, expect, test } from "bun:test";
import { staleAction } from "../src/supervisors/watchdog.ts";

const FRESH = 10_000;
const STALE = 200_000;

describe("watchdog stale action", () => {
  test("fresh beats need nothing", () => {
    expect(staleAction({ supervisorAgeMs: FRESH, wsAgeMs: FRESH, gatewayPids: [7], gatewayAttempts: 0 })).toEqual({
      kind: "none",
    });
  });

  test("a stale socket under a fresh supervisor costs only the gateway child", () => {
    expect(staleAction({ supervisorAgeMs: FRESH, wsAgeMs: STALE, gatewayPids: [7], gatewayAttempts: 0 })).toEqual({
      kind: "gateway",
      pids: [7],
    });
  });

  test("a stale supervisor takes the whole tree", () => {
    const stale = { supervisorAgeMs: STALE, gatewayPids: [7], gatewayAttempts: 0 };
    expect(staleAction({ ...stale, wsAgeMs: FRESH })).toEqual({ kind: "supervisor" });
    expect(staleAction({ ...stale, wsAgeMs: STALE })).toEqual({ kind: "supervisor" });
  });

  test("no gateway pid or two child restarts already spent escalates to the whole tree", () => {
    expect(staleAction({ supervisorAgeMs: FRESH, wsAgeMs: STALE, gatewayPids: [], gatewayAttempts: 0 })).toEqual({
      kind: "supervisor",
    });
    expect(staleAction({ supervisorAgeMs: FRESH, wsAgeMs: STALE, gatewayPids: [7], gatewayAttempts: 2 })).toEqual({
      kind: "supervisor",
    });
  });

  test("a missing supervisor heartbeat counts as stale", () => {
    expect(staleAction({ wsAgeMs: FRESH, gatewayPids: [7], gatewayAttempts: 0 })).toEqual({ kind: "supervisor" });
  });
});
