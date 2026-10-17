
const {
  Client,
  GatewayIntentBits,
  Partials,
  REST,
  Routes,
  SlashCommandBuilder,
  EmbedBuilder,
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  ModalBuilder,
  TextInputBuilder,
  TextInputStyle,
  MessageFlags,
  ChannelType,
  PermissionFlagsBits,
  StringSelectMenuBuilder,
  AttachmentBuilder
} = require("discord.js");

const fs = require("node:fs");
const path = require("node:path");

// --------------------------------------------------
// CONFIGURATION
// --------------------------------------------------

const TOKEN = process.env.DISCORD_TOKEN;
const CLIENT_ID = process.env.CLIENT_ID;
const GUILD_ID = process.env.GUILD_ID;
const KEEP_CHANNEL_ID = process.env.KEEP_ALIVE_CHANNEL_ID;
const KEEP_IMAGE_URL = process.env.KEEP_ALIVE_IMAGE_URL || "";

const QUIZ_CHANNEL_ID = "1560333520725868665";

const GIVEAWAY_ROLES = [
  "1559581706929840198",
  "1559581789306228736",
  "1559581840908484608",
  "1559581895531044945",
  "1559581952103813270",
  "1559582187869704233",
  "1559582256731922562"
];

const ANNOUNCE_ROLES = GIVEAWAY_ROLES;

const DAILY_REWARD = [20000, 10000, 5000, 2000, 2000];
const KEEP_COOLDOWN = 5 * 60 * 60 * 1000;
const QUIZ_INTERVAL = 2 * 60 * 60 * 1000;
const QUIZ_DURATION = 90 * 60 * 1000;
const DAY = 24 * 60 * 60 * 1000;

// Ticket configuration
const TICKET_PANEL_CHANNEL_ID = "1560338921173553203";
const TICKET_TRANSCRIPT_CHANNEL_ID = "1561036169649848470";

const TICKET_STAFF_ROLE_IDS = [
  "1559581706929840198",
  "1559581789306228736",
  "1559581840908484608",
  "1559581895531044945",
  "1559581952103813270",
  "1559582187869704233",
  "1559582256731922562",
  "1559582345907142857"
];

const TICKET_EXTRA_STAFF_ROLE_ID = "1559585704177049600";

const MAX_OPEN_TICKETS = 3;
const TICKET_REMINDER_DELAY = 10 * 60 * 1000;
const TICKET_DELETE_DELAY = 5 * 1000;

const TICKET_CATEGORIES = {
  general_support: {
    label: "General Support",
    description: "Get help with a question or problem.",
    emoji: "🛟"
  },
  customer_service: {
    label: "Customer Service",
    description: "Get help with a service-related issue.",
    emoji: "💬"
  },
  business_inquiry: {
    label: "Business Inquiry",
    description: "Discuss a business-related matter.",
    emoji: "💼"
  },
  partnership_proposition: {
    label: "Partnership Proposition",
    description: "Propose a partnership with us.",
    emoji: "🤝"
  }
};

const TICKET_PRIORITIES = ["Low", "Standard", "High"];

if (!TOKEN || !CLIENT_ID || !GUILD_ID) {
  console.error(
    "Missing environment variables: DISCORD_TOKEN, CLIENT_ID, GUILD_ID."
  );
  process.exit(1);
}

// --------------------------------------------------
// PERSISTENT JSON STORAGE
// --------------------------------------------------

const DATA_DIR = path.join(__dirname, "..", "data");
const DATA_FILE = path.join(DATA_DIR, "state.json");
const TICKETS_FILE = path.join(DATA_DIR, "tickets.json");

fs.mkdirSync(DATA_DIR, { recursive: true });

const initialState = {
  keepClicks: {},
  keepTotal: 0,
  keepMessageId: null,
  activeQuiz: null,
  nextQuizAt: Date.now() + QUIZ_INTERVAL,
  dailyScores: {},
  nextDailyAt: Date.now() + DAY,
  lastReminder: -1,
  giveaways: {}
};

let state = initialState;

try {
  if (fs.existsSync(DATA_FILE)) {
    state = {
      ...initialState,
      ...JSON.parse(fs.readFileSync(DATA_FILE, "utf8"))
    };
  }
} catch (error) {
  console.error("Could not read saved state:", error);
}

function saveState() {
  const temporaryFile = `${DATA_FILE}.tmp`;

  fs.writeFileSync(
    temporaryFile,
    JSON.stringify(state, null, 2),
    "utf8"
  );

  fs.renameSync(temporaryFile, DATA_FILE);
}

// Ticket state is stored separately from the existing bot data.
let ticketState = {
  panelMessageId: null,
  tickets: {}
};

try {
  if (fs.existsSync(TICKETS_FILE)) {
    const saved = JSON.parse(
      fs.readFileSync(TICKETS_FILE, "utf8")
    );

    ticketState = {
      panelMessageId: saved.panelMessageId || null,
      tickets:
        saved.tickets && typeof saved.tickets === "object"
          ? saved.tickets
          : {}
    };
  }
} catch (error) {
  console.error("Could not read ticket data:", error);
}

function saveTickets() {
  const temporaryFile = `${TICKETS_FILE}.tmp`;

  try {
    fs.writeFileSync(
      temporaryFile,
      JSON.stringify(ticketState, null, 2),
      "utf8"
    );

    fs.renameSync(temporaryFile, TICKETS_FILE);
  } catch (error) {
    console.error("Could not save ticket data:", error);
  }
}

// --------------------------------------------------
// DISCORD CLIENT
// --------------------------------------------------

const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMembers,
    GatewayIntentBits.GuildVoiceStates,
    GatewayIntentBits.GuildMessages
  ],
  partials: [Partials.Channel]
});

// Existing waiting-room module.
require("./waitingRoom")(client);

// --------------------------------------------------
// SLASH COMMANDS
// --------------------------------------------------

const commands = [
  new SlashCommandBuilder()
    .setName("giveavay")
    .setDescription("Create a new giveaway.")
    .addStringOption(option =>
      option
        .setName("title")
        .setDescription("Giveaway title")
        .setRequired(true)
        .setMaxLength(100)
    )
    .addStringOption(option =>
      option
        .setName("description")
        .setDescription("Giveaway description")
        .setRequired(true)
        .setMaxLength(1000)
    )
    .addStringOption(option =>
      option
        .setName("prize")
        .setDescription("The prize")
        .setRequired(true)
        .setMaxLength(100)
    )
    .addStringOption(option =>
      option
        .setName("duration")
        .setDescription("Examples: 30m, 2h, 3d, 2weeks")
        .setRequired(true)
    )
    .addStringOption(option =>
      option
        .setName("minimum_membership")
        .setDescription("Minimum server membership, e.g. 7d or 0d")
        .setRequired(true)
    )
    .addIntegerOption(option =>
      option
        .setName("winners")
        .setDescription("Number of winners (1-25)")
        .setMinValue(1)
        .setMaxValue(25)
        .setRequired(true)
    ),

  new SlashCommandBuilder()
    .setName("announce")
    .setDescription("Create and publish a community announcement.")
].map(command => command.toJSON());

const rest = new REST({ version: "10" }).setToken(TOKEN);

