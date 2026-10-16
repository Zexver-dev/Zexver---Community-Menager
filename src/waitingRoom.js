"use strict";

const fs = require("node:fs");
const path = require("node:path");

// Make the bundled FFmpeg executable available to the audio library.
try {
  const ffmpegPath = require("ffmpeg-static");

  if (ffmpegPath) {
    process.env.PATH =
      `${path.dirname(ffmpegPath)}${path.delimiter}${process.env.PATH || ""}`;
  }
} catch (error) {
  console.error("[WaitingRoom] FFmpeg setup failed:", error.message);
}

const {
  joinVoiceChannel,
  createAudioPlayer,
  createAudioResource,
  AudioPlayerStatus,
  VoiceConnectionStatus,
  entersState
} = require("@discordjs/voice");

// --------------------------------------------------
// CONFIGURATION
// --------------------------------------------------

const VOICE_CHANNEL_ID = "1560340357919539240";
const NOTIFICATION_CHANNEL_ID = "1560695688902344925";
const NOTIFICATION_ROLE_ID = "1559585704177049600";

// Same role IDs as /announce in index.js.
const ANNOUNCEMENT_ROLE_IDS = [
  "1559581706929840198",
  "1559581789306228736",
  "1559581840908484608",
  "1559581895531044945",
  "1559581952103813270",
  "1559582187869704233",
  "1559582256731922562"
];

const SUPPORT_ROLE_IDS = new Set([
  NOTIFICATION_ROLE_ID,
  ...ANNOUNCEMENT_ROLE_IDS
]);

// Audio file is stored in the repository root.
const MUSIC_FILE = path.join(
  __dirname,
  "..",
  "waiting-room.wav.wav"
);

const FIRST_NOTIFICATION_DELAY = 10_000;
const REMINDER_INTERVAL = 5 * 60 * 1000;
const CONNECTION_RETRY_DELAY = 5_000;
const NOTIFICATION_RETRY_DELAY = 60_000;

// --------------------------------------------------
// MODULE
// --------------------------------------------------

