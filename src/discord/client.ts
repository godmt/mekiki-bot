import {
  Client,
  GatewayIntentBits,
  Events,
  type TextChannel,
  type ForumChannel,
  ChannelType,
} from "discord.js";
import type { MekikiSpec } from "../config/specLoader.js";

export interface ResolvedChannels {
  feedAi: TextChannel;
  ops: TextChannel;
  inboxManual: TextChannel;
  libraryForum: ForumChannel;
}

export function createClient(): Client {
  return new Client({
    intents: [
      GatewayIntentBits.Guilds,
      GatewayIntentBits.GuildMessages,
      GatewayIntentBits.MessageContent,
      GatewayIntentBits.GuildMessageReactions,
    ],
  });
}

/**
 * Resolve channels by name first, falling back to ID.
 */
export function resolveChannels(client: Client, spec: MekikiSpec): ResolvedChannels {
  const chConf = spec.channels as Record<string, { name: string; id: string }>;

  function findText(key: string): TextChannel {
    const conf = chConf[key];
    if (!conf) throw new Error(`[channels] Missing config for "${key}"`);

    // Try name resolution first
    const byName = client.channels.cache.find(
      (ch) => ch.type === ChannelType.GuildText && "name" in ch && ch.name === conf.name,
    );
    if (byName) return byName as TextChannel;

    // Fallback to ID
    const byId = client.channels.cache.get(conf.id);
    if (byId && byId.type === ChannelType.GuildText) return byId as TextChannel;

    throw new Error(
      `[channels] Could not resolve text channel "${key}" (name="${conf.name}", id="${conf.id}")`,
    );
  }

  function findForum(key: string): ForumChannel {
    const conf = chConf[key];
    if (!conf) throw new Error(`[channels] Missing config for "${key}"`);

    const byName = client.channels.cache.find(
      (ch) => ch.type === ChannelType.GuildForum && "name" in ch && ch.name === conf.name,
    );
    if (byName) return byName as ForumChannel;

    const byId = client.channels.cache.get(conf.id);
    if (byId && byId.type === ChannelType.GuildForum) return byId as ForumChannel;

    throw new Error(
      `[channels] Could not resolve forum channel "${key}" (name="${conf.name}", id="${conf.id}")`,
    );
  }

  return {
    feedAi: findText("feed_ai"),
    ops: findText("ops"),
    inboxManual: findText("inbox_manual"),
    libraryForum: findForum("library_forum"),
  };
}
