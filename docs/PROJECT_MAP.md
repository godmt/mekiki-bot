# Mekiki Bot Spec v0.3 Map

This folder is **only the spec + docs** needed for Claude Code to implement the Discord bot.
No application code is included here.

## Big picture

- `#feed-ai` is the **fast decision lane**: short card + buttons (Keep / Unsure / Discard / Open / Note).
- `#library` is the **archive**: Forum posts with tags, created only for Keep/Unsure.
- The bot is **not always-on**: on restart, RSS sync continues from the last cursor timestamp with a safety grace window.

## Where to edit what

### UI text / layout (you will iterate here a lot)
- `spec/templates/feed_card.template.md`  
  Controls the message body posted to `#feed-ai`.
- `spec/templates/library_post.template.md`  
  Controls the Forum post body in `#library`.

### UX wiring (buttons, modals, state rules)
- `spec/ux/channels.yaml`  
  Channel names/ids + operational switches.
- `spec/ux/components.yaml`  
  Buttons / modals / select menus (custom_id format included).
- `spec/ux/state_machine.yaml`  
  Keep/Unsure/Discard overwrite rules + library upsert policy.

### RSS ingestion (manual feeds only, MVP)
- `spec/rss/rss_sources.json`  
  You register RSS feeds here.
- Cursor behavior: see `spec/ux/channels.yaml` (grace + max catchup), and `docs/RUNBOOK.md`.

### LLM (Vercel AI SDK) and model selection (BYOK + easy extension)
- `spec/llm/llm_config.json`  
  Active provider/model + provider connection settings (env keys or baseURL).
- `spec/llm/model_registry.json`  
  Which models are selectable per provider (add lines to extend).
- `spec/llm/task_routing.json`  
  Default model per internal task (summarize, signals, etc).

### Learning (time-aware preference)
- `spec/learning/learning_config.yaml`  
  Time decay + fatigue parameters (concept drift handling).
- `spec/learning/signals.yaml`  
  Signals vocabulary (short hashtags).
- `spec/learning/tag_map.yaml`  
  Signals -> Forum tags mapping.

### Forum tags
- `spec/forum/forum_tags.yaml`  
  Tag keys + labels for the `#library` Forum.

### Validation (schemas)
- `spec/schemas/*.schema.json`  
  JSON Schemas for all config/template contexts. Bot should validate on startup and fail loudly.

## “Escape hatch” for Claude Code

If Claude Code hits a wall due to Discord/API limitations or missing config fields:
1. It may propose a **minimal spec change** (edit/add fields under `spec/`).
2. It must ask you to approve that change (with a clear diff-like explanation).
3. After approval, it updates `spec/` and continues implementation.

(See `docs/CLAUDE_CODE_BRIEF.md`.)

## Quick tree

- docs/
  - PROJECT_MAP.md (this file)
  - RUNBOOK.md
  - CLAUDE_CODE_BRIEF.md
- spec/
  - templates/
  - schemas/
  - ux/
  - rss/
  - llm/
  - learning/
  - forum/