module.exports = function setupWaitingRoom(client) {
  if (client.__zexverWaitingRoomLoaded) return;
  client.__zexverWaitingRoomLoaded = true;

  const player = createAudioPlayer();

  let voiceChannel = null;
  let connection = null;
  let connectPromise = null;
  let reconnectTimer = null;
  let notificationTimer = null;
  let musicLoopTimer = null;

  let humansPresent = false;
  let supportPresent = false;
  let firstNotificationSent = false;
  let notificationInProgress = false;
  let missingFileLogged = false;

  // ------------------------------------------------
  // HELPERS
  // ------------------------------------------------

  function getHumans(channel = voiceChannel) {
    if (!channel?.members) return [];

    return [...channel.members.values()].filter(
      member => !member.user.bot
    );
  }

  function hasSupportMember(channel = voiceChannel) {
    return getHumans(channel).some(member =>
      [...SUPPORT_ROLE_IDS].some(roleId =>
        member.roles.cache.has(roleId)
      )
    );
  }

  async function refreshVoiceChannel() {
    const channel = await client.channels.fetch(VOICE_CHANNEL_ID);

    if (!channel || !channel.isVoiceBased()) {
      throw new Error("The configured voice channel is unavailable.");
    }

    voiceChannel = channel;
    return channel;
  }

  function clearNotificationTimer() {
    if (notificationTimer) {
      clearTimeout(notificationTimer);
      notificationTimer = null;
    }
  }

  function stopMusic() {
    if (musicLoopTimer) {
      clearTimeout(musicLoopTimer);
      musicLoopTimer = null;
    }

    if (player.state.status !== AudioPlayerStatus.Idle) {
      player.stop(true);
    }
  }

  function leaveVoiceChannel() {
    const oldConnection = connection;
    connection = null;

    if (
      oldConnection &&
      oldConnection.state.status !== VoiceConnectionStatus.Destroyed
    ) {
      oldConnection.destroy();
      console.log("[WaitingRoom] Left the empty waiting room.");
    }
  }

  // ------------------------------------------------
  // MUSIC
  // ------------------------------------------------

  function playMusic() {
    if (!humansPresent || !connection || !voiceChannel) return;

    if (connection.state.status !== VoiceConnectionStatus.Ready) {
      return;
    }

    if (player.state.status !== AudioPlayerStatus.Idle) {
      return;
    }

    if (!fs.existsSync(MUSIC_FILE)) {
      if (!missingFileLogged) {
        console.error(
          `[WaitingRoom] Audio file not found: ${MUSIC_FILE}`
        );
        missingFileLogged = true;
      }

      return;
    }

    try {
      player.play(
        createAudioResource(MUSIC_FILE, {
          metadata: { title: "Zexver Waiting Room" }
        })
      );

      console.log("[WaitingRoom] Playing waiting-room audio.");
    } catch (error) {
      console.error(
        "[WaitingRoom] Could not start audio:",
        error.message
      );
    }
  }

  // Repeat the complete file, including the ElevenLabs announcement.
  player.on(AudioPlayerStatus.Idle, () => {
    if (
      !humansPresent ||
      !connection ||
      connection.state.status !== VoiceConnectionStatus.Ready
    ) {
      return;
    }

    if (musicLoopTimer) clearTimeout(musicLoopTimer);

    musicLoopTimer = setTimeout(() => {
      musicLoopTimer = null;
      playMusic();
    }, 300);

    musicLoopTimer.unref?.();
  });

  player.on("error", error => {
    console.error(
      "[WaitingRoom] Audio playback error:",
      error.message
    );
  });

  // ------------------------------------------------
  // SUPPORT NOTIFICATIONS
  // ------------------------------------------------

  async function sendWaitingNotification() {
    const channel = await refreshVoiceChannel();
    const humans = getHumans(channel);

    if (humans.length === 0 || hasSupportMember(channel)) {
      return false;
    }

    const textChannel = await client.channels.fetch(
      NOTIFICATION_CHANNEL_ID
    );

    if (
      !textChannel ||
      !textChannel.isTextBased() ||
      typeof textChannel.send !== "function"
    ) {
      throw new Error("The notification text channel is unavailable.");
    }

    await textChannel.send({
      content:
        "🛎️ **Someone is waiting for help!**\n" +
        `A user is waiting in <#${VOICE_CHANNEL_ID}>.\n` +
        `<@&${NOTIFICATION_ROLE_ID}>`,

      allowedMentions: {
        parse: [],
        roles: [NOTIFICATION_ROLE_ID],
        users: []
      }
    });

    console.log("[WaitingRoom] Sent a support notification.");
    return true;
  }

  function scheduleNotification(delay) {
    if (
      notificationTimer ||
      notificationInProgress ||
      !humansPresent ||
      supportPresent
    ) {
      return;
    }

    notificationTimer = setTimeout(async () => {
      notificationTimer = null;
      notificationInProgress = true;

      try {
        const sent = await sendWaitingNotification();

        if (sent) {
          firstNotificationSent = true;
        }
      } catch (error) {
        console.error(
          "[WaitingRoom] Notification failed:",
          error.message
        );

        // Retry later if Discord temporarily prevents sending.
        scheduleNotification(NOTIFICATION_RETRY_DELAY);
      } finally {
        notificationInProgress = false;
      }

      await syncPresence();
    }, delay);

    notificationTimer.unref?.();
  }

  // ------------------------------------------------
  // VOICE CONNECTION
  // ------------------------------------------------

  function scheduleReconnect() {
    if (reconnectTimer || !humansPresent) return;

    reconnectTimer = setTimeout(() => {
      reconnectTimer = null;
      void syncPresence();
    }, CONNECTION_RETRY_DELAY);

    reconnectTimer.unref?.();
  }

  async function connectToChannel(channel) {
    if (
      connection &&
      connection.state.status === VoiceConnectionStatus.Ready
    ) {
      playMusic();
      return;
    }

    if (connectPromise) {
      await connectPromise;
      return;
    }

    connectPromise = (async () => {
      let newConnection;

      try {
        if (!humansPresent) return;

        newConnection = joinVoiceChannel({
          channelId: channel.id,
          guildId: channel.guild.id,
          adapterCreator: channel.guild.voiceAdapterCreator,
          selfDeaf: true
        });

        connection = newConnection;
        newConnection.subscribe(player);

        newConnection.on("error", error => {
          console.error(
            "[WaitingRoom] Voice connection error:",
            error.message
          );
        });

        newConnection.on("stateChange", (_oldState, newState) => {
          if (newState.status === VoiceConnectionStatus.Ready) {
            console.log("[WaitingRoom] Voice connection is ready.");

            if (humansPresent) playMusic();
          }

          if (
            newState.status === VoiceConnectionStatus.Destroyed &&
            connection === newConnection &&
            humansPresent
          ) {
            connection = null;
            scheduleReconnect();
          }
        });

        await entersState(
          newConnection,
          VoiceConnectionStatus.Ready,
          30_000
        );

        // Someone may have left while the connection was starting.
        if (!humansPresent) {
          if (connection === newConnection) {
            leaveVoiceChannel();
          }

          return;
        }

        console.log("[WaitingRoom] Joined the waiting room.");
        playMusic();
      } catch (error) {
        console.error(
          "[WaitingRoom] Could not join voice:",
          error.message
        );

        if (connection === newConnection) {
          connection = null;
        }

        if (
          newConnection &&
          newConnection.state.status !== VoiceConnectionStatus.Destroyed
        ) {
          newConnection.destroy();
        }

        if (humansPresent) scheduleReconnect();
      }
    })();

    try {
      await connectPromise;
    } finally {
      connectPromise = null;
    }
  }

  // ------------------------------------------------
  // PRESENCE AND WAITING TIMER
  // ------------------------------------------------

  async function syncPresence() {
    let channel;

    try {
      channel = await refreshVoiceChannel();
    } catch (error) {
      console.error(
        "[WaitingRoom] Could not check waiting room:",
        error.message
      );
      return;
    }

    const humans = getHumans(channel);

    // No people: cancel timers, stop audio, and disconnect.
    if (humans.length === 0) {
      humansPresent = false;
      supportPresent = false;
      firstNotificationSent = false;

      clearNotificationTimer();

      if (reconnectTimer) {
        clearTimeout(reconnectTimer);
        reconnectTimer = null;
      }

      stopMusic();
      leaveVoiceChannel();
      return;
    }

    humansPresent = true;

    const supportIsHere = hasSupportMember(channel);
    supportPresent = supportIsHere;

    if (supportIsHere) {
      // Don't notify while an authorised support member is present.
      clearNotificationTimer();
    } else {
      const delay = firstNotificationSent
        ? REMINDER_INTERVAL
        : FIRST_NOTIFICATION_DELAY;

      scheduleNotification(delay);
    }

    // Connect only after a human has entered the channel.
    await connectToChannel(channel);
  }

  // ------------------------------------------------
  // DISCORD EVENTS
  // ------------------------------------------------

  client.on("voiceStateUpdate", (oldState, newState) => {
    if (
      oldState.channelId === VOICE_CHANNEL_ID ||
      newState.channelId === VOICE_CHANNEL_ID
    ) {
      void syncPresence();
    }
  });

  client.on("guildMemberUpdate", (oldMember, newMember) => {
    const wasSupport = [...SUPPORT_ROLE_IDS].some(roleId =>
      oldMember.roles.cache.has(roleId)
    );

    const isSupport = [...SUPPORT_ROLE_IDS].some(roleId =>
      newMember.roles.cache.has(roleId)
    );

    if (
      wasSupport !== isSupport &&
      newMember.voice.channelId === VOICE_CHANNEL_ID
    ) {
      void syncPresence();
    }
  });

  client.once("clientReady", () => {
    console.log("[WaitingRoom] Waiting for the first visitor.");
    void syncPresence();
  });
};
