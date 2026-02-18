import {
  SlashCommandBuilder,
  REST,
  Routes,
  type ChatInputCommandInteraction,
} from "discord.js";
import type { MekikiSpec } from "../config/specLoader.js";
import type { BotContext } from "./botContext.js";
import { runSync } from "./syncHandler.js";
import { ingestInput } from "./ingestHandler.js";
import { runLearningBatch } from "../learning/batchLearner.js";
import { postProposal } from "./proposalPost.js";

// ---------- Command definitions ----------

const syncCmd = new SlashCommandBuilder()
  .setName("sync")
  .setDescription("Fetch RSS deltas and post new cards to #feed-ai");

const pauseCmd = new SlashCommandBuilder()
  .setName("pause")
  .setDescription("Pause RSS ingestion (buttons still work)");

const resumeCmd = new SlashCommandBuilder()
  .setName("resume")
  .setDescription("Resume RSS ingestion");

const modelCmd = new SlashCommandBuilder()
  .setName("model")
  .setDescription("Show, list, or set the active LLM model")
  .addSubcommand((sub) =>
    sub.setName("show").setDescription("Show current provider and model"),
  )
  .addSubcommand((sub) =>
    sub.setName("list").setDescription("List all available providers and models"),
  )
  .addSubcommand((sub) =>
    sub
      .setName("set")
      .setDescription("Set the active provider and model")
      .addStringOption((opt) =>
        opt.setName("provider").setDescription("LLM provider name").setRequired(true),
      )
      .addStringOption((opt) =>
        opt.setName("model").setDescription("Model ID").setRequired(true),
      ),
  );

const ingestCmd = new SlashCommandBuilder()
  .setName("ingest")
  .setDescription("Manually ingest a URL or text snippet")
  .addStringOption((opt) =>
    opt.setName("input").setDescription("URL or text to ingest").setRequired(true),
  );

const learnCmd = new SlashCommandBuilder()
  .setName("learn")
  .setDescription("Run a taste-profile learning batch")
  .addSubcommand((sub) =>
    sub.setName("run").setDescription("Run learning batch (force even if below threshold)"),
  )
  .addSubcommand((sub) =>
    sub.setName("profile").setDescription("Show the current taste profile"),
  );

const configCmd = new SlashCommandBuilder()
  .setName("config")
  .setDescription("Show or change bot configuration")
  .addSubcommand((sub) =>
    sub.setName("show").setDescription("Show current configuration"),
  )
  .addSubcommand((sub) =>
    sub
      .setName("set")
      .setDescription("Change a config parameter")
      .addStringOption((opt) =>
        opt
          .setName("key")
          .setDescription("Config key to change")
          .setRequired(true)
          .addChoices(
            { name: "language", value: "language" },
            { name: "min_new_events_to_run", value: "min_new_events_to_run" },
            { name: "lookback_days", value: "lookback_days" },
            { name: "manual_boost", value: "manual_boost" },
            { name: "half_life_days", value: "half_life_days" },
            { name: "proposal_expire_hours", value: "proposal_expire_hours" },
          ),
      )
      .addStringOption((opt) =>
        opt.setName("value").setDescription("New value").setRequired(true),
      ),
  );

export const commandBuilders = [syncCmd, pauseCmd, resumeCmd, modelCmd, ingestCmd, learnCmd, configCmd];

// ---------- Register slash commands ----------

export async function registerCommands(token: string, clientId: string, guildId?: string): Promise<void> {
  const rest = new REST({ version: "10" }).setToken(token);
  const body = commandBuilders.map((cmd) => cmd.toJSON());

  if (guildId) {
    await rest.put(Routes.applicationGuildCommands(clientId, guildId), { body });
    console.log(`[commands] Registered ${body.length} slash commands to guild ${guildId}.`);
  } else {
    await rest.put(Routes.applicationCommands(clientId), { body });
    console.log(`[commands] Registered ${body.length} slash commands globally.`);
  }
}

// ---------- Command handler ----------

