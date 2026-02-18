import {
  type ButtonInteraction,
  type ModalSubmitInteraction,
  ModalBuilder,
  TextInputBuilder,
  TextInputStyle,
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
} from "discord.js";
import type { BotContext } from "./botContext.js";
import { upsertLibraryPost } from "./libraryPost.js";

/**
 * Parse a custom_id like "mk:label:keep:{evidence_id}" or "mk:note:{evidence_id}".
 */
type ParsedId = {
  kind: "evidence";
  action: string;
  evidenceId: string;
} | {
  kind: "profile";
  action: string;
  proposalId: string;
};

function parseCustomId(customId: string): ParsedId | null {
  const parts = customId.split(":");
  if (parts[0] !== "mk" || parts.length < 3) return null;

  // Profile proposal buttons: mk:profile:approve:{proposal_id}
  if (parts[1] === "profile" && parts.length >= 4) {
    return { kind: "profile", action: `profile.${parts[2]}`, proposalId: parts.slice(3).join(":") };
  }

  if (parts[1] === "label" && parts.length >= 4) {
    return { kind: "evidence", action: `label.${parts[2]}`, evidenceId: parts.slice(3).join(":") };
  }
  if (parts[1] === "note") {
    return { kind: "evidence", action: "note", evidenceId: parts.slice(2).join(":") };
  }
  if (parts[1] === "open") {
    return { kind: "evidence", action: "open", evidenceId: parts.slice(2).join(":") };
  }
  return null;
}