// --------------------------------------------------
// GENERAL HELPERS
// --------------------------------------------------

function makeEmbed(title, description) {
  return new EmbedBuilder()
    .setColor(0xf28c28)
    .setTitle(title)
    .setDescription(description)
    .setTimestamp();
}

async function hasAllowedRole(interaction, allowedRoles) {
  if (!interaction.guild) return false;

  try {
    const member = await interaction.guild.members.fetch(
      interaction.user.id
    );

    return allowedRoles.some(roleId =>
      member.roles.cache.has(roleId)
    );
  } catch (error) {
    console.error("Could not verify member roles:", error.message);
    return false;
  }
}

function parseDuration(input) {
  const match = String(input)
    .trim()
    .toLowerCase()
    .match(/^(\d+)\s*(m|min|minutes?|h|hours?|d|days?|w|weeks?)$/);

  if (!match) return null;

  const amount = Number(match[1]);
  const unit = match[2];

  if (!Number.isSafeInteger(amount) || amount < 0) return null;

  let multiplier;

  if (["m", "min", "minute", "minutes"].includes(unit)) {
    multiplier = 60 * 1000;
  } else if (["h", "hour", "hours"].includes(unit)) {
    multiplier = 60 * 60 * 1000;
  } else if (["d", "day", "days"].includes(unit)) {
    multiplier = DAY;
  } else {
    multiplier = 7 * DAY;
  }

  const result = amount * multiplier;

  if (!Number.isSafeInteger(result)) return null;

  return result;
}

function normalise(value) {
  return String(value)
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]/g, "");
}

function discordTime(timestamp) {
  return `<t:${Math.floor(timestamp / 1000)}:F>`;
}

async function getTextChannel(channelId) {
  if (!channelId) return null;

  try {
    const channel = await client.channels.fetch(channelId);

    if (!channel || !channel.isTextBased() || !channel.send) {
      return null;
    }

    return channel;
  } catch (error) {
    console.error(
      `Could not access channel ${channelId}:`,
      error.message
    );

    return null;
  }
}

function getDailyScore(userId) {
  if (!state.dailyScores[userId]) {
    state.dailyScores[userId] = {
      points: 0,
      correct: 0,
      totalTimeMs: 0
    };
  }

  return state.dailyScores[userId];
}

// --------------------------------------------------
// TICKET HELPERS
// --------------------------------------------------

function getTicket(channelId) {
  return ticketState.tickets[channelId] || null;
}

function getOpenTicketsForUser(userId) {
  return Object.values(ticketState.tickets).filter(
    ticket =>
      ticket.userId === userId &&
      !ticket.closed
  );
}

function isTicketStaff(member, categoryKey) {
  if (!member?.roles?.cache) return false;

  const hasMainStaffRole = TICKET_STAFF_ROLE_IDS.some(
    roleId => member.roles.cache.has(roleId)
  );

  if (categoryKey === "partnership_proposition") {
    return hasMainStaffRole;
  }

  return (
    hasMainStaffRole ||
    member.roles.cache.has(TICKET_EXTRA_STAFF_ROLE_ID)
  );
}

function createTicketPanelEmbed() {
  return new EmbedBuilder()
    .setColor(0xf28c28)
    .setTitle("ZexverAI Support Center")
    .setDescription([
      "Welcome to the ZexverAI Support Center.",
      "",
      "Select the category that best matches your request to create a private ticket.",
      "",
      "**Available categories**",
      "🛟 General Support",
      "💬 Customer Service",
      "💼 Business Inquiry",
      "🤝 Partnership Proposition",
      "",
      "You can have up to 3 open tickets at a time.",
      "",
      "Please explain your request clearly after creating your ticket."
    ].join("\n"))
    .setFooter({ text: "ZexverAI Support System" });
}

function createTicketPanelComponents() {
  const menu = new StringSelectMenuBuilder()
    .setCustomId("ticket_category_select")
    .setPlaceholder("Select a ticket category...")
    .setMinValues(1)
    .setMaxValues(1)
    .addOptions(
      Object.entries(TICKET_CATEGORIES).map(
        ([value, category]) => ({
          label: category.label,
          description: category.description,
          value,
          emoji: category.emoji
        })
      )
    );

  return [
    new ActionRowBuilder().addComponents(menu)
  ];
}

function createTicketEmbed(ticket) {
  const category = TICKET_CATEGORIES[ticket.categoryKey];

  return new EmbedBuilder()
    .setColor(0xf28c28)
    .setTitle("Support Ticket")
    .setDescription([
      `**Ticket ID:** \`${ticket.channelId}\``,
      `**Category:** ${category?.label || ticket.categoryKey}`,
      `**Created By:** <@${ticket.userId}>`,
      `**Priority:** ${ticket.priority}`,
      `**Claimed By:** ${
        ticket.claimedBy
          ? `<@${ticket.claimedBy}>`
          : "Not claimed"
      }`,
      "",
      "Please describe your request in this channel.",
      "An authorized staff member will respond as soon as possible."
    ].join("\n"))
    .setTimestamp(new Date(ticket.createdAt))
    .setFooter({ text: "ZexverAI Ticket System" });
}

function createTicketControls(ticket) {
  const claimButton = new ButtonBuilder()
    .setCustomId(`ticket_claim:${ticket.channelId}`)
    .setLabel(ticket.claimedBy ? "Ticket Claimed" : "Claim")
    .setStyle(
      ticket.claimedBy
        ? ButtonStyle.Secondary
        : ButtonStyle.Success
    )
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
      TICKET_PRIORITIES.map(priority => ({
        label: priority,
        value: priority.toLowerCase(),
        default:
          ticket.priority.toLowerCase() === priority.toLowerCase()
      }))
    );

  return [
    new ActionRowBuilder().addComponents(
      claimButton,
      closeButton
    ),
    new ActionRowBuilder().addComponents(priorityMenu)
  ];
}

function ticketStaffOverwrites(categoryKey) {
  const overwrites = TICKET_STAFF_ROLE_IDS.map(roleId => ({
    id: roleId,
    allow: [
      PermissionFlagsBits.ViewChannel,
      PermissionFlagsBits.SendMessages,
      PermissionFlagsBits.ReadMessageHistory,
      PermissionFlagsBits.AttachFiles,
      PermissionFlagsBits.EmbedLinks
    ]
  }));

  if (categoryKey !== "partnership_proposition") {
    overwrites.push({
      id: TICKET_EXTRA_STAFF_ROLE_ID,
      allow: [
        PermissionFlagsBits.ViewChannel,
        PermissionFlagsBits.SendMessages,
        PermissionFlagsBits.ReadMessageHistory,
        PermissionFlagsBits.AttachFiles,
        PermissionFlagsBits.EmbedLinks
      ]
    });
  }

  return overwrites;
}

async function ticketEphemeral(interaction, content) {
  if (interaction.deferred || interaction.replied) {
    return interaction.followUp({
      content,
      flags: MessageFlags.Ephemeral
    });
  }

  return interaction.reply({
    content,
    flags: MessageFlags.Ephemeral
  });
}

// --------------------------------------------------
// TICKET PANEL SETUP
// --------------------------------------------------

