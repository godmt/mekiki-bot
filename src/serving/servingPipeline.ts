import type { BotContext } from "../discord/botContext.js";
import type { EvidenceRow } from "../db/database.js";
import type { LlmClient } from "../llm/client.js";
import { createLlmClient } from "../llm/client.js";

// ---------- Types ----------

interface ServingPolicy {
  enabled: boolean;
  posting: { max_posts_per_cycle: number; min_gap_minutes_between_posts: number };
  candidates: { lookback_hours: number; max_candidates: number };
  filters: {
    exclude_already_posted: boolean;
    exclude_already_seen: boolean;
    exclude_recently_discarded_days: number;
    recency: { enabled: boolean; max_age_hours: number };
    per_source_cap: { enabled: boolean; max_per_cycle: number };
  };
  preselect: {
    top_k_for_llm: number;
    scoring: { recency_weight: number; signal_weight: number; source_diversity_bonus: number };
  };
  llm_judge: {
    enabled: boolean;
    task_name: string;
    timeout_ms: number;
    cache: { enabled: boolean; ttl_days: number };
  };
  portfolio: {
    enabled: boolean;
    target_share: Record<string, number>;
    deficit_boost: number;
  };
  diversity: {
    enabled: boolean;
    lambda: number;
  };
  exploration: {
    enabled: boolean;
    explore_share: number;
    uncertain_score_range: [number, number];
  };
  logging: { explain_in_ops: boolean; explain_max_lines: number };
}

interface Judgement {
  post_score: number;
  bucket: string;
  reason: string;
  signals?: string[];
  novelty?: number;
  actionability?: number;
  trust?: number;
  time_sensitivity?: number;
  avoid_repeats?: boolean;
  notes?: string;
}

interface ScoredCandidate {
  evidence: EvidenceRow;
  rawData: { one_liner?: string; signals?: string; signals_inline?: string; source_domain?: string; published_at?: string; content?: string };
  prelimScore: number;
  judgement?: Judgement;
  finalScore: number;
  bucket: string;
  flags: { explore: boolean; portfolio_fill: boolean };
  selectionReason: string;
}

export interface ServingResult {
  selected: ScoredCandidate[];
  totalCandidates: number;
  llmJudged: number;
  cached: number;
  skipped: number;
}

// ---------- Helpers ----------

function parseRawJson(raw: string | null): ScoredCandidate["rawData"] {
  if (!raw) return {};
  try {
    return JSON.parse(raw);
  } catch {
    return {};
  }
}

function signalsFromRaw(rawData: ScoredCandidate["rawData"]): string[] {
  if (!rawData.signals) return [];
  try {
    return JSON.parse(rawData.signals);
  } catch {
    return [];
  }
}

function tokenize(text: string): Set<string> {
  return new Set(text.toLowerCase().split(/\W+/).filter(t => t.length > 1));
}

function tokenJaccard(a: string, b: string): number {
  const setA = tokenize(a);
  const setB = tokenize(b);
  if (setA.size === 0 && setB.size === 0) return 0;
  let intersection = 0;
  for (const t of setA) {
    if (setB.has(t)) intersection++;
  }
  const union = setA.size + setB.size - intersection;
  return union === 0 ? 0 : intersection / union;
}

function candidateText(c: ScoredCandidate): string {
  const raw = c.rawData;
  return [c.evidence.title, raw.one_liner ?? "", raw.signals_inline ?? ""].join(" ");
}

// ---------- Stage 0: Candidate preparation ----------

function loadCandidates(ctx: BotContext, policy: ServingPolicy): ScoredCandidate[] {
  const rows = ctx.db.getCandidateEvidence(
    policy.candidates.lookback_hours,
    policy.candidates.max_candidates,
  );

  // Apply filters
  let candidates = rows.map(e => ({
    evidence: e,
    rawData: parseRawJson(e.raw_json),
    prelimScore: 0,
    finalScore: 0,
    bucket: "OTHER",
    flags: { explore: false, portfolio_fill: false },
    selectionReason: "",
  } as ScoredCandidate));

  // Exclude recently discarded
  if (policy.filters.exclude_recently_discarded_days > 0) {
    const discardedIds = new Set<string>();
    const cutoff = new Date(Date.now() - policy.filters.exclude_recently_discarded_days * 24 * 60 * 60 * 1000).toISOString();
    // Query discarded items
    const discarded = ctx.db.raw.prepare(
      `SELECT DISTINCT evidence_id FROM actions_log WHERE action = 'label.discard' AND created_at > ?`,
    ).all(cutoff) as Array<{ evidence_id: string }>;
    for (const r of discarded) discardedIds.add(r.evidence_id);
    candidates = candidates.filter(c => !discardedIds.has(c.evidence.evidence_id));
  }

  // Recency filter: max_age_hours
  if (policy.filters.recency?.enabled) {
    const maxAge = policy.filters.recency.max_age_hours;
    const cutoff = new Date(Date.now() - maxAge * 60 * 60 * 1000);
    candidates = candidates.filter(c => new Date(c.evidence.created_at) >= cutoff);
  }

  // Per-source cap
  if (policy.filters.per_source_cap?.enabled) {
    const cap = policy.filters.per_source_cap.max_per_cycle;
    const counts = new Map<string, number>();
    candidates = candidates.filter(c => {
      const src = c.evidence.source_id ?? "unknown";
      const cnt = counts.get(src) ?? 0;
      if (cnt >= cap) return false;
      counts.set(src, cnt + 1);
      return true;
    });
  }

  return candidates;
}

