import { mkdirSync, mkdtempSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { writeSupervisorRecord } from "../src/supervisors.ts";

export const NOW = 1_800_000_000_000;

export function homeWithState(): string {
  const home = mkdtempSync(join(tmpdir(), "dori-sup-"));
  mkdirSync(join(home, "state"), { recursive: true });
  return home;
}

/** Writes a state heartbeat with the given mtime, so a test can look at any age without waiting. */
export function beat(home: string, name: string, at = NOW): void {
  const path = join(home, "state", name);
  mkdirSync(join(home, "state"), { recursive: true });
  writeFileSync(path, new Date(at).toISOString());
  utimesSync(path, new Date(at), new Date(at));
}

/** A loops supervisor record whose units are this test process, so `pidAlive` answers true. */
export function loopsRecord(home: string, units: readonly string[] = ["duty"]): void {
  writeSupervisorRecord(home, {
    name: "loops",
    pid: process.pid,
    startedAt: NOW - 60_000,
    units: units.map((name) => ({ name, pid: process.pid, at: NOW - 60_000 })),
    at: NOW,
  });
}
