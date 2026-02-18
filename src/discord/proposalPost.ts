import {
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
} from "discord.js";
import type { BotContext } from "./botContext.js";

interface RenderingConfig {
  show_diff_summary_lines: number;
  show_profile_preview_chars: number;
}

/**
 * Post a taste-profile proposal to the ops channel with Approve/Reject/Edit buttons.
 */
export async function postProposal(
  ctx: BotContext,
  proposalId: string,
): Promise<void> {
  const proposal = ctx.db.getProposal(proposalId);
  if (!proposal) throw new Error(`Proposal not found: ${proposalId}`);

  const config = ctx.spec.profileUpdateConfig as unknown as {
    rendering: RenderingConfig;
  };
  const rendering = config.rendering;

  // Parse diff_summary and risks from JSON strings
  let diffLines: string[];
  let risks: string[];
  try {
    diffLines = JSON.parse(proposal.diff_summary) as string[];
  } catch {
    diffLines = [proposal.diff_summary];
  }
  try {
    risks = JSON.parse(proposal.risks) as string[];
  } catch {
    risks = [proposal.risks];
  }

  // Build message content
  const diffText = diffLines
    .slice(0, rendering.show_diff_summary_lines)
    .map((line) => `- ${line}`)
    .join("\n");

  const risksText = risks.length > 0
    ? risks.map((r) => `- ${r}`).join("\n")
    : "- (none)";

  const profilePreview = proposal.new_profile_md.slice(
    0,
    rendering.show_profile_preview_chars,
  );

  const content = [
    `🧠 **Taste Profile Proposal** \`${proposalId}\``,
    `Confidence: **${(proposal.confidence * 100).toFixed(0)}%**`,
    "",
    "**Changes:**",
    diffText,
    "",
    "**Risks:**",
    risksText,
    "",
    "**Preview:**",
    "```md",
    profilePreview,
    "```",
  ].join("\n");

  // Truncate to Discord limit
  const truncated = content.slice(0, 1950);

  // Build buttons from components.yaml
  const buttons = (ctx.spec.components as {
    profile_proposal: { buttons: Array<{ key: string; label: string; emoji: string; custom_id: string }> };
  }).profile_proposal.buttons;

  const row = new ActionRowBuilder<ButtonBuilder>();
  for (const btn of buttons) {
    const customId = btn.custom_id.replace("{proposal_id}", proposalId);
    const style = btn.key === "APPROVE_PROFILE"
      ? ButtonStyle.Success
      : btn.key === "REJECT_PROFILE"
        ? ButtonStyle.Danger
        : ButtonStyle.Secondary;

    row.addComponents(
      new ButtonBuilder()
        .setCustomId(customId)
        .setLabel(btn.label)
        .setEmoji(btn.emoji)
        .setStyle(style),
    );
  }

  const msg = await ctx.channels.ops.send({
    content: truncated,
    components: [row],
  });

  // Store the ops message ID on the proposal
  ctx.db.updateProposalStatus(proposalId, "pending", msg.id);

  console.log(`[learn] Proposal ${proposalId} posted to #ops (msg: ${msg.id})`);
}
