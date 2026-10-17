
const {
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  ChannelType,
  EmbedBuilder,
  ModalBuilder,
  PermissionFlagsBits,
  StringSelectMenuBuilder,
  TextInputBuilder,
  TextInputStyle,
  AttachmentBuilder,
  MessageFlags,
} = require("discord.js");

const fs = require("node:fs");
const path = require("node:path");

// ==================== CONFIGURATION ====================

const PANEL_CHANNEL_ID = "1560338921173553203";
const TRANSCRIPT_CHANNEL_ID = "1561036169649848470";

const STAFF_ROLE_IDS = [
  "1559581706929840198",
  "1559581789306228736",
  "1559581840908484608",
  "1559581895531044945",
  "1559581952103813270",
  "1559582187869704233",
  "1559582256731922562",
  "1559582345907142857",
];

const EXTRA_STAFF_ROLE_ID = "1559585704177049600";

const TICKET_CATEGORIES = {
  general_support: {
    label: "General Support",
    description: "Get help with a question or problem.",
    emoji: "🛟",
  },
  customer_service: {
    label: "Customer Service",
    description: "Help with a service-related issue.",
    emoji: "💬",
  },
  business_inquiry: {
    label: "Business Inquiry",
    description: "Discuss a business-related matter.",
    emoji: "💼",
  },
  partnership_proposition: {
    label: "Partnership Proposition",
    description: "Propose a partnership with us.",
    emoji: "🤝",
  },
};

const PRIORITIES = ["Low", "Standard", "High"];
const MAX_OPEN_TICKETS = 3;
const STAFF_REMINDER_DELAY = 10 * 60 * 1000;
const DELETE_DELAY = 5 * 1000;

const DATA_DIR = path.join(__dirname, "..", "data");
const DATA_FILE = path.join(DATA_DIR, "tickets.json");

// ==================== PERSISTENT DATA ====================

if (!fs.existsSync(DATA_DIR)) {
  fs.mkdirSync(DATA_DIR, { recursive: true });
}

function loadData() {
  try {
    if (fs.existsSync(DATA_FILE)) {
      const parsed = JSON.parse(fs.readFileSync(DATA_FILE, "utf8"));

      return {
        panelMessageId: parsed.panelMessageId || null,
        tickets:
          parsed.tickets && typeof parsed.tickets === "object"
            ? parsed.tickets
            : {},
      };
    }
  } catch (error) {
    console.error("[Tickets] Could not read tickets.json:", error);
  }

  return { panelMessageId: null, tickets: {} };
}

const data = loadData();

function saveData() {
  try {
    fs.writeFileSync(DATA_FILE, JSON.stringify(data, null, 2));
  } catch (error) {
    console.error("[Tickets] Could not save tickets.json:", error);
  }
}

// ==================== HELPERS ====================

function isTicketStaff(member, categoryKey) {
  if (!member?.roles?.cache) return false;

  const hasStandardStaffRole = STAFF_ROLE_IDS.some((roleId) =>
    member.roles.cache.has(roleId)
  );

  if (categoryKey === "partnership_proposition") {
    return hasStandardStaffRole;
  }

  return (
    hasStandardStaffRole ||
    member.roles.cache.has(EXTRA_STAFF_ROLE_ID)
  );
}

function canAccessCategory(roleId, categoryKey) {
  if (STAFF_ROLE_IDS.includes(roleId)) return true;

  return (
    roleId === EXTRA_STAFF_ROLE_ID &&
    categoryKey !== "partnership_proposition"
  );
}

function getOpenTicketsForUser(userId) {
  return Object.values(data.tickets).filter(
    (ticket) => ticket.userId === userId && !ticket.closed
  );
}

function createTicketPanelEmbed() {
  return new EmbedBuilder()
    .setColor(0xf28c28)
    .setTitle("ZexverAI Support Center")
    .setDescription(
      [
        "Welcome to the ZexverAI Support Center.",
        "",
        "Select a category from the menu below to create a private ticket.",
        "Please choose the category that best matches your request.",
        "",
        "**Available categories:**",
        "🛟 General Support",
        "💬 Customer Service",
        "💼 Business Inquiry",
        "🤝 Partnership Proposition",
        "",
        "You can have up to 3 open tickets at a time.",
      ].join("\n")
    )
    .setFooter({ text: "ZexverAI Support System" });
}

