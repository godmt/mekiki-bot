import "dotenv/config";
import { existsSync, writeFileSync, unlinkSync, readFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { Events } from "discord.js";
import { loadAndValidateSpec } from "./config/specLoader.js";
import { initDb } from "./db/database.js";
import { createClient, resolveChannels } from "./discord/client.js";
import { registerCommands, handleCommand } from "./discord/commands.js";
import { handleButton, handleModalSubmit } from "./discord/buttonHandler.js";
import { ingestInput } from "./discord/ingestHandler.js";
import { ensureForumTags } from "./discord/ensureTags.js";
import { runSync } from "./discord/syncHandler.js";
import { updateRegistryWithOllama } from "./llm/ollamaProbe.js";
import { startScheduler, stopScheduler, runOnce } from "./scheduler.js";
import type { BotContext } from "./discord/botContext.js";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const LOCK_FILE = resolve(ROOT, "data", "mekiki.lock");
const TEST_SYNC = process.argv.includes("--test-sync");
const RUN_ONCE = process.argv.includes("--once");

// ---------- Lock file guard ----------

function acquireLock(): void {
  if (existsSync(LOCK_FILE)) {
    const content = readFileSync(LOCK_FILE, "utf-8").trim();
    const pid = Number(content);

    // Check if the process is still alive
    if (pid && isProcessRunning(pid)) {
      console.error(`[mekiki-bot] Another instance is already running (PID ${pid}).`);
      console.error(`[mekiki-bot] If this is incorrect, delete ${LOCK_FILE} and retry.`);
      process.exit(1);
    }

    // Stale lock file — previous process crashed without cleanup
    console.warn(`[mekiki-bot] Removing stale lock file (PID ${pid} is not running).`);
    unlinkSync(LOCK_FILE);
  }

  writeFileSync(LOCK_FILE, String(process.pid), "utf-8");
}

function releaseLock(): void {
  try {
    if (existsSync(LOCK_FILE)) unlinkSync(LOCK_FILE);
  } catch { /* best effort */ }
}

function isProcessRunning(pid: number): boolean {
  try {
    process.kill(pid, 0); // signal 0 = existence check only
    return true;
  } catch {
    return false;
  }
}

// ---------- Context ----------

function getCtx(client: unknown): BotContext | undefined {
  return (client as { _ctx?: BotContext })._ctx;
}

// ---------- Main ----------

async function main() {
  console.log("[mekiki-bot] Starting...");

  acquireLock();

  // Clean up lock on exit
  process.on("exit", () => { stopScheduler(); releaseLock(); });
  process.on("SIGINT", () => { stopScheduler(); releaseLock(); process.exit(0); });
  process.on("SIGTERM", () => { stopScheduler(); releaseLock(); process.exit(0); });

  const spec = loadAndValidateSpec();
  console.log("[mekiki-bot] Spec loaded and validated.");

  // Probe Ollama for locally available models
  updateRegistryWithOllama(
    spec.modelRegistry as { providers: Record<string, { label: string; models: Array<{ id: string; label: string }> }> },
  );

  const db = initDb();
  console.log("[mekiki-bot] Database initialized.");

  const token = process.env.DISCORD_TOKEN;
  if (!token) throw new Error("DISCORD_TOKEN is not set in .env");

  const client = createClient();

  client.once(Events.ClientReady, async (readyClient) => {
    console.log(`[discord] Logged in as ${readyClient.user.tag}`);

    // Find the first guild to register guild-scoped commands (instant propagation)
    const guild = readyClient.guilds.cache.first();
    const guildId = guild?.id;
    await registerCommands(token, readyClient.user.id, guildId);

    const channels = resolveChannels(client, spec);
    console.log("[discord] Channels resolved:", {
      feedAi: `#${channels.feedAi.name}`,
      ops: `#${channels.ops.name}`,
      inboxManual: `#${channels.inboxManual.name}`,
      libraryForum: `#${channels.libraryForum.name}`,
    });

    // Ensure forum tags exist
    try {
      await ensureForumTags(channels.libraryForum, spec);
    } catch (err) {
      console.error("[tags] Failed to ensure forum tags:", err);
      await channels.ops.send(
        `⚠️ Forum タグの作成に失敗しました: ${err instanceof Error ? err.message : String(err)}\n` +
        `Bot に「チャンネルの管理」権限があるか確認してください。`,
      );
    }

    const ctx: BotContext = { client, spec, db, channels, paused: false };
    (client as unknown as { _ctx: BotContext })._ctx = ctx;

    await channels.ops.send(
      `🟢 **あいきき** 起動しました。\n` +
      `Provider: ${(spec.llmConfig as { activeProvider: string }).activeProvider} / ` +
      `Model: ${(spec.llmConfig as { activeModel: string }).activeModel}\n` +
      `manual_sync_only: ${(spec.runtime as { manual_sync_only: boolean }).manual_sync_only}`,
    );

    // Graceful shutdown helper
    const gracefulExit = (label: string, delayMs = 3000) => {
      setTimeout(() => {
        console.log(`[${label}] Exiting.`);
        stopScheduler();
        client.destroy();
        db.close();
        process.exit(0);
      }, delayMs);
    };

    // --once: run sync → learn → expire, then exit (for external schedulers)
    if (RUN_ONCE) {
      console.log("[once] Run-once mode activated.");
      try {
        await runOnce(ctx);
      } catch (err) {
        console.error("[once] Error:", err);
        await channels.ops.send(
          `❌ run-once エラー: ${err instanceof Error ? err.message : String(err)}`,
        );
      }
      gracefulExit("once");
      return;
    }

    // Start scheduler (respects manual_sync_only and profile_update.yaml mode)
    startScheduler(ctx);

    // --test-sync: auto-run sync for testing, then exit
    if (TEST_SYNC) {
      console.log("[test] Running test sync...");
      await channels.ops.send("🧪 テスト同期を開始します...");
      try {
        const count = await runSync(ctx, { maxSources: 1, maxItemsPerSource: 3 });
        console.log(`[test] Sync complete: ${count} items posted.`);
        await channels.ops.send(`🧪 テスト同期完了: ${count} 件投稿しました。`);
      } catch (err) {
        console.error("[test] Sync error:", err);
        await channels.ops.send(
          `🧪 テスト同期エラー: ${err instanceof Error ? err.message : String(err)}`,
        );
      }
      gracefulExit("test", 5000);
    }
  });

  // Slash commands + buttons + modals
  client.on(Events.InteractionCreate, async (interaction) => {
    const ctx = getCtx(client);
    if (!ctx) return;

    try {
      if (interaction.isChatInputCommand()) {
        await handleCommand(interaction, ctx);
      } else if (interaction.isButton()) {
        await handleButton(interaction, ctx);
      } else if (interaction.isModalSubmit()) {
        await handleModalSubmit(interaction, ctx);
      }
    } catch (err) {
      console.error("[interaction] Error:", err);
      const msg = `Error: ${err instanceof Error ? err.message : String(err)}`;
      try {
        if ("replied" in interaction && (interaction.replied || interaction.deferred)) {
          await interaction.followUp({ content: msg, ephemeral: true });
        } else if ("reply" in interaction && typeof interaction.reply === "function") {
          await interaction.reply({ content: msg, ephemeral: true });
        }
      } catch { /* ignore follow-up errors */ }
    }
  });

  // #inbox-manual message listener
  client.on(Events.MessageCreate, async (message) => {
    if (message.author.bot) return;
    const ctx = getCtx(client);
    if (!ctx) return;

    const isInbox = message.channel.id === ctx.channels.inboxManual.id;
    const isDm = !message.guild;

    if (!isInbox && !isDm) return;

    const content = message.content.trim();
    if (!content) return;

    const origin = isInbox ? "inbox_manual" as const : "dm" as const;

    try {
      await ingestInput(ctx, content, origin);
      await message.react("✅");
    } catch (err) {
      console.error(`[inbox] Error ingesting from ${origin}:`, err);
      await message.react("❌");
      await ctx.channels.ops.send(
        `⚠️ Ingest error (${origin}): ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  });

  await client.login(token);
}

main().catch((err) => {
  console.error("[mekiki-bot] Fatal error:", err);
  releaseLock();
  process.exit(1);
});
