import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { readJson, writeJson } from "../json-file.ts";
import {
  discordGet,
  newerSnowflake,
  readDiscordToken,
  readGatewayLast,
  watchedChannels,
  type DiscordMessage,
} from "./discord.ts";
import type { Plugin, PluginCtx } from "./plugin.ts";

// A person's Discord message that no bot has answered is a lead problem, not a chat problem: the lead's turn may be
// held by a child, its child may be stuck, its prompt may never have arrived, or the socket catch-up may have missed the
// message. This plugin watches the gateway's channels and puts one compact prompt into the lead's inbox on the
// 5/15/30-minute ladder, keyed by message id so a tick can never repeat a rung and a newer bot message clears it.

const LIMIT = 20;
const FIRST_MINUTES = 5;
const SECOND_MINUTES = 15;
const REPEAT_MINUTES = 30;

export type RungMark = { readonly messageId: string; readonly rung: number };
export type SilenceState = Record<string, RungMark>;

export type SilenceDecision =
  | { readonly kind: "none" }
  | { readonly kind: "clear"; readonly messageId: string }
  | {
      readonly kind: "alert";
      readonly messageId: string;
      readonly rung: number;
      readonly silentMinutes: number;
      readonly at: number;
      readonly preview: string;
    };

/** Rung 1 at 5 min, rung 2 at 15 min, then one every 30 min; 0 before the first. */
export function rungFor(minutes: number): number {
  if (minutes < FIRST_MINUTES) return 0;
  if (minutes < SECOND_MINUTES) return 1;
  return 2 + Math.floor((minutes - SECOND_MINUTES) / REPEAT_MINUTES);
}

const newestHuman = (messages: readonly DiscordMessage[]): DiscordMessage | undefined =>
  messages
    .filter((m) => m.author?.bot !== true)
    .reduce<DiscordMessage | undefined>(
      (newest, m) => (newest === undefined || newerSnowflake(m.id, newest.id) ? m : newest),
      undefined,
    );

const answered = (messages: readonly DiscordMessage[], humanId: string): boolean =>
  messages.some((m) => m.author?.bot === true && newerSnowflake(m.id, humanId));

const preview = (content: string | undefined): string => {
  const flat = (content ?? "").replace(/\s+/g, " ").replaceAll('"', "'").trim();
  return flat === "" ? "(no text)" : flat.slice(0, 60);
};

/** Messages plus now: the newest unanswered human message's next rung, a clear, or nothing. Pure. */
export function decide(messages: readonly DiscordMessage[], now: number, alerted?: RungMark): SilenceDecision {
  const human = newestHuman(messages);
  if (human === undefined) return { kind: "none" };
  if (answered(messages, human.id)) return { kind: "clear", messageId: human.id };
  const at = Date.parse(human.timestamp ?? "");
  if (!Number.isFinite(at)) return { kind: "none" };
  const minutes = (now - at) / 60_000;
  const rung = rungFor(minutes);
  const already = alerted?.messageId === human.id ? alerted.rung : 0;
  if (rung === 0 || rung <= already) return { kind: "none" };
  return {
    kind: "alert",
    messageId: human.id,
    rung,
    silentMinutes: Math.floor(minutes),
    at,
    preview: preview(human.content),
  };
}

const two = (n: number): string => String(n).padStart(2, "0");
const clock = (at: number): string => {
  const date = new Date(at);
  return `${two(date.getHours())}:${two(date.getMinutes())}`;
};

/** The one block the lead gets: which message, how long, and the four causes to check right now. */
export const alertText = (channel: string, decision: Extract<SilenceDecision, { kind: "alert" }>): string =>
  [
    `[SILENT ${decision.silentMinutes}min] ch=${channel} msg=${decision.messageId} at=${clock(decision.at)} "${decision.preview}"`,
    "check now: 1) turn blocked on a child 2) child stuck 3) prompt never delivered 4) gateway catch-up missed it",
  ].join("\n");

export const silenceStatePath = (home: string): string => join(home, "state", "silence-check.json");

/** Throws on an unreadable file so the tick can log it and skip, instead of silently repeating an alert. */
export function readSilenceState(home: string): SilenceState {
  const raw = readJson<unknown>(silenceStatePath(home));
  if (raw === null || typeof raw !== "object" || Array.isArray(raw)) return {};
  const state: SilenceState = {};
  for (const [channel, value] of Object.entries(raw as Record<string, unknown>)) {
    const mark = value as { messageId?: unknown; rung?: unknown };
    if (typeof mark.messageId === "string" && Number.isInteger(mark.rung) && (mark.rung as number) > 0)
      state[channel] = { messageId: mark.messageId, rung: mark.rung as number };
  }
  return state;
}

