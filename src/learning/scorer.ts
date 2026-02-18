import type { MekikiDb, ActionRow } from "../db/database.js";
import type { MekikiSpec } from "../config/specLoader.js";

interface LearningConfig {
  time_decay: { half_life_days: number };
  fatigue: {
    window_days: number;
    discard_streak_threshold: number;
    penalty_multiplier: number;
  };
  scoring: {
    keep_weight: number;
    unsure_weight: number;
    discard_weight: number;
    manual_boost: number;
  };
}

/**
 * Time-decay factor: weight = 2^(-age_days / half_life_days)
 */
function timeDecay(actionDate: Date, now: Date, halfLifeDays: number): number {
  const ageDays = (now.getTime() - actionDate.getTime()) / (1000 * 60 * 60 * 24);
  return Math.pow(2, -ageDays / halfLifeDays);
}

/**
 * Determine if an evidence item originated from manual input.
 * Manual items have source_id = "manual" or origin in raw_json.
 */
function isManualOrigin(rawJson: string | null, sourceId: string | null): boolean {
  if (sourceId === "manual") return true;
  if (rawJson) {
    try {
      const raw = JSON.parse(rawJson);
      return raw.origin === "inbox_manual" || raw.origin === "slash_command" || raw.origin === "dm";
    } catch { /* ignore */ }
  }
  return false;
}

/**
 * Calculate a signal's preference score based on all actions that involved it.
 * Considers time decay, fatigue, and manual-input boost.
 */
export function calculateSignalScore(
  signal: string,
  db: MekikiDb,
  spec: MekikiSpec,
): number {
  const config = spec.learningConfig as unknown as LearningConfig;
  const now = new Date();

  // Get all label actions joined with evidence data
  const allActions = db.raw.prepare(
    `SELECT a.*, e.raw_json, e.source_id FROM actions_log a
     JOIN evidence e ON a.evidence_id = e.evidence_id
     WHERE a.action IN ('label.keep', 'label.unsure', 'label.discard')
     ORDER BY a.created_at DESC`,
  ).all() as (ActionRow & { raw_json: string | null; source_id: string | null })[];

  let score = 0;
  let recentDiscardStreak = 0;
  const windowStart = new Date(now.getTime() - config.fatigue.window_days * 24 * 60 * 60 * 1000);

  for (const action of allActions) {
    // Parse signals from evidence
    let signals: string[] = [];
    if (action.raw_json) {
      try {
        const raw = JSON.parse(action.raw_json);
        if (raw.signals) signals = JSON.parse(raw.signals);
      } catch { /* ignore */ }
    }

    if (!signals.includes(signal)) continue;

    const actionDate = new Date(action.created_at);
    const decay = timeDecay(actionDate, now, config.time_decay.half_life_days);

    let weight = 0;
    if (action.action === "label.keep") weight = config.scoring.keep_weight;
    else if (action.action === "label.unsure") weight = config.scoring.unsure_weight;
    else if (action.action === "label.discard") weight = config.scoring.discard_weight;

    // Fatigue: count recent discard streak within window
    if (action.action === "label.discard" && actionDate >= windowStart) {
      recentDiscardStreak++;
    } else {
      recentDiscardStreak = 0;
    }

    let fatiguePenalty = 1.0;
    if (recentDiscardStreak >= config.fatigue.discard_streak_threshold) {
      fatiguePenalty = config.fatigue.penalty_multiplier;
    }

    // Manual-origin boost: user explicitly chose to ingest this
    const manualBoost = isManualOrigin(action.raw_json, action.source_id)
      ? (config.scoring.manual_boost ?? 1.5)
      : 1.0;

    score += weight * decay * fatiguePenalty * manualBoost;
  }

  return score;
}

/**
 * Get scores for all known signals.
 */
export function getAllSignalScores(
  db: MekikiDb,
  spec: MekikiSpec,
): Map<string, number> {
  const signals = (spec.signals as { signals: string[] }).signals;
  const scores = new Map<string, number>();

  for (const signal of signals) {
    scores.set(signal, calculateSignalScore(signal, db, spec));
  }

  return scores;
}