function createTicketPanelComponents() {
  const menu = new StringSelectMenuBuilder()
    .setCustomId("ticket_category_select")
    .setPlaceholder("Select a ticket category...")
    .setMinValues(1)
    .setMaxValues(1)
    .addOptions(
      Object.entries(TICKET_CATEGORIES).map(([value, category]) => ({
        label: category.label,
        description: category.description,
        value,
        emoji: category.emoji,
      }))
    );

  return [new ActionRowBuilder().addComponents(menu)];
}

function createTicketControls(ticket) {
  const claimButton = new ButtonBuilder()
    .setCustomId(`ticket_claim:${ticket.channelId}`)
    .setLabel(ticket.claimedBy ? "Ticket Claimed" : "Claim")
    .setStyle(ticket.claimedBy ? ButtonStyle.Secondary : ButtonStyle.Success)
    .setDisabled(Boolean(ticket.claimedBy));

  const closeButton = new ButtonBuilder()
    .setCustomId(`ticket_close:${ticket.channelId}`)
    .setLabel("Close")
    .setStyle(ButtonStyle.Danger);

  const priorityMenu = new StringSelectMenuBuilder()
    .setCustomId(`ticket_priority:${ticket.channelId}`)
    .setPlaceholder(`Priority: ${ticket.priority}`)
    .setMinValues(1)
    .setMaxValues(1)
    .addOptions(
      PRIORITIES.map((priority) => ({
        label: priority,
        value: priority.toLowerCase(),
        default: ticket.priority.toLowerCase() === priority.toLowerCase(),
      }))
    );

  return [
    new ActionRowBuilder().addComponents(claimButton, closeButton),
    new ActionRowBuilder().addComponents(priorityMenu),
  ];
}

function createTicketEmbed(ticket) {
  const category = TICKET_CATEGORIES[ticket.categoryKey];

  return new EmbedBuilder()
    .setColor(0xf28c28)
    .setTitle("Support Ticket")
    .setDescription(
      [
        `**Ticket ID:** \`${ticket.channelId}\``,
        `**Category:** ${category.label}`,
        `**Created by:** <@${ticket.userId}>`,
        `**Priority:** ${ticket.priority}`,
        `**Claimed by:** ${
          ticket.claimedBy ? `<@${ticket.claimedBy}>` : "Not claimed"
        }`,
        "",
        "Please describe your request in this channel.",
        "A member of our staff team will respond as soon as possible.",
      ].join("\n")
    )
    .setTimestamp(new Date(ticket.createdAt))
    .setFooter({ text: "ZexverAI Ticket System" });
}

function getStaffRoleOverwrites(categoryKey) {
  const overwrites = [];

  for (const roleId of STAFF_ROLE_IDS) {
    overwrites.push({
      id: roleId,
      allow: [
        PermissionFlagsBits.ViewChannel,
        PermissionFlagsBits.SendMessages,
        PermissionFlagsBits.ReadMessageHistory,
        PermissionFlagsBits.AttachFiles,
        PermissionFlagsBits.EmbedLinks,
      ],
    });
  }

  if (categoryKey !== "partnership_proposition") {
    overwrites.push({
      id: EXTRA_STAFF_ROLE_ID,
      allow: [
        PermissionFlagsBits.ViewChannel,
        PermissionFlagsBits.SendMessages,
        PermissionFlagsBits.ReadMessageHistory,
        PermissionFlagsBits.AttachFiles,
        PermissionFlagsBits.EmbedLinks,
      ],
    });
  }

  return overwrites;
}

async function replyEphemeral(interaction, content) {
  if (interaction.deferred || interaction.replied) {
    return interaction.followUp({
      content,
      flags: MessageFlags.Ephemeral,
    });
  }

  return interaction.reply({
    content,
    flags: MessageFlags.Ephemeral,
  });
}

// ==================== PANEL SETUP ====================