async function setupTicketPanel() {
  const channel = await getTextChannel(
    TICKET_PANEL_CHANNEL_ID
  );

  if (!channel) {
    console.error(
      "Ticket panel channel is unavailable. Check TICKET_PANEL_CHANNEL_ID."
    );
    return;
  }

  let existingMessage = null;

  if (ticketState.panelMessageId) {
    existingMessage = await channel.messages
      .fetch(ticketState.panelMessageId)
      .catch(() => null);
  }

  const payload = {
    embeds: [createTicketPanelEmbed()],
    components: createTicketPanelComponents()
  };

  if (existingMessage) {
    await existingMessage.edit(payload);
  } else {
    const message = await channel.send(payload);
    ticketState.panelMessageId = message.id;
    saveTickets();
  }

  console.log("Ticket panel is ready.");
}

// --------------------------------------------------
// CREATE TICKET
// --------------------------------------------------

async function createTicket(interaction, categoryKey) {
  const category = TICKET_CATEGORIES[categoryKey];

  if (!category) {
    return ticketEphemeral(
      interaction,
      "That ticket category is invalid."
    );
  }

  if (!interaction.guild) {
    return ticketEphemeral(
      interaction,
      "Tickets can only be created inside a server."
    );
  }

  const openTickets = getOpenTicketsForUser(
    interaction.user.id
  );

  if (openTickets.length >= MAX_OPEN_TICKETS) {
    return ticketEphemeral(
      interaction,
      "You already have 3 open tickets. Close an existing ticket before creating another one."
    );
  }

  await interaction.deferReply({
    flags: MessageFlags.Ephemeral
  });

  const safeUsername = interaction.user.username
    .toLowerCase()
    .replace(/[^a-z0-9-]/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-|-$/g, "")
    .slice(0, 35) || "user";

  const channelName = `ticket-${safeUsername}`.slice(0, 90);

  const permissionOverwrites = [
    {
      id: interaction.guild.roles.everyone.id,
      deny: [PermissionFlagsBits.ViewChannel]
    },
    {
      id: interaction.user.id,
      allow: [
        PermissionFlagsBits.ViewChannel,
        PermissionFlagsBits.SendMessages,
        PermissionFlagsBits.ReadMessageHistory,
        PermissionFlagsBits.AttachFiles,
        PermissionFlagsBits.EmbedLinks
      ]
    },
    {
      id: client.user.id,
      allow: [
        PermissionFlagsBits.ViewChannel,
        PermissionFlagsBits.SendMessages,
        PermissionFlagsBits.ReadMessageHistory,
        PermissionFlagsBits.ManageChannels,
        PermissionFlagsBits.AttachFiles,
        PermissionFlagsBits.EmbedLinks
      ]
    },
    ...ticketStaffOverwrites(categoryKey)
  ];

  let ticketChannel;

  try {
    ticketChannel = await interaction.guild.channels.create({
      name: channelName,
      type: ChannelType.GuildText,
      topic: `ZexverAI ticket | User: ${interaction.user.id} | Category: ${category.label}`,
      permissionOverwrites,
      reason: `Support ticket created by ${interaction.user.tag}`
    });
  } catch (error) {
    console.error("Could not create ticket channel:", error);

    return interaction.editReply({
      content:
        "I couldn't create your ticket. Please check the bot's Manage Channels permission."
    });
  }

  const ticket = {
    channelId: ticketChannel.id,
    guildId: interaction.guild.id,
    userId: interaction.user.id,
    username: interaction.user.tag,
    categoryKey,
    priority: "Standard",
    claimedBy: null,
    claimedByTag: null,
    createdAt: Date.now(),
    closed: false,
    reminderSent: false,
    staffResponded: false
  };

  ticketState.tickets[ticketChannel.id] = ticket;
  saveTickets();

  try {
    await ticketChannel.send({
      content: `<@${interaction.user.id}>`,
      embeds: [createTicketEmbed(ticket)],
      components: createTicketControls(ticket),
      allowedMentions: {
        users: [interaction.user.id]
      }
    });
  } catch (error) {
    console.error("Could not post ticket controls:", error);
  }

  await interaction.editReply({
    content: `Your ticket has been created successfully: ${ticketChannel}`
  });

  console.log(
    `Created ticket ${ticketChannel.id} for ${interaction.user.tag}`
  );
}

// --------------------------------------------------
// CLAIM TICKET
// --------------------------------------------------

async function claimTicket(interaction, channelId) {
  const ticket = getTicket(channelId);

  if (!ticket || ticket.closed) {
    return ticketEphemeral(
      interaction,
      "This ticket is no longer open."
    );
  }

  if (!isTicketStaff(interaction.member, ticket.categoryKey)) {
    return ticketEphemeral(
      interaction,
      "You do not have permission to claim this ticket."
    );
  }

  if (ticket.claimedBy) {
    return ticketEphemeral(
      interaction,
      `This ticket has been claimed by <@${ticket.claimedBy}>.`
    );
  }

  ticket.claimedBy = interaction.user.id;
  ticket.claimedByTag = interaction.user.tag;
  saveTickets();

  await interaction.message.edit({
    embeds: [createTicketEmbed(ticket)],
    components: createTicketControls(ticket)
  });

  await ticketEphemeral(
    interaction,
    `You have successfully claimed ticket \`${channelId}\`.`
  );

  await interaction.channel.send({
    content: `This ticket has been claimed by <@${interaction.user.id}>.`,
    allowedMentions: {
      users: [interaction.user.id]
    }
  });
}

// --------------------------------------------------
// CHANGE TICKET PRIORITY
// --------------------------------------------------

async function changeTicketPriority(interaction, channelId) {
  const ticket = getTicket(channelId);

  if (!ticket || ticket.closed) {
    return ticketEphemeral(
      interaction,
      "This ticket is no longer open."
    );
  }

  if (!isTicketStaff(interaction.member, ticket.categoryKey)) {
    return ticketEphemeral(
      interaction,
      "Only authorized staff members can change ticket priority."
    );
  }

  const selected = interaction.values[0];

  const priority = TICKET_PRIORITIES.find(
    item => item.toLowerCase() === selected
  );

  if (!priority) {
    return ticketEphemeral(
      interaction,
      "That priority is invalid."
    );
  }

  ticket.priority = priority;
  saveTickets();

  await interaction.message.edit({
    embeds: [createTicketEmbed(ticket)],
    components: createTicketControls(ticket)
  });

  await ticketEphemeral(
    interaction,
    `Ticket priority changed to ${priority}.`
  );

  await interaction.channel.send({
    content: `Ticket priority was changed to **${priority}** by <@${interaction.user.id}>.`,
    allowedMentions: {
      users: [interaction.user.id]
    }
  });
}

// --------------------------------------------------
// CLOSE TICKET MODAL
// --------------------------------------------------