export async function handleCommand(
  interaction: ChatInputCommandInteraction,
  ctx: BotContext,
): Promise<void> {
  const { commandName } = interaction;

  switch (commandName) {
    case "sync":
      await handleSync(interaction, ctx);
      break;
    case "pause":
      await handlePause(interaction, ctx);
      break;
    case "resume":
      await handleResume(interaction, ctx);
      break;
    case "model":
      await handleModel(interaction, ctx);
      break;
    case "ingest":
      await handleIngest(interaction, ctx);
      break;
    case "learn":
      await handleLearn(interaction, ctx);
      break;
    case "config":
      await handleConfig(interaction, ctx);
      break;
    default:
      await interaction.reply({ content: `Unknown command: ${commandName}`, ephemeral: true });
  }
}

// ---------- Helpers ----------

interface LlmConfig {
  language: string;
  activeProvider: string;
  activeModel: string;
  providers: Record<string, { type: string; apiKeyEnv?: string; baseURL?: string }>;
}

interface ModelRegistry {
  providers: Record<string, { label: string; models: Array<{ id: string; label: string }> }>;
}

function getLlmConfig(spec: MekikiSpec): LlmConfig {
  return spec.llmConfig as unknown as LlmConfig;
}

function getModelRegistry(spec: MekikiSpec): ModelRegistry {
  return spec.modelRegistry as unknown as ModelRegistry;
}

// ---------- Individual handlers ----------

async function handleSync(
  interaction: ChatInputCommandInteraction,
  ctx: BotContext,
): Promise<void> {
  if (ctx.paused) {
    await interaction.reply({ content: "Bot is paused. Use `/resume` first.", ephemeral: true });
    return;
  }
  await interaction.deferReply({ ephemeral: true });
  await ctx.channels.ops.send("🔄 Sync started...");
  try {
    const count = await runSync(ctx);
    try {
      await interaction.editReply(`Sync complete: ${count} new items posted.`);
    } catch {
      console.warn("[sync] Could not editReply (interaction may have expired)");
    }
    await ctx.channels.ops.send(`✅ Sync complete: ${count} new items posted.`);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    try {
      await interaction.editReply(`Sync failed: ${msg}`);
    } catch {
      console.warn("[sync] Could not editReply (interaction may have expired)");
    }
    await ctx.channels.ops.send(`❌ Sync failed: ${msg}`);
  }
}

async function handlePause(
  interaction: ChatInputCommandInteraction,
  ctx: BotContext,
): Promise<void> {
  if (ctx.paused) {
    await interaction.reply({ content: "Already paused.", ephemeral: true });
    return;
  }
  ctx.paused = true;
  await interaction.reply({ content: "Paused. Buttons still work. Use `/resume` to resume.", ephemeral: true });
  await ctx.channels.ops.send("⏸ Bot paused by user.");
}

async function handleResume(
  interaction: ChatInputCommandInteraction,
  ctx: BotContext,
): Promise<void> {
  if (!ctx.paused) {
    await interaction.reply({ content: "Not paused.", ephemeral: true });
    return;
  }
  ctx.paused = false;
  await interaction.reply({ content: "Resumed.", ephemeral: true });
  await ctx.channels.ops.send("▶ Bot resumed by user.");
}