async function ensureTicketPanel(client) {
  const panelChannel = await client.channels
    .fetch(PANEL_CHANNEL_ID)
    .catch(() => null);

  if (!panelChannel || !panelChannel.isTextBased()) {
    console.error(
      `[Tickets] Panel channel ${PANEL_CHANNEL_ID} was not found or is not a text channel.`
    );
    return;
  }

  let panelMessage = null;

  if (data.panelMessageId) {
    panelMessage = await panelChannel.messages
      .fetch(data.panelMessageId)
      .catch(() => null);
  }

  const payload = {
    embeds: [createTicketPanelEmbed()],
    components: createTicketPanelComponents(),
  };

  if (panelMessage) {
    await panelMessage.edit(payload);
  } else {
    panelMessage = await panelChannel.send(payload);
    data.panelMessageId = panelMessage.id;
    saveData();
  }

  console.log("[Tickets] Ticket panel is ready.");
}

// ==================== CREATE TICKET ====================

async function createTicket(interaction, categoryKey) {
  const category = TICKET_CATEGORIES[categoryKey];

  if (!category) {
    return replyEphemeral(interaction, "That ticket category is invalid.");
  }

  const openTickets = getOpenTicketsForUser(interaction.user.id);

  if (openTickets.length >= MAX_OPEN_TICKETS) {
    return replyEphemeral(
      interaction,
      `You already have ${MAX_OPEN_TICKETS} open tickets. Close an existing ticket before creating another one.`
    );
  }

  const guild = interaction.guild;

  if (!guild) {
    return replyEphemeral(interaction, "Tickets can only be created in a server.");
  }

  await interaction.deferReply({ flags: MessageFlags.Ephemeral });

  const safeUsername = interaction.user.username
    .toLowerCase()
    .replace(/[^a-z0-9-]/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-|-$/g, "")
    .slice(0, 40) || "user";

  const channelName = `ticket-${safeUsername}`.slice(0, 90);

  const permissionOverwrites = [
    {
      id: guild.roles.everyone.id,
      deny: [PermissionFlagsBits.ViewChannel],
    },
    {
      id: interaction.user.id,
      allow: [
        PermissionFlagsBits.ViewChannel,
        PermissionFlagsBits.SendMessages,
        PermissionFlagsBits.ReadMessageHistory,
        PermissionFlagsBits.AttachFiles,
        PermissionFlagsBits.EmbedLinks,
      ],
    },
    {
      id: interaction.client.user.id,
      allow: [
        PermissionFlagsBits.ViewChannel,
        PermissionFlagsBits.SendMessages,
        PermissionFlagsBits.ReadMessageHistory,
        PermissionFlagsBits.ManageChannels,
        PermissionFlagsBits.AttachFiles,
        PermissionFlagsBits.EmbedLinks,
      ],
    },
    ...getStaffRoleOverwrites(categoryKey),
  ];

  let ticketChannel;

  try {
    ticketChannel = await guild.channels.create({
      name: channelName,
      type: ChannelType.GuildText,
      topic: `ZexverAI ticket | User: ${interaction.user.id} | Category: ${category.label}`,
      permissionOverwrites,
      reason: `Support ticket created by ${interaction.user.tag}`,
    });
  } catch (error) {
    console.error("[Tickets] Could not create ticket channel:", error);

    return interaction.editReply({
      content:
        "I couldn't create your ticket. Please contact a server administrator.",
    });
  }

  const ticket = {
    channelId: ticketChannel.id,
    guildId: guild.id,
    userId: interaction.user.id,
    username: interaction.user.tag,
    categoryKey,
    priority: "Standard",
    claimedBy: null,
    claimedByTag: null,
    createdAt: Date.now(),
    closed: false,
    reminderSent: false,
    staffResponded: false,
  };

  data.tickets[ticketChannel.id] = ticket;
  saveData();

  try {
    await ticketChannel.send({
      content: `<@${interaction.user.id}>`,
      embeds: [createTicketEmbed(ticket)],
      components: createTicketControls(ticket),
      allowedMentions: { users: [interaction.user.id] },
    });
  } catch (error) {
    console.error("[Tickets] Could not send the ticket panel:", error);
  }

  await interaction.editReply({
    content: `Your ticket has been created successfully: ${ticketChannel}`,
  });

  console.log(
    `[Tickets] Created ${ticketChannel.name} for ${interaction.user.tag}`
  );
}

