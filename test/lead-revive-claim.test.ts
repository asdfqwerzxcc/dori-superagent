import { describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { claimLeadRevive, LEAD_REVIVE, leadRevives } from "../src/lead-revive.ts";

// D2 gate finding: the one-revive claim must be an exclusive create, so two concurrent dori up processes cannot both
// type into the same pane. The loser opens a new lead instead. The race test releases every child from one barrier, so
// their claims land together instead of a few milliseconds apart.

const PANE = "w1:p1";
const CHILDREN = 4;
const ROUNDS = 3;
const MODULE = join(import.meta.dir, "..", "src", "lead-revive.ts");

const until = async (what: string, ready: () => boolean): Promise<void> => {
  const deadline = Date.now() + 15_000;
  while (!ready()) {
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
    await Bun.sleep(5);
  }
};

/** One round: every child loads first, signals ready, then waits for the one go file the parent writes when all are. */
async function race(home: string): Promise<string[]> {
  const script = `
    const { existsSync, writeFileSync } = await import("node:fs");
    const { claimLeadRevive } = await import(${JSON.stringify(MODULE)});
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
      expect(err.trim()).toBe("");
      expect(code).toBe(0);
      return out.trim();
    }),
  );
  return results;
}

describe("the one-revive claim is exclusive", () => {
  test("a marker that already exists is not claimed again, and another pane is", () => {
    const home = mkdtempSync(join(tmpdir(), "dori-claim-"));
    expect(claimLeadRevive(home, PANE)).toBe(true);
    expect(claimLeadRevive(home, PANE)).toBe(false);
    expect(leadRevives(home, PANE)).toBe(1);
    expect(claimLeadRevive(home, "w1:p2")).toBe(true);
  });

  test("every barrier round of four processes yields exactly one claim", async () => {
    for (let round = 0; round < ROUNDS; round++) {
      const home = mkdtempSync(join(tmpdir(), `dori-claim-race-${round}-`));
      const results = await race(home);
      expect(results.filter((out) => out === "CLAIMED")).toHaveLength(1);
      expect(results.filter((out) => out === "LOST")).toHaveLength(CHILDREN - 1);
      expect(leadRevives(home, PANE)).toBe(1);
    }
  });

  test("a record write that fails refuses the claim, keeps the marker and leaves the reason", () => {
    const home = mkdtempSync(join(tmpdir(), "dori-claim-fail-"));
    const deny = (): never => {
      throw new Error("EPERM: cannot write");
    };
    expect(claimLeadRevive(home, PANE, Date.now(), deny)).toBe(false);
    // The claim stands: the marker exists, so a later dori up opens a new lead instead of typing into the pane again.
    expect(leadRevives(home, PANE)).toBe(1);
    expect(claimLeadRevive(home, PANE)).toBe(false);
    const notes = readFileSync(join(home, "state", LEAD_REVIVE, "errors.jsonl"), "utf8");
    expect(notes).toContain('"pane":"w1:p1"');
    expect(notes).toContain("EPERM: cannot write");
  });
});