async function handleModel(
  interaction: ChatInputCommandInteraction,
  ctx: BotContext,
): Promise<void> {
  const sub = interaction.options.getSubcommand();
  const llm = getLlmConfig(ctx.spec);

  if (sub === "show") {
    await interaction.reply({
      content: `**Provider:** ${llm.activeProvider}\n**Model:** ${llm.activeModel}`,
      ephemeral: true,
    });
    return;
  }

  if (sub === "list") {
    const registry = getModelRegistry(ctx.spec);
    const lines: string[] = ["**Available Models**\n"];

    for (const [provKey, prov] of Object.entries(registry.providers)) {
      const provConf = llm.providers[provKey];
      const hasKey = provConf?.apiKeyEnv
        ? !!process.env[provConf.apiKeyEnv]
        : provConf?.type === "ollama"; // ollama doesn't need a key

      const statusIcon = hasKey ? "🟢" : "🔴";
      lines.push(`${statusIcon} **${prov.label}** (\`${provKey}\`)`);

      for (const model of prov.models) {
        const isCurrent = provKey === llm.activeProvider && model.id === llm.activeModel;
        const marker = isCurrent ? " **← current**" : "";
        lines.push(`   \`${model.id}\`${marker}`);
      }
      lines.push("");
    }

    lines.push("🟢 = API key set / 🔴 = API key missing");

    await interaction.reply({ content: lines.join("\n"), ephemeral: true });
    return;
  }

  // sub === "set"
  const provider = interaction.options.getString("provider", true);
  const model = interaction.options.getString("model", true);

  const registry = getModelRegistry(ctx.spec);
  const providerEntry = registry.providers[provider];
  if (!providerEntry) {
    const available = Object.keys(registry.providers).join(", ");
    await interaction.reply({
      content: `Unknown provider "${provider}". Available: ${available}`,
      ephemeral: true,
    });
    return;
  }

  const modelEntry = providerEntry.models.find((m) => m.id === model);
  if (!modelEntry) {
    const available = providerEntry.models.map((m) => m.id).join(", ");
    await interaction.reply({
      content: `Unknown model "${model}" for provider "${provider}". Available: ${available}`,
      ephemeral: true,
    });
    return;
  }

  llm.activeProvider = provider;
  llm.activeModel = model;

  await interaction.reply({
    content: `Model updated: **${provider}** / **${model}**`,
    ephemeral: true,
  });
  await ctx.channels.ops.send(`🔄 Model changed to ${provider}/${model}`);
}

async function handleIngest(
  interaction: ChatInputCommandInteraction,
  ctx: BotContext,
): Promise<void> {
  await interaction.deferReply({ ephemeral: true });
  const input = interaction.options.getString("input", true);
  try {
    await ingestInput(ctx, input, "slash_command");
    await interaction.editReply(`Ingested: ${input.slice(0, 100)}`);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    await interaction.editReply(`Ingest failed: ${msg}`);
  }
}

async function handleLearn(
  interaction: ChatInputCommandInteraction,
  ctx: BotContext,
): Promise<void> {
  const sub = interaction.options.getSubcommand();

  if (sub === "profile") {
    const profile = ctx.db.getActiveProfile();
    if (!profile) {
      await interaction.reply({ content: "No taste profile yet. Run `/learn run` first.", ephemeral: true });
      return;
    }
    const preview = profile.profile_md.slice(0, 1800);
    await interaction.reply({
      content: `**Taste Profile** (v${profile.id}, source: ${profile.source})\n\`\`\`md\n${preview}\n\`\`\``,
      ephemeral: true,
    });
    return;
  }

  // sub === "run"
  await interaction.deferReply({ ephemeral: true });
  await ctx.channels.ops.send("🧠 Learning batch started...");

  try {
    const result = await runLearningBatch(ctx, true);

    if (!result.proposalId) {
      await interaction.editReply(`Learning batch completed: ${result.reason}`);
      await ctx.channels.ops.send(`🧠 Learning batch: ${result.reason}`);
      return;
    }

    await postProposal(ctx, result.proposalId);
    await interaction.editReply(`Learning batch completed. Proposal \`${result.proposalId}\` posted to #ops.`);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    await interaction.editReply(`Learning failed: ${msg}`);
    await ctx.channels.ops.send(`❌ Learning batch failed: ${msg}`);
  }
}

// ---------- /config handler ----------

interface LearningConfigFields {
  scoring: { manual_boost: number };
  time_decay: { half_life_days: number };
}

interface ProfileUpdateFields {
  scheduler: { min_new_events_to_run: number };
  sampling: { lookback_days: number };
  proposal: { expire_hours: number };
}

