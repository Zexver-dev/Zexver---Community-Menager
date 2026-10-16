"use strict";

const fs = require("node:fs");
const path = require("node:path");

const {
    joinVoiceChannel,
    createAudioPlayer,
    createAudioResource,
    AudioPlayerStatus,
    VoiceConnectionStatus,
    entersState
} = require("@discordjs/voice");

// =============================================
// ZEXVER COMMUNITY MANAGER — WAITING ROOM
// =============================================

const WAITING_VOICE_CHANNEL_ID = "1560340357919539240";
const NOTIFICATION_TEXT_CHANNEL_ID = "1560695688902344925";
const NOTIFICATION_ROLE_ID = "1559585704177049600";

// Role uprawnione do /announce.
// Osoba z dowolną z tych ról może przejąć obsługę.
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

// Plik audio leży w głównym folderze repozytorium.
// Nazwa odpowiada plikowi waiting-room.wav.wav.
const MUSIC_FILE_PATH = path.join(
    __dirname,
    "..",
    "waiting-room.wav.wav"
);

const FIRST_NOTIFICATION_DELAY = 10_000;
const REMINDER_INTERVAL = 5 * 60 * 1000;
const RECONNECT_DELAY = 5_000;

module.exports = function setupWaitingRoom(client) {
    // Zabezpieczenie przed przypadkowym podłączeniem modułu dwa razy.
    if (client.__zexverWaitingRoomLoaded) return;
    client.__zexverWaitingRoomLoaded = true;

    const player = createAudioPlayer();

    let voiceChannel = null;
    let connection = null;

    let connecting = false;
    let recovering = false;
    let reconnectTimer = null;
    let musicLoopTimer = null;

    let humansPresent = false;
    let initialNotificationSent = false;
    let supportWasPresent = false;

    let initialNotificationTimer = null;
    let reminderTimer = null;
    let missingFileWarningShown = false;

    // =============================================
    // POMOCNICZE
    // =============================================

    function getHumanMembers() {
        if (!voiceChannel) return [];

        return [...voiceChannel.members.values()].filter(
            member => !member.user.bot
        );
    }

    function hasSupportMember() {
        return getHumanMembers().some(member =>
            member.roles.cache.some(role =>
                SUPPORT_ROLE_IDS.has(role.id)
            )
        );
    }

    function clearInitialNotificationTimer() {
        if (initialNotificationTimer) {
            clearTimeout(initialNotificationTimer);
            initialNotificationTimer = null;
        }
    }

    function clearReminderTimer() {
        if (reminderTimer) {
            clearTimeout(reminderTimer);
            reminderTimer = null;
        }
    }

    function clearNotificationTimers() {
        clearInitialNotificationTimer();
        clearReminderTimer();
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

    // =============================================
    // MUZYKA
    // =============================================

    function playMusic() {
        if (!humansPresent) return;

        if (
            !connection ||
            connection.state.status !== VoiceConnectionStatus.Ready
        ) {
            return;
        }

        if (player.state.status !== AudioPlayerStatus.Idle) {
            return;
        }

        if (!fs.existsSync(MUSIC_FILE_PATH)) {
            if (!missingFileWarningShown) {
                console.error(
                    `[WaitingRoom] Nie znaleziono pliku audio: ${MUSIC_FILE_PATH}`
                );
                missingFileWarningShown = true;
            }

            return;
        }

        try {
            const resource = createAudioResource(MUSIC_FILE_PATH);
            player.play(resource);

            console.log("[WaitingRoom] Rozpoczęto odtwarzanie muzyki.");
        } catch (error) {
            console.error(
                "[WaitingRoom] Nie udało się uruchomić muzyki:",
                error
            );
        }
    }

    // Po zakończeniu pliku uruchom go ponownie,
    // ale tylko wtedy, gdy ktoś nadal jest w poczekalni.
    player.on(AudioPlayerStatus.Idle, () => {
        if (!humansPresent || !fs.existsSync(MUSIC_FILE_PATH)) {
            return;
        }

        if (musicLoopTimer) {
            clearTimeout(musicLoopTimer);
        }

        musicLoopTimer = setTimeout(() => {
            musicLoopTimer = null;

            if (
                humansPresent &&
                getHumanMembers().length > 0 &&
                player.state.status === AudioPlayerStatus.Idle
            ) {
                playMusic();
            }
        }, 300);

        musicLoopTimer.unref?.();
    });

    player.on("error", error => {
        console.error(
            "[WaitingRoom] Błąd odtwarzacza audio:",
            error
        );
    });

    // =============================================
    // POWIADOMIENIA O OCZEKUJĄCYCH
    // =============================================

    async function sendWaitingNotification() {
        try {
            const updatedVoiceChannel = await client.channels.fetch(
                WAITING_VOICE_CHANNEL_ID
            );

            if (
                !updatedVoiceChannel ||
                !updatedVoiceChannel.isVoiceBased()
            ) {
                console.error(
                    "[WaitingRoom] Nie znaleziono kanału głosowego."
                );
                return false;
            }

            voiceChannel = updatedVoiceChannel;

            // Nie wysyłaj niczego, jeśli kanał jest pusty.
            if (getHumanMembers().length === 0) {
                return false;
            }

            // Jeśli osoba uprawniona już pomaga, nie pinguj zespołu.
            if (hasSupportMember()) {
                return false;
            }

            const textChannel = await client.channels.fetch(
                NOTIFICATION_TEXT_CHANNEL_ID
            );

            if (
                !textChannel ||
                !textChannel.isTextBased() ||
                typeof textChannel.send !== "function"
            ) {
                console.error(
                    "[WaitingRoom] Nie znaleziono kanału tekstowego."
                );
                return false;
            }

            await textChannel.send({
                content:
                    "🛎️ **Someone is waiting for help!** " +
                    `A user is waiting in <#${WAITING_VOICE_CHANNEL_ID}>. ` +
                    `<@&${NOTIFICATION_ROLE_ID}>`,

                // Dozwolony jest tylko ping wskazanej roli.
                allowedMentions: {
                    parse: [],
                    roles: [NOTIFICATION_ROLE_ID],
                    users: []
                }
            });

            console.log(
                "[WaitingRoom] Wysłano powiadomienie o oczekującej osobie."
            );

            return true;
        } catch (error) {
            console.error(
                "[WaitingRoom] Nie udało się wysłać powiadomienia:",
                error
            );

            return false;
        }
    }

    function scheduleInitialNotification() {
        if (
            initialNotificationTimer ||
            initialNotificationSent ||
            !humansPresent ||
            getHumanMembers().length === 0 ||
            hasSupportMember()
        ) {
            return;
        }

        initialNotificationTimer = setTimeout(async () => {
            initialNotificationTimer = null;

            const sent = await sendWaitingNotification();

            if (sent) {
                initialNotificationSent = true;
                scheduleReminder();
            } else {
                await syncPresence();
            }
        }, FIRST_NOTIFICATION_DELAY);

        initialNotificationTimer.unref?.();
    }

    function scheduleReminder() {
        if (
            reminderTimer ||
            !humansPresent ||
            !initialNotificationSent ||
            getHumanMembers().length === 0 ||
            hasSupportMember()
        ) {
            return;
        }

        reminderTimer = setTimeout(async () => {
            reminderTimer = null;

            const sent = await sendWaitingNotification();

            if (sent) {
                // Następne przypomnienie za 5 minut,
                // jeżeli nadal nikt z obsługi nie dołączył.
                scheduleReminder();
            } else {
                await syncPresence();
            }
        }, REMINDER_INTERVAL);

        reminderTimer.unref?.();
    }

    // =============================================
    // SPRAWDZANIE OBECNOŚCI NA POCZEKALNI
    // =============================================

    async function syncPresence() {
        try {
            const updatedVoiceChannel = await client.channels.fetch(
                WAITING_VOICE_CHANNEL_ID
            );

            if (
                !updatedVoiceChannel ||
                !updatedVoiceChannel.isVoiceBased()
            ) {
                console.error(
                    "[WaitingRoom] Kanał głosowy jest niedostępny."
                );
                return;
            }

            voiceChannel = updatedVoiceChannel;

            const humans = getHumanMembers();

            // Kanał pusty: zatrzymaj muzykę i wyzeruj oczekiwanie.
            if (humans.length === 0) {
                humansPresent = false;
                initialNotificationSent = false;
                supportWasPresent = false;

                clearNotificationTimers();
                stopMusic();

                return;
            }

            humansPresent = true;

            // Jeśli bot jest już połączony, uruchom muzykę.
            playMusic();

            const supportPresent = hasSupportMember();

            if (supportPresent) {
                // Osoba z odpowiednią rolą jest na kanale:
                // zatrzymaj nowe powiadomienia.
                clearNotificationTimers();
                supportWasPresent = true;

                return;
            }

            if (supportWasPresent) {
                // Obsługa opuściła kanał, ale ktoś nadal czeka.
                supportWasPresent = false;

                if (initialNotificationSent) {
                    scheduleReminder();
                } else {
                    scheduleInitialNotification();
                }

                return;
            }

            if (!initialNotificationSent) {
                // Pierwszy ping po 10 sekundach oczekiwania.
                scheduleInitialNotification();
            } else {
                // Kolejne pingi co 5 minut.
                scheduleReminder();
            }
        } catch (error) {
            console.error(
                "[WaitingRoom] Błąd sprawdzania poczekalni:",
                error
            );
        }
    }

    // =============================================
    // POŁĄCZENIE GŁOSOWE I PONOWNE ŁĄCZENIE
    // =============================================

    function scheduleReconnect() {
        if (reconnectTimer) return;

        reconnectTimer = setTimeout(() => {
            reconnectTimer = null;
            void connectToWaitingRoom();
        }, RECONNECT_DELAY);

        reconnectTimer.unref?.();
    }

    async function recoverConnection(disconnectedConnection) {
        if (recovering) return;

        recovering = true;

        try {
            await Promise.race([
                entersState(
                    disconnectedConnection,
                    VoiceConnectionStatus.Signalling,
                    5_000
                ),
                entersState(
                    disconnectedConnection,
                    VoiceConnectionStatus.Connecting,
                    5_000
                )
            ]);
        } catch {
            if (connection === disconnectedConnection) {
                try {
                    disconnectedConnection.destroy();
                } catch {
                    // Połączenie mogło już zostać zamknięte.
                }

                connection = null;
                scheduleReconnect();
            }
        } finally {
            recovering = false;
        }
    }

    async function connectToWaitingRoom() {
        if (connecting) return;

        connecting = true;

        try {
            const channel = await client.channels.fetch(
                WAITING_VOICE_CHANNEL_ID
            );

            if (!channel || !channel.isVoiceBased()) {
                console.error(
                    "[WaitingRoom] Podane ID nie wskazuje kanału głosowego."
                );
                return;
            }

            voiceChannel = channel;

            const newConnection = joinVoiceChannel({
                channelId: channel.id,
                guildId: channel.guild.id,
                adapterCreator: channel.guild.voiceAdapterCreator,

                // Bot pozostaje połączony również wtedy,
                // gdy aktualnie nic nie odtwarza.
                selfDeaf: true
            });

            connection = newConnection;
            newConnection.subscribe(player);

            newConnection.on("error", error => {
                console.error(
                    "[WaitingRoom] Błąd połączenia głosowego:",
                    error
                );
            });

            newConnection.on("stateChange", (oldState, newState) => {
                if (newState.status === VoiceConnectionStatus.Ready) {
                    void syncPresence();
                }

                if (
                    newState.status === VoiceConnectionStatus.Disconnected
                ) {
                    void recoverConnection(newConnection);
                }
            });

            await entersState(
                newConnection,
                VoiceConnectionStatus.Ready,
                30_000
            );

            console.log(
                "[WaitingRoom] Bot połączony z kanałem poczekalni."
            );

            await syncPresence();
        } catch (error) {
            console.error(
                "[WaitingRoom] Nie udało się połączyć z poczekalnią:",
                error
            );

            if (
                connection &&
                connection.state.status !== VoiceConnectionStatus.Destroyed
            ) {
                try {
                    connection.destroy();
                } catch {
                    // Połączenie mogło być już zamknięte.
                }
            }

            connection = null;
            scheduleReconnect();
        } finally {
            connecting = false;
        }
    }

    // =============================================
    // EVENTY DISCORDA
    // =============================================

    client.on("voiceStateUpdate", (oldState, newState) => {
        if (
            oldState.channelId === WAITING_VOICE_CHANNEL_ID ||
            newState.channelId === WAITING_VOICE_CHANNEL_ID
        ) {
            void syncPresence();
        }
    });

    // Gdy komuś zmieni się rola podczas oczekiwania,
    // od razu ponownie sprawdź, czy jest już obsługa.
    client.on("guildMemberUpdate", (oldMember, newMember) => {
        const wasSupport = oldMember.roles.cache.some(role =>
            SUPPORT_ROLE_IDS.has(role.id)
        );

        const isSupport = newMember.roles.cache.some(role =>
            SUPPORT_ROLE_IDS.has(role.id)
        );

        if (
            wasSupport !== isSupport &&
            newMember.voice.channelId === WAITING_VOICE_CHANNEL_ID
        ) {
            void syncPresence();
        }
    });

    client.once("ready", () => {
        console.log("[WaitingRoom] Uruchamianie modułu poczekalni...");
        void connectToWaitingRoom();
    });
};
