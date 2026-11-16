import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  alertText,
  checkSilence,
  decide,
  readSilenceState,
  rungFor,
  silenceStatePath,
  type SilenceIo,
} from "../src/plugins/silence-check.ts";
import type { DiscordMessage } from "../src/plugins/discord.ts";

const NOW = Date.parse("2026-11-16T12:06:00.000Z");
const human = (id: string, at: string, content = "hello"): DiscordMessage => ({
  id,
  timestamp: at,
  content,
  author: { bot: false },
});
const bot = (id: string, at: string): DiscordMessage => ({
  id,
  timestamp: at,
  content: "ok",
  author: { bot: true },
});

const homeWithState = (): string => {
  const home = mkdtempSync(join(tmpdir(), "dori-silence-"));
  mkdirSync(join(home, "state"), { recursive: true });
  return home;
};

const ioWith = (messages: readonly DiscordMessage[], delivered: string[]): SilenceIo => ({
  token: () => "token",
  channels: () => ["c1"],
  fetchMessages: async () => messages,
  deliver: async (_home, text) => {
    delivered.push(text);
  },
});

describe("silence-check decision", () => {
  test("unanswered 4 min -> none", () => {
    expect(decide([human("100", "2026-11-16T12:02:00.000Z")], NOW).kind).toBe("none");
  });

  test("6 min -> rung 1", () => {
    expect(decide([human("100", "2026-11-16T12:00:00.000Z")], NOW)).toMatchObject({
      kind: "alert",
      messageId: "100",
      rung: 1,
      silentMinutes: 6,
    });
  });

  test("16 min -> rung 2", () => {
    expect(decide([human("100", "2026-11-16T11:50:00.000Z")], NOW)).toMatchObject({
      kind: "alert",
      rung: 2,
      silentMinutes: 16,
    });
  });

  test("the ladder repeats every 30 min after 15", () => {
    expect([4 / 60, 5, 14.9, 15, 44.9, 45, 75].map(rungFor)).toEqual([0, 1, 1, 2, 2, 3, 4]);
  });

  test("same message twice -> no duplicate", () => {
    const messages = [human("100", "2026-11-16T12:00:00.000Z")];
    expect(decide(messages, NOW, { messageId: "100", rung: 1 }).kind).toBe("none");
    expect(decide(messages, NOW, { messageId: "100", rung: 2 }).kind).toBe("none");
  });

  test("bot reply after the human message -> cleared", () => {
    const messages = [human("100", "2026-11-16T12:00:00.000Z"), bot("200", "2026-11-16T12:02:00.000Z")];
    expect(decide(messages, NOW)).toEqual({ kind: "clear", messageId: "100" });
  });

  test("a bot message older than the human one leaves it unanswered", () => {
    const messages = [human("200", "2026-11-16T12:00:00.000Z"), bot("100", "2026-11-16T12:03:00.000Z")];
    expect(decide(messages, NOW)).toMatchObject({ kind: "alert", messageId: "200", rung: 1 });
  });

  test("the alert block carries the id, the clock, 60 chars and the four causes", () => {
    const content = `${"x".repeat(59)}y and much more after the cut`;
    const decision = decide([human("100", "2026-11-16T12:00:00.000Z", content)], NOW);
    if (decision.kind !== "alert") throw new Error("expected an alert");
    const text = alertText("c1", decision);
    expect(text).toContain(`[SILENT 6min] ch=c1 msg=100 at=`);
    expect(text).toContain(`"${"x".repeat(59)}y"`);
    expect(text).toContain("1) turn blocked on a child");
    expect(text).toContain("4) gateway catch-up missed it");
    expect(text.split("\n")).toHaveLength(2);
  });
});

describe("silence-check tick", () => {
  test("alerts once per rung, keeps the message id in state, and clears on a newer bot message", async () => {
    const home = homeWithState();
    const delivered: string[] = [];
    const messages: DiscordMessage[] = [human("100", "2026-11-16T12:00:00.000Z")];
    const io = ioWith(messages, delivered);
    const ctx = { home, now: () => NOW, log: () => {} };

    expect(await checkSilence(ctx, io)).toMatchObject({ channels: 1, alerts: 1, errors: 0 });
    expect(delivered).toHaveLength(1);
    expect(readSilenceState(home)).toEqual({ c1: { messageId: "100", rung: 1 } });

    expect(await checkSilence(ctx, io)).toMatchObject({ alerts: 0 });
    expect(delivered).toHaveLength(1);

    messages.push(bot("200", "2026-11-16T12:05:00.000Z"));
    expect(await checkSilence(ctx, io)).toMatchObject({ alerts: 0, cleared: 1 });
    expect(readSilenceState(home)).toEqual({});
  });

  test("a Discord API error logs one line, returns, and never delivers", async () => {
    const home = homeWithState();
    const logs: string[] = [];
    const delivered: string[] = [];
    const io: SilenceIo = {
      token: () => "token",
      channels: () => ["c1"],
      fetchMessages: async () => {
        throw new Error("503 Service Unavailable");
      },
      deliver: async (_home, text) => {
        delivered.push(text);
      },
    };
    const counts = await checkSilence({ home, now: () => NOW, log: (line) => logs.push(line) }, io);
    expect(counts).toMatchObject({ channels: 1, alerts: 0, errors: 1 });
    expect(delivered).toEqual([]);
    expect(logs).toHaveLength(1);
    expect(logs[0]).toContain("SILENCE_CHECK error ch=c1 503 Service Unavailable");
  });

  test("an HTTP failure is one log line, not a throw", async () => {
    const home = homeWithState();
    const logs: string[] = [];
    const io: SilenceIo = {
      token: () => "token",
      channels: () => ["c1"],
      fetchMessages: async () => null,
      deliver: async () => {},
    };
    expect(await checkSilence({ home, now: () => NOW, log: (line) => logs.push(line) }, io)).toMatchObject({
      errors: 1,
    });
    expect(logs).toEqual(["SILENCE_CHECK discord_api ch=c1 unavailable"]);
  });

  test("a failed delivery does not record the rung, so the next tick retries it", async () => {
    const home = homeWithState();
    const messages = [human("100", "2026-11-16T12:00:00.000Z")];
    const ctx = { home, now: () => NOW, log: () => {} };
    const failing: SilenceIo = {
      token: () => "token",
      channels: () => ["c1"],
      fetchMessages: async () => messages,
      deliver: async () => {
        throw new Error("send lead exited 2");
      },
    };
    expect(await checkSilence(ctx, failing)).toMatchObject({ alerts: 0, errors: 1 });
    expect(readSilenceState(home)).toEqual({});

    const delivered: string[] = [];
    expect(await checkSilence(ctx, ioWith(messages, delivered))).toMatchObject({ alerts: 1 });
    expect(delivered).toHaveLength(1);
  });

  test("a malformed state file is a logged skip, never a duplicate alert", async () => {
    const home = homeWithState();
    writeFileSync(silenceStatePath(home), "{not json");
    const logs: string[] = [];
    const delivered: string[] = [];
    const io = ioWith([human("100", "2026-11-16T12:00:00.000Z")], delivered);
    expect(await checkSilence({ home, now: () => NOW, log: (line) => logs.push(line) }, io)).toMatchObject({
      errors: 1,
    });
    expect(delivered).toEqual([]);
    expect(logs[0]).toContain("SILENCE_CHECK state unreadable");
  });
});
