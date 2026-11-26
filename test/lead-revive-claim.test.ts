import { describe, expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { claimLeadRevive, leadRevives } from "../src/lead-revive.ts";

// D2 gate finding: the one-revive claim must be an exclusive create, so two concurrent dori up processes cannot both
// type into the same pane. The loser opens a new lead instead.

const PANE = "w1:p1";

describe("the one-revive claim is exclusive", () => {
  test("a marker that already exists is not claimed again, and another pane is", () => {
    const home = mkdtempSync(join(tmpdir(), "dori-claim-"));
    expect(claimLeadRevive(home, PANE)).toBe(true);
    expect(claimLeadRevive(home, PANE)).toBe(false);
    expect(leadRevives(home, PANE)).toBe(1);
    expect(claimLeadRevive(home, "w1:p2")).toBe(true);
  });

  test("two processes claiming the same pane at once: exactly one wins", async () => {
    const home = mkdtempSync(join(tmpdir(), "dori-claim-race-"));
    const module = join(import.meta.dir, "..", "src", "lead-revive.ts");
    const script = `const { claimLeadRevive } = await import(${JSON.stringify(module)}); console.log(claimLeadRevive(process.env.CLAIM_HOME, ${JSON.stringify(PANE)}) ? "CLAIMED" : "LOST");`;
    const runs = [0, 1, 2].map(() =>
      Bun.spawn([process.execPath, "-e", script], {
        env: { ...process.env, CLAIM_HOME: home },
        windowsHide: true,
        stdout: "pipe",
        stderr: "pipe",
        stdin: "ignore",
      }),
    );
    const results = await Promise.all(
      runs.map(async (proc) => {
        const [out, code] = await Promise.all([new Response(proc.stdout).text(), proc.exited]);
        return { out, code };
      }),
    );
    expect(results.map((r) => r.code)).toEqual([0, 0, 0]);
    expect(results.filter((r) => r.out.includes("CLAIMED"))).toHaveLength(1);
    expect(leadRevives(home, PANE)).toBe(1);
  }, 30_000);
});
