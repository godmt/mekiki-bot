import {
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  type TextChannel,
  type Message,
} from "discord.js";
import { renderTemplate } from "../templates/renderer.js";
import type { FeedCardData } from "../llm/tasks.js";
import type { MekikiSpec } from "../config/specLoader.js";

interface ButtonDef {
  id: string;
  label: string;
  emoji: string;
  custom_id: string;
  style?: string;
}

/**
 * Build action row buttons from components.yaml spec.
 */
function buildButtons(
  spec: MekikiSpec,
  evidenceId: string,
): ActionRowBuilder<ButtonBuilder>[] {
  const components = spec.components as {
    feed_actions: { buttons: ButtonDef[] };
  };
  const buttons = components.feed_actions.buttons;

  const row = new ActionRowBuilder<ButtonBuilder>();

  for (const btn of buttons) {
    const customId = btn.custom_id.replace("{evidence_id}", evidenceId);
    let style = ButtonStyle.Secondary;
    if (btn.id === "KEEP") style = ButtonStyle.Success;
    else if (btn.id === "DISCARD") style = ButtonStyle.Danger;
    else if (btn.id === "OPEN") style = ButtonStyle.Link;

    // OPEN button is a link button → needs url, not custom_id
    // But we don't have the URL at button-build time in the component spec,
    // so OPEN uses a regular button that will reply with the URL.
    if (btn.id === "OPEN") {
      // Use Secondary style instead of Link (Link requires URL, not custom_id)
      style = ButtonStyle.Secondary;
    }

    row.addComponents(
      new ButtonBuilder()
        .setCustomId(customId)
        .setLabel(btn.label)
        .setEmoji(btn.emoji)
        .setStyle(style),
    );
  }

  return [row];
}

/**
 * Post a feed card to #feed-ai with buttons.
 */
export async function postFeedCard(
  channel: TextChannel,
  spec: MekikiSpec,
  data: FeedCardData,
): Promise<Message> {
  const content = renderTemplate(spec.templates.feedCard, {
    title: data.title,
    one_liner: data.one_liner,
    signals_inline: data.signals_inline,
    source_domain: data.source_domain,
    source_type: data.source_type,
    published_at: data.published_at,
    evidence_id: data.evidence_id,
    canonical_url: data.canonical_url,
  });

  const components = buildButtons(spec, data.evidence_id);

  return channel.send({ content, components });
}
