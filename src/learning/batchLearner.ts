import { randomUUID } from "node:crypto";
import type { BotContext } from "../discord/botContext.js";
import type { MekikiDb } from "../db/database.js";
import { createLlmClient } from "../llm/client.js";
import { getAllSignalScores } from "./scorer.js";

interface ProfileUpdateConfig {
  enabled: boolean;
  scheduler: {
    min_new_events_to_run: number;
    lock_ttl_minutes: number;
  };
  sampling: {
    lookback_days: number;
    max_events: number;
    origins: Record<string, { enabled: boolean; weight: number }>;
    labels: Record<string, { weight: number }>;
  };
  proposal: {
    require_approval: boolean;
    post_channel_key: string;
    expire_hours: number;
    max_proposals_per_day: number;
    max_profile_chars: number;
  };
  llm_task: {
    task_name: string;
  };
}

interface SampledEvent {
  evidence_id: string;
  title: string;
  label: string;
  origin: string;
  signals: string[];
  one_liner: string;
  source_domain: string;
  created_at: string;
  weight: number;
}

interface Stats {
  total_events: number;
  keep_count: number;
  unsure_count: number;
  discard_count: number;
  user_seeded_count: number;
  bot_recommended_count: number;
  top_keep_signals: [string, number][];
  top_discard_signals: [string, number][];
  signal_scores: Record<string, number>;
}

/**
 * Run a learning batch: sample events, compute stats, call LLM to propose profile update.
 * Returns the proposal_id if a proposal was created, or null if skipped.
 */
export async function runLearningBatch(
  ctx: BotContext,
  force = false,
): Promise<{ proposalId: string | null; reason: string }> {
  const config = ctx.spec.profileUpdateConfig as unknown as ProfileUpdateConfig;

  if (!config.enabled) {
    return { proposalId: null, reason: "Learning is disabled in config." };
  }

  // Check lock
  if (!ctx.db.tryAcquireLearningLock(config.scheduler.lock_ttl_minutes)) {
    return { proposalId: null, reason: "Another learning run is in progress." };
  }

  // Check minimum events threshold
  const lookbackDate = new Date(
    Date.now() - config.sampling.lookback_days * 24 * 60 * 60 * 1000,
  ).toISOString();

  const newEventCount = ctx.db.countNewEventsSince(lookbackDate);

  if (!force && newEventCount < config.scheduler.min_new_events_to_run) {
    return {
      proposalId: null,
      reason: `Not enough events (${newEventCount} < ${config.scheduler.min_new_events_to_run}).`,
    };
  }

  // Start a learning run
  const runId = ctx.db.insertLearningRun();
  console.log(`[learn] Starting learning run #${runId}`);

  try {
    // Sample events
    const events = sampleEvents(ctx.db, config);
    console.log(`[learn] Sampled ${events.length} events`);

    if (events.length === 0) {
      ctx.db.finishLearningRun(runId, "completed", 0);
      return { proposalId: null, reason: "No events to learn from." };
    }

    // Compute stats
    const stats = computeStats(events, ctx);

    // Get current profile
    const activeProfile = ctx.db.getActiveProfile();
    const currentProfileMd = activeProfile?.profile_md ?? getDefaultSeedProfile(ctx);

    // Seed profile if none exists
    if (!activeProfile) {
      console.log("[learn] No active profile found, seeding from taste_profile_seed.md");
      ctx.db.insertProfileVersion(currentProfileMd, "seed");
    }

    // Build LLM prompt
    const prompt = buildProposalPrompt(currentProfileMd, events, stats, ctx);

    // Call LLM
    const llm = createLlmClient(ctx.spec);
    const taskName = config.llm_task.task_name;
    console.log(`[learn] Calling LLM task "${taskName}"...`);
    const response = await llm.run(taskName, prompt);

    // Parse proposal
    const proposal = parseProposal(response);
    if (!proposal) {
      ctx.db.finishLearningRun(runId, "failed", events.length);
      return { proposalId: null, reason: "LLM returned invalid proposal JSON." };
    }

    // Store proposal in DB (always generate ID on our side to avoid collisions)
    const proposalId = `prop-${randomUUID().slice(0, 8)}`;
    ctx.db.insertProposal({
      id: proposalId,
      status: "pending",
      new_profile_md: proposal.new_profile_md.slice(0, config.proposal.max_profile_chars),
      diff_summary: JSON.stringify(proposal.diff_summary),
      risks: JSON.stringify(proposal.risks),
      confidence: proposal.confidence,
      notes: proposal.notes ?? null,
      stats_used: JSON.stringify(stats),
      ops_message_id: null,
    });

    ctx.db.finishLearningRun(runId, "completed", events.length, proposalId);

    console.log(`[learn] Proposal created: ${proposalId} (confidence: ${proposal.confidence})`);
    return { proposalId, reason: "Proposal created successfully." };
  } catch (err) {
    ctx.db.finishLearningRun(runId, "failed", 0);
    throw err;
  }
}

