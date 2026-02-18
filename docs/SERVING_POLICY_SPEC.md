# Serving Policy Spec (v0.1)

## Goal
Close the learning loop: Taste Profile and scores must affect what gets posted to #feed-ai.
Never post all RSS items.

## Inputs
- Candidates: new RSS items (deduped) not yet posted.
- Taste Profile: current approved profile (or seed if missing).
- Signal scores: existing scorer output (if available).
- Recent history: last N posted items (for repetition control).

## Output
- Selected list of evidence_ids (max_posts_per_cycle), each with:
  - final_score
  - selection_reason (short)
  - bucket
  - flags: {explore: bool, portfolio_fill: bool}

## Stages

### Stage 0: Candidate preparation
1. Load candidates within lookback_hours (cap max_candidates).
2. Apply filters:
   - exclude already_posted/seen
   - exclude recently_discarded
   - enforce max_age_hours
   - enforce per_source_cap

### Stage 1: Preselect (cheap scoring)
Compute prelim_score for each remaining candidate:
- prelim_score = recency_weight * RecencyScore
              + signal_weight * SignalScore
              + source_diversity_bonus * SourceDiversityBonus
Sort desc. Take top_k_for_llm as "LLM pool".

### Stage 2: LLM judge (topK only)
For each item in LLM pool:
- Call task serve_judge with Taste Profile + item summary/signals + recent context
- Validate JSON with serve_judgement.schema.json
- Store judgement result in DB cache (ttl_days)
Define:
- base_score = post_score (0..1)

### Stage 3: Portfolio & Exploration selection
Let N = max_posts_per_cycle.
Let E = round(N * explore_share). (at least 1 if explore_share>0 and N>=3)

Maintain target distribution over buckets (target_share).
Compute recent histogram over last M posts (e.g., M=30).
Compute deficit(bucket) = max(0, target_share - recent_share).

Selection:
A) First fill (N - E) slots using weighted score:
   final_candidate_score = base_score
                        + deficit_boost * deficit(bucket)
   Pick highest scores iteratively, but apply diversity penalty via MMR (Stage 4).
B) Then fill E explore slots:
   - Prefer underrepresented buckets first (highest deficit)
   - If none, pick uncertain post_score range [0.35..0.65]
   - If still none, pick a random from remaining with base_score >= 0.25

### Stage 4: Diversity via MMR
When selecting items iteratively, re-rank remaining candidates by:
MMR = lambda * final_candidate_score - (1 - lambda) * max_similarity_to_selected
Similarity can be a lightweight token Jaccard over (title + summary + signals).
This prevents near-duplicates.

### Stage 5: Post & record
Post only the selected items to #feed-ai.
Record in DB:
- selected_by_policy version
- base_score / final_score
- bucket
- reason
- flags explore/portfolio_fill