// ==================== CLAIM TICKET ====================

async function claimTicket(interaction, channelId) {
  const ticket = data.tickets[channelId];

  if (!ticket || ticket.closed) {
    return replyEphemeral(interaction, "This ticket is no longer open.");
  }

  if (!isTicketStaff(interaction.member, ticket.categoryKey)) {
    return replyEphemeral(
      interaction,
      "You do not have permission to claim this ticket."
    );
  }

  if (ticket.claimedBy) {
    return replyEphemeral(
      interaction,
      `This ticket has been claimed by <@${ticket.claimedBy}>.`
    );
  }

  ticket.claimedBy = interaction.user.id;
  ticket.claimedByTag = interaction.user.tag;
  saveData();

  await interaction.message.edit({
    embeds: [createTicketEmbed(ticket)],
    components: createTicketControls(ticket),
  });

  await replyEphemeral(
    interaction,
    `You have successfully claimed ticket \`${channelId}\`.`
  );

  const channel = interaction.channel;

  if (channel?.isTextBased()) {
    await channel.send({
      content: `This ticket has been claimed by <@${interaction.user.id}>.`,
      allowedMentions: { users: [interaction.user.id] },
    });
  }
}

// ==================== CHANGE PRIORITY ====================

async function changePriority(interaction, channelId) {
  const ticket = data.tickets[channelId];

  if (!ticket || ticket.closed) {
    return replyEphemeral(interaction, "This ticket is no longer open.");
  }

  if (!isTicketStaff(interaction.member, ticket.categoryKey)) {
    return replyEphemeral(
      interaction,
      "Only authorized staff members can change ticket priority."
    );
  }

  const selected = interaction.values[0];
  const priority = PRIORITIES.find(
    (item) => item.toLowerCase() === selected
  );

  if (!priority) {
    return replyEphemeral(interaction, "That priority is invalid.");
  }

  ticket.priority = priority;
  saveData();

  await interaction.message.edit({
    embeds: [createTicketEmbed(ticket)],
    components: createTicketControls(ticket),
  });

  await replyEphemeral(interaction, `Ticket priority changed to **${priority}**.`);

  await interaction.channel.send({
    content: `Ticket priority was changed to **${priority}** by <@${interaction.user.id}>.`,
    allowedMentions: { users: [interaction.user.id] },
  });
}

// ==================== CLOSE TICKET MODAL ====================

async function showCloseModal(interaction, channelId) {
  const ticket = data.tickets[channelId];

  if (!ticket || ticket.closed) {
    return replyEphemeral(interaction, "This ticket is no longer open.");
  }

  if (!isTicketStaff(interaction.member, ticket.categoryKey)) {
    return replyEphemeral(
      interaction,
      "Only authorized staff members can close tickets."
    );
  }

  const modal = new ModalBuilder()
    .setCustomId(`ticket_close_modal:${channelId}`)
    .setTitle("Close Support Ticket");

  const reasonInput = new TextInputBuilder()
    .setCustomId("close_reason")
    .setLabel("Reason for closing")
    .setPlaceholder("Explain why this ticket is being closed...")
    .setStyle(TextInputStyle.Paragraph)
    .setMinLength(3)
    .setMaxLength(1000)
    .setRequired(true);

  modal.addComponents(
    new ActionRowBuilder().addComponents(reasonInput)
  );

  await interaction.showModal(modal);
}

// ==================== TRANSCRIPT ====================

async function fetchAllMessages(channel) {
  const messages = [];
  let lastId;

  while (true) {
    const options = { limit: 100 };
    if (lastId) options.before = lastId;

    const batch = await channel.messages.fetch(options);

    if (batch.size === 0) break;

    messages.push(...batch.values());
    lastId = batch.last().id;

    if (batch.size < 100) break;
  }

  return messages.sort(
    (a, b) => a.createdTimestamp - b.createdTimestamp
  );
}

