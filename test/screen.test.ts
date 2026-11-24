import { describe, expect, test } from "bun:test";
import { join } from "node:path";
import { flushInbox, send } from "../src/inbox.ts";
import { World, href } from "./fake.ts";

// Real omo screens captured with `herdr pane read --source recent`, sanitized (titles, costs, ids, paths replaced).
const screen = (name: string) => Bun.file(join(import.meta.dir, "fixtures", "screens", `${name}.txt`)).text();

async function captureStderr(run: () => Promise<unknown>): Promise<string> {
  const chunks: string[] = [];
  const write = process.stderr.write;
  process.stderr.write = ((chunk: string | Uint8Array) => {
    chunks.push(String(chunk));
    return true;
  }) as typeof process.stderr.write;
  try {
    await run();
    return chunks.join("");
  } finally {
    process.stderr.write = write;
  }
}

describe("delivery to a pane herdr calls working", () => {
  function setup(screenText?: string) {
    const w = new World();
    const d = w.deps();
    const lead = w.addPane("w1:p1", "working");
    lead.screen = screenText;
    d.store.setRole("lead", href("w1:p1"));
    return { w, d, lead };
  }

  test("live monitors and an idle screen: the message is delivered", async () => {
    const { d, lead } = setup(await screen("omo-idle-live-monitors"));
    expect(await send(d, "lead", "hello", "cli")).toBe("DELIVERED");
    expect(lead.received).toEqual(["hello"]);
  });

  test("a real turn: the message is queued and nothing is typed", async () => {
    const { w, d, lead } = setup(await screen("omo-turn"));
    expect(await send(d, "lead", "hello", "cli")).toBe("QUEUED");
    expect(lead.received).toEqual([]);
    expect(w.calls.some((c) => c.argv[1] === "send-text" || c.argv[0] === "agent")).toBe(false);
  });

  test("a failed screen read keeps the message queued", async () => {
    const { d, lead } = setup(undefined);
    expect(await send(d, "lead", "hello", "cli")).toBe("QUEUED");
    expect(lead.received).toEqual([]);
  });

  test("blocked is never read as idle, whatever the screen shows", async () => {
    const { w, d, lead } = setup(await screen("omo-idle-live-monitors"));
    lead.status = "blocked";
    expect(await send(d, "lead", "hello", "cli")).toBe("QUEUED");
    expect(w.calls.some((c) => c.argv[1] === "read")).toBe(false);
  });

  test("a lead waiting on a background child: the live composer takes the message", async () => {
    const { d, lead } = setup(await screen("omo-waiting-children"));
    expect(await send(d, "lead", "hello", "cli")).toBe("DELIVERED");
    expect(lead.received).toEqual(["hello"]);
  });

  test("a draft in the composer: held, never typed over", async () => {
    const { w, d, lead } = setup(await screen("omo-draft"));
    expect(await send(d, "lead", "hello", "cli")).toBe("QUEUED");
    expect(lead.received).toEqual([]);
    expect(w.calls.some((c) => c.argv[0] === "agent" || c.argv[1] === "send-text")).toBe(false);
  });

  test("the deliver and hold decisions leave their reason on stderr", async () => {
    const ready = setup(await screen("omo-waiting-children"));
    const delivered = await captureStderr(() => send(ready.d, "lead", "hello", "cli"));
    expect(delivered).toContain("delivering: working, input box live while waiting on background children");

    const busy = setup(await screen("omo-turn"));
    const queued = await captureStderr(() => send(busy.d, "lead", "hello", "cli"));
    expect(queued).toContain("queued: working, a turn is running (esc to interrupt)");
  });
});

function setupLane(screenText?: string) {
  const w = new World();
  const d = w.deps();
  const pane = w.addPane("w1:p2", "working");
  pane.screen = screenText;
  d.store.saveLane({
    key: "fix-x",
    sessionRef: href("w1:p2"),
    paneId: "w1:p2",
    tabId: "w1:t2",
    brief: "/dev/null",
    cwd: "/",
    status: "working",
    createdAt: 0,
    lastActivityAt: 0,
    nudges: 0,
    log: [],
  });
  return { w, d, pane };
}

describe("delivery to a lane pane", () => {
  test("waiting on a live monitor with the current footer: delivered", async () => {
    const { w, d, pane } = setupLane(await screen("omo-idle-current-footer"));
    expect(await send(d, "fix-x", "hello", "cli")).toBe("DELIVERED");
    expect(pane.received).toEqual(["hello"]);
    expect(w.calls.some((c) => c.argv[0] === "agent")).toBe(true);
  });

  test("the TPS footer fused onto the composer border: delivered", async () => {
    const { d, pane } = setupLane(await screen("omo-idle-fused-tps"));
    expect(await send(d, "fix-x", "hello", "cli")).toBe("DELIVERED");
    expect(pane.received).toEqual(["hello"]);
  });

  test("waiting on a background child: delivered into the follow-up queue", async () => {
    const { d, pane } = setupLane(await screen("omo-waiting-children"));
    expect(await send(d, "fix-x", "hello", "cli")).toBe("DELIVERED");
    expect(pane.received).toEqual(["hello"]);
  });

  test("in a real turn: held, nothing typed", async () => {
    const { w, d, pane } = setupLane(await screen("omo-turn"));
    expect(await send(d, "fix-x", "hello", "cli")).toBe("QUEUED");
    expect(pane.received).toEqual([]);
    expect(w.calls.some((c) => c.argv[0] === "agent" || c.argv[1] === "send-text")).toBe(false);
  });

  test("an ambiguous entry stays held, even when the screen is ready", async () => {
    const { d, pane } = setupLane(await screen("omo-waiting-children"));
    d.store.saveInbox(href("w1:p2"), [
      { at: 1, from: "cli", text: "maybe arrived", attempt: { at: 1, state: "ambiguous" } },
    ]);
    expect(await flushInbox(d, href("w1:p2"))).toBe("held");
    expect(pane.received).toEqual([]);
  });
});
