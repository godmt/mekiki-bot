# spec/ (Source of truth)

This directory contains all user-editable behavior:

- Templates (markdown): `templates/`
- UX wiring (yaml): `ux/`
- RSS sources (json): `rss/`
- LLM selection (json): `llm/`
- Learning knobs (yaml): `learning/`
- Forum tags (yaml): `forum/`
- Validation schemas: `schemas/`

Claude Code should validate configs on startup and fail loudly on schema errors.