function formatTranscript(messages, ticket, reason, closedBy) {
  const lines = [
    "ZEXVERAI SUPPORT TICKET TRANSCRIPT",
    "==================================",
    `Ticket ID: ${ticket.channelId}`,
    `Created By: ${ticket.username} (${ticket.userId})`,
    `Claimed By: ${ticket.claimedByTag || "Not claimed"}`,
    `Ticket Date: ${new Date(ticket.createdAt).toISOString()}`,
    `Priority: ${ticket.priority}`,
    `Category: ${TICKET_CATEGORIES[ticket.categoryKey].label}`,
    `Reason: ${reason}`,
    `Closed By: ${closedBy.tag} (${closedBy.id})`,
    "",
    "CONVERSATION",
    "============",
    "",
  ];

  for (const message of messages) {
    const timestamp = new Date(message.createdTimestamp).toISOString();
    const author = `${message.author.tag} (${message.author.id})`;
    const content = message.content || "[No text content]";

    lines.push(`[${timestamp}] ${author}: ${content}`);

    for (const attachment of message.attachments.values()) {
      lines.push(`  Attachment: ${attachment.url}`);
    }

    for (const embed of message.embeds) {
      if (embed.title) lines.push(`  Embed title: ${embed.title}`);
      if (embed.description) lines.push(`  Embed description: ${embed.description}`);
    }

    lines.push("");
  }

  return lines.join("\n");
}

// ==================== CLOSE TICKET ====================

async function closeTicket(interaction, channelId, reason) {
  const ticket = data.tickets[channelId];

  if (!ticket || ticket.closed) {
    return replyEphemeral(interaction, "This ticket is already closed.");
  }

  if (!isTicketStaff(interaction.member, ticket.categoryKey)) {
    return replyEphemeral(
      interaction,
      "Only authorized staff members can close tickets."
    );
  }

  await interaction.deferReply({ flags: MessageFlags.Ephemeral });

  const ticketChannel = await interaction.guild.channels
    .fetch(channelId)
    .catch(() => null);

  if (!ticketChannel || !ticketChannel.isTextBased()) {
    return interaction.editReply({
      content: "The ticket channel could not be found.",
    });
  }

  let messages;

  try {
    messages = await fetchAllMessages(ticketChannel);
  } catch (error) {
    console.error("[Tickets] Could not fetch ticket messages:", error);

    return interaction.editReply({
      content:
        "I couldn't fetch the conversation, so the ticket has not been deleted. Please check the bot's View Channel and Read Message History permissions.",
    });
  }

  const transcriptText = formatTranscript(
    messages,
    ticket,
    reason,
    interaction.user
  );

  const transcriptChannel = await interaction.client.channels
    .fetch(TRANSCRIPT_CHANNEL_ID)
    .catch(() => null);

  if (!transcriptChannel || !transcriptChannel.isTextBased()) {
    return interaction.editReply({
      content:
        "The transcript channel could not be found. The ticket has not been deleted.",
    });
  }

  const transcriptBuffer = Buffer.from(transcriptText, "utf8");
  const transcriptFile = new AttachmentBuilder(transcriptBuffer, {
    name: `ticket-${ticket.channelId}-transcript.txt`,
  });

  const logEmbed = new EmbedBuilder()
    .setColor(0xf28c28)
    .setTitle("Ticket Closed")
    .addFields(
      { name: "Ticket ID", value: ticket.channelId },
      {
        name: "Created By",
        value: `${ticket.username} (${ticket.userId})`,
      },
      {
        name: "Claimed By",
        value: ticket.claimedByTag || "Not claimed",
      },
      {
        name: "Ticket Date",
        value: new Date(ticket.createdAt).toISOString(),
      },
      {
        name: "Reason",
        value: reason.slice(0, 1024),
      },
      {
        name: "Closed By",
        value: `${interaction.user.tag} (${interaction.user.id})`,
      },
      {
        name: "Priority",
        value: ticket.priority,
        inline: true,
      },
      {
        name: "Category",
        value: TICKET_CATEGORIES[ticket.categoryKey].label,
        inline: true,
      }
    )
    .setTimestamp();

  try {
    await transcriptChannel.send({
      embeds: [logEmbed],
      files: [transcriptFile],
      allowedMentions: { parse: [] },
    });
  } catch (error) {
    console.error("[Tickets] Could not send transcript:", error);

    return interaction.editReply({
      content:
        "I couldn't send the transcript. The ticket has not been deleted; please check the bot's permissions in the transcript channel.",
    });
  }

  ticket.closed = true;
  ticket.closedAt = Date.now();
  ticket.closedBy = interaction.user.id;
  ticket.closeReason = reason;
  saveData();

  await interaction.editReply({
    content: "The ticket has been closed. Its transcript has been saved.",
  });

  try {
    await ticketChannel.send(
      `This ticket has been closed by ${interaction.user.tag}. The channel will be deleted in 5 seconds.`
    );
  } catch {
    // The transcript has already been saved, so continue closing.
  }

  setTimeout(async () => {
    await ticketChannel.delete("Ticket closed; transcript saved").catch((error) => {
      console.error("[Tickets] Could not delete closed ticket:", error);
    });
  }, DELETE_DELAY);
}

