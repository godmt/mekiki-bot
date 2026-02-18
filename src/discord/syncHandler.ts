import type { BotContext } from "./botContext.js";
import { fetchAllSources, type FetchOptions } from "../rss/fetcher.js";
import { createLlmClient } from "../llm/client.js";
import { summarizeFeed, extractSignals, type FeedCardData } from "../llm/tasks.js";
import { postFeedCard } from "./feedCard.js";
import { runServingPipeline, type ServingResult } from "../serving/servingPipeline.js";

let syncRunning = false;

/** Check if a sync is currently running (used by scheduler) */
export function isSyncRunning(): boolean {
  return syncRunning;
}

/**
 * Run full sync: fetch RSS → ingest to DB → run serving pipeline → post selected to #feed-ai.
 * Returns count of new items posted.
 */
export async function runSync(ctx: BotContext, fetchOpts?: FetchOptions): Promise<number> {
  if (syncRunning) {
    throw new Error("Sync is already running.");
  }
  syncRunning = true;
  try {
    return await runSyncInner(ctx, fetchOpts);
  } finally {
    syncRunning = false;
  }
}

async function runSyncInner(ctx: BotContext, fetchOpts?: FetchOptions): Promise<number> {
  // Phase 1: Fetch RSS and ingest all new items into DB (with LLM summarize/signals)
  const items = await fetchAllSources(ctx.db, ctx.spec, fetchOpts);
  const llm = createLlmClient(ctx.spec);
  const signals = ctx.spec.signals.signals;
  const maxSignals = ((ctx.spec.posting as { feed_card_max_signals?: number }).feed_card_max_signals) ?? 8;
  const language = (ctx.spec.llmConfig as { language?: string }).language ?? "ja";

  let ingested = 0;
  for (const item of items) {
    try {
      const [summary, itemSignals] = await Promise.all([
        summarizeFeed(llm, item, language),
        extractSignals(llm, item, signals),
      ]);

      const displaySignals = itemSignals.slice(0, maxSignals);
      const displayTitle = summary.title || item.title;

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
      ingested++;
    } catch (err) {
      console.error(`[sync] Error ingesting ${item.evidenceId}:`, err);
    }
  }

  console.log(`[sync] Ingested ${ingested} new RSS items into DB`);

  // Phase 2: Run serving pipeline (candidate selection)
  // Always run even if no new items — there may be un-posted candidates from previous ingests
  let result: ServingResult;
  try {
    result = await runServingPipeline(ctx);
  } catch (err) {
    console.error("[sync] Serving pipeline error:", err);
    await ctx.channels.ops.send(
      `⚠️ Serving pipeline error: ${err instanceof Error ? err.message : String(err)}`,
    );
    return 0;
  }

  // Log selection summary to ops
  const policyLog = ctx.spec.servingPolicy as { logging?: { explain_in_ops?: boolean; explain_max_lines?: number } };
  if (policyLog.logging?.explain_in_ops && result.selected.length > 0) {
    const lines: string[] = [
      `📊 **Serving Report** — candidates: ${result.totalCandidates}, LLM judged: ${result.llmJudged}, cached: ${result.cached}, skipped: ${result.skipped}`,
      `Selected **${result.selected.length}** items:`,
    ];
    const maxLines = policyLog.logging.explain_max_lines ?? 20;
    for (const sel of result.selected.slice(0, maxLines - 2)) {
      const flags = [
        sel.flags.explore ? "🔍explore" : "",
        sel.flags.portfolio_fill ? "📊portfolio" : "",
      ].filter(Boolean).join(" ");
      lines.push(
        `• \`${sel.evidence.evidence_id}\` — ${sel.evidence.title.slice(0, 60)} | ${sel.selectionReason} ${flags}`,
      );
    }
    try {
      await ctx.channels.ops.send(lines.join("\n").slice(0, 2000));
    } catch (err) {
      console.error("[sync] Failed to send ops report:", err);
    }
  }

  // Phase 3: Post selected items to #feed-ai
  console.log(`[sync] Phase 3: posting ${result.selected.length} items to #feed-ai`);
  let posted = 0;
  for (const sel of result.selected) {
    try {
      const rawData = sel.rawData;
      let parsedSignals: string[] = [];
      try {
        parsedSignals = rawData.signals ? JSON.parse(rawData.signals) : [];
      } catch { /* empty */ }

      const cardData: FeedCardData = {
        title: sel.evidence.title,
        one_liner: rawData.one_liner ?? "",
        signals: parsedSignals,
        signals_inline: rawData.signals_inline ?? "",
        source_domain: rawData.source_domain ?? "",
        source_type: sel.evidence.source_type,
        published_at: rawData.published_at ?? sel.evidence.created_at,
        evidence_id: sel.evidence.evidence_id,
        canonical_url: sel.evidence.url ?? "",
      };

      console.log(`[sync] Posting ${sel.evidence.evidence_id}: ${sel.evidence.title.slice(0, 50)}`);
      const msg = await postFeedCard(ctx.channels.feedAi, ctx.spec, cardData);
      ctx.db.updateEvidenceFeedMsg(sel.evidence.evidence_id, msg.id);
      posted++;
      console.log(`[sync] Posted ${posted}/${result.selected.length}`);

      // Brief delay to avoid rate limiting
      if (posted < result.selected.length) {
        await new Promise((r) => setTimeout(r, 1000));
      }
    } catch (err) {
      console.error(`[sync] Error posting ${sel.evidence.evidence_id}:`, err);
      try {
        await ctx.channels.ops.send(
          `⚠️ Post error for \`${sel.evidence.evidence_id}\`: ${err instanceof Error ? err.message : String(err)}`,
        );
      } catch { /* ignore ops send failure */ }
    }
  }

  console.log(`[sync] Complete: ${posted} items posted to #feed-ai`);
  return posted;
}
