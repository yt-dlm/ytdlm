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

const {
  streamAudio,
  streamContinuous,
  getInfo,
  searchVideos,
  normalizePlaybackSpeed,
  buildAtempoFilter,
} = require('../../src/index');

/**
 * Plays a single YouTube URL or search query on a @discordjs/voice AudioPlayer.
 */
async function playOnDiscordVoice(audioPlayer, urlOrQuery, options = {}) {
  const { createAudioResource, StreamType } = require('@discordjs/voice');
  const speed = normalizePlaybackSpeed(options.speed);

  const opusStream = streamAudio(urlOrQuery, {
    itag: options.itag || 251,
    guest: options.guest ?? true,
    startTimeMs: options.startTimeMs || 0,
    loop: Boolean(options.loop),
    speed,
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
  constructor(defaultOptions = { itag: 251, guest: true, speed: 1.0 }) {
    this.defaultOptions = {
      ...defaultOptions,
      speed: normalizePlaybackSpeed(defaultOptions.speed),
    };
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
        startedAtMs: 0,
        offsetMs: 0,
        speed: normalizePlaybackSpeed(this.defaultOptions.speed),
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

  async enqueue(guildId, voiceConnection, urlOrQuery, options = {}) {
    const session = this.getOrCreateSession(guildId, voiceConnection);
    if (options.speed !== undefined) {
      session.speed = normalizePlaybackSpeed(options.speed);
    }
    const info = await getInfo(urlOrQuery, { ...this.defaultOptions, speed: session.speed });
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
    const targetMs = Math.max(0, Number(positionMs) || 0);
    const { trackInfo, stream } = await playOnDiscordVoice(
      session.player,
      session.currentTrack.videoId,
      {
        ...this.defaultOptions,
        startTimeMs: targetMs,
        speed: session.speed,
        loop: session.loopMode === 'track',
      }
    );
    session.currentStream = stream;
    session.offsetMs = targetMs;
    session.startedAtMs = Date.now();
    return trackInfo;
  }

  /**
   * Dynamically adjusts playback speed (0.10x to 4.00x) in real time for a Guild session.
   */
  async setSpeed(guildId, newSpeed) {
    const session = this.guilds.get(guildId);
    if (!session) return null;
    const prevSpeed = session.speed || 1.0;
    const normalized = normalizePlaybackSpeed(newSpeed);
    session.speed = normalized;

    if (!session.currentTrack) return normalized;

    const elapsedRealMs = session.startedAtMs > 0 ? Math.max(0, Date.now() - session.startedAtMs) : 0;
    const currentPositionMs = Math.min(
      Math.max(0, (session.currentTrack.durationMs || 0) - 1000),
      Math.round(session.offsetMs + elapsedRealMs * prevSpeed)
    );
    return this.seek(guildId, currentPositionMs);
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
        nextItem = await getInfo(nextQuery, { ...this.defaultOptions, speed: session.speed });
      }
    }

    if (!nextItem) {
      session.currentTrack = null;
      return;
    }

    session.currentTrack = nextItem;
    session.offsetMs = 0;
    session.startedAtMs = Date.now();
    const { stream } = await playOnDiscordVoice(session.player, nextItem.videoId, {
      ...this.defaultOptions,
      speed: session.speed,
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
  normalizePlaybackSpeed,
  buildAtempoFilter,
};