/**
 * Sample label events from the DB, weighted by origin and label.
 */
function sampleEvents(db: MekikiDb, config: ProfileUpdateConfig): SampledEvent[] {
  const lookbackDate = new Date(
    Date.now() - config.sampling.lookback_days * 24 * 60 * 60 * 1000,
  ).toISOString();

  const rows = db.raw.prepare(`
    SELECT a.evidence_id, a.action, a.created_at, a.actor,
           e.title, e.origin, e.raw_json, e.source_id
    FROM actions_log a
    JOIN evidence e ON a.evidence_id = e.evidence_id
    WHERE a.action IN ('label.keep', 'label.unsure', 'label.discard')
      AND a.created_at > ?
    ORDER BY a.created_at DESC
    LIMIT ?
  `).all(lookbackDate, config.sampling.max_events) as Array<{
    evidence_id: string;
    action: string;
    created_at: string;
    actor: string;
    title: string;
    origin: string;
    raw_json: string | null;
    source_id: string | null;
  }>;

  return rows.map((row) => {
    const label = row.action.replace("label.", "").toUpperCase();
    const originKey = row.origin || "BOT_RECOMMENDED";

    // Parse raw_json for signals and one_liner
    let signals: string[] = [];
    let oneLiner = "";
    let sourceDomain = "";
    if (row.raw_json) {
      try {
        const raw = JSON.parse(row.raw_json);
        if (raw.signals) signals = JSON.parse(raw.signals);
        oneLiner = raw.one_liner ?? "";
        sourceDomain = raw.source_domain ?? "";
      } catch { /* ignore */ }
    }

    const originWeight = config.sampling.origins[originKey]?.weight ?? 1.0;
    const labelWeight = config.sampling.labels[label]?.weight ?? 0;
    const weight = Math.abs(labelWeight) * originWeight;

    return {
      evidence_id: row.evidence_id,
      title: row.title,
      label,
      origin: originKey,
      signals,
      one_liner: oneLiner,
      source_domain: sourceDomain,
      created_at: row.created_at,
      weight,
    };
  });
}

/**
 * Compute aggregate statistics from sampled events.
 */
