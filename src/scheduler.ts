import type { BotContext } from "./discord/botContext.js";
import { runSync, isSyncRunning } from "./discord/syncHandler.js";
import { runLearningBatch } from "./learning/batchLearner.js";
import { postProposal } from "./discord/proposalPost.js";

// ---------- Config types ----------

interface SchedulerConfig {
  sync: { enabled: boolean; interval_minutes: number };
  learning: { enabled: boolean; interval_minutes: number };
  proposal_expire: { enabled: boolean; check_interval_minutes: number };
  run_on_start: boolean;
}

interface ProfileUpdateConfig {
  scheduler: { min_new_events_to_run: number; interval_minutes: number };
  proposal: { expire_hours: number };
}

// ---------- State ----------

let syncTimer: ReturnType<typeof setInterval> | null = null;
let learnTimer: ReturnType<typeof setInterval> | null = null;
let expireTimer: ReturnType<typeof setInterval> | null = null;
let learnRunning = false;

// ---------- Defaults ----------

function resolveConfig(ctx: BotContext): SchedulerConfig {
  const runtime = ctx.spec.runtime as { manual_sync_only?: boolean; run_on_start?: boolean };
  const profileCfg = ctx.spec.profileUpdateConfig as unknown as ProfileUpdateConfig;
  const servingPolicy = ctx.spec.servingPolicy as { enabled?: boolean };

  // Sync: disabled if manual_sync_only, otherwise 60min default
  const syncEnabled = !runtime.manual_sync_only && (servingPolicy.enabled ?? true);

  // Learning: use profile_update.yaml scheduler settings
  const learnModes = ((ctx.spec.profileUpdateConfig as { scheduler?: { mode?: string[] } }).scheduler?.mode) ?? [];
  const learnEnabled = learnModes.includes("interval");
  const learnInterval = profileCfg.scheduler?.interval_minutes ?? 360;

  return {
    sync: {
      enabled: syncEnabled,
      interval_minutes: 60,
    },
    learning: {
      enabled: learnEnabled,
      interval_minutes: learnInterval,
    },
    proposal_expire: {
      enabled: true,
      check_interval_minutes: 30,
    },
    run_on_start: runtime.run_on_start ?? false,
  };
}

// ---------- Tasks ----------

async function scheduledSync(ctx: BotContext): Promise<number> {
  if (ctx.paused) return 0;
  if (isSyncRunning()) {
    console.log("[scheduler] Sync skipped (already running)");
    return 0;
  }
  try {
    console.log("[scheduler] Running scheduled sync...");
    const count = await runSync(ctx);
    console.log(`[scheduler] Scheduled sync complete: ${count} items posted`);
    if (count > 0) {
      await ctx.channels.ops.send(`⏰ 定期同期完了: ${count} 件投稿しました。`);
    }
    return count;
  } catch (err) {
    console.error("[scheduler] Sync error:", err);
    try {
      await ctx.channels.ops.send(
        `⚠️ 定期同期エラー: ${err instanceof Error ? err.message : String(err)}`,
      );
    } catch { /* ignore */ }
    return 0;
  }
}

async function scheduledLearn(ctx: BotContext): Promise<string | null> {
  if (learnRunning) {
    console.log("[scheduler] Learning skipped (already running)");
    return null;
  }
  learnRunning = true;
  try {
    console.log("[scheduler] Running scheduled learning...");
    const { proposalId, reason } = await runLearningBatch(ctx);
    console.log(`[scheduler] Learning result: ${reason}`);

    if (proposalId) {
      await postProposal(ctx, proposalId);
      await ctx.channels.ops.send(`⏰ 定期学習完了: Proposal \`${proposalId}\` を投稿しました。`);
    }
    return proposalId;
  } catch (err) {
    console.error("[scheduler] Learning error:", err);
    try {
      await ctx.channels.ops.send(
        `⚠️ 定期学習エラー: ${err instanceof Error ? err.message : String(err)}`,
      );
    } catch { /* ignore */ }
    return null;
  } finally {
    learnRunning = false;
  }
}

