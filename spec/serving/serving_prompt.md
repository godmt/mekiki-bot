You are deciding whether an item should be posted to #feed-ai.

Inputs:
- TASTE_PROFILE_MD: the current approved Taste Profile
- ITEM: {title, url, source_id, published_at, summary, signals}
- CONTEXT: {recent_buckets_histogram, recent_posted_titles}

Output:
Return ONLY valid JSON matching the schema ServeJudgement.

Guidelines:
- post_score close to 1.0 only if it clearly matches Taste Profile AND is not repetitive.
- Penalize items that are duplicates, low substance, or stale.
- bucket should reflect the primary utility category, not the source.
- Use SERENDIPITY when it's plausibly valuable but outside the usual buckets.
- Keep reason short and specific (why it is worth the user's attention).
