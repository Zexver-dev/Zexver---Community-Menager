
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
  MessageFlags
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

// --------------------------------------------------
// DISCORD CLIENT
// --------------------------------------------------

const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMembers
  ],
  partials: [Partials.Channel]
});

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
    console.error(`Could not access channel ${channelId}:`, error.message);
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
    !channel.permissionsFor(botMember)?.has(["ViewChannel", "SendMessages", "EmbedLinks"])
  ) {
    return interaction.reply({
      content: "I need permission to view this channel, send messages, and embed links.",
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
      content: "The announcement could not be published. Please check my channel permissions.",
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
    console.log("Keep AI Alive is waiting for KEEP_ALIVE_CHANNEL_ID.");
    return;
  }

  const channel = await getTextChannel(KEEP_CHANNEL_ID);

  if (!channel) {
    console.error("Keep AI Alive channel is unavailable.");
    return;
  }

  if (state.keepMessageId) {
    try {
      const existing = await channel.messages.fetch(state.keepMessageId);

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
// Only user-provided facts are included.
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
    answers: ["lerequin52", "natanloveroblox", "jaibesoindaidealed"],
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
    answers: ["colds mokedsalmon", "coldsmokedsalmon", "salmon", "losos"],
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
    question: "What is the Discord username of the person who inspired Kengiee to create ZexverAI?",
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
      .sort((a, b) => b.points - a.points || a.elapsedMs - b.elapsedMs);

    const top = sorted.slice(0, 15);

    let description = `**Correct answer:** ${question.display}\n\n`;

    if (top.length === 0) {
      description += "No answers were submitted.";
    } else {
      description += top.map((entry, i) => {
        const seconds = (entry.elapsedMs / 1000).toFixed(2);

        return `**${i + 1}.** <@${entry.userId}> — ${seconds} sec | ${entry.points} points`;
      }).join("\n");

      if (sorted.length > 15) {
        description += `\n\n+${sorted.length - 15} more participants`;
      }
    }

    await channel.send({
      embeds: [makeEmbed("Quizzy — Results", description)]
    });

    if (quiz.messageId) {
      try {
        const message = await channel.messages.fetch(quiz.messageId);

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
      description = "No quiz points were recorded during this period.";
    } else {
      description = entries.slice(0, 5).map((entry, index) => {
        const reward = DAILY_REWARD[index] || 0;

        return `**${index + 1}.** <@${entry.userId}> — ${entry.points} points | ${reward.toLocaleString("en-US")} Tokens`;
      }).join("\n");
    }

    const reminderIndex = (state.lastReminder + 1) % reminderMessages.length;
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
  const remaining = Math.max(0, giveaway.endsAt - Date.now());

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
      .setLabel(disabled ? "Giveaway Ended" : "Take Part in the Giveaway")
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

  while (participants.length > 0 && winners.length < giveaway.winners) {
    const index = Math.floor(Math.random() * participants.length);
    winners.push(participants.splice(index, 1)[0]);
  }

  if (giveaway.messageId) {
    try {
      const message = await channel.messages.fetch(giveaway.messageId);

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
// SCHEDULER — RESTORES AFTER RESTART
// --------------------------------------------------

async function schedulerTick() {
  const now = Date.now();

  if (state.activeQuiz && now >= state.activeQuiz.endsAt) {
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
}

// --------------------------------------------------
// INTERACTION HANDLING
// --------------------------------------------------

client.on("interactionCreate", async interaction => {
  try {
    if (interaction.isChatInputCommand()) {
      // ANNOUNCE COMMAND
      if (interaction.commandName === "announce") {
        const permitted = await hasAllowedRole(
          interaction,
          ANNOUNCE_ROLES
        );

        if (!permitted) {
          return interaction.reply({
            content: "You do not have permission to create announcements.",
            flags: MessageFlags.Ephemeral
          });
        }

        if (!interaction.channelId) {
          return interaction.reply({
            content: "Please use this command in a server text channel.",
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
            content: "You do not have permission to create giveaways.",
            flags: MessageFlags.Ephemeral
          });
        }

        const title = interaction.options.getString("title", true);
        const description = interaction.options.getString("description", true);
        const prize = interaction.options.getString("prize", true);
        const durationText = interaction.options.getString("duration", true);
        const membershipText = interaction.options.getString("minimum_membership", true);
        const winners = interaction.options.getInteger("winners", true);

        const duration = parseDuration(durationText);
        const minimumMembership = parseDuration(membershipText);

        if (duration === null || duration <= 0) {
          return interaction.reply({
            content: "Invalid giveaway duration. Use a format such as 30m, 2h, 3d or 2weeks.",
            flags: MessageFlags.Ephemeral
          });
        }

        if (minimumMembership === null) {
          return interaction.reply({
            content: "Invalid minimum membership. Use a format such as 0d, 7d or 2weeks.",
            flags: MessageFlags.Ephemeral
          });
        }

        const channel = interaction.channel;

        if (!channel || !channel.isTextBased() || !channel.send) {
          return interaction.reply({
            content: "This command must be used in a text channel.",
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
          content: "Your giveaway has been published successfully.",
          flags: MessageFlags.Ephemeral
        });
      }
    }

    // BUTTONS
    if (interaction.isButton()) {
      if (interaction.customId === "keep_alive") {
        const userId = interaction.user.id;
        const now = Date.now();
        const lastClick = state.keepClicks[userId] || 0;
        const remaining = KEEP_COOLDOWN - (now - lastClick);

        if (remaining > 0) {
          const hours = Math.floor(remaining / 3600000);
          const minutes = Math.ceil((remaining % 3600000) / 60000);

          return interaction.reply({
            content: `You have already supported ZexverAI recently. Please wait ${hours}h ${minutes}m before clicking again.`,
            flags: MessageFlags.Ephemeral
          });
        }

        state.keepClicks[userId] = now;
        state.keepTotal += 1;
        saveState();

        await interaction.reply({
          content: "Thank you for supporting ZexverAI! Your support has been recorded.",
          flags: MessageFlags.Ephemeral
        });

        try {
          await interaction.message.edit({
            embeds: [keepAliveEmbed()],
            components: [keepAliveRow()]
          });
        } catch (error) {
          console.error("Could not update Keep AI Alive embed:", error.message);
        }

        return;
      }

      if (interaction.customId === "quiz_answer") {
        const quiz = state.activeQuiz;

        if (!quiz || Date.now() >= quiz.endsAt) {
          return interaction.reply({
            content: "This quiz is closed. Please wait for the next question.",
            flags: MessageFlags.Ephemeral
          });
        }

        if (quiz.answers[interaction.user.id]) {
          return interaction.reply({
            content: "You have already submitted an answer for this quiz.",
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

      if (interaction.customId.startsWith("giveaway_enter:")) {
        const id = interaction.customId.split(":")[1];
        const giveaway = state.giveaways[id];

        if (!giveaway || giveaway.ended || Date.now() >= giveaway.endsAt) {
          return interaction.reply({
            content: "This giveaway has ended or is unavailable.",
            flags: MessageFlags.Ephemeral
          });
        }

        if (giveaway.entrants.includes(interaction.user.id)) {
          return interaction.reply({
            content: "You have already entered this giveaway.",
            flags: MessageFlags.Ephemeral
          });
        }

        let member;

        try {
          member = await interaction.guild.members.fetch(interaction.user.id);
        } catch {
          return interaction.reply({
            content: "You must be a member of this server to enter.",
            flags: MessageFlags.Ephemeral
          });
        }

        const joinedAt = member.joinedTimestamp;

        if (!joinedAt || Date.now() - joinedAt < giveaway.minimumMembershipMs) {
          return interaction.reply({
            content: `You do not meet the minimum server membership requirement of ${giveaway.minimumMembershipLabel}.`,
            flags: MessageFlags.Ephemeral
          });
        }

        giveaway.entrants.push(interaction.user.id);
        saveState();

        await interaction.reply({
          content: "You have successfully entered the giveaway. Good luck!",
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
      if (interaction.customId.startsWith("announce_submit:")) {
        const permitted = await hasAllowedRole(
          interaction,
          ANNOUNCE_ROLES
        );

        if (!permitted) {
          return interaction.reply({
            content: "You do not have permission to create announcements.",
            flags: MessageFlags.Ephemeral
          });
        }

        const channelId = interaction.customId.split(":")[1];

        return publishAnnouncement(interaction, channelId);
      }

      if (interaction.customId === "quiz_submit") {
        const quiz = state.activeQuiz;

        if (!quiz || Date.now() >= quiz.endsAt) {
          return interaction.reply({
            content: "This quiz is closed. Your answer was not recorded.",
            flags: MessageFlags.Ephemeral
          });
        }

        if (quiz.answers[interaction.user.id]) {
          return interaction.reply({
            content: "You have already submitted an answer for this quiz.",
            flags: MessageFlags.Ephemeral
          });
        }

        const question = questions[quiz.questionIndex];
        const answer = interaction.fields.getTextInputValue("answer");
        const elapsedMs = Math.max(0, Date.now() - quiz.startedAt);
        const correct = isCorrect(question, answer);
        const points = correct ? 100 + answerBonus(elapsedMs) : 0;

        quiz.answers[interaction.user.id] = {
          points,
          correct,
          elapsedMs,
          answeredAt: Date.now()
        };

        if (correct) {
          const score = getDailyScore(interaction.user.id);

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

    if (interaction.isRepliable() && !interaction.replied && !interaction.deferred) {
      try {
        await interaction.reply({
          content: "Something went wrong. Please try again later.",
          flags: MessageFlags.Ephemeral
        });
      } catch {}
    }
  }
});

// --------------------------------------------------
// STARTUP
// --------------------------------------------------

client.once("clientReady", async () => {
  console.log(`Logged in as ${client.user.tag}`);

  try {
    await rest.put(
      Routes.applicationGuildCommands(CLIENT_ID, GUILD_ID),
      { body: commands }
    );

    console.log("Slash commands registered.");
  } catch (error) {
    console.error("Could not register slash commands:", error);
  }

  await setupKeepAlive();

  if (state.activeQuiz && Date.now() >= state.activeQuiz.endsAt) {
    await closeQuiz();
  }

  await schedulerTick();

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
  client.destroy();
  process.exit(0);
});

process.on("SIGINT", () => {
  saveState();
  client.destroy();
  process.exit(0);
});

client.login(TOKEN);
