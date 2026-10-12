'use strict';

/**
 * SDK & Production Multi-Guild Music Manager for Discord.js v14 & @discordjs/voice
 * ================================================================================
 * Features:
 * 1. Unlimited Concurrent Multi-Guild Streaming: Each Guild has its own isolated
 *    `GuildMusicSession` with O(1) memory (~512 KB per voice channel).
 * 2. Zero-FFmpeg Direct WebM/Opus Pipe (`StreamType.WebmOpus`).
 * 3. Continuous 24/7 Radio / Queue Auto-Advance & Loop (`track` / `queue`).
 * 4. Instant Real-Time Seeking (`seek(ms)`) without downloading the file.
 */

const { streamAudio, streamContinuous, getInfo, searchVideos } = require('../../src/index');

/**
 * Plays a single YouTube URL or search query on a @discordjs/voice AudioPlayer.
 */
async function playOnDiscordVoice(audioPlayer, urlOrQuery, options = {}) {
  const { createAudioResource, StreamType } = require('@discordjs/voice');

  const opusStream = streamAudio(urlOrQuery, {
    itag: options.itag || 251,
    guest: options.guest ?? true,
    startTimeMs: options.startTimeMs || 0,
    loop: Boolean(options.loop),
  });

  const trackInfo = await opusStream.getInfo();

  const resource = createAudioResource(opusStream, {
    inputType: StreamType.WebmOpus,
    inlineVolume: false,
    metadata: trackInfo,
  });

  audioPlayer.play(resource);
  return { trackInfo, stream: opusStream, resource };
}

/**
 * Multi-Guild Concurrent & 24/7 Continuous Music Manager for Discord.js v14
 */
class DiscordMusicManager {
  constructor(defaultOptions = { itag: 251, guest: true }) {
    this.defaultOptions = defaultOptions;
    this.guilds = new Map(); // guildId -> GuildSession
  }

  getOrCreateSession(guildId, voiceConnection) {
    let session = this.guilds.get(guildId);
    if (!session) {
      const { createAudioPlayer, AudioPlayerStatus, NoSubscriberBehavior } = require('@discordjs/voice');
      const player = createAudioPlayer({
        behaviors: {
          noSubscriber: NoSubscriberBehavior.Continue, // Keep playing in 24/7 mode
        },
      });

      session = {
        guildId,
        connection: voiceConnection,
        player,
        queue: [],
        currentTrack: null,
        currentStream: null,
        loopMode: 'off', // 'off' | 'track' | 'queue'
        radioProvider: null, // Optional async () => nextQuery for 24/7 auto-radio
      };

      voiceConnection.subscribe(player);

      player.on(AudioPlayerStatus.Idle, () => {
        this._advanceQueue(guildId).catch(err => {
          console.error(`[ytdlm][Guild ${guildId}] Queue advance error:`, err.message);
        });
      });

      this.guilds.set(guildId, session);
    } else if (voiceConnection && session.connection !== voiceConnection) {
      session.connection = voiceConnection;
      voiceConnection.subscribe(session.player);
    }
    return session;
  }

  async enqueue(guildId, voiceConnection, urlOrQuery) {
    const session = this.getOrCreateSession(guildId, voiceConnection);
    const info = await getInfo(urlOrQuery, this.defaultOptions);
    session.queue.push(info);

    const { AudioPlayerStatus } = require('@discordjs/voice');
    if (session.player.state.status === AudioPlayerStatus.Idle && !session.currentTrack) {
      await this._advanceQueue(guildId);
    }
    return info;
  }

  async seek(guildId, positionMs) {
    const session = this.guilds.get(guildId);
    if (!session || !session.currentTrack) return null;
    if (session.currentStream) {
      session.currentStream.destroy();
    }
    const { trackInfo, stream } = await playOnDiscordVoice(
      session.player,
      session.currentTrack.videoId,
      {
        ...this.defaultOptions,
        startTimeMs: Math.max(0, Number(positionMs) || 0),
        loop: session.loopMode === 'track',
      }
    );
    session.currentStream = stream;
    return trackInfo;
  }

  setLoopMode(guildId, mode = 'off') {
    const session = this.guilds.get(guildId);
    if (session) session.loopMode = mode; // 'off' | 'track' | 'queue'
  }

  set247RadioProvider(guildId, asyncProviderFn) {
    const session = this.guilds.get(guildId);
    if (session) session.radioProvider = asyncProviderFn;
  }

  skip(guildId) {
    const session = this.guilds.get(guildId);
    if (!session) return;
    if (session.currentStream) {
      session.currentStream.destroy();
      session.currentStream = null;
    }
    session.player.stop(true);
  }

  destroyGuild(guildId) {
    const session = this.guilds.get(guildId);
    if (!session) return;
    if (session.currentStream) session.currentStream.destroy();
    session.player.stop(true);
    try {
      session.connection?.destroy();
    } catch (e) {}
    this.guilds.delete(guildId);
  }

  async _advanceQueue(guildId) {
    const session = this.guilds.get(guildId);
    if (!session) return;

    if (session.currentStream) {
      session.currentStream.destroy();
      session.currentStream = null;
    }

    let nextItem = null;
    if (session.loopMode === 'track' && session.currentTrack) {
      nextItem = session.currentTrack;
    } else if (session.queue.length > 0) {
      nextItem = session.queue.shift();
      if (session.loopMode === 'queue' && session.currentTrack) {
        session.queue.push(session.currentTrack);
      }
    } else if (typeof session.radioProvider === 'function') {
      const nextQuery = await session.radioProvider(session.currentTrack);
      if (nextQuery) {
        nextItem = await getInfo(nextQuery, this.defaultOptions);
      }
    }

    if (!nextItem) {
      session.currentTrack = null;
      return;
    }

    session.currentTrack = nextItem;
    const { stream } = await playOnDiscordVoice(session.player, nextItem.videoId, {
      ...this.defaultOptions,
      loop: session.loopMode === 'track',
    });
    session.currentStream = stream;
  }
}

module.exports = {
  playOnDiscordVoice,
  DiscordMusicManager,
  streamAudio,
  streamContinuous,
  getInfo,
  searchVideos,
};