// ---------- Stage 1: Preselect (heuristic scoring) ----------

function preselectTopK(candidates: ScoredCandidate[], policy: ServingPolicy): ScoredCandidate[] {
  const weights = policy.preselect.scoring;
  const now = Date.now();
  const seenSources = new Set<string>();

  for (const c of candidates) {
    // Recency score: exponential decay, 1.0 for brand new, 0 for max_age
    const ageHours = (now - new Date(c.evidence.created_at).getTime()) / (1000 * 60 * 60);
    const maxAge = policy.filters.recency?.max_age_hours ?? 168;
    const recencyScore = Math.max(0, 1 - ageHours / maxAge);

    // Signal score: normalized count of signals (0-1)
    const signals = signalsFromRaw(c.rawData);
    const signalScore = Math.min(1, signals.length / 8);

    // Source diversity bonus
    const src = c.evidence.source_id ?? "unknown";
    const diversityBonus = seenSources.has(src) ? 0 : 1;
    seenSources.add(src);

    c.prelimScore =
      weights.recency_weight * recencyScore +
      weights.signal_weight * signalScore +
      weights.source_diversity_bonus * diversityBonus;
  }

  // Sort descending by prelim score
  candidates.sort((a, b) => b.prelimScore - a.prelimScore);

  return candidates.slice(0, policy.preselect.top_k_for_llm);
}

// ---------- Stage 2: LLM Judge ----------

function buildJudgePrompt(
  servingPrompt: string,
  tasteProfile: string,
  candidate: ScoredCandidate,
  recentTitles: string[],
  recentBuckets: Array<{ bucket: string; cnt: number }>,
  language: string,
): string {
  const raw = candidate.rawData;
  const signals = signalsFromRaw(candidate.rawData);
  const bucketHistogram = recentBuckets.map(b => `${b.bucket}: ${b.cnt}`).join(", ");

  return `${servingPrompt}

TASTE_PROFILE_MD:
${tasteProfile}

ITEM:
- title: ${candidate.evidence.title}
- url: ${candidate.evidence.url ?? "(no url)"}
- source_id: ${candidate.evidence.source_id ?? "unknown"}
- published_at: ${raw.published_at ?? candidate.evidence.created_at}
- summary: ${raw.one_liner ?? ""}
- signals: ${JSON.stringify(signals)}

CONTEXT:
- recent_buckets_histogram: {${bucketHistogram}}
- recent_posted_titles: ${JSON.stringify(recentTitles.slice(0, 10))}

IMPORTANT: Write the "reason" field in ${language === "ja" ? "Japanese" : language}.
Return ONLY valid JSON.`;
}

function parseJudgement(text: string): Judgement | null {
  try {
    const match = text.match(/\{[\s\S]*\}/);
    if (!match) return null;
    const parsed = JSON.parse(match[0]);
    if (typeof parsed.post_score !== "number" || typeof parsed.bucket !== "string") return null;
    return {
      post_score: Math.max(0, Math.min(1, parsed.post_score)),
      bucket: String(parsed.bucket),
      reason: String(parsed.reason ?? ""),
      signals: Array.isArray(parsed.signals) ? parsed.signals : undefined,
      novelty: parsed.novelty,
      actionability: parsed.actionability,
      trust: parsed.trust,
      time_sensitivity: parsed.time_sensitivity,
      avoid_repeats: parsed.avoid_repeats,
      notes: parsed.notes,
    };
  } catch {
    return null;
  }
}

