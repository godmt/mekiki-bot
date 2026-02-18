import { createHash } from "node:crypto";
import RssParser from "rss-parser";
import type { MekikiDb } from "../db/database.js";
import type { MekikiSpec } from "../config/specLoader.js";

const parser = new RssParser();

export interface RssItem {
  evidenceId: string;
  title: string;
  url: string;
  publishedAt: string;
  sourceId: string;
  sourceDomain: string;
  defaultSignals: string[];
  content?: string;
}

function urlHash(url: string): string {
  return createHash("sha256").update(url).digest("hex").slice(0, 16);
}

function evidenceId(sourceId: string, url: string): string {
  const hash = urlHash(url);
  return `${sourceId}:${hash}`;
}

function domainOf(url: string): string {
  try {
    return new URL(url).hostname;
  } catch {
    return "unknown";
  }
}

interface RssSourceConfig {
  id: string;
  title: string;
  feed_url: string;
  enabled: boolean;
  default_signals?: string[];
  grace_hours?: number;
  max_catchup_days?: number;
}

export interface FetchOptions {
  maxSources?: number;
  maxItemsPerSource?: number;
}

/**
 * Fetch RSS for all enabled sources, respecting cursor/grace/dedupe.
 * Returns new (unseen) items.
 */
export async function fetchAllSources(
  db: MekikiDb,
  spec: MekikiSpec,
  opts?: FetchOptions,
): Promise<RssItem[]> {
  const sources = spec.rssSources.sources as unknown as RssSourceConfig[];
  const runtime = spec.runtime as { grace_hours_default: number; max_catchup_days_default: number };
  const allItems: RssItem[] = [];
  let sourceCount = 0;

  for (const source of sources) {
    if (!source.enabled) continue;
    if (opts?.maxSources && sourceCount >= opts.maxSources) break;
    sourceCount++;

    try {
      let items = await fetchSource(db, source, runtime);
      if (opts?.maxItemsPerSource) {
        items = items.slice(0, opts.maxItemsPerSource);
      }
      allItems.push(...items);
    } catch (err) {
      console.error(`[rss] Error fetching ${source.id}:`, err instanceof Error ? err.message : err);
    }
  }

  return allItems;
}

async function fetchSource(
  db: MekikiDb,
  source: RssSourceConfig,
  runtime: { grace_hours_default: number; max_catchup_days_default: number },
): Promise<RssItem[]> {
  const graceHours = source.grace_hours ?? runtime.grace_hours_default;
  const maxCatchupDays = source.max_catchup_days ?? runtime.max_catchup_days_default;

  // Determine "since" cutoff
  const cursorRow = db.getCursor(source.id);
  const now = new Date();
  let since: Date;

  if (cursorRow) {
    // since = last_fetch_at - grace
    const lastFetch = new Date(cursorRow.last_fetch_at);
    since = new Date(lastFetch.getTime() - graceHours * 60 * 60 * 1000);
  } else {
    // First fetch: go back max_catchup_days
    since = new Date(now.getTime() - maxCatchupDays * 24 * 60 * 60 * 1000);
  }

  // Hard floor: never go further back than max_catchup_days
  const floor = new Date(now.getTime() - maxCatchupDays * 24 * 60 * 60 * 1000);
  if (since < floor) since = floor;

  console.log(`[rss] Fetching ${source.id} since ${since.toISOString()}`);

  const feed = await parser.parseURL(source.feed_url);
  const newItems: RssItem[] = [];

  for (const entry of feed.items) {
    const itemUrl = entry.link;
    if (!itemUrl) continue;

    const pubDate = entry.pubDate ? new Date(entry.pubDate) : now;
    if (pubDate < since) continue;

    const hash = urlHash(itemUrl);

    // Dedupe check
    if (db.isSeen(hash)) continue;

    const eid = evidenceId(source.id, itemUrl);
    db.insertSeen(eid, hash);

    newItems.push({
      evidenceId: eid,
      title: entry.title ?? "(no title)",
      url: itemUrl,
      publishedAt: pubDate.toISOString(),
      sourceId: source.id,
      sourceDomain: domainOf(source.feed_url),
      defaultSignals: source.default_signals ?? [],
      content: entry.contentSnippet ?? entry.content ?? undefined,
    });
  }

  // Update cursor
  db.upsertCursor(source.id, now.toISOString());

  console.log(`[rss] ${source.id}: ${newItems.length} new items (of ${feed.items.length} total)`);
  return newItems;
}
