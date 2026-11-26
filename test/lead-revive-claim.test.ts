import { describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { claimLeadRevive, leadRevives } from "../src/lead-revive.ts";

// D2 gate finding: the one-revive claim must be an exclusive create, so two concurrent dori up processes cannot both
// type into the same pane. The loser opens a new lead instead. The race test releases every child from one barrier, so
// their claims land together instead of a few milliseconds apart.

const PANE = "w1:p1";
const CHILDREN = 4;

const until = async (what: string, ready: () => boolean): Promise<void> => {
  const deadline = Date.now() + 15_000;
  while (!ready()) {
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
    await Bun.sleep(5);
  }
};

describe("the one-revive claim is exclusive", () => {
  test("a marker that already exists is not claimed again, and another pane is", () => {
    const home = mkdtempSync(join(tmpdir(), "dori-claim-"));
    expect(claimLeadRevive(home, PANE)).toBe(true);
    expect(claimLeadRevive(home, PANE)).toBe(false);
    expect(leadRevives(home, PANE)).toBe(1);
    expect(claimLeadRevive(home, "w1:p2")).toBe(true);
  });

  test("four processes released from one barrier: exactly one claim wins", async () => {
    const home = mkdtempSync(join(tmpdir(), "dori-claim-race-"));
    const module = join(import.meta.dir, "..", "src", "lead-revive.ts");
    // Each child loads first, signals ready, then waits for the one go file; the parent writes it once all are loaded,
    // so all four call claimLeadRevive within the same instant.
    const script = `
      const { existsSync, writeFileSync } = await import("node:fs");
      const { claimLeadRevive } = await import(${JSON.stringify(module)});
      const home = process.env.CLAIM_HOME;
      writeFileSync(home + "/ready-" + process.env.CLAIM_ID, "1");
      while (!existsSync(home + "/go")) await Bun.sleep(1);
      console.log(claimLeadRevive(home, ${JSON.stringify(PANE)}) ? "CLAIMED" : "LOST");
    `;
    const ids = Array.from({ length: CHILDREN }, (_, id) => id);
    const children = ids.map((id) =>
      Bun.spawn([process.execPath, "-e", script], {
        env: { ...process.env, CLAIM_HOME: home, CLAIM_ID: String(id) },
        windowsHide: true,
        stdout: "pipe",
        stderr: "pipe",
        stdin: "ignore",
      }),
    );
    await until("every child to load", () => ids.every((id) => existsSync(join(home, `ready-${id}`))));
    writeFileSync(join(home, "go"), "1");
    const results = await Promise.all(
      children.map(async (proc) => {
        const [out, err, code] = await Promise.all([
          new Response(proc.stdout).text(),
          new Response(proc.stderr).text(),
          proc.exited,
        ]);
        return { out: out.trim(), err: err.trim(), code };
      }),
    );
    expect(results.map((r) => r.err)).toEqual(ids.map(() => ""));
    expect(results.map((r) => r.code)).toEqual(ids.map(() => 0));
    expect(results.filter((r) => r.out === "CLAIMED")).toHaveLength(1);
    expect(results.filter((r) => r.out === "LOST")).toHaveLength(CHILDREN - 1);
    expect(leadRevives(home, PANE)).toBe(1);
  });
});