async function showTicketCloseModal(interaction, channelId) {
  const ticket = getTicket(channelId);

  if (!ticket || ticket.closed) {
    return ticketEphemeral(
      interaction,
      "This ticket is no longer open."
    );
  }

  if (!isTicketStaff(interaction.member, ticket.categoryKey)) {
    return ticketEphemeral(
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

// --------------------------------------------------
// TICKET TRANSCRIPT HELPERS
// --------------------------------------------------

async function fetchAllTicketMessages(channel) {
  const messages = [];
  let before;

  while (true) {
    const options = { limit: 100 };

    if (before) {
      options.before = before;
    }

    const batch = await channel.messages.fetch(options);

    if (batch.size === 0) {
      break;
    }

    messages.push(...batch.values());
    before = batch.last().id;

    if (batch.size < 100) {
      break;
    }
  }

  return messages.sort(
    (a, b) => a.createdTimestamp - b.createdTimestamp
  );
}

function buildTicketTranscript(messages, ticket, reason, closer) {
  const category = TICKET_CATEGORIES[ticket.categoryKey];

  const lines = [
    "ZEXVERAI SUPPORT TICKET TRANSCRIPT",
    "==================================",
    `Ticket ID: ${ticket.channelId}`,
    `Created By: ${ticket.username} (${ticket.userId})`,
    `Claimed By: ${ticket.claimedByTag || "Not claimed"}`,
    `Ticket Date: ${new Date(ticket.createdAt).toISOString()}`,
    `Category: ${category?.label || ticket.categoryKey}`,
    `Priority: ${ticket.priority}`,
    `Reason: ${reason}`,
    `Closed By: ${closer.tag} (${closer.id})`,
    "",
    "CONVERSATION",
    "============",
    ""
  ];

  for (const message of messages) {
    const timestamp = new Date(
      message.createdTimestamp
    ).toISOString();

    lines.push(
      `[${timestamp}] ${message.author.tag} (${message.author.id}):`
    );

    if (message.content) {
      lines.push(message.content);
    } else {
      lines.push("[No text content]");
    }

    for (const attachment of message.attachments.values()) {
      lines.push(`Attachment: ${attachment.url}`);
    }

    for (const embed of message.embeds) {
      if (embed.title) {
        lines.push(`Embed title: ${embed.title}`);
      }

      if (embed.description) {
        lines.push(`Embed description: ${embed.description}`);
      }
    }

    lines.push("");
  }

  return lines.join("\n");
}

// --------------------------------------------------
// CLOSE TICKET AND SAVE TRANSCRIPT
// --------------------------------------------------

async function closeTicket(interaction, channelId, reason) {
  const ticket = getTicket(channelId);

  if (!ticket || ticket.closed) {
    return ticketEphemeral(
      interaction,
      "This ticket is already closed."
    );
  }

  if (!isTicketStaff(interaction.member, ticket.categoryKey)) {
    return ticketEphemeral(
      interaction,
      "Only authorized staff members can close tickets."
    );
  }

  await interaction.deferReply({
    flags: MessageFlags.Ephemeral
  });

  const channel = await interaction.guild.channels
    .fetch(channelId)
    .catch(() => null);

  if (!channel || !channel.isTextBased()) {
    return interaction.editReply({
      content: "The ticket channel could not be found."
    });
  }

  let messages;

  try {
    messages = await fetchAllTicketMessages(channel);
  } catch (error) {
    console.error("Could not fetch ticket messages:", error);

    return interaction.editReply({
      content:
        "I couldn't read the ticket conversation. The ticket has not been deleted. Check the bot's View Channel and Read Message History permissions."
    });
  }

  const transcript = buildTicketTranscript(
    messages,
    ticket,
    reason,
    interaction.user
  );

  const transcriptChannel = await getTextChannel(
    TICKET_TRANSCRIPT_CHANNEL_ID
  );

  if (!transcriptChannel) {
    return interaction.editReply({
      content:
        "The transcript channel is unavailable. The ticket has not been deleted."
    });
  }

  const transcriptAttachment = new AttachmentBuilder(
    Buffer.from(transcript, "utf8"),
    {
      name: `ticket-${ticket.channelId}-transcript.txt`
    }
  );

  const category = TICKET_CATEGORIES[ticket.categoryKey];

  const logEmbed = new EmbedBuilder()
    .setColor(0xf28c28)
    .setTitle("Ticket Closed")
    .addFields(
      {
        name: "Ticket ID",
        value: ticket.channelId
      },
      {
        name: "Created By",
        value: `${ticket.username} (${ticket.userId})`
      },
      {
        name: "Claimed By",
        value: ticket.claimedByTag || "Not claimed"
      },
      {
        name: "Ticket Date",
        value: new Date(ticket.createdAt).toISOString()
      },
      {
        name: "Category",
        value: category?.label || ticket.categoryKey,
        inline: true
      },
      {
        name: "Priority",
        value: ticket.priority,
        inline: true
      },
      {
        name: "Reason",
        value: reason.slice(0, 1024)
      },
      {
        name: "Closed By",
        value: `${interaction.user.tag} (${interaction.user.id})`
      }
    )
    .setTimestamp();

  try {
    await transcriptChannel.send({
      embeds: [logEmbed],
      files: [transcriptAttachment],
      allowedMentions: {
        parse: []
      }
    });
  } catch (error) {
    console.error("Could not send ticket transcript:", error);

    return interaction.editReply({
      content:
        "The transcript could not be saved. The ticket has not been deleted. Check the bot's permissions in the transcript channel."
    });
  }

  ticket.closed = true;
  ticket.closedAt = Date.now();
  ticket.closedBy = interaction.user.id;
  ticket.closedByTag = interaction.user.tag;
  ticket.closeReason = reason;
  saveTickets();

  await interaction.editReply({
    content: "The ticket has been closed and its transcript has been saved."
  });

  try {
    await channel.send(
      `This ticket has been closed by ${interaction.user.tag}. The channel will be deleted in 5 seconds.`
    );
  } catch (error) {
    console.error("Could not send closing notice:", error.message);
  }

  setTimeout(async () => {
    try {
      await channel.delete(
        "Ticket closed; transcript saved successfully."
      );
    } catch (error) {
      console.error("Could not delete closed ticket:", error);
    }
  }, TICKET_DELETE_DELAY);
}

// --------------------------------------------------
// TICKET REMINDER
// --------------------------------------------------

async function checkTicketReminders() {
  const now = Date.now();

  for (const ticket of Object.values(ticketState.tickets)) {
    if (
      ticket.closed ||
      ticket.reminderSent ||
      ticket.staffResponded
    ) {
      continue;
    }

    if (now - ticket.createdAt < TICKET_REMINDER_DELAY) {
      continue;
    }

    const channel = await client.channels
      .fetch(ticket.channelId)
      .catch(() => null);

    if (!channel || !channel.isTextBased()) {
      continue;
    }

    try {
      await channel.send(
        "Reminder: This ticket is waiting for a response from our staff team."
      );

      ticket.reminderSent = true;
      saveTickets();
    } catch (error) {
      console.error("Could not send ticket reminder:", error);
    }
  }
}

// --------------------------------------------------
// ANNOUNCE
// --------------------------------------------------

function createAnnouncementModal(channelId) {
  const modal = new ModalBuilder()
    .setCustomId(`announce_submit:${channelId}`)
    .setTitle("Create an Announcement");

  const titleInput = new TextInputBuilder()
    .setCustomId("announcement_title")
    .setLabel("Title")
    .setPlaceholder("Enter the announcement title")
    .setStyle(TextInputStyle.Short)
    .setRequired(true)
    .setMaxLength(256);

  const descriptionInput = new TextInputBuilder()
    .setCustomId("announcement_description")
    .setLabel("Description")
    .setPlaceholder("Write your announcement here")
    .setStyle(TextInputStyle.Paragraph)
    .setRequired(true)
    .setMaxLength(4000);

  modal.addComponents(
    new ActionRowBuilder().addComponents(titleInput),
    new ActionRowBuilder().addComponents(descriptionInput)
  );

  return modal;
}

async function publishAnnouncement(interaction, channelId) {
  const title = interaction.fields
    .getTextInputValue("announcement_title")
    .trim();

  const description = interaction.fields
    .getTextInputValue("announcement_description")
    .trim();

  if (!title || !description) {
    return interaction.reply({
      content: "Both the title and description are required.",
      flags: MessageFlags.Ephemeral
    });
  }

  const channel = await getTextChannel(channelId);

  if (!channel || channel.guildId !== interaction.guildId) {
    return interaction.reply({
      content: "I could not access the announcement channel.",
      flags: MessageFlags.Ephemeral
    });
  }

  const botMember = interaction.guild.members.me;

  if (
    !botMember ||
    !channel.permissionsFor(botMember)?.has([
      PermissionFlagsBits.ViewChannel,
      PermissionFlagsBits.SendMessages,
      PermissionFlagsBits.EmbedLinks
    ])
  ) {
    return interaction.reply({
      content:
        "I need permission to view this channel, send messages, and embed links.",
      flags: MessageFlags.Ephemeral
    });
  }

  try {
    await channel.send({
      embeds: [makeEmbed(title, description)]
    });

    return interaction.reply({
      content: `Announcement published successfully in <#${channelId}>.`,
      flags: MessageFlags.Ephemeral
    });
  } catch (error) {
    console.error("Could not publish announcement:", error);

    return interaction.reply({
      content:
        "The announcement could not be published. Please check my channel permissions.",
      flags: MessageFlags.Ephemeral
    });
  }
}

// --------------------------------------------------
// KEEP AI ALIVE
// --------------------------------------------------

function keepAliveEmbed() {
  const embed = makeEmbed(
    "Keep AI Tree Alive!",
    [
      "**A Small Seed. A Growing Future.**",
      "",
      "Every great project begins with a small idea. This tree represents the journey of ZexverAI — from its first beginnings to the possibilities that lie ahead.",
      "",
      "Its roots represent the foundation, its trunk represents the work invested in the project, and its branches and leaves represent new ideas, features, and future improvements.",
      "",
      "Just like a real tree, ZexverAI needs time, patience, and dedication to grow. Every step forward brings new opportunities to learn, improve, and build something better.",
      "",
      "## How Can Clicking the Button Help?",
      "",
      "By clicking the button below, you show your support for ZexverAI. Your click is a sign of community interest and can motivate the creator to continue developing the project.",
      "",
      "Every supporter is a reminder that this project has the potential to grow. Even a small gesture can make the journey more encouraging.",
      "",
      "Please remember that clicking does not directly provide funding, computing power, or automatic AI improvements. It simply records your support.",
      "",
      `**Total support clicks:** ${state.keepTotal}`
    ].join("\n")
  );

  if (KEEP_IMAGE_URL) {
    embed.setImage(KEEP_IMAGE_URL);
  }

  return embed;
}

function keepAliveRow() {
  return new ActionRowBuilder().addComponents(
    new ButtonBuilder()
      .setCustomId("keep_alive")
      .setLabel("Keep ZexverAI Alive")
      .setEmoji("🌱")
      .setStyle(ButtonStyle.Success)
  );
}

async function setupKeepAlive() {
  if (!KEEP_CHANNEL_ID) {
    console.log(
      "Keep AI Alive is waiting for KEEP_ALIVE_CHANNEL_ID."
    );
    return;
  }

  const channel = await getTextChannel(KEEP_CHANNEL_ID);

  if (!channel) {
    console.error("Keep AI Alive channel is unavailable.");
    return;
  }

  if (state.keepMessageId) {
    try {
      const existing = await channel.messages.fetch(
        state.keepMessageId
      );

      await existing.edit({
        embeds: [keepAliveEmbed()],
        components: [keepAliveRow()]
      });

      return;
    } catch {
      state.keepMessageId = null;
    }
  }

  const message = await channel.send({
    embeds: [keepAliveEmbed()],
    components: [keepAliveRow()]
  });

  state.keepMessageId = message.id;
  saveState();
}

// --------------------------------------------------
// QUIZZY QUESTIONS
// --------------------------------------------------

const questions = [
  {
    question: "When was ZexverAI first founded?",
    answers: ["13.10.2026", "13.10", "13.2026"],
    display: "13.10.2026",
    date: true
  },
  {
    question: "What is the founder of ZexverAI called on Discord?",
    answers: ["kengiee"],
    display: "Kengiee"
  },
  {
    question: "When was Kengiee's Discord account created?",
    answers: ["2.01.2024", "2.01"],
    display: "2.01.2024",
    date: true
  },
  {
    question: "Who are Kengiee's best friends?",
    answers: [
      "lerequin52",
      "natanloveroblox",
      "jaibesoindaidealed"
    ],
    display: "Lerequin52 and Nate"
  },
  {
    question: "What was ZexverAI originally going to be called?",
    answers: ["zexver"],
    display: "Zexver"
  },
  {
    question: "What is the cooldown for growing our tree per person?",
    answers: ["5h", "5hours", "fivehours", "fiveh"],
    display: "5 hours"
  },
  {
    question: "What is Kengiee's favourite food?",
    answers: [
      "colds mokedsalmon",
      "coldsmokedsalmon",
      "salmon",
      "losos"
    ],
    display: "Cold-smoked salmon"
  },
  {
    question: "What is Lerequin's favourite anime movie?",
    answers: ["demonsleyers", "demonslayer", "demonslayers"],
    display: "Demon Slayer"
  },
  {
    question: "What is Kengiee's favourite anime?",
    answers: ["none", "na", "n a", "inazumaeleven"],
    display: "None / N/A / Inazuma Eleven"
  },
  {
    question: "Who was the first owner of Zexver?",
    answers: ["kengiee"],
    display: "Kengiee"
  },
  {
    question:
      "What is the Discord username of the person who inspired Kengiee to create ZexverAI?",
    answers: ["rulovius"],
    display: "Rulovius"
  },
  {
    question: "What was Rulovius's role?",
    answers: ["founder"],
    display: "Founder"
  },
  {
    question: "In which year was ZexverAI founded?",
    answers: ["2026"],
    display: "2026"
  }
];

function isCorrect(question, answer) {
  const submitted = normalise(answer);

  if (question.date) {
    const date = submitted.replace(/\D/g, "");

    return question.answers.some(
      accepted => date === accepted.replace(/\D/g, "")
    );
  }

  return question.answers.some(
    accepted => normalise(accepted) === submitted
  );
}

function answerBonus(elapsedMs) {
  const seconds = elapsedMs / 1000;

  if (seconds <= 5) return 35;
  if (seconds <= 10) return 30;
  if (seconds <= 15) return 20;
  if (seconds <= 25) return 10;
  if (seconds <= 60) return 5;

  return 0;
}

async function postQuiz() {
  const channel = await getTextChannel(QUIZ_CHANNEL_ID);

  if (!channel) return;

  const used = state.activeQuiz?.questionIndex;
  let index = Math.floor(Math.random() * questions.length);

  if (questions.length > 1 && index === used) {
    index = (index + 1) % questions.length;
  }

  const question = questions[index];
  const now = Date.now();

  state.activeQuiz = {
    questionIndex: index,
    startedAt: now,
    endsAt: now + QUIZ_DURATION,
    answers: {},
    messageId: null
  };

  const row = new ActionRowBuilder().addComponents(
    new ButtonBuilder()
      .setCustomId("quiz_answer")
      .setLabel("Answer Quiz")
      .setStyle(ButtonStyle.Primary)
  );

  const message = await channel.send({
    embeds: [
      makeEmbed(
        "Quizzy — Community Quiz",
        [
          `**Question:** ${question.question}`,
          "",
          "You have 90 minutes to submit your answer.",
          `Answers close ${discordTime(now + QUIZ_DURATION)}.`,
          "",
          "Click the button below to submit your answer. Each participant gets one attempt."
        ].join("\n")
      )
    ],
    components: [row]
  });

  state.activeQuiz.messageId = message.id;
  state.nextQuizAt = now + QUIZ_INTERVAL;
  saveState();
}

async function closeQuiz() {
  const quiz = state.activeQuiz;

  if (!quiz) return;

  const channel = await getTextChannel(QUIZ_CHANNEL_ID);
  const question = questions[quiz.questionIndex];

  if (channel) {
    const sorted = Object.entries(quiz.answers)
      .map(([userId, result]) => ({ userId, ...result }))
      .sort(
        (a, b) =>
          b.points - a.points ||
          a.elapsedMs - b.elapsedMs
      );

    const top = sorted.slice(0, 15);

    let description =
      `**Correct answer:** ${question.display}\n\n`;

    if (top.length === 0) {
      description += "No answers were submitted.";
    } else {
      description += top
        .map((entry, i) => {
          const seconds = (
            entry.elapsedMs / 1000
          ).toFixed(2);

          return `**${i + 1}.** <@${entry.userId}> — ${seconds} sec | ${entry.points} points`;
        })
        .join("\n");

      if (sorted.length > 15) {
        description +=
          `\n\n+${sorted.length - 15} more participants`;
      }
    }

    await channel.send({
      embeds: [makeEmbed("Quizzy — Results", description)]
    });

    if (quiz.messageId) {
      try {
        const message = await channel.messages.fetch(
          quiz.messageId
        );

        await message.edit({
          components: [
            new ActionRowBuilder().addComponents(
              new ButtonBuilder()
                .setCustomId("quiz_closed")
                .setLabel("Quiz Closed")
                .setStyle(ButtonStyle.Secondary)
                .setDisabled(true)
            )
          ]
        });
      } catch {}
    }
  }

  state.activeQuiz = null;
  saveState();
}

const reminderMessages = [
  "Please move your butt, stop being a statue, and start handing out those rewards!",
  "The leaderboard is ready, the winners are waiting, and you're still procrastinating.",
  "Roses are red, the leaderboard is bright, hand out those rewards and do something right.",
  "Hey, move your feet, the winners are waiting for their daily treat.",
  "Less sitting, more rewarding. Chop-chop!",
  "The winners did their part, now hand out the rewards and show some heart.",
  "Your mission, should you choose to accept it: stop chilling and distribute the rewards.",
  "No more hiding, no more delay. Hand those rewards out today!",
  "The points are counted, the winners are known. Get off your throne and hand out what's owed!",
  "Please move your butt and do your duty. The leaderboard deserves your beauty."
];

async function postDailyLeaderboard() {
  const channel = await getTextChannel(QUIZ_CHANNEL_ID);

  const entries = Object.entries(state.dailyScores)
    .map(([userId, score]) => ({ userId, ...score }))
    .sort((a, b) => b.points - a.points);

  if (channel) {
    let description = "";

    if (entries.length === 0) {
      description =
        "No quiz points were recorded during this period.";
    } else {
      description = entries
        .slice(0, 5)
        .map((entry, index) => {
          const reward = DAILY_REWARD[index] || 0;

          return `**${index + 1}.** <@${entry.userId}> — ${entry.points} points | ${reward.toLocaleString("en-US")} Tokens`;
        })
        .join("\n");
    }

    const reminderIndex =
      (state.lastReminder + 1) % reminderMessages.length;

    state.lastReminder = reminderIndex;

    await channel.send({
      embeds: [
        makeEmbed("Quizzy — Daily Leaderboard", description)
      ]
    });

    await channel.send(
      `<@1191814686644117537> ${reminderMessages[reminderIndex]}`
    );
  }

  state.dailyScores = {};
  state.nextDailyAt = Date.now() + DAY;
  saveState();
}

// --------------------------------------------------
// GIVEAWAYS
// --------------------------------------------------

function giveawayEmbed(giveaway) {
  const remaining = Math.max(
    0,
    giveaway.endsAt - Date.now()
  );

  return makeEmbed(
    giveaway.title,
    [
      giveaway.description,
      "",
      `**Prize:** ${giveaway.prize}`,
      `**Registered Participants:** ${giveaway.entrants.length}`,
      `**Number of Winners:** ${giveaway.winners}`,
      `**Minimum Server Membership:** ${giveaway.minimumMembershipLabel}`,
      `**Time Remaining:** ${remaining > 0 ? `<t:${Math.floor(giveaway.endsAt / 1000)}:R>` : "Ended"}`,
      `**Ends:** ${discordTime(giveaway.endsAt)}`
    ].join("\n")
  );
}

function giveawayRow(giveawayId, disabled = false) {
  return new ActionRowBuilder().addComponents(
    new ButtonBuilder()
      .setCustomId(`giveaway_enter:${giveawayId}`)
      .setLabel(
        disabled
          ? "Giveaway Ended"
          : "Take Part in the Giveaway"
      )
      .setEmoji("🎉")
      .setStyle(ButtonStyle.Success)
      .setDisabled(disabled)
  );
}

async function finishGiveaway(giveawayId) {
  const giveaway = state.giveaways[giveawayId];

  if (!giveaway || giveaway.ended) return;

  giveaway.ended = true;
  saveState();

  const channel = await getTextChannel(giveaway.channelId);

  if (!channel) return;

  const participants = [...new Set(giveaway.entrants)];
  const winners = [];

  while (
    participants.length > 0 &&
    winners.length < giveaway.winners
  ) {
    const index = Math.floor(
      Math.random() * participants.length
    );

    winners.push(participants.splice(index, 1)[0]);
  }

  if (giveaway.messageId) {
    try {
      const message = await channel.messages.fetch(
        giveaway.messageId
      );

      await message.edit({
        embeds: [giveawayEmbed(giveaway)],
        components: [giveawayRow(giveawayId, true)]
      });
    } catch {}
  }

  const winnerText = winners.length
    ? winners.map(id => `<@${id}>`).join(", ")
    : "There were no eligible participants.";

  await channel.send({
    content: [
      "## Giveaway Ended!",
      `**Prize:** ${giveaway.prize}`,
      `**Registered Participants:** ${giveaway.entrants.length} participants`,
      `**Number of Winners:** ${winners.length} winners`,
      "",
      "**Congratulations to our winners!**",
      winnerText,
      "",
      winners.length
        ? `Congratulations! You've won **${giveaway.prize}**. We hope you enjoy your prize.`
        : "Unfortunately, there were not enough eligible participants to select a winner.",
      "",
      "Thank you to everyone who entered. Stay tuned for more giveaways!"
    ].join("\n"),
    allowedMentions: { users: winners }
  });

  saveState();
}

// --------------------------------------------------
// SCHEDULER
// --------------------------------------------------

async function schedulerTick() {
  const now = Date.now();

  if (
    state.activeQuiz &&
    now >= state.activeQuiz.endsAt
  ) {
    await closeQuiz();
  }

  if (!state.activeQuiz && now >= state.nextQuizAt) {
    await postQuiz();
  }

  if (now >= state.nextDailyAt) {
    await postDailyLeaderboard();
  }

  for (const [id, giveaway] of Object.entries(state.giveaways)) {
    if (!giveaway.ended && now >= giveaway.endsAt) {
      await finishGiveaway(id);
    }
  }

  await checkTicketReminders();
}

// --------------------------------------------------
// INTERACTION HANDLING
// --------------------------------------------------

client.on("interactionCreate", async interaction => {
  try {
    // TICKET CATEGORY SELECT
    if (
      interaction.isStringSelectMenu() &&
      interaction.customId === "ticket_category_select"
    ) {
      await createTicket(
        interaction,
        interaction.values[0]
      );
      return;
    }

    // TICKET PRIORITY SELECT
    if (
      interaction.isStringSelectMenu() &&
      interaction.customId.startsWith("ticket_priority:")
    ) {
      const channelId =
        interaction.customId.split(":")[1];

      await changeTicketPriority(interaction, channelId);
      return;
    }

    // TICKET BUTTONS
    if (interaction.isButton()) {
      if (
        interaction.customId.startsWith("ticket_claim:")
      ) {
        const channelId =
          interaction.customId.split(":")[1];

        await claimTicket(interaction, channelId);
        return;
      }

      if (
        interaction.customId.startsWith("ticket_close:")
      ) {
        const channelId =
          interaction.customId.split(":")[1];

        await showTicketCloseModal(interaction, channelId);
        return;
      }
    }

    // SLASH COMMANDS
    if (interaction.isChatInputCommand()) {
      // ANNOUNCE COMMAND
      if (interaction.commandName === "announce") {
        const permitted = await hasAllowedRole(
          interaction,
          ANNOUNCE_ROLES
        );

        if (!permitted) {
          return interaction.reply({
            content:
              "You do not have permission to create announcements.",
            flags: MessageFlags.Ephemeral
          });
        }

        if (!interaction.channelId) {
          return interaction.reply({
            content:
              "Please use this command in a server text channel.",
            flags: MessageFlags.Ephemeral
          });
        }

        return interaction.showModal(
          createAnnouncementModal(interaction.channelId)
        );
      }

      // GIVEAWAY COMMAND
      if (interaction.commandName === "giveavay") {
        const permitted = await hasAllowedRole(
          interaction,
          GIVEAWAY_ROLES
        );

        if (!permitted) {
          return interaction.reply({
            content:
              "You do not have permission to create giveaways.",
            flags: MessageFlags.Ephemeral
          });
        }

        const title = interaction.options.getString(
          "title",
          true
        );

        const description = interaction.options.getString(
          "description",
          true
        );

        const prize = interaction.options.getString(
          "prize",
          true
        );

        const durationText = interaction.options.getString(
          "duration",
          true
        );

        const membershipText = interaction.options.getString(
          "minimum_membership",
          true
        );

        const winners = interaction.options.getInteger(
          "winners",
          true
        );

        const duration = parseDuration(durationText);
        const minimumMembership = parseDuration(
          membershipText
        );

        if (duration === null || duration <= 0) {
          return interaction.reply({
            content:
              "Invalid giveaway duration. Use a format such as 30m, 2h, 3d or 2weeks.",
            flags: MessageFlags.Ephemeral
          });
        }

        if (minimumMembership === null) {
          return interaction.reply({
            content:
              "Invalid minimum membership. Use a format such as 0d, 7d or 2weeks.",
            flags: MessageFlags.Ephemeral
          });
        }

        const channel = interaction.channel;

        if (
          !channel ||
          !channel.isTextBased() ||
          !channel.send
        ) {
          return interaction.reply({
            content:
              "This command must be used in a text channel.",
            flags: MessageFlags.Ephemeral
          });
        }

        const id = `${interaction.id}`;
        const endsAt = Date.now() + duration;

        const giveaway = {
          id,
          guildId: interaction.guildId,
          channelId: channel.id,
          messageId: null,
          title,
          description,
          prize,
          createdAt: Date.now(),
          endsAt,
          minimumMembershipMs: minimumMembership,
          minimumMembershipLabel: membershipText,
          winners,
          entrants: [],
          ended: false
        };

        state.giveaways[id] = giveaway;
        saveState();

        const message = await channel.send({
          embeds: [giveawayEmbed(giveaway)],
          components: [giveawayRow(id)]
        });

        giveaway.messageId = message.id;
        saveState();

        return interaction.reply({
          content:
            "Your giveaway has been published successfully.",
          flags: MessageFlags.Ephemeral
        });
      }
    }

    // EXISTING BUTTONS
    if (interaction.isButton()) {
      if (interaction.customId === "keep_alive") {
        const userId = interaction.user.id;
        const now = Date.now();
        const lastClick = state.keepClicks[userId] || 0;

        const remaining =
          KEEP_COOLDOWN - (now - lastClick);

        if (remaining > 0) {
          const hours = Math.floor(
            remaining / 3600000
          );

          const minutes = Math.ceil(
            (remaining % 3600000) / 60000
          );

          return interaction.reply({
            content:
              `You have already supported ZexverAI recently. Please wait ${hours}h ${minutes}m before clicking again.`,
            flags: MessageFlags.Ephemeral
          });
        }

        state.keepClicks[userId] = now;
        state.keepTotal += 1;
        saveState();

        await interaction.reply({
          content:
            "Thank you for supporting ZexverAI! Your support has been recorded.",
          flags: MessageFlags.Ephemeral
        });

        try {
          await interaction.message.edit({
            embeds: [keepAliveEmbed()],
            components: [keepAliveRow()]
          });
        } catch (error) {
          console.error(
            "Could not update Keep AI Alive embed:",
            error.message
          );
        }

        return;
      }

      if (interaction.customId === "quiz_answer") {
        const quiz = state.activeQuiz;

        if (!quiz || Date.now() >= quiz.endsAt) {
          return interaction.reply({
            content:
              "This quiz is closed. Please wait for the next question.",
            flags: MessageFlags.Ephemeral
          });
        }

        if (quiz.answers[interaction.user.id]) {
          return interaction.reply({
            content:
              "You have already submitted an answer for this quiz.",
            flags: MessageFlags.Ephemeral
          });
        }

        const modal = new ModalBuilder()
          .setCustomId("quiz_submit")
          .setTitle("Submit Your Quiz Answer");

        const answerInput = new TextInputBuilder()
          .setCustomId("answer")
          .setLabel("Your answer")
          .setStyle(TextInputStyle.Short)
          .setRequired(true)
          .setMaxLength(200);

        modal.addComponents(
          new ActionRowBuilder().addComponents(answerInput)
        );

        return interaction.showModal(modal);
      }

      if (
        interaction.customId.startsWith("giveaway_enter:")
      ) {
        const id = interaction.customId.split(":")[1];
        const giveaway = state.giveaways[id];

        if (
          !giveaway ||
          giveaway.ended ||
          Date.now() >= giveaway.endsAt
        ) {
          return interaction.reply({
            content:
              "This giveaway has ended or is unavailable.",
            flags: MessageFlags.Ephemeral
          });
        }

        if (
          giveaway.entrants.includes(interaction.user.id)
        ) {
          return interaction.reply({
            content:
              "You have already entered this giveaway.",
            flags: MessageFlags.Ephemeral
          });
        }

        let member;

        try {
          member = await interaction.guild.members.fetch(
            interaction.user.id
          );
        } catch {
          return interaction.reply({
            content:
              "You must be a member of this server to enter.",
            flags: MessageFlags.Ephemeral
          });
        }

        const joinedAt = member.joinedTimestamp;

        if (
          !joinedAt ||
          Date.now() - joinedAt <
            giveaway.minimumMembershipMs
        ) {
          return interaction.reply({
            content:
              `You do not meet the minimum server membership requirement of ${giveaway.minimumMembershipLabel}.`,
            flags: MessageFlags.Ephemeral
          });
        }

        giveaway.entrants.push(interaction.user.id);
        saveState();

        await interaction.reply({
          content:
            "You have successfully entered the giveaway. Good luck!",
          flags: MessageFlags.Ephemeral
        });

        try {
          await interaction.message.edit({
            embeds: [giveawayEmbed(giveaway)],
            components: [giveawayRow(id)]
          });
        } catch {}

        return;
      }
    }

    // MODAL SUBMISSIONS
    if (interaction.isModalSubmit()) {
      // TICKET CLOSE MODAL
      if (
        interaction.customId.startsWith("ticket_close_modal:")
      ) {
        const channelId =
          interaction.customId.split(":")[1];

        const reason = interaction.fields
          .getTextInputValue("close_reason")
          .trim();

        if (reason.length < 3) {
          return ticketEphemeral(
            interaction,
            "Please provide a closing reason of at least 3 characters."
          );
        }

        await closeTicket(
          interaction,
          channelId,
          reason
        );
        return;
      }

      // ANNOUNCEMENT MODAL
      if (
        interaction.customId.startsWith("announce_submit:")
      ) {
        const permitted = await hasAllowedRole(
          interaction,
          ANNOUNCE_ROLES
        );

        if (!permitted) {
          return interaction.reply({
            content:
              "You do not have permission to create announcements.",
            flags: MessageFlags.Ephemeral
          });
        }

        const channelId =
          interaction.customId.split(":")[1];

        return publishAnnouncement(
          interaction,
          channelId
        );
      }

      // QUIZZY ANSWER MODAL
      if (interaction.customId === "quiz_submit") {
        const quiz = state.activeQuiz;

        if (!quiz || Date.now() >= quiz.endsAt) {
          return interaction.reply({
            content:
              "This quiz is closed. Your answer was not recorded.",
            flags: MessageFlags.Ephemeral
          });
        }

        if (quiz.answers[interaction.user.id]) {
          return interaction.reply({
            content:
              "You have already submitted an answer for this quiz.",
            flags: MessageFlags.Ephemeral
          });
        }

        const question = questions[quiz.questionIndex];

        const answer =
          interaction.fields.getTextInputValue("answer");

        const elapsedMs = Math.max(
          0,
          Date.now() - quiz.startedAt
        );

        const correct = isCorrect(question, answer);

        const points = correct
          ? 100 + answerBonus(elapsedMs)
          : 0;

        quiz.answers[interaction.user.id] = {
          points,
          correct,
          elapsedMs,
          answeredAt: Date.now()
        };

        if (correct) {
          const score = getDailyScore(
            interaction.user.id
          );

          score.points += points;
          score.correct += 1;
          score.totalTimeMs += elapsedMs;
        }

        saveState();

        return interaction.reply({
          content: correct
            ? `Correct answer! You earned ${points} points.`
            : "Incorrect answer. You earned 0 points. Better luck next time!",
          flags: MessageFlags.Ephemeral
        });
      }
    }
  } catch (error) {
    console.error("Interaction error:", error);

    if (
      interaction.isRepliable() &&
      !interaction.replied &&
      !interaction.deferred
    ) {
      try {
        await interaction.reply({
          content:
            "Something went wrong. Please try again later.",
          flags: MessageFlags.Ephemeral
        });
      } catch {}
    }
  }
});

// --------------------------------------------------
// STAFF RESPONSE TRACKING FOR TICKETS
// --------------------------------------------------

client.on("messageCreate", message => {
  if (!message.guild || message.author.bot) return;

  const ticket = getTicket(message.channel.id);

  if (!ticket || ticket.closed || ticket.staffResponded) {
    return;
  }

  if (isTicketStaff(message.member, ticket.categoryKey)) {
    ticket.staffResponded = true;
    saveTickets();
  }
});

// --------------------------------------------------
// STARTUP
// --------------------------------------------------

client.once("clientReady", async () => {
  console.log(`Logged in as ${client.user.tag}`);

  try {
    await rest.put(
      Routes.applicationGuildCommands(
        CLIENT_ID,
        GUILD_ID
      ),
      { body: commands }
    );

    console.log("Slash commands registered.");
  } catch (error) {
    console.error(
      "Could not register slash commands:",
      error
    );
  }

  try {
    await setupKeepAlive();
  } catch (error) {
    console.error("Keep AI Alive setup failed:", error);
  }

  try {
    await setupTicketPanel();
  } catch (error) {
    console.error("Ticket panel setup failed:", error);
  }

  if (
    state.activeQuiz &&
    Date.now() >= state.activeQuiz.endsAt
  ) {
    await closeQuiz();
  }

  try {
    await schedulerTick();
  } catch (error) {
    console.error("Initial scheduler run failed:", error);
  }

  setInterval(() => {
    schedulerTick().catch(error =>
      console.error("Scheduler error:", error)
    );
  }, 15000);

  console.log("Zexver Community Manager is running.");
});

client.on("error", error => {
  console.error("Discord client error:", error);
});

process.on("SIGTERM", () => {
  saveState();
  saveTickets();
  client.destroy();
  process.exit(0);
});

process.on("SIGINT", () => {
  saveState();
  saveTickets();
  client.destroy();
  process.exit(0);
});

client.login(TOKEN);