async function expirePendingProposals(ctx: BotContext): Promise<number> {
  const profileCfg = ctx.spec.profileUpdateConfig as unknown as ProfileUpdateConfig;
  const expireHours = profileCfg.proposal?.expire_hours ?? 72;

  const pending = ctx.db.getPendingProposals();
  let expired = 0;

  for (const p of pending) {
    const createdAt = new Date(p.created_at).getTime();
    const ageHours = (Date.now() - createdAt) / (1000 * 60 * 60);
    if (ageHours >= expireHours) {
      ctx.db.updateProposalStatus(p.id, "expired");
      expired++;
      console.log(`[scheduler] Expired proposal ${p.id} (age: ${ageHours.toFixed(1)}h >= ${expireHours}h)`);
    }
  }

  if (expired > 0) {
    try {
      await ctx.channels.ops.send(
        `⏳ ${expired} 件の Taste Profile Proposal が期限切れになりました（${expireHours}h超過）。`,
      );
    } catch { /* ignore */ }
  }

  return expired;
}

// ---------- Public API ----------

export interface StartSchedulerOptions {
  /** Override run_on_start regardless of spec setting */
  runOnStart?: boolean;
}

export function startScheduler(ctx: BotContext, opts?: StartSchedulerOptions): void {
  const config = resolveConfig(ctx);
  const runOnStart = opts?.runOnStart ?? config.run_on_start;

  // Sync scheduler
  if (config.sync.enabled) {
    const ms = config.sync.interval_minutes * 60 * 1000;
    console.log(`[scheduler] Sync: enabled (every ${config.sync.interval_minutes} min)`);
    syncTimer = setInterval(() => { scheduledSync(ctx).catch(console.error); }, ms);
  } else {
    console.log("[scheduler] Sync: disabled (manual_sync_only=true)");
  }

  // Learning scheduler
  if (config.learning.enabled) {
    const ms = config.learning.interval_minutes * 60 * 1000;
    console.log(`[scheduler] Learning: enabled (every ${config.learning.interval_minutes} min)`);
    learnTimer = setInterval(() => { scheduledLearn(ctx).catch(console.error); }, ms);
  } else {
    console.log("[scheduler] Learning: disabled (mode does not include 'interval')");
  }

  // Proposal expire checker (always enabled)
  {
    const ms = config.proposal_expire.check_interval_minutes * 60 * 1000;
    console.log(`[scheduler] Proposal expire: enabled (check every ${config.proposal_expire.check_interval_minutes} min)`);
    expireTimer = setInterval(() => { expirePendingProposals(ctx).catch(console.error); }, ms);
    // Always run expire check once immediately
    expirePendingProposals(ctx).catch(console.error);
  }

  if (runOnStart) {
    console.log("[scheduler] run_on_start: running initial sync + learn...");
    // Fire async without blocking startup; sync first, then learn
    (async () => {
      await scheduledSync(ctx);
      await scheduledLearn(ctx);
    })().catch(console.error);
  }
}

export function stopScheduler(): void {
  if (syncTimer) { clearInterval(syncTimer); syncTimer = null; }
  if (learnTimer) { clearInterval(learnTimer); learnTimer = null; }
  if (expireTimer) { clearInterval(expireTimer); expireTimer = null; }
  console.log("[scheduler] All timers stopped.");
}

/**
 * Run-once mode: sync → learn → expire check, then resolve.
 * Used by --once CLI flag for external scheduler integration.
 */
export async function runOnce(ctx: BotContext): Promise<void> {
  console.log("[once] Starting run-once mode: sync → learn → expire");

  await ctx.channels.ops.send("🔁 **run-once** モード: sync → learn → expire を実行します。");

  // 1) Expire check first (lightweight)
  const expired = await expirePendingProposals(ctx);
  console.log(`[once] Expire check done (${expired} expired)`);

  // 2) Sync
  const posted = await scheduledSync(ctx);
  console.log(`[once] Sync done (${posted} posted)`);

  // 3) Learn
  const proposalId = await scheduledLearn(ctx);
  console.log(`[once] Learn done (proposal: ${proposalId ?? "none"})`);

  await ctx.channels.ops.send(
    `✅ **run-once** 完了: sync=${posted}件投稿, expired=${expired}件, learn=${proposalId ? `Proposal ${proposalId}` : "スキップ"}`,
  );
}
