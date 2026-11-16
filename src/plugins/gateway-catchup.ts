import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import {
  compareSnowflakes,
  discordGet as getJson,
  gatewayLastPath,
  newerSnowflake,
  readDiscordToken as readToken,
  readGatewayLast as readLast,
  watchedChannels,
  type DiscordAttachment as Attachment,
  type DiscordMessage as Message,
} from "./discord.ts";
import type { Plugin, PluginCtx } from "./plugin.ts";

/** A message this fresh belongs to the socket path; the catch-up only claims what the socket cannot have seen. */
const FRESH_MS = 10_000;

type Reply = { id: string; author: string; content: string; attachments: number };
type Saved = { filename: string; contentType: string; size: number; path: string };

const inboxDir = (home: string): string => join(home, "state", "inbound");
const cliPath = (): string => join(import.meta.dir, "..", "cli.ts");

function remember(home: string, last: Record<string, string>, channel: string, id: string): void {
  const current = last[channel];
  if (current !== undefined && !newerSnowflake(id, current)) return;
  last[channel] = id;
  mkdirSync(join(home, "state"), { recursive: true });
  writeFileSync(gatewayLastPath(home), JSON.stringify(last));
}

async function resolveReply(channel: string, messageId: string | undefined, token: string): Promise<Reply | null> {
  if (messageId === undefined) return null;
  const full = await getJson<Message>(`/channels/${channel}/messages/${messageId}`, token);
  if (!full) return { id: messageId, author: "-", content: "", attachments: 0 };
  return {
    id: messageId,
    author: full.author?.username ?? "-",
    content: (full.content ?? "").slice(0, 500),
    attachments: full.attachments?.length ?? 0,
  };
}

async function saveAttachments(
  home: string,
  id: string,
  attachments: readonly Attachment[] | undefined,
  log: (line: string) => void,
): Promise<Saved[]> {
  if (attachments === undefined || attachments.length === 0) return [];
  const dir = join(inboxDir(home), "files");
  mkdirSync(dir, { recursive: true });
  const saved: Saved[] = [];
  for (const attachment of attachments) {
    if (attachment.url === undefined) continue;
    try {
      const res = await fetch(attachment.url);
      if (!res.ok) {
        log(`WARN attachment ${id} ${attachment.filename} ${res.status}`);
        continue;
      }
      const bytes = new Uint8Array(await res.arrayBuffer());
      const safe = (attachment.filename ?? "file").replace(/[^\w.-]+/g, "_");
      const path = join(dir, `${id}_${safe}`);
      writeFileSync(path, bytes);
      saved.push({
        filename: attachment.filename ?? safe,
        contentType: attachment.content_type ?? "application/octet-stream",
        size: bytes.length,
        path,
      });
    } catch (error) {
      log(`WARN attachment ${id} ${attachment.filename} ${String((error as Error)?.message ?? error).slice(0, 120)}`);
    }
  }
  return saved;
}

async function pushLead(
  ctx: PluginCtx,
  channel: string,
  id: string,
  text: string,
  username: string,
  reply: Reply | null,
) {
  const tag = reply ? ` reply_to=${reply.id}` : "";
  const body = `[INBOUND discord] channel=${channel} msg=${id} from=${username}${tag}\n${text}`;
  const p = Bun.spawn([process.execPath, cliPath(), "send", "lead", "--text", body], {
    stdout: "pipe",
    stderr: "pipe",
    windowsHide: true,
    env: { ...process.env, DORI_HOME: ctx.home },
  });
  const [out, err] = await Promise.all([new Response(p.stdout).text(), new Response(p.stderr).text()]);
  const code = await p.exited;
  ctx.log(`LEAD_PUSH ${code} ${(out || err).trim().split("\n")[0]?.slice(0, 120) ?? ""}`);
}

async function deliver(ctx: PluginCtx, channel: string, m: Message, token: string): Promise<void> {
  const author = m.author ?? { id: "-", username: "-" };
  const content = m.content ?? "";
  const replyTo = await resolveReply(channel, m.message_reference?.message_id, token);
  const saved = await saveAttachments(ctx.home, m.id, m.attachments, ctx.log);
  mkdirSync(inboxDir(ctx.home), { recursive: true });
  const file = join(inboxDir(ctx.home), `${m.id}.json`);
  writeFileSync(
    file,
    JSON.stringify({
      id: m.id,
      channel,
      author: author.id,
      username: author.username,
      timestamp: m.timestamp,
      content,
      attachments: saved,
      replyTo,
    }),
  );
  ctx.log(
    `INBOUND discord ${channel} ${m.id} ${author.id} len=${content.length} att=${saved.length} reply=${replyTo ? replyTo.id : "-"} file=${file}`,
  );
  await pushLead(ctx, channel, m.id, content, author.username ?? "-", replyTo);
}

export type CatchUpCounts = {
  readonly channels: number;
  readonly fetched: number;
  readonly delivered: number;
  readonly skipped: number;
};

/**
 * Delivers what Discord holds past `gateway-last.json` that no inbound file covers, and moves the last id on. The
 * gateway's in-process catch-up keeps running; the inbound-file check plus the freshness window is what keeps the two
 * from pushing one message to the lead twice.
 */
export async function catchUp(ctx: PluginCtx): Promise<CatchUpCounts> {
  const counts = { channels: 0, fetched: 0, delivered: 0, skipped: 0 };
  const token = readToken(ctx.home);
  if (token === undefined) {
    ctx.log("GATEWAY_CATCHUP no token");
    return counts;
  }
  const last = readLast(ctx.home);
  const channels = watchedChannels(last);
  counts.channels = channels.length;
  for (const channel of channels) {
    const since = last[channel];
    if (since === undefined) continue;
    const batch = await getJson<Message[]>(`/channels/${channel}/messages?limit=50&after=${since}`, token);
    if (!Array.isArray(batch) || batch.length === 0) continue;
    batch.sort((a, b) => compareSnowflakes(a.id, b.id));
    counts.fetched += batch.length;
    for (const m of batch) {
      if (m.author?.bot === true) {
        remember(ctx.home, last, channel, m.id);
        counts.skipped += 1;
        continue;
      }
      if (existsSync(join(inboxDir(ctx.home), `${m.id}.json`))) {
        remember(ctx.home, last, channel, m.id);
        counts.skipped += 1;
        continue;
      }
      const at = m.timestamp === undefined ? Number.NaN : Date.parse(m.timestamp);
      if (Number.isFinite(at) && at > ctx.now() - FRESH_MS) {
        counts.skipped += 1;
        continue;
      }
      await deliver(ctx, channel, m, token);
      remember(ctx.home, last, channel, m.id);
      counts.delivered += 1;
    }
    ctx.log(`GATEWAY_CATCHUP ${channel} ${batch.length} delivered=${counts.delivered}`);
  }
  return counts;
}

let started = false;

export const gatewayCatchupPlugin: Plugin = {
  name: "gateway-catchup",
  intervalMs: 60_000,
  async run(ctx) {
    const counts = await catchUp(ctx);
    if (!started) {
      started = true;
      ctx.log(`GATEWAY_CATCHUP watching ${counts.channels} channel(s)`);
    }
  },
  status: (c) => {
    const n = watchedChannels(readLast(c.home)).length;
    return n === 0 ? "" : `${n} channel${n === 1 ? "" : "s"}`;
  },
};
