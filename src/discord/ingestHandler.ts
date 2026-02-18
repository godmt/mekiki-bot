import { createHash } from "node:crypto";
import type { BotContext } from "./botContext.js";
import { createLlmClient } from "../llm/client.js";
import { summarizeFeed, extractSignals, type FeedCardData } from "../llm/tasks.js";
import { postFeedCard } from "./feedCard.js";
import { upsertLibraryPost } from "./libraryPost.js";
import { fetchPageText } from "../utils/fetchPage.js";
import type { RssItem } from "../rss/fetcher.js";

function urlHash(input: string): string {
  return createHash("sha256").update(input).digest("hex").slice(0, 16);
}

function isUrl(input: string): boolean {
  try {
    new URL(input.trim());
    return true;
  } catch {
    return false;
  }
}

function domainOf(url: string): string {
  try {
    return new URL(url).hostname;
  } catch {
    return "manual";
  }
}

/**
 * Ingest a URL or text snippet, create evidence, and post a card to #feed-ai.
 * Used by both /ingest command and #inbox-manual channel listener.
 */
export async function ingestInput(
  ctx: BotContext,
  input: string,
  origin: "slash_command" | "inbox_manual" | "dm",
): Promise<void> {
  const trimmed = input.trim();
  const hash = urlHash(trimmed);
  const isLink = isUrl(trimmed);

  const evidenceId = `manual:${hash}`;

  // Dedupe
  if (ctx.db.isSeen(hash)) {
    console.log(`[ingest] Already seen: ${evidenceId}`);
    return;
  }
  ctx.db.insertSeen(evidenceId, hash);

  const sourceType = isLink ? "url" : "text";
  const domain = isLink ? domainOf(trimmed) : "manual";

  // For URLs: fetch the page to get actual title and content
  let pageTitle = "";
  let pageContent = "";
  if (isLink) {
    console.log(`[ingest] Fetching page content: ${trimmed}`);
    const page = await fetchPageText(trimmed);
    if (page) {
      pageTitle = page.pageTitle;
      pageContent = page.textContent;
      console.log(`[ingest] Fetched: title="${pageTitle.slice(0, 60)}", content=${pageContent.length} chars`);
    } else {
      console.warn(`[ingest] Could not fetch page content for ${trimmed}`);
    }
  }

  // Build a pseudo RssItem for LLM tasks
  const item: RssItem = {
    evidenceId,
    title: pageTitle || (isLink ? trimmed.slice(0, 120) : trimmed.slice(0, 80)),
    url: isLink ? trimmed : "",
    publishedAt: new Date().toISOString(),
    sourceId: "manual",
    sourceDomain: domain,
    defaultSignals: [],
    content: pageContent || (isLink ? undefined : trimmed),
  };

  // LLM summarize + signals
  const llm = createLlmClient(ctx.spec);
  const signals = ctx.spec.signals.signals;
  const language = (ctx.spec.llmConfig as { language?: string }).language ?? "ja";

  const [summary, itemSignals] = await Promise.all([
    summarizeFeed(llm, item, language),
    extractSignals(llm, item, signals),
  ]);

  const maxSignals = ((ctx.spec.posting as { feed_card_max_signals?: number }).feed_card_max_signals) ?? 8;
  const displaySignals = itemSignals.slice(0, maxSignals);

  // Use LLM-generated title, fallback to page title, then URL
  const displayTitle = summary.title || pageTitle || item.title;

  // Store evidence
  const rawJson = JSON.stringify({
    one_liner: summary.one_liner,
    signals: JSON.stringify(displaySignals),
    signals_inline: displaySignals.join(" "),
    source_domain: domain,
    published_at: item.publishedAt,
    content: (pageContent || item.content || "").slice(0, 3000),
    origin,
  });

  ctx.db.upsertEvidence(evidenceId, displayTitle, isLink ? trimmed : null, sourceType, "manual", "USER_SEEDED", rawJson);

  // Post card to #feed-ai
  const cardData: FeedCardData = {
    title: displayTitle,
    one_liner: summary.one_liner,
    signals: displaySignals,
    signals_inline: displaySignals.join(" "),
    source_domain: domain,
    source_type: sourceType,
    published_at: item.publishedAt,
    evidence_id: evidenceId,
    canonical_url: isLink ? trimmed : "",
  };

  const msg = await postFeedCard(ctx.channels.feedAi, ctx.spec, cardData);
  ctx.db.updateEvidenceFeedMsg(evidenceId, msg.id);

  console.log(`[ingest] Posted card for ${evidenceId} from ${origin}`);

  // Auto-label if configured (e.g. inbox_manual → auto keep)
  const inboxConf = ctx.spec.channels as Record<string, { auto_label?: string }>;
  const autoLabel = inboxConf.inbox_manual?.auto_label;

  if (autoLabel) {
    const autoState = autoLabel.toUpperCase(); // "keep" → "KEEP"

    ctx.db.updateEvidenceState(evidenceId, autoState);
    ctx.db.insertAction(evidenceId, `label.${autoLabel}`, "auto", JSON.stringify({ origin }));

    console.log(`[ingest] Auto-labeled ${evidenceId} → ${autoState}`);

    // Auto-create library post
    try {
      await upsertLibraryPost(ctx, evidenceId, autoState);
      console.log(`[ingest] Auto-created library post for ${evidenceId}`);
    } catch (err) {
      console.error(`[ingest] Auto library upsert failed for ${evidenceId}:`, err);
      await ctx.channels.ops.send(
        `⚠️ Auto library upsert failed for \`${evidenceId}\`: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }
}
