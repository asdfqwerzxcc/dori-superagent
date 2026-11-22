import { describe, expect, test } from "bun:test";
import { join } from "node:path";
import { flushInbox } from "../src/inbox.ts";
import { Runtimes } from "../src/runtime/registry.ts";
import type { SessionRuntime } from "../src/runtime/types.ts";
import { href, World } from "./fake.ts";

const screen = (name: string) => Bun.file(join(import.meta.dir, "fixtures", "screens", `${name}.txt`)).text();

function runtimeFor(text: string, sent: string[]): SessionRuntime {
  return {
    kind: "herdr",
    self: () => undefined,
    createGroup: async (label) => label,
    create: async () => {
      throw new Error("create is not used");
    },
    start: async () => {},
    list: async () => [],
    probe: async () => ({ status: "working", shellInFront: false }),
    read: async () => text,
    deliver: async (_ref, body) => {
      sent.push(body);
      return { kind: "delivered" };
    },
    submitTyped: async () => "submitted",
    typeIntoShell: async () => false,
    keys: async () => {},
    close: async () => {},
  };
}

function held(text: string) {
  const w = new World();
  const sent: string[] = [];
  const d = { ...w.deps(), runtimes: new Runtimes("herdr", () => runtimeFor(text, sent)) };
  const ref = href("w1:p9");
  d.store.enqueue(ref, { at: w.clock, from: "cli", text: "hello" });
  return { d, ref, sent };
}

describe("the inbox's own idle-screen read", () => {
  test("a busy probe word with an idle screen and extra footer lines delivers the held entry", async () => {
    const idle = await screen("omo-idle-live-monitors");
    const footer = [
      "Tip: /reflect reviews the session now.",
      "(2h 14m)",
      "~/work/project • CH42% • $0.120 • 90K/1M (9.0%) (auto) • effort high (shift+tab)",
    ].join("\n");
    const { d, ref, sent } = held(`${idle}\n${footer}`);
    expect(await flushInbox(d, ref)).toBe("delivered");
    expect(sent).toEqual(["hello"]);
  });

  test("a busy probe word with a turn screen keeps the held entry queued", async () => {
    const { d, ref, sent } = held(await screen("omo-turn"));
    expect(await flushInbox(d, ref)).toBe("queued");
    expect(sent).toEqual([]);
  });
});
