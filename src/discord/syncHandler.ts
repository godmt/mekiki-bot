import type { BotContext } from "./botContext.js";
import { fetchAllSources, type RssItem, type FetchOptions } from "../rss/fetcher.js";
import { createLlmClient } from "../llm/client.js";
import { summarizeFeed, extractSignals, type FeedCardData } from "../llm/tasks.js";
import { postFeedCard } from "./feedCard.js";

/**
 * Run full sync: fetch RSS → LLM summarize/signals → post cards to #feed-ai.
 * Returns count of new items posted.
 */
export async function runSync(ctx: BotContext, fetchOpts?: FetchOptions): Promise<number> {
  const items = await fetchAllSources(ctx.db, ctx.spec, fetchOpts);

  if (items.length === 0) {
    return 0;
  }

  const llm = createLlmClient(ctx.spec);
  const signals = ctx.spec.signals.signals;
  const maxSignals = ((ctx.spec.posting as { feed_card_max_signals?: number }).feed_card_max_signals) ?? 8;
  const language = (ctx.spec.llmConfig as { language?: string }).language ?? "ja";
  let posted = 0;

  for (const item of items) {
    try {
      // LLM: summarize + extract signals
      const [summary, itemSignals] = await Promise.all([
        summarizeFeed(llm, item, language),
        extractSignals(llm, item, signals),
      ]);

      const displaySignals = itemSignals.slice(0, maxSignals);

      // Use LLM-generated title, fallback to original
      const displayTitle = summary.title || item.title;

      // Store evidence in DB
      const rawJson = JSON.stringify({
        one_liner: summary.one_liner,
        signals: JSON.stringify(displaySignals),
        signals_inline: displaySignals.join(" "),
        source_domain: item.sourceDomain,
        published_at: item.publishedAt,
        content: item.content?.slice(0, 3000),
      });

      ctx.db.upsertEvidence(
        item.evidenceId,
        displayTitle,
        item.url,
        "url",
        item.sourceId,
        "BOT_RECOMMENDED",
        rawJson,
      );

      // Build card data
      const cardData: FeedCardData = {
        title: displayTitle,
        one_liner: summary.one_liner,
        signals: displaySignals,
        signals_inline: displaySignals.join(" "),
        source_domain: item.sourceDomain,
        source_type: "url",
        published_at: item.publishedAt,
        evidence_id: item.evidenceId,
        canonical_url: item.url,
      };

      // Post to #feed-ai
      const msg = await postFeedCard(ctx.channels.feedAi, ctx.spec, cardData);
      ctx.db.updateEvidenceFeedMsg(item.evidenceId, msg.id);
      posted++;

      // Brief delay to avoid rate limiting
      if (posted < items.length) {
        await new Promise((r) => setTimeout(r, 1000));
      }
    } catch (err) {
      console.error(`[sync] Error processing ${item.evidenceId}:`, err);
      await ctx.channels.ops.send(
        `⚠️ Sync error for \`${item.evidenceId}\` (${item.title}): ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }

  return posted;
}
