import type { Client } from "discord.js";
import type { MekikiSpec } from "../config/specLoader.js";
import type { MekikiDb } from "../db/database.js";
import type { ResolvedChannels } from "./client.js";

export interface BotContext {
  client: Client;
  spec: MekikiSpec;
  db: MekikiDb;
  channels: ResolvedChannels;
  paused: boolean;
}
