import { describe, expect, test } from "bun:test";
import { join } from "node:path";
import { omoInputReady } from "../src/runtime/screen.ts";
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

describe("omoInputReady (the live composer, not only the idle box)", () => {
  test("waiting on background children: ready while the status word stays working", async () => {
    expect(omoInputReady(await screen("omo-waiting-children"))).toEqual({
      ready: true,
      why: "input box live while waiting on background children",
    });
    expect(omoScreenIdle(await screen("omo-waiting-children"))).toBe(false);
  });

  test("a turn, a draft or a dialog is not ready, with the logged reason", async () => {
    expect(omoInputReady(await screen("omo-turn"))).toEqual({
      ready: false,
      why: "a turn is running (esc to interrupt)",
    });
    expect(omoInputReady(await screen("omo-draft"))).toEqual({
      ready: false,
      why: "the input box holds a draft",
    });
    expect(omoInputReady(await screen("omo-dialog"))).toEqual({ ready: false, why: "no input box on screen" });
  });

  test("the current footer wording (`~ •`, `effort max`, `mem:user`) does not hide an idle box", async () => {
    expect(omoScreenIdle(await screen("omo-idle-current-footer"))).toBe(true);
    expect(omoInputReady(await screen("omo-idle-current-footer"))).toEqual({ ready: true, why: "idle input box" });
  });

  test("the TPS footer fused onto the composer's top border does not hide an idle box", async () => {
    expect(omoScreenIdle(await screen("omo-idle-fused-tps"))).toBe(true);
    expect(omoInputReady(await screen("omo-idle-fused-tps"))).toEqual({ ready: true, why: "idle input box" });
  });

  test("an unknown line below the box without waiting_children is not ready", async () => {
    const idle = await screen("omo-idle-live-monitors");
    expect(omoInputReady(`${idle}\nsome late output`)).toEqual({ ready: false, why: "output below the input box" });
  });

  test("waiting_children above the composer does not excuse output below it", async () => {
    const idle = await screen("omo-idle-live-monitors");
    expect(omoInputReady(`the footer said waiting_children\n${idle}\nsome late output`)).toEqual({
      ready: false,
      why: "output below the input box",
    });
  });
});

describe("unwrapped read", () => {
  test("asks herdr for the recent-unwrapped source, so a line wider than the pane comes back as one line", async () => {
    const r = recorder();
    await new HerdrRuntime(r.exec, "").read(ref("w1:p1"), 40, { unwrapped: true });
    expect(r.calls).toEqual([["pane", "read", "w1:p1", "--lines", "40", "--source", "recent-unwrapped"]]);
  });
});
