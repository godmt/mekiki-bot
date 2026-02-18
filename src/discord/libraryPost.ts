import type { ForumChannel, ThreadChannel } from "discord.js";
import { renderTemplate } from "../templates/renderer.js";
import { libraryWriteup } from "../llm/tasks.js";
import { createLlmClient } from "../llm/client.js";
import type { BotContext } from "./botContext.js";

interface TagMapConfig {
  map: Record<string, string[]>;
  defaults: { unsure_tag_key: string; discard_tag_key: string };
}

interface ForumTagConfig {
  tags: Array<{ key: string; label: string }>;
}

/**
 * Resolve Discord forum tag IDs from signal tag keys.
 */
function resolveTagIds(
  forum: ForumChannel,
  tagKeys: string[],
  forumTags: ForumTagConfig,
): string[] {
  const ids: string[] = [];
  for (const key of tagKeys) {
    const tagDef = forumTags.tags.find((t) => t.key === key);
    if (!tagDef) continue;
    // Match by label in the actual Discord forum tags
    const discordTag = forum.availableTags.find((t) => t.name === tagDef.label);
    if (discordTag) ids.push(discordTag.id);
  }
  return ids;
}

/**
 * Map signals to tag keys via tag_map.yaml.
 */
function signalsToTagKeys(signals: string[], tagMap: TagMapConfig): string[] {
  const keys = new Set<string>();
  for (const signal of signals) {
    const mapped = tagMap.map[signal];
    if (mapped) mapped.forEach((k) => keys.add(k));
  }
  return [...keys];
}

/**
 * Upsert or mark a library Forum post based on state.
 */
export async function upsertLibraryPost(
  ctx: BotContext,
  evidenceId: string,
  state: string,
): Promise<void> {
  const evidence = ctx.db.getEvidence(evidenceId);
  if (!evidence) return;

  const forum = ctx.channels.libraryForum;
  const tagMap = ctx.spec.tagMap as unknown as TagMapConfig;
  const forumTags = ctx.spec.forumTags as unknown as ForumTagConfig;
  // Parse stored raw_json to get signals and item data
  let rawData: Record<string, string> = {};
  if (evidence.raw_json) {
    try {
      rawData = JSON.parse(evidence.raw_json);
    } catch { /* ignore */ }
  }

  const signals = rawData.signals ? JSON.parse(rawData.signals) as string[] : [];

  // Determine tag keys from signals
  const tagKeys = signalsToTagKeys(signals, tagMap);

  if (state === "DISCARD") {
    // Delete the library thread if it exists (DB record is retained)
    if (evidence.library_thread_id) {
      try {
        const thread = await forum.threads.fetch(evidence.library_thread_id) as ThreadChannel | null;
        if (thread) {
          await thread.delete(`Discarded by user`);
          ctx.db.updateEvidenceLibraryThread(evidenceId, "");
          console.log(`[library] Deleted thread for discarded ${evidenceId}`);
        }
      } catch (err) {
        console.error(`[library] Failed to delete thread for ${evidenceId}:`, err);
      }
    }
    return;
  }

  // KEEP or UNSURE → upsert
  if (state !== "KEEP" && state !== "UNSURE") return;

  // Add UNSURE tag if state is UNSURE
  if (state === "UNSURE") {
    tagKeys.push(tagMap.defaults.unsure_tag_key);
  }

  const tagIds = resolveTagIds(forum, tagKeys, forumTags);

  // Build actions history
  const actions = ctx.db.getActions(evidenceId);
  const actionsHistoryMd = actions.length > 0
    ? actions.map((a) => `- ${a.created_at} | ${a.action} | <@${a.actor}>`).join("\n")
    : "(none)";

  // Build notes
  const notes = actions.filter((a) => a.action === "note");
  const notesMd = notes.length > 0
    ? notes.map((n) => {
        const meta = n.metadata ? JSON.parse(n.metadata) : {};
        return `### ${meta.title || "Note"}\n${meta.body || ""}`;
      }).join("\n\n")
    : "(none)";

  // Get feed message URL
  const feedMsgUrl = evidence.feed_message_id
    ? `https://discord.com/channels/${ctx.channels.feedAi.guildId}/${ctx.channels.feedAi.id}/${evidence.feed_message_id}`
    : "(not posted)";

  // Generate library writeup via LLM (or use stored data)
  let writeupData = {
    title: evidence.title,
    summary_1: rawData.one_liner || evidence.title,
    summary_2: "",
    summary_3: "",
    why_1: "",
    why_2: "",
    why_3: "",
    excerpts_md: "",
  };

  try {
    const llm = createLlmClient(ctx.spec);
    const language = (ctx.spec.llmConfig as { language?: string }).language ?? "ja";
    writeupData = await libraryWriteup(llm, {
      evidenceId: evidence.evidence_id,
      title: evidence.title,
      url: evidence.url ?? "",
      publishedAt: rawData.published_at || evidence.created_at,
      sourceId: evidence.source_id ?? "",
      sourceDomain: rawData.source_domain || "",
      defaultSignals: signals,
      content: rawData.content,
    }, rawData.one_liner || evidence.title, language);
  } catch (err) {
    console.error(`[library] LLM writeup failed for ${evidenceId}:`, err);
  }

  // Use LLM-generated title for the forum thread
  const threadTitle = writeupData.title || evidence.title;

  const content = renderTemplate(ctx.spec.templates.libraryPost, {
    one_liner: rawData.one_liner || evidence.title,
    summary_1: writeupData.summary_1,
    summary_2: writeupData.summary_2,
    summary_3: writeupData.summary_3,
    why_1: writeupData.why_1,
    why_2: writeupData.why_2,
    why_3: writeupData.why_3,
    excerpts_md: writeupData.excerpts_md,
    source_domain: rawData.source_domain || "",
    source_type: evidence.source_type,
    published_at: rawData.published_at || evidence.created_at,
    collected_at: evidence.created_at,
    signals_inline: rawData.signals_inline || signals.join(" "),
    evidence_id: evidence.evidence_id,
    canonical_url: evidence.url ?? "",
    feed_message_url: feedMsgUrl,
    actions_history_md: actionsHistoryMd,
    notes_md: notesMd,
  });

  // Upsert: update existing thread or create new one
  if (evidence.library_thread_id) {
    try {
      const thread = await forum.threads.fetch(evidence.library_thread_id) as ThreadChannel | null;
      if (thread) {
        // Update thread title and tags
        await thread.edit({
          name: threadTitle.slice(0, 100),
          appliedTags: tagIds.slice(0, 5),
        });
        // Update the starter message content
        const starterMsg = await thread.fetchStarterMessage();
        if (starterMsg) {
          await starterMsg.edit({ content });
        }
        return;
      }
    } catch {
      // Thread not found, create new one
    }
  }

  // Create new forum thread
  const thread = await forum.threads.create({
    name: evidence.title.slice(0, 100),
    message: { content },
    appliedTags: tagIds.slice(0, 5),
  });

  ctx.db.updateEvidenceLibraryThread(evidenceId, thread.id);
}
