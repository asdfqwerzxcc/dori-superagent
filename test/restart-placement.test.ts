import { describe, expect, test } from "bun:test";
import { restartLines } from "../src/supervisor-restart.ts";
import type { SupervisorHealth } from "../src/supervisors.ts";

describe("restart placement lines", () => {
  test("the printed output names a headless unit in the UNITS line before the verdict", () => {
    const health: SupervisorHealth[] = [
      {
        name: "supervisor",
        pid: 1,
        alive: true,
        heartbeatAgeMs: 0,
        units: [
          { name: "discord-gateway", pid: 11, pane: "w1:p1", alive: true },
          { name: "duty", pid: 12, alive: true },
          { name: "loop", pid: 13, pane: "w1:p2", alive: true },
        ],
      },
      { name: "watchdog", pid: 2, alive: true, units: [] },
    ];
    const lines = restartLines(
      {
        ok: true,
        elapsedMs: 1_200,
        dupes: { killed: [] },
        killed: [1],
        health,
        expected: ["discord-gateway", "duty", "loop"],
        ensureUp: { alive: false },
        off: true,
        wsHeartbeatAgeMs: 1_000,
        retried: false,
        missing: [],
      },
      "panes",
    );
    expect(lines).toContain("UNITS panes=2/3 headless=duty dead=none missing=none");
    expect(lines.findIndex((line) => line.startsWith("UNITS "))).toBe(2);
    expect(lines.at(-1)).toBe("RESTARTED killed=1 ms=1200 ws=1s units=panes");
  });

  test("a short restart prints each missing piece after the UNITS line and before the verdict", () => {
    const lines = restartLines(
      {
        ok: false,
        elapsedMs: 500,
        dupes: { killed: [] },
        killed: [],
        health: [{ name: "supervisor", pid: 1, alive: false, units: [] }],
        expected: ["duty"],
        ensureUp: { alive: false },
        off: true,
        retried: true,
        missing: ["unit du\nty missing"],
      },
      "headless",
    );
    expect(lines.at(-2)).toBe("RESTART MISSING unit du?ty missing");
    expect(lines.at(-1)).toBe("RESTART INCOMPLETE killed=0 ms=500 ws=missing retried=1 units=headless");
  });

  test("a dead unit beside its pane is reported dead, not placed", () => {
    const health: SupervisorHealth[] = [
      {
        name: "supervisor",
        pid: 1,
        alive: true,
        units: [
          { name: "duty", pid: 12, pane: "w1:p1", alive: true },
          { name: "loop", pid: 13, pane: "w1:p2", alive: false },
        ],
      },
    ];
    const lines = restartLines(
      {
        ok: true,
        elapsedMs: 1,
        dupes: { killed: [] },
        killed: [],
        health,
        expected: ["duty", "loop"],
        ensureUp: { alive: false },
        off: true,
        retried: false,
        missing: [],
      },
      "panes",
    );
    expect(lines).toContain("UNITS panes=1/2 headless=none dead=loop missing=none");
  });

  test("a headless restart still names every headless unit", () => {
    const health: SupervisorHealth[] = [
      { name: "supervisor", pid: 1, alive: true, units: [{ name: "duty", pid: 2, alive: true }] },
    ];
    const lines = restartLines(
      {
        ok: true,
        elapsedMs: 1,
        dupes: { killed: [] },
        killed: [],
        health,
        expected: ["duty", "loop"],
        ensureUp: { alive: false },
        off: true,
        retried: false,
        missing: [],
      },
      "headless",
    );
    expect(lines).toContain("UNITS panes=0/2 headless=duty dead=none missing=loop");
    expect(lines.at(-1)).toContain("units=headless");
  });
});
