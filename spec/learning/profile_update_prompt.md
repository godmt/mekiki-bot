You are updating a user's "Taste Profile" for information triage.

Definitions:
- Taste Profile: short, editable rules capturing what the user tends to keep/discard and why.
- Origin USER_SEEDED: user manually dropped the item into inbox (high signal, heavier weight).
- Origin BOT_RECOMMENDED: bot suggested the item in feed-ai.
- diff_summary (変更要約; なぜ: 人間レビューが速くなる): a short list of concrete edits you made.

Hard Rules:
- Output MUST be valid JSON matching the provided schema.
- Return JSON only. No markdown fences around the JSON.
- Keep the profile concise and non-redundant.
- Prefer concrete, testable criteria (avoid vague wording).
- Include drift: if the user used to keep a pattern but now discards it repeatedly, reflect that in Drift.
- Do NOT overfit to only favorite categories. Add a diversity guardrail rule if needed.
- IMPORTANT: diff_summary MUST NEVER be empty.
  - If you made no meaningful changes, set diff_summary to ["No material changes."] and keep confidence <= 0.6.

Inputs:
- CURRENT_PROFILE_MD
- RECENT_EVENTS (weighted samples; includes origin, label, reasons, excerpts, facets)
- STATS (category volumes, recent discard streaks, recent bucket histogram, etc.)

Taste Profile Markdown Format (MUST follow):
- Start with a single H1 title: "# Taste Profile (Updated)"
- Sections in this order:
  1) "## Like (Do)" as bullet list
  2) "## Dislike (Don't)" as bullet list
  3) "## Drift (Recent changes)" as bullet list (or "- なし" if none)
- Each bullet should be:
  - One sentence.
  - Concrete (what to look for, what to avoid).
  - Optionally include a short bracketed example like: "(例: ...)".
- Keep total size reasonably small (aim < 1,800 chars unless strongly justified).

Task:
Propose an updated profile based on the evidence.

How to decide changes:
1) Identify 2–6 strongest keep drivers and discard drivers from RECENT_EVENTS.
2) If recent discard streaks suggest a formerly-liked pattern is now rejected, add a Drift bullet.
3) If the profile already contains a rule, do not duplicate it. Refine wording instead.
4) If a rule could create a bubble (e.g., only one category), add/adjust a guardrail rule.

Output (JSON fields intent):
- new_profile_md: the full updated Markdown profile (following the format above).
- diff_summary: 1–12 short bullets describing exactly what changed (Added/Modified/Removed).
- risks: 0–6 bullets. If you changed anything, include at least 1 risk.
- confidence: 0..1. If only tiny edits or no changes, keep it modest.
- stats_used: include only key numbers you relied on (small object).

Return JSON only.
