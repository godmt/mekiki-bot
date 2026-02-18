import type { LlmClient } from "./client.js";
import type { RssItem } from "../rss/fetcher.js";

/** Language code → display name for prompts */
const LANG_NAMES: Record<string, string> = {
  ja: "Japanese",
  en: "English",
  zh: "Chinese",
  ko: "Korean",
};

function langName(code: string): string {
  return LANG_NAMES[code] ?? code;
}

export interface FeedCardData {
  title: string;
  one_liner: string;
  signals: string[];
  signals_inline: string;
  source_domain: string;
  source_type: string;
  published_at: string;
  evidence_id: string;
  canonical_url: string;
}

export interface LibraryPostData {
  one_liner: string;
  summary_1: string;
  summary_2: string;
  summary_3: string;
  why_1: string;
  why_2: string;
  why_3: string;
  excerpts_md: string;
  source_domain: string;
  source_type: string;
  published_at: string;
  collected_at: string;
  signals_inline: string;
  evidence_id: string;
  canonical_url: string;
  feed_message_url: string;
  actions_history_md: string;
  notes_md: string;
}

/**
 * Summarize an RSS item for the #feed-ai card.
 */
export async function summarizeFeed(
  llm: LlmClient,
  item: RssItem,
  language = "ja",
): Promise<{ title: string; one_liner: string }> {
  const lang = langName(language);
  const prompt = `You are a concise news summarizer.
Given this article, produce a JSON object with these exact keys:
- "title": A short, descriptive title in ${lang} (max 80 chars). Do NOT just copy the URL.
- "one_liner": A single-line summary in ${lang} (max 240 chars).

Return ONLY valid JSON. No explanation.

Original title: ${item.title}
URL: ${item.url}
Content snippet: ${(item.content ?? "").slice(0, 1500)}
Source: ${item.sourceDomain}`;

  const text = await llm.run("summarize_feed", prompt);
  try {
    const match = text.match(/\{[\s\S]*\}/);
    if (match) {
      const parsed = JSON.parse(match[0]);
      return {
        title: String(parsed.title ?? item.title).slice(0, 80),
        one_liner: String(parsed.one_liner ?? "").slice(0, 240),
      };
    }
  } catch {
    // fallback
  }
  return {
    title: item.title.slice(0, 80),
    one_liner: text.trim().slice(0, 240),
  };
}

/**
 * Extract signal tags from an RSS item.
 */
export async function extractSignals(
  llm: LlmClient,
  item: RssItem,
  availableSignals: string[],
): Promise<string[]> {
  const prompt = `You are a signal tagger for a tech curation bot.
Given this article, pick the most relevant signals from the list below.
Return ONLY a JSON array of signal strings (max 8). No explanation.

Available signals: ${JSON.stringify(availableSignals)}

Title: ${item.title}
URL: ${item.url}
Content snippet: ${(item.content ?? "").slice(0, 1500)}
Source: ${item.sourceDomain}
Default signals from feed config: ${JSON.stringify(item.defaultSignals)}`;

  const text = await llm.run("extract_signals", prompt);
  try {
    const match = text.match(/\[[\s\S]*?\]/);
    if (match) {
      const parsed = JSON.parse(match[0]) as string[];
      return parsed.filter((s) => availableSignals.includes(s)).slice(0, 8);
    }
  } catch {
    // fallback
  }
  return item.defaultSignals.slice(0, 8);
}

/**
 * Generate library writeup for a Keep/Unsure item.
 */
export async function libraryWriteup(
  llm: LlmClient,
  item: RssItem,
  existingSummary: string,
  language = "ja",
): Promise<{
  title: string;
  summary_1: string;
  summary_2: string;
  summary_3: string;
  why_1: string;
  why_2: string;
  why_3: string;
  excerpts_md: string;
}> {
  const lang = langName(language);
  const prompt = `You are a tech librarian writing a structured archive entry.
Given this article, produce a JSON object with these exact keys:
- title: A short descriptive title in ${lang} for a Discord forum thread (max 80 chars)
- summary_1, summary_2, summary_3: Three concise summary bullet points in ${lang}. All three MUST be filled.
- why_1, why_2, why_3: Three reasons why this might matter in ${lang}. All three MUST be filled.
- excerpts_md: Key excerpts in markdown (or empty string if none)

ALL fields are REQUIRED. Do not leave any empty.
Return ONLY valid JSON. No explanation.

Original title: ${item.title}
URL: ${item.url}
One-liner: ${existingSummary}
Content snippet: ${(item.content ?? "").slice(0, 2000)}`;

  const text = await llm.run("library_writeup", prompt);
  try {
    const match = text.match(/\{[\s\S]*\}/);
    if (match) {
      const parsed = JSON.parse(match[0]);
      return {
        title: String(parsed.title ?? item.title).slice(0, 80),
        summary_1: String(parsed.summary_1 ?? existingSummary),
        summary_2: String(parsed.summary_2 ?? ""),
        summary_3: String(parsed.summary_3 ?? ""),
        why_1: String(parsed.why_1 ?? ""),
        why_2: String(parsed.why_2 ?? ""),
        why_3: String(parsed.why_3 ?? ""),
        excerpts_md: String(parsed.excerpts_md ?? ""),
      };
    }
  } catch {
    // fallback
  }
  return {
    title: item.title.slice(0, 80),
    summary_1: existingSummary,
    summary_2: "",
    summary_3: "",
    why_1: "",
    why_2: "",
    why_3: "",
    excerpts_md: "",
  };
}
