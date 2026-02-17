# Claude Code Brief (Implementation Contract)

You are implementing a Discord bot from **spec/**. Treat **spec/** as the source of truth.

## Hard rules

- Do NOT hardcode UI text layouts; render from:
  - `spec/templates/feed_card.template.md`
  - `spec/templates/library_post.template.md`
- Do NOT call any LLM SDK outside `src/llm/*` (single choke point).
- Do NOT mix learning logic with publishing/archiving logic.
- Validate all config files on startup using `spec/schemas/*`. If invalid, exit with actionable errors.

## Allowed “escape hatch” (required when blocked)

If you encounter an unavoidable mismatch (Discord API constraints, missing field, etc.):
- You MAY propose a minimal change to spec/.
- You MUST ask the user to approve before proceeding.
- Provide:
  - what you want to change (file path + diff-style summary)
  - why (which limitation / failure)
  - impact (what behavior changes)
  - safe default values

After approval, apply the spec change and continue.

## MVP scope

- RSS-only ingestion.
- Restart-safe cursor sync (last_fetch_at with grace window + dedupe).
- #feed-ai cards + buttons.
- #library Forum posts for Keep/Unsure with tags.
- LLM via Vercel AI SDK (OpenAI / Anthropic / Google Gemini / Ollama), selectable via config.

## Explicit non-MVP (future)

- 3–7 day clustering (group duplicates) with per-article viewpoint posts.
- Auto-search word generation from preferences.
