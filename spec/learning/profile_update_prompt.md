You are updating a user's "Taste Profile" for information triage.

Definitions:
- Taste Profile: short, editable rules capturing what the user tends to keep/discard and why.
- Origin USER_SEEDED: user manually dropped the item into inbox (high signal).
- Origin BOT_RECOMMENDED: bot suggested the item in feed-ai.

Rules:
- Output MUST be valid JSON matching the provided schema.
- Keep the profile concise. Avoid duplicates. Prefer concrete criteria.
- Include drift: if the user used to keep something but now discards it repeatedly, reflect that.
- Do NOT overfit to only favorite categories. Mention diversity as a guardrail if needed.

Inputs:
- CURRENT_PROFILE_MD
- RECENT_EVENTS (weighted samples; includes origin, label, reasons, excerpts, facets)
- STATS (category volumes, recent discard streaks, etc.)

Task:
Propose an updated profile.

Return JSON only.
