import { describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  clearLeadRestartBusy,
  leadRestartBusy,
  leadRestartTtl,
  markLeadRestartBusy,
} from "../src/lead-restart-busy.ts";
import {
  clearLeadStarting,
  LEAD_STARTING_MS,
  LEAD_START_WINDOW_MS,
  leadStarting,
  markLeadStarting,
} from "../src/lead-starting.ts";
import { USAGE } from "../src/cli-args.ts";
import { targetScope } from "../src/lead-swap-detach.ts";

const home = () => mkdtempSync(join(tmpdir(), "dori-busy-"));
const busyPath = (h: string) => join(h, "state", "lead-restart.busy");

describe("the lead restart busy marker", () => {
  test("a marker expires by its own deadline", () => {
    const h = home();
    const token = markLeadRestartBusy(h, "w1:p1", 200);
    expect(token).toBeDefined();
    expect(leadRestartBusy(h)).toBe(true);
    expect(leadRestartBusy(h, Date.now() + 5000)).toBe(false);
    expect(existsSync(busyPath(h))).toBe(false);
  });

  test("a long drain gets a lifetime longer than the drain", () => {
    expect(leadRestartTtl(600_000)).toBeGreaterThan(600_000);
    expect(leadRestartTtl(180_000)).toBe(390_000);
    const h = home();
    markLeadRestartBusy(h, "w1:p1", leadRestartTtl(600_000));
    expect(leadRestartBusy(h, Date.now() + 500_000)).toBe(true);
  });

  test("a newer owner is not cleared by an older token", () => {
    const h = home();
    const first = markLeadRestartBusy(h, "w1:p1", 60_000);
    const second = markLeadRestartBusy(h, "w1:p1", 60_000);
    clearLeadRestartBusy(h, first);
    expect(leadRestartBusy(h)).toBe(true);
    clearLeadRestartBusy(h, second);
    expect(leadRestartBusy(h)).toBe(false);
  });

  test("a legacy marker without until uses the five-minute fallback", () => {
    const h = home();
    mkdirSync(join(h, "state"), { recursive: true });
    writeFileSync(busyPath(h), JSON.stringify({ pane: "w1:p1", pid: 1, token: "legacy", at: 0 }));
    const old = new Date(Date.now() - 600_000);
    utimesSync(busyPath(h), old, old);
    expect(leadRestartBusy(h)).toBe(false);
    expect(existsSync(busyPath(h))).toBe(false);
  });
});

describe("the lead start grace", () => {
  test("fresh and capped markers block, a stale one allows a retry", () => {
    const h = home();
    expect(leadStarting(h).starting).toBe(false);
    markLeadStarting(h);
    expect(leadStarting(h).starting).toBe(true);
    expect(leadStarting(h, Date.now() + LEAD_STARTING_MS + 1000).starting).toBe(false);
    markLeadStarting(h);
    markLeadStarting(h);
    expect(leadStarting(h, Date.now() + LEAD_STARTING_MS + 1000).starting).toBe(true);
    expect(leadStarting(h, Date.now() + LEAD_START_WINDOW_MS + 1000).starting).toBe(false);
    clearLeadStarting(h);
  });
});

describe("targetScope", () => {
  test("the caller pid is excluded even when its command carries the prompt", () => {
    const procs = [{ pid: 4000, command: "bun cli.ts lead-restart --append-system-prompt C:\\lead.md", parent: 1 }];
    expect(targetScope(procs, 4000)).toEqual([]);
    expect(targetScope(procs, 1)).toEqual(procs);
  });
});

describe("worker flags", () => {
  test("help lists --parent-pid and --busy-token", () => {
    expect(USAGE).toContain("--parent-pid");
    expect(USAGE).toContain("--busy-token");
  });
});