export async function handleButton(
  interaction: ButtonInteraction,
  ctx: BotContext,
): Promise<void> {
  const parsed = parseCustomId(interaction.customId);
  if (!parsed) return;

  // Dispatch profile proposal buttons
  if (parsed.kind === "profile") {
    await handleProfileButton(interaction, ctx, parsed.action, parsed.proposalId);
    return;
  }

  const { action, evidenceId } = parsed;
  const evidence = ctx.db.getEvidence(evidenceId);

  if (!evidence) {
    await interaction.reply({ content: `Evidence not found: ${evidenceId}`, ephemeral: true });
    return;
  }

  // Handle Open button
  if (action === "open") {
    const url = evidence.url ?? "(no URL)";
    await interaction.reply({ content: `🔗 ${url}`, ephemeral: true });
    return;
  }

  // Handle Note button → show modal
  if (action === "note") {
    const modal = new ModalBuilder()
      .setCustomId(`mk:note_modal:${evidenceId}`)
      .setTitle("メモ追加");

    const titleInput = new TextInputBuilder()
      .setCustomId("note_title")
      .setLabel("タイトル (任意)")
      .setStyle(TextInputStyle.Short)
      .setMaxLength(80)
      .setRequired(false);

    const bodyInput = new TextInputBuilder()
      .setCustomId("note_body")
      .setLabel("メモ")
      .setStyle(TextInputStyle.Paragraph)
      .setMaxLength(800)
      .setRequired(true);

    modal.addComponents(
      new ActionRowBuilder<TextInputBuilder>().addComponents(titleInput),
      new ActionRowBuilder<TextInputBuilder>().addComponents(bodyInput),
    );

    await interaction.showModal(modal);
    return;
  }

  // Handle label actions (keep, unsure, discard)
  if (action.startsWith("label.")) {
    // Defer immediately — library upsert involves LLM and can take >3s
    try {
      await interaction.deferReply({ ephemeral: true });
    } catch {
      // Interaction already expired; still process the label change
      console.warn(`[button] deferReply failed for ${evidenceId}, processing anyway`);
    }

    const label = action.split(".")[1]; // keep, unsure, discard
    const newState = label.toUpperCase(); // KEEP, UNSURE, DISCARD

    // Update state
    ctx.db.updateEvidenceState(evidenceId, newState);

    // Log action (once)
    ctx.db.insertAction(evidenceId, action, interaction.user.id);

    // Library upsert/delete for Keep/Unsure/Discard
    try {
      await upsertLibraryPost(ctx, evidenceId, newState);
      try {
        await interaction.editReply(`✅ **${evidence.title}** → **${newState}**`);
      } catch { /* interaction may have expired */ }
    } catch (err) {
      console.error(`[button] Library upsert error for ${evidenceId}:`, err);
      try {
        await interaction.editReply(`✅ **${evidence.title}** → **${newState}** (Library投稿にエラーあり)`);
      } catch { /* interaction may have expired */ }
      await ctx.channels.ops.send(
        `⚠️ Library upsert failed for \`${evidenceId}\`: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }
}

/**
 * Update the proposal message to show only the selected action button (disabled).
 */
async function updateProposalButtons(
  interaction: ButtonInteraction,
  result: "approved" | "rejected",
): Promise<void> {
  try {
    const label = result === "approved" ? "Approved" : "Rejected";
    const emoji = result === "approved" ? "✅" : "🗑";
    const style = result === "approved" ? ButtonStyle.Success : ButtonStyle.Danger;

    const row = new ActionRowBuilder<ButtonBuilder>().addComponents(
      new ButtonBuilder()
        .setCustomId(interaction.customId)
        .setLabel(label)
        .setEmoji(emoji)
        .setStyle(style)
        .setDisabled(true),
    );

    await interaction.message.edit({ components: [row] });
  } catch {
    // Message may have been deleted or bot lacks permission
  }
}

/**
 * Handle profile proposal buttons (Approve/Reject/Edit).
 */
async function handleProfileButton(
  interaction: ButtonInteraction,
  ctx: BotContext,
  action: string,
  proposalId: string,
): Promise<void> {
  const proposal = ctx.db.getProposal(proposalId);
  if (!proposal) {
    await interaction.reply({ content: `Proposal not found: ${proposalId}`, ephemeral: true });
    return;
  }

  if (proposal.status !== "pending") {
    await interaction.reply({ content: `Proposal already ${proposal.status}.`, ephemeral: true });
    return;
  }

  if (action === "profile.approve") {
    ctx.db.updateProposalStatus(proposalId, "approved");
    ctx.db.insertProfileVersion(proposal.new_profile_md, "approved", proposalId);
    await interaction.reply({ content: `✅ Taste Profile updated (proposal \`${proposalId}\` approved).`, ephemeral: true });
    await updateProposalButtons(interaction, "approved");
    console.log(`[learn] Proposal ${proposalId} approved`);
    return;
  }

  if (action === "profile.reject") {
    ctx.db.updateProposalStatus(proposalId, "rejected");
    await interaction.reply({ content: `🗑 Proposal \`${proposalId}\` rejected.`, ephemeral: true });
    await updateProposalButtons(interaction, "rejected");
    console.log(`[learn] Proposal ${proposalId} rejected`);
    return;
  }

  if (action === "profile.edit_modal") {
    // Show modal with the proposed profile for manual editing
    const modal = new ModalBuilder()
      .setCustomId(`mk:profile_edit_modal:${proposalId}`)
      .setTitle("Taste Profile 手動編集");

    const profileInput = new TextInputBuilder()
      .setCustomId("profile_md")
      .setLabel("Taste Profile (Markdown)")
      .setStyle(TextInputStyle.Paragraph)
      .setMaxLength(4000)
      .setRequired(true)
      .setValue(proposal.new_profile_md.slice(0, 4000));

    modal.addComponents(
      new ActionRowBuilder<TextInputBuilder>().addComponents(profileInput),
    );

    await interaction.showModal(modal);
    return;
  }
}

/**
 * Handle modal submissions (note + profile edit).
 */
export async function handleModalSubmit(
  interaction: ModalSubmitInteraction,
  ctx: BotContext,
): Promise<void> {
  // Note modal
  if (interaction.customId.startsWith("mk:note_modal:")) {
    const evidenceId = interaction.customId.replace("mk:note_modal:", "");
    const noteTitle = interaction.fields.getTextInputValue("note_title") || "";
    const noteBody = interaction.fields.getTextInputValue("note_body");

    const metadata = JSON.stringify({ title: noteTitle, body: noteBody });
    ctx.db.insertAction(evidenceId, "note", interaction.user.id, metadata);

    await interaction.reply({
      content: `📝 メモを保存しました。`,
      ephemeral: true,
    });
    return;
  }

  // Profile edit modal
  if (interaction.customId.startsWith("mk:profile_edit_modal:")) {
    const proposalId = interaction.customId.replace("mk:profile_edit_modal:", "");
    const editedProfile = interaction.fields.getTextInputValue("profile_md");

    const proposal = ctx.db.getProposal(proposalId);
    if (!proposal || proposal.status !== "pending") {
      await interaction.reply({ content: `Proposal \`${proposalId}\` is no longer pending.`, ephemeral: true });
      return;
    }

    // Approve with edited content
    ctx.db.updateProposalStatus(proposalId, "approved");
    ctx.db.insertProfileVersion(editedProfile, "edited", proposalId);

    await interaction.reply({
      content: `✅ Taste Profile updated with your edits (proposal \`${proposalId}\`).`,
      ephemeral: true,
    });

    // Update the original proposal message buttons
    if (proposal.ops_message_id) {
      try {
        const opsMsg = await ctx.channels.ops.messages.fetch(proposal.ops_message_id);
        const row = new ActionRowBuilder<ButtonBuilder>().addComponents(
          new ButtonBuilder()
            .setCustomId(`mk:profile:done:${proposalId}`)
            .setLabel("Approved (edited)")
            .setEmoji("✅")
            .setStyle(ButtonStyle.Success)
            .setDisabled(true),
        );
        await opsMsg.edit({ components: [row] });
      } catch { /* message may have been deleted */ }
    }

    console.log(`[learn] Proposal ${proposalId} approved with manual edits`);
    return;
  }
}
