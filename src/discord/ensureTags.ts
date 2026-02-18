import type { ForumChannel } from "discord.js";
import type { MekikiSpec } from "../config/specLoader.js";

interface ForumTagDef {
  key: string;
  label: string;
}

/**
 * Ensure all tags from spec/forum/forum_tags.yaml exist on the Discord Forum channel.
 * Creates missing tags. Requires "Manage Channels" permission.
 */
export async function ensureForumTags(
  forum: ForumChannel,
  spec: MekikiSpec,
): Promise<void> {
  const tagDefs = (spec.forumTags as unknown as { tags: ForumTagDef[] }).tags;
  const existing = forum.availableTags;

  const missing = tagDefs.filter(
    (def) => !existing.some((t) => t.name === def.label),
  );

  if (missing.length === 0) {
    console.log(`[tags] All ${tagDefs.length} forum tags already exist.`);
    return;
  }

  console.log(`[tags] Creating ${missing.length} missing forum tags...`);

  const newTags = [
    ...existing.map((t) => ({ name: t.name, emoji: t.emoji, moderated: t.moderated })),
    ...missing.map((def) => ({ name: def.label })),
  ];

  // Discord allows max 20 tags per forum
  await forum.setAvailableTags(newTags.slice(0, 20));

  console.log(`[tags] Forum tags updated. Total: ${Math.min(newTags.length, 20)}`);
}