function computeStats(events: SampledEvent[], ctx: BotContext): Stats {
  const keepCount = events.filter((e) => e.label === "KEEP").length;
  const unsureCount = events.filter((e) => e.label === "UNSURE").length;
  const discardCount = events.filter((e) => e.label === "DISCARD").length;
  const userSeeded = events.filter((e) => e.origin === "USER_SEEDED").length;
  const botRecommended = events.filter((e) => e.origin === "BOT_RECOMMENDED").length;

  // Count signals by label
  const keepSignals = new Map<string, number>();
  const discardSignals = new Map<string, number>();

  for (const event of events) {
    const map = event.label === "KEEP" ? keepSignals : event.label === "DISCARD" ? discardSignals : null;
    if (!map) continue;
    for (const s of event.signals) {
      map.set(s, (map.get(s) ?? 0) + event.weight);
    }
  }

  const topKeep = [...keepSignals.entries()].sort((a, b) => b[1] - a[1]).slice(0, 10);
  const topDiscard = [...discardSignals.entries()].sort((a, b) => b[1] - a[1]).slice(0, 10);

  // Get signal scores from scorer
  const signalScores = getAllSignalScores(ctx.db, ctx.spec);
  const scoresObj: Record<string, number> = {};
  for (const [k, v] of signalScores) {
    scoresObj[k] = Math.round(v * 100) / 100;
  }

  return {
    total_events: events.length,
    keep_count: keepCount,
    unsure_count: unsureCount,
    discard_count: discardCount,
    user_seeded_count: userSeeded,
    bot_recommended_count: botRecommended,
    top_keep_signals: topKeep,
    top_discard_signals: topDiscard,
    signal_scores: scoresObj,
  };
}

/**
 * Build the LLM prompt for taste profile proposal.
 */
function buildProposalPrompt(
  currentProfile: string,
  events: SampledEvent[],
  stats: Stats,
  ctx: BotContext,
): string {
  const promptTemplate = ctx.spec.profileUpdatePrompt;

  // Format events for the prompt (top weighted events, limited to keep prompt small)
  const sortedEvents = [...events]
    .sort((a, b) => b.weight - a.weight)
    .slice(0, 50);

  const eventsText = sortedEvents.map((e) =>
    `- [${e.label}] (origin:${e.origin}, weight:${e.weight.toFixed(1)}) "${e.title}" signals:[${e.signals.join(",")}] ${e.one_liner}`,
  ).join("\n");

  const statsText = JSON.stringify(stats, null, 2);

  const language = (ctx.spec.llmConfig as { language?: string }).language ?? "ja";

  // Build full prompt
  const prompt = `${promptTemplate}

IMPORTANT: Write ALL text content (new_profile_md, diff_summary, risks, notes) in ${language}.

---

## CURRENT_PROFILE_MD
${currentProfile}

## RECENT_EVENTS (${events.length} total, showing top ${sortedEvents.length} by weight)
${eventsText}

## STATS
${statsText}

---

Output a JSON object with these exact keys:
- new_profile_md: the updated taste profile in markdown (same structure as current)
- diff_summary: array of strings describing what changed (max 12 lines)
- risks: array of strings noting risks/concerns (max 5)
- confidence: number 0-1 indicating confidence in the update
- notes: optional string with any additional notes

Return ONLY valid JSON. No explanation outside JSON.`;

  return prompt;
}

/**
 * Parse the LLM response into a proposal object.
 */
function parseProposal(response: string): {
  proposal_id: string;
  new_profile_md: string;
  diff_summary: string[];
  risks: string[];
  confidence: number;
  notes?: string;
} | null {
  try {
    const match = response.match(/\{[\s\S]*\}/);
    if (!match) return null;
    const parsed = JSON.parse(match[0]);

    if (!parsed.new_profile_md || !Array.isArray(parsed.diff_summary)) {
      return null;
    }

    return {
      proposal_id: String(parsed.proposal_id ?? `prop-${randomUUID().slice(0, 8)}`),
      new_profile_md: String(parsed.new_profile_md),
      diff_summary: parsed.diff_summary.map(String),
      risks: Array.isArray(parsed.risks) ? parsed.risks.map(String) : [],
      confidence: Number(parsed.confidence ?? 0.5),
      notes: parsed.notes ? String(parsed.notes) : undefined,
    };
  } catch {
    return null;
  }
}

/**
 * Get the default seed profile from spec.
 */
function getDefaultSeedProfile(ctx: BotContext): string {
  return ctx.spec.tasteProfileSeed
    ?? "# Taste Profile (Seed)\n\n## Like (Do)\n- (empty)\n\n## Dislike (Don't)\n- (empty)\n\n## Drift\n- (empty)\n";
}