export function writeSilenceState(home: string, state: SilenceState): void {
  mkdirSync(join(home, "state"), { recursive: true });
  writeJson(silenceStatePath(home), state);
}

export type SilenceIo = {
  readonly token: (home: string) => string | undefined;
  readonly channels: (home: string) => readonly string[];
  readonly fetchMessages: (channel: string, token: string) => Promise<readonly DiscordMessage[] | null>;
  readonly deliver: (home: string, text: string) => Promise<void>;
};

const cliPath = (): string => join(import.meta.dir, "..", "cli.ts");

/**
 * `dori send lead` is the same inbox duty flushes: a blocked lead keeps the alert in its queue, and a lead that is
 * ready gets it now. Exit 3 is HELD (recorded, must not be resent), which counts as delivered for the rung.
 */
export async function deliverLead(home: string, text: string): Promise<void> {
  const proc = Bun.spawn([process.execPath, cliPath(), "send", "lead", "--text", text], {
    stdout: "pipe",
    stderr: "pipe",
    windowsHide: true,
    env: { ...process.env, DORI_HOME: home },
  });
  const [out, err] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text()]);
  const code = await proc.exited;
  if (code !== 0 && code !== 3)
    throw new Error(`send lead exited ${code}: ${(out || err).trim().split("\n")[0] ?? ""}`);
}

const liveIo: SilenceIo = {
  token: readDiscordToken,
  channels: (home) => watchedChannels(readGatewayLast(home)),
  fetchMessages: (channel, token) =>
    discordGet<DiscordMessage[]>(`/channels/${channel}/messages?limit=${LIMIT}`, token),
  deliver: deliverLead,
};

const oneLine = (e: unknown): string =>
  String((e as Error)?.message ?? e)
    .replace(/\s+/g, " ")
    .slice(0, 160);

export type SilenceCounts = {
  readonly channels: number;
  readonly alerts: number;
  readonly cleared: number;
  readonly errors: number;
};

/** One tick. Every Discord failure is one log line and a return, never a throw; state keeps delivery idempotent. */
export async function checkSilence(
  ctx: Pick<PluginCtx, "home" | "now" | "log">,
  io: SilenceIo = liveIo,
): Promise<SilenceCounts> {
  const counts = { channels: 0, alerts: 0, cleared: 0, errors: 0 };
  const token = io.token(ctx.home);
  if (token === undefined || token === "") {
    ctx.log("SILENCE_CHECK no token");
    return counts;
  }
  let state: SilenceState;
  try {
    state = readSilenceState(ctx.home);
  } catch (e) {
    ctx.log(`SILENCE_CHECK state unreadable ${oneLine(e)}`);
    counts.errors += 1;
    return counts;
  }
  const channels = io.channels(ctx.home);
  counts.channels = channels.length;
  const watched = new Set(channels);
  let dirty = false;
  for (const channel of Object.keys(state)) {
    if (!watched.has(channel)) {
      delete state[channel];
      dirty = true;
    }
  }
  for (const channel of channels) {
    try {
      const messages = await io.fetchMessages(channel, token);
      if (messages === null) {
        ctx.log(`SILENCE_CHECK discord_api ch=${channel} unavailable`);
        counts.errors += 1;
        continue;
      }
      const decision = decide(messages, ctx.now(), state[channel]);
      if (decision.kind === "clear") {
        if (state[channel] !== undefined) {
          delete state[channel];
          dirty = true;
          counts.cleared += 1;
        }
        continue;
      }
      if (decision.kind !== "alert") continue;
      await io.deliver(ctx.home, alertText(channel, decision));
      state[channel] = { messageId: decision.messageId, rung: decision.rung };
      dirty = true;
      counts.alerts += 1;
      ctx.log(
        `SILENCE_CHECK alert ch=${channel} msg=${decision.messageId} rung=${decision.rung} min=${decision.silentMinutes}`,
      );
    } catch (e) {
      ctx.log(`SILENCE_CHECK error ch=${channel} ${oneLine(e)}`);
      counts.errors += 1;
    }
  }
  if (dirty) {
    try {
      writeSilenceState(ctx.home, state);
    } catch (e) {
      ctx.log(`SILENCE_CHECK state write failed ${oneLine(e)}`);
      counts.errors += 1;
    }
  }
  return counts;
}

export const silenceCheckPlugin: Plugin = {
  name: "silence-check",
  intervalMs: 60_000,
  async run(ctx) {
    await checkSilence(ctx);
  },
  status: (c) => {
    const n = watchedChannels(readGatewayLast(c.home)).length;
    return n === 0 ? "" : `${n} channel${n === 1 ? "" : "s"}`;
  },
};
