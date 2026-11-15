import { describe, expect, test } from "bun:test";
import { status } from "../src/cli-up.ts";
import { Refusal } from "../src/refusal.ts";
import { StaleRole, resolveLiveTarget } from "../src/target.ts";
import { World, href } from "./fake.ts";
import { captureIo } from "./inbox-setup.ts";
import { beat, loopsRecord } from "./supervisor-fixtures.ts";

describe("role honesty", () => {
  test("a role whose pane is gone is a StaleRole, and the hint names the supervisor that runs it", async () => {
    const w = new World();
    const d = w.deps();
    beat(d.store.root, "loops-heartbeat");
    loopsRecord(d.store.root);
    d.store.setRole("duty", href("w1:p9"));
    const failure: unknown = await resolveLiveTarget(d, "duty").then(
      () => undefined,
      (e: unknown) => e,
    );
    expect(failure).toBeInstanceOf(StaleRole);
    expect((failure as Error).message).toContain("w1:p9");
    expect((failure as Error).message).toContain(`loops supervisor (pid ${process.pid}, duty pid ${process.pid})`);
  });

  test("a role nobody registered is refused with the supervised process, not a silent guess", async () => {
    const w = new World();
    const d = w.deps();
    beat(d.store.root, "loops-heartbeat");
    loopsRecord(d.store.root, ["duty", "loop"]);
    const failure: unknown = await resolveLiveTarget(d, "hourly-loop").then(
      () => undefined,
      (e: unknown) => e,
    );
    expect(failure).toBeInstanceOf(Refusal);
    expect(failure).not.toBeInstanceOf(StaleRole);
    expect((failure as Error).message).toContain("no hourly-loop session registered");
    expect((failure as Error).message).toContain("the hourly loop runs under the loops supervisor");
  });

  test("a healthy role resolves and a lane key never pays for the probe", async () => {
    const w = new World();
    const d = w.deps();
    w.addPane("w1:p1", "idle");
    d.store.setRole("lead", href("w1:p1"));
    expect(await resolveLiveTarget(d, "lead")).toEqual(href("w1:p1"));
    expect(await resolveLiveTarget(d, "w1:p1")).toEqual(href("w1:p1"));
  });

  test("dori status prints a stale role and the supervised process lines", async () => {
    const w = new World();
    const d = w.deps();
    d.store.setRole("lead", href("w9:p1"));
    beat(d.store.root, "loops-heartbeat");
    loopsRecord(d.store.root);
    const { out } = await captureIo(async () => {
      await status(d);
      return 0;
    });
    expect(out).toContain("STALE lead=w9:p1: pane not found");
    expect(out).toContain("SUPERVISED loops    up");
    expect(out).toContain("ENSURE-UP DOWN");
  });
});
