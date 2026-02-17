# RUNBOOK (Local-first operation)

## Start/Stop philosophy

This bot is often run only when you want it. It must be restart-safe.

### Cursor
- Per RSS source, store `last_fetch_at` in SQLite.
- On sync, compute:
  - `since = max(last_fetch_at - grace_hours, now - max_catchup_days)`
- Use dedupe so the grace window does not create duplicates.

## Typical flow

1. Configure:
   - `spec/ux/channels.yaml` (channel IDs)
   - `spec/rss/rss_sources.json`
   - `spec/llm/llm_config.json`
2. Set env vars (BYOK):
   - OPENAI_API_KEY / ANTHROPIC_API_KEY / GOOGLE_API_KEY (as needed)
3. Run bot locally.
4. Use `/sync` to fetch new RSS items since cursor.
5. Press buttons in `#feed-ai`:
   - Keep/Unsure => create or update a Forum post in `#library`
   - Discard => do not archive, but log action for learning

## Operational commands (expected)

- `/sync` : fetch RSS deltas and post to `#feed-ai`
- `/pause` : stop ingestion actions (still accept button clicks)
- `/resume`
- `/model show` : show active provider/model
- `/model set provider=<...> model=<...>` : update `spec/llm/llm_config.json` OR a runtime overlay (implementation choice)

## Backup

- Copy the SQLite file periodically (manual is fine).
- If you want safety, write a small script to zip the DB daily.
