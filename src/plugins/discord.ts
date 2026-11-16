import { readFileSync } from "node:fs";
import { join } from "node:path";

// What the plugins that read Discord share: the REST base, the token, the channels the gateway last watched, the
// message shape and snowflake order. The socket path stays in ~/.dori/bin/discord-gateway.ts; this module is only for
// plugins that read the REST API, so a plugin that exists is still one line in the registry and nothing else.

export const DISCORD_API = "https://discord.com/api/v10";

export type DiscordAttachment = {
  readonly url?: string;
  readonly filename?: string;
  readonly content_type?: string;
  readonly size?: number;
};
export type DiscordAuthor = { readonly id?: string; readonly username?: string; readonly bot?: boolean };
export type DiscordMessage = {
  readonly id: string;
  readonly content?: string;
  readonly timestamp?: string;
  readonly author?: DiscordAuthor;
  readonly channel_id?: string;
  readonly attachments?: readonly DiscordAttachment[];
  readonly message_reference?: { readonly message_id?: string };
};

export const gatewayLastPath = (home: string): string => join(home, "state", "gateway-last.json");

/** The id the gateway last delivered per channel; an unreadable or absent file means no watched channels. */
export function readGatewayLast(home: string): Record<string, string> {
  try {
    return JSON.parse(readFileSync(gatewayLastPath(home), "utf8")) as Record<string, string>;
  } catch {
    return {};
  }
}

/** DORI_DISCORD_TOKEN, else `<home>/discord.token`; undefined when neither has one. */
export function readDiscordToken(home: string): string | undefined {
  const env = process.env["DORI_DISCORD_TOKEN"];
  if (env !== undefined && env.trim() !== "") return env.trim();
  try {
    return readFileSync(join(home, "discord.token"), "utf8").trim();
  } catch {
    return undefined;
  }
}

/** The channels the gateway watched last (its keys), with DORI_WATCH_CHANNELS as the cold-start override. */
export function watchedChannels(last: Readonly<Record<string, string>>): string[] {
  const env = process.env["DORI_WATCH_CHANNELS"];
  if (env !== undefined && env.trim() !== "") {
    return env
      .split(",")
      .map((c) => c.trim())
      .filter((c) => c !== "");
  }
  return Object.keys(last);
}

/** GET a Discord path; null on a non-2xx answer or a failed request. Never throws. */
export async function discordGet<T>(path: string, token: string): Promise<T | null> {
  try {
    const res = await fetch(`${DISCORD_API}${path}`, { headers: { Authorization: `Bot ${token}` } });
    if (!res.ok) return null;
    return (await res.json()) as T;
  } catch {
    return null;
  }
}

const snowflake = (id: string): bigint | undefined => {
  try {
    return BigInt(id);
  } catch {
    return undefined;
  }
};

/** Snowflake order; a value that is not a snowflake sorts before any that is. */
export function compareSnowflakes(a: string, b: string): number {
  const x = snowflake(a);
  const y = snowflake(b);
  if (x === undefined || y === undefined) {
    if (x === undefined && y === undefined) return a.localeCompare(b);
    return x === undefined ? -1 : 1;
  }
  return x < y ? -1 : x > y ? 1 : 0;
}

export const newerSnowflake = (id: string, than: string): boolean => compareSnowflakes(id, than) > 0;