// ==================== STAFF RESPONSE REMINDER ====================

async function checkTicketReminders(client) {
  const now = Date.now();

  for (const ticket of Object.values(data.tickets)) {
    if (ticket.closed || ticket.reminderSent || ticket.staffResponded) {
      continue;
    }

    if (now - ticket.createdAt < STAFF_REMINDER_DELAY) {
      continue;
    }

    const channel = await client.channels
      .fetch(ticket.channelId)
      .catch(() => null);

    if (!channel || !channel.isTextBased()) continue;

    try {
      await channel.send(
        "Reminder: This ticket is waiting for a response from our staff team."
      );

      ticket.reminderSent = true;
      saveData();
    } catch (error) {
      console.error("[Tickets] Could not send staff reminder:", error);
    }
  }
}

// ==================== EVENT HANDLERS ====================

module.exports = function registerTickets(client) {
  client.once("clientReady", async () => {
    await ensureTicketPanel(client);

    // Check periodically so a restart does not permanently lose reminders.
    setInterval(() => {
      checkTicketReminders(client).catch((error) => {
        console.error("[Tickets] Reminder check failed:", error);
      });
    }, 15 * 1000);
  });

  client.on("messageCreate", (message) => {
    if (!message.guild || message.author.bot) return;

    const ticket = data.tickets[message.channel.id];
    if (!ticket || ticket.closed) return;

    if (isTicketStaff(message.member, ticket.categoryKey)) {
      ticket.staffResponded = true;
      saveData();
    }
  });

  client.on("interactionCreate", async (interaction) => {
    try {
      if (interaction.isStringSelectMenu()) {
        if (interaction.customId === "ticket_category_select") {
          const categoryKey = interaction.values[0];
          await createTicket(interaction, categoryKey);
          return;
        }

        if (interaction.customId.startsWith("ticket_priority:")) {
          const channelId = interaction.customId.split(":")[1];
          await changePriority(interaction, channelId);
          return;
        }
      }

      if (interaction.isButton()) {
        if (interaction.customId.startsWith("ticket_claim:")) {
          const channelId = interaction.customId.split(":")[1];
          await claimTicket(interaction, channelId);
          return;
        }

        if (interaction.customId.startsWith("ticket_close:")) {
          const channelId = interaction.customId.split(":")[1];
          await showCloseModal(interaction, channelId);
          return;
        }
      }

      if (
        interaction.isModalSubmit() &&
        interaction.customId.startsWith("ticket_close_modal:")
      ) {
        const channelId = interaction.customId.split(":")[1];
        const reason = interaction.fields
          .getTextInputValue("close_reason")
          .trim();

        if (reason.length < 3) {
          return replyEphemeral(
            interaction,
            "Please provide a closing reason of at least 3 characters."
          );
        }

        await closeTicket(interaction, channelId, reason);
      }
    } catch (error) {
      console.error("[Tickets] Interaction failed:", error);

      if (interaction.isRepliable() && !interaction.replied && !interaction.deferred) {
        await interaction
          .reply({
            content:
              "Something went wrong while processing this ticket action. Please try again or contact an administrator.",
            flags: MessageFlags.Ephemeral,
          })
          .catch(() => {});
      }
    }
  });
};