async function handleConfig(
  interaction: ChatInputCommandInteraction,
  ctx: BotContext,
): Promise<void> {
  const sub = interaction.options.getSubcommand();
  const llm = getLlmConfig(ctx.spec);
  const learning = ctx.spec.learningConfig as unknown as LearningConfigFields;
  const profile = ctx.spec.profileUpdateConfig as unknown as ProfileUpdateFields;

  if (sub === "show") {
    const lines = [
      "**Bot Configuration**\n",
      "**LLM**",
      `  language: \`${llm.language}\``,
      `  provider: \`${llm.activeProvider}\``,
      `  model: \`${llm.activeModel}\``,
      "",
      "**Learning**",
      `  min_new_events_to_run: \`${profile.scheduler.min_new_events_to_run}\``,
      `  lookback_days: \`${profile.sampling.lookback_days}\``,
      `  manual_boost: \`${learning.scoring.manual_boost}\``,
      `  half_life_days: \`${learning.time_decay.half_life_days}\``,
      `  proposal_expire_hours: \`${profile.proposal.expire_hours}\``,
      "",
      "*Use `/config set key:<name> value:<value>` to change.*",
    ];

    await interaction.reply({ content: lines.join("\n"), ephemeral: true });
    return;
  }

  // sub === "set"
  const key = interaction.options.getString("key", true);
  const value = interaction.options.getString("value", true);

  switch (key) {
    case "language": {
      llm.language = value;
      await interaction.reply({ content: `language → \`${value}\``, ephemeral: true });
      await ctx.channels.ops.send(`⚙️ Config: language → \`${value}\``);
      break;
    }
    case "min_new_events_to_run": {
      const n = parseInt(value, 10);
      if (isNaN(n) || n < 1) {
        await interaction.reply({ content: "Invalid value (positive integer required).", ephemeral: true });
        return;
      }
      profile.scheduler.min_new_events_to_run = n;
      await interaction.reply({ content: `min_new_events_to_run → \`${n}\``, ephemeral: true });
      await ctx.channels.ops.send(`⚙️ Config: min_new_events_to_run → \`${n}\``);
      break;
    }
    case "lookback_days": {
      const n = parseInt(value, 10);
      if (isNaN(n) || n < 1) {
        await interaction.reply({ content: "Invalid value (positive integer required).", ephemeral: true });
        return;
      }
      profile.sampling.lookback_days = n;
      await interaction.reply({ content: `lookback_days → \`${n}\``, ephemeral: true });
      await ctx.channels.ops.send(`⚙️ Config: lookback_days → \`${n}\``);
      break;
    }
    case "manual_boost": {
      const n = parseFloat(value);
      if (isNaN(n) || n < 0) {
        await interaction.reply({ content: "Invalid value (positive number required).", ephemeral: true });
        return;
      }
      learning.scoring.manual_boost = n;
      await interaction.reply({ content: `manual_boost → \`${n}\``, ephemeral: true });
      await ctx.channels.ops.send(`⚙️ Config: manual_boost → \`${n}\``);
      break;
    }
    case "half_life_days": {
      const n = parseInt(value, 10);
      if (isNaN(n) || n < 1) {
        await interaction.reply({ content: "Invalid value (positive integer required).", ephemeral: true });
        return;
      }
      learning.time_decay.half_life_days = n;
      await interaction.reply({ content: `half_life_days → \`${n}\``, ephemeral: true });
      await ctx.channels.ops.send(`⚙️ Config: half_life_days → \`${n}\``);
      break;
    }
    case "proposal_expire_hours": {
      const n = parseInt(value, 10);
      if (isNaN(n) || n < 1) {
        await interaction.reply({ content: "Invalid value (positive integer required).", ephemeral: true });
        return;
      }
      profile.proposal.expire_hours = n;
      await interaction.reply({ content: `proposal_expire_hours → \`${n}\``, ephemeral: true });
      await ctx.channels.ops.send(`⚙️ Config: proposal_expire_hours → \`${n}\``);
      break;
    }
    default:
      await interaction.reply({ content: `Unknown config key: ${key}`, ephemeral: true });
  }
}