async function judgeCandidate(
  llm: LlmClient,
  ctx: BotContext,
  candidate: ScoredCandidate,
  policy: ServingPolicy,
  servingPrompt: string,
  tasteProfile: string,
  recentTitles: string[],
  recentBuckets: Array<{ bucket: string; cnt: number }>,
  language: string,
): Promise<{ judgement: Judgement | null; cached: boolean }> {
  const eid = candidate.evidence.evidence_id;

  // Check cache first
  if (policy.llm_judge.cache.enabled) {
    const cached = ctx.db.getCachedJudgement(eid);
    if (cached) {
      return {
        judgement: {
          post_score: cached.post_score,
          bucket: cached.bucket,
          reason: cached.reason,
          signals: cached.signals_json ? JSON.parse(cached.signals_json) : undefined,
        },
        cached: true,
      };
    }
  }

  // Call LLM
  const prompt = buildJudgePrompt(servingPrompt, tasteProfile, candidate, recentTitles, recentBuckets, language);
  const text = await llm.run(policy.llm_judge.task_name, prompt);
  const judgement = parseJudgement(text);

  // Cache result
  if (judgement && policy.llm_judge.cache.enabled) {
    ctx.db.upsertJudgement(
      eid,
      judgement.post_score,
      judgement.bucket,
      judgement.reason,
      JSON.stringify(judgement.signals ?? []),
      text,
      policy.llm_judge.cache.ttl_days,
    );
  }

  return { judgement, cached: false };
}

// ---------- Stage 3+4: Portfolio + Exploration + MMR ----------

function selectWithPortfolio(
  judged: ScoredCandidate[],
  policy: ServingPolicy,
  recentBuckets: Array<{ bucket: string; cnt: number }>,
): ScoredCandidate[] {
  const N = policy.posting.max_posts_per_cycle;
  if (judged.length === 0) return [];

  // Compute explore slots
  const exploreEnabled = policy.exploration?.enabled ?? false;
  const exploreShare = exploreEnabled ? (policy.exploration.explore_share ?? 0.15) : 0;
  let E = Math.round(N * exploreShare);
  if (exploreShare > 0 && N >= 3 && E < 1) E = 1;
  const mainSlots = N - E;

  // Compute recent histogram and deficit
  const totalRecent = recentBuckets.reduce((s, b) => s + b.cnt, 0) || 1;
  const recentShareMap = new Map<string, number>();
  for (const b of recentBuckets) recentShareMap.set(b.bucket, b.cnt / totalRecent);

  const targetShare = policy.portfolio?.target_share ?? {};
  const deficit = new Map<string, number>();
  for (const [bucket, target] of Object.entries(targetShare)) {
    const recent = recentShareMap.get(bucket) ?? 0;
    deficit.set(bucket, Math.max(0, target - recent));
  }

  // Compute final scores with deficit boost
  const deficitBoost = policy.portfolio?.deficit_boost ?? 0.35;
  for (const c of judged) {
    if (!c.judgement) continue;
    const d = deficit.get(c.bucket) ?? 0;
    c.finalScore = c.judgement.post_score + deficitBoost * d;
  }

  const selected: ScoredCandidate[] = [];
  const remaining = [...judged.filter(c => c.judgement !== undefined)];
  const lambda = policy.diversity?.lambda ?? 0.75;
  const diversityEnabled = policy.diversity?.enabled ?? false;

  // A) Fill main slots via MMR
  while (selected.length < mainSlots && remaining.length > 0) {
    let bestIdx = 0;
    let bestMmr = -Infinity;

    for (let i = 0; i < remaining.length; i++) {
      const c = remaining[i];
      let mmrScore = c.finalScore;

      if (diversityEnabled && selected.length > 0) {
        const cText = candidateText(c);
        const maxSim = Math.max(
          ...selected.map(s => tokenJaccard(candidateText(s), cText)),
        );
        mmrScore = lambda * c.finalScore - (1 - lambda) * maxSim;
      }

      if (mmrScore > bestMmr) {
        bestMmr = mmrScore;
        bestIdx = i;
      }
    }

    const pick = remaining.splice(bestIdx, 1)[0];
    // Check if deficit filled
    const d = deficit.get(pick.bucket) ?? 0;
    if (d > 0) pick.flags.portfolio_fill = true;
    pick.selectionReason = `score=${pick.judgement!.post_score.toFixed(2)} final=${pick.finalScore.toFixed(2)} bucket=${pick.bucket}`;
    selected.push(pick);
  }

  // B) Fill explore slots
  if (E > 0 && remaining.length > 0) {
    // Prefer underrepresented buckets
    const underrepBuckets = [...deficit.entries()]
      .filter(([, d]) => d > 0)
      .sort((a, b) => b[1] - a[1])
      .map(([b]) => b);

    let filled = 0;

    // Try underrepresented buckets first
    for (const targetBucket of underrepBuckets) {
      if (filled >= E) break;
      const idx = remaining.findIndex(c => c.bucket === targetBucket);
      if (idx >= 0) {
        const pick = remaining.splice(idx, 1)[0];
        pick.flags.explore = true;
        pick.selectionReason = `explore: underrepresented bucket ${pick.bucket}`;
        selected.push(pick);
        filled++;
      }
    }

    // Uncertain score range
    if (filled < E) {
      const [lo, hi] = policy.exploration?.uncertain_score_range ?? [0.35, 0.65];
      const uncertainCandidates = remaining.filter(c =>
        c.judgement && c.judgement.post_score >= lo && c.judgement.post_score <= hi,
      );
      uncertainCandidates.sort((a, b) => b.finalScore - a.finalScore);
      for (const c of uncertainCandidates) {
        if (filled >= E) break;
        const idx = remaining.indexOf(c);
        if (idx >= 0) {
          remaining.splice(idx, 1);
          c.flags.explore = true;
          c.selectionReason = `explore: uncertain score ${c.judgement!.post_score.toFixed(2)}`;
          selected.push(c);
          filled++;
        }
      }
    }

    // Random fallback
    if (filled < E) {
      const eligible = remaining.filter(c =>
        c.judgement && c.judgement.post_score >= 0.25,
      );
      for (const c of eligible) {
        if (filled >= E) break;
        const idx = remaining.indexOf(c);
        if (idx >= 0) {
          remaining.splice(idx, 1);
          c.flags.explore = true;
          c.selectionReason = `explore: random pick score=${c.judgement!.post_score.toFixed(2)}`;
          selected.push(c);
          filled++;
        }
      }
    }
  }

  return selected;
}

