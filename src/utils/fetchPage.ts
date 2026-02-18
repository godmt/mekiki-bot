/**
 * Fetch a web page and extract text content (title + body text).
 * Returns first ~3000 chars of text for LLM consumption.
 */
export async function fetchPageText(
  url: string,
  maxChars = 3000,
): Promise<{ pageTitle: string; textContent: string } | null> {
  try {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 10000);

    const res = await fetch(url, {
      signal: controller.signal,
      headers: {
        "User-Agent": "Mozilla/5.0 (compatible; MekikiBot/0.1; +https://github.com/mekiki-bot)",
        "Accept": "text/html,application/xhtml+xml,*/*",
        "Accept-Language": "ja,en;q=0.9",
      },
      redirect: "follow",
    });
    clearTimeout(timeout);

    if (!res.ok) {
      console.warn(`[fetchPage] HTTP ${res.status} for ${url}`);
      return null;
    }

    const contentType = res.headers.get("content-type") ?? "";
    if (!contentType.includes("text/html") && !contentType.includes("application/xhtml")) {
      console.warn(`[fetchPage] Non-HTML content type: ${contentType} for ${url}`);
      return null;
    }

    const html = await res.text();

    // Extract <title>
    const titleMatch = html.match(/<title[^>]*>([\s\S]*?)<\/title>/i);
    const pageTitle = titleMatch
      ? titleMatch[1].replace(/\s+/g, " ").trim()
      : "";

    // Extract og:title as fallback
    const ogTitleMatch = html.match(/<meta[^>]+property=["']og:title["'][^>]+content=["']([^"']+)["']/i)
      ?? html.match(/<meta[^>]+content=["']([^"']+)["'][^>]+property=["']og:title["']/i);
    const ogTitle = ogTitleMatch ? ogTitleMatch[1].trim() : "";

    // Extract og:description
    const ogDescMatch = html.match(/<meta[^>]+property=["']og:description["'][^>]+content=["']([^"']+)["']/i)
      ?? html.match(/<meta[^>]+content=["']([^"']+)["'][^>]+property=["']og:description["']/i);
    const ogDesc = ogDescMatch ? ogDescMatch[1].trim() : "";

    // Strip HTML tags to get body text
    const bodyMatch = html.match(/<body[^>]*>([\s\S]*)<\/body>/i);
    const bodyHtml = bodyMatch ? bodyMatch[1] : html;

    const textContent = bodyHtml
      // Remove script/style blocks
      .replace(/<script[\s\S]*?<\/script>/gi, "")
      .replace(/<style[\s\S]*?<\/style>/gi, "")
      .replace(/<nav[\s\S]*?<\/nav>/gi, "")
      .replace(/<header[\s\S]*?<\/header>/gi, "")
      .replace(/<footer[\s\S]*?<\/footer>/gi, "")
      // Remove HTML tags
      .replace(/<[^>]+>/g, " ")
      // Decode common HTML entities
      .replace(/&amp;/g, "&")
      .replace(/&lt;/g, "<")
      .replace(/&gt;/g, ">")
      .replace(/&quot;/g, '"')
      .replace(/&#39;/g, "'")
      .replace(/&nbsp;/g, " ")
      // Collapse whitespace
      .replace(/\s+/g, " ")
      .trim();

    // Combine og:description + body text, prioritizing structured data
    const combined = [ogDesc, textContent].filter(Boolean).join("\n\n");

    return {
      pageTitle: ogTitle || pageTitle,
      textContent: combined.slice(0, maxChars),
    };
  } catch (err) {
    console.warn(`[fetchPage] Failed to fetch ${url}:`, err instanceof Error ? err.message : err);
    return null;
  }
}
