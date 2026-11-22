import { describe, expect, test } from "bun:test";
import { join } from "node:path";
import { HerdrRuntime, omoScreenIdle } from "../src/runtime/herdr/index.ts";
import { recorder, ref, world } from "./herdr-recorder.ts";

const screen = (name: string) => Bun.file(join(import.meta.dir, "fixtures", "screens", `${name}.txt`)).text();

describe("omoScreenIdle (#62: herdr reports an omo with live monitors as working)", () => {
  test("idle input rule between turns, monitors still live: idle; a real turn: not idle", async () => {
    expect(omoScreenIdle(await screen("omo-idle-live-monitors"))).toBe(true);
    expect(omoScreenIdle(await screen("omo-turn"))).toBe(false);
  });

  test("doubt keeps it working: dialog, draft in the input, no box, unknown layout, empty read", async () => {
    expect(omoScreenIdle(await screen("omo-dialog"))).toBe(false);
    expect(omoScreenIdle(await screen("omo-draft"))).toBe(false);
    expect(omoScreenIdle("$ ls\nREADME.md\n$ ")).toBe(false);
    expect(omoScreenIdle("──────────\n❯\nsomething else\n")).toBe(false);
    expect(omoScreenIdle("")).toBe(false);
  });

  test("esc to interrupt or a spinner is busy; extra footer lines do not hide an idle box", async () => {
    const idle = await screen("omo-idle-live-monitors");
    expect(omoScreenIdle(`── • Working (9s • esc to interrupt) ──\n${idle}`)).toBe(false);
    expect(omoScreenIdle(`⠋ working\n${idle}`)).toBe(false);
    const footer = [
      "Tip: /reflect reviews the session now.",
      "(2h 14m)",
      "~/work/project • CH42% • $0.120 • 90K/1M (9.0%) (auto) • effort high (shift+tab)",
    ].join("\n");
    expect(omoScreenIdle(`${idle}\n${footer}`)).toBe(true);
    expect(omoScreenIdle(`${footer}\n${idle}`)).toBe(true);
    const unknown = ["more", "output", "below", "the", "box"].join("\n");
    expect(omoScreenIdle(`${idle}\n${unknown}`)).toBe(false);
  });

  test("probe of a working pane reads 30 recent lines and reports idle only for an idle omo screen", async () => {
    const { w, rt, herdr } = world();
    const p = w.addPane("w1:p1", "working");
    for (const [name, want] of [
      ["omo-idle-live-monitors", "idle"],
      ["omo-turn", "working"],
      ["omo-dialog", "working"],
      ["omo-draft", "working"],
    ] as const) {
      p.screen = await screen(name);
      expect((await rt.probe(ref("w1:p1"))).status).toBe(want);
    }
    expect(herdr()).toContainEqual(["pane", "read", "w1:p1", "--lines", "30", "--source", "recent"]);
    p.screen = undefined;
    expect((await rt.probe(ref("w1:p1"))).status).toBe("working");
  });

  test("blocked is never read as idle, whatever the screen shows", async () => {
    const { w, rt, herdr } = world();
    w.addPane("w1:p1", "blocked").screen = await screen("omo-idle-live-monitors");
    expect((await rt.probe(ref("w1:p1"))).status).toBe("blocked");
    expect(herdr().some((a) => a[1] === "read")).toBe(false);
  });
});

describe("unwrapped read", () => {
  test("asks herdr for the recent-unwrapped source, so a line wider than the pane comes back as one line", async () => {
    const r = recorder();
    await new HerdrRuntime(r.exec, "").read(ref("w1:p1"), 40, { unwrapped: true });
    expect(r.calls).toEqual([["pane", "read", "w1:p1", "--lines", "40", "--source", "recent-unwrapped"]]);
  });
});