// ---------- Public API ----------

export async function runServingPipeline(ctx: BotContext): Promise<ServingResult> {
  const policy = ctx.spec.servingPolicy as unknown as ServingPolicy;
  const language = (ctx.spec.llmConfig as { language?: string }).language ?? "ja";

  if (!policy.enabled) {
    return { selected: [], totalCandidates: 0, llmJudged: 0, cached: 0, skipped: 0 };
  }

  // Stage 0: Load candidates
  const candidates = loadCandidates(ctx, policy);
  console.log(`[serving] Stage 0: ${candidates.length} candidates after filtering`);

  if (candidates.length === 0) {
    return { selected: [], totalCandidates: 0, llmJudged: 0, cached: 0, skipped: 0 };
  }

  // Stage 1: Preselect top K
  const topK = preselectTopK(candidates, policy);
  console.log(`[serving] Stage 1: ${topK.length} candidates after preselect (top_k=${policy.preselect.top_k_for_llm})`);

  // Stage 2: LLM Judge
  let llmJudged = 0;
  let cached = 0;
  let skipped = 0;

  if (policy.llm_judge.enabled) {
    const llm = createLlmClient(ctx.spec);
    const tasteProfile = ctx.db.getActiveProfile()?.profile_md ?? ctx.spec.tasteProfileSeed;
    const recentTitles = ctx.db.getRecentPostedTitles(20);
    const recentBuckets = ctx.db.getRecentPostedBuckets(50);

    for (const c of topK) {
      try {
        const result = await judgeCandidate(
          llm, ctx, c, policy, ctx.spec.servingPrompt, tasteProfile,
          recentTitles, recentBuckets, language,
        );
        if (result.judgement) {
          c.judgement = result.judgement;
          c.bucket = result.judgement.bucket;
          if (result.cached) cached++;
          else llmJudged++;
        } else {
          skipped++;
        }
      } catch (err) {
        console.error(`[serving] LLM judge error for ${c.evidence.evidence_id}:`, err);
        skipped++;
      }
    }

    console.log(`[serving] Stage 2: judged=${llmJudged} cached=${cached} skipped=${skipped}`);
  } else {
    // No LLM judge: use prelim score as post_score
    for (const c of topK) {
      c.judgement = { post_score: c.prelimScore, bucket: "OTHER", reason: "no-llm-judge" };
      c.bucket = "OTHER";
    }
  }

  // Stage 3+4: Portfolio + Exploration + MMR
  const recentBuckets = ctx.db.getRecentPostedBuckets(50);
  const selected = selectWithPortfolio(topK, policy, recentBuckets);
  console.log(`[serving] Stage 3+4: ${selected.length} items selected for posting`);

  return {
    selected,
    totalCandidates: candidates.length,
    llmJudged,
    cached,
    skipped,
  };
}
