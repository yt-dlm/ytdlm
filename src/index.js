'use strict';

const {
  createSabrAudioStream,
  createContinuousAudioStream,
  downloadSabrAudio,
} = require('./sabr-stream');
const {
  extractVideoId,
  sanitizeFilename,
  getGuestVisitorData,
  loadStoredAuth,
  clearStoredAuth,
  requestTvDeviceCode,
  pollTvDeviceToken,
  getValidTvAccessToken,
  searchVideos,
  resolveSabrContext,
} = require('./innertube');
const { decipherSabrUrl, getPlayerContext } = require('./decipher');
const { startServer } = require('./server');
const {
  parseAndPatchWebmInit,
  buildStreamingWebmInit,
  buildSeekableWebmFile,
  WebmClusterAssembler,
} = require('./webm');
const {
  buildFormatIdMsg,
  buildClientInfoMsg,
  buildAbrRequestBytes,
  demuxUmp,
} = require('./protobuf');

/**
 * High-level helper to get clean track metadata + SABR stream info.
 */
async function getInfo(videoIdOrQuery, options = {}) {
  const ctx = await resolveSabrContext(videoIdOrQuery, options);
  return {
    videoId: ctx.videoId,
    url: `https://www.youtube.com/watch?v=${ctx.videoId}`,
    title: ctx.title,
    author: ctx.author,
    durationSec: ctx.durationSec,
    durationMs: ctx.durationMs,
    thumbnail: ctx.thumbnail,
    itag: ctx.itag,
    mimeType: ctx.mimeType,
    bitrate: ctx.bitrate,
    sampleRate: ctx.sampleRate,
    channels: ctx.channels,
    isGuest: ctx.isGuest,
    mode: ctx.mode,
    filename: sanitizeFilename(ctx.title, ctx.author, ctx.itag),
  };
}

class Ytdlm {
  constructor(defaultOptions = {}) {
    this.defaultOptions = defaultOptions;
  }

  stream(videoIdOrQuery, options = {}) {
    return createSabrAudioStream(videoIdOrQuery, { ...this.defaultOptions, ...options });
  }

  streamContinuous(tracksOrProvider, options = {}) {
    return createContinuousAudioStream(tracksOrProvider, { ...this.defaultOptions, ...options });
  }

  download(videoIdOrQuery, outputPath = null, options = {}) {
    return downloadSabrAudio(videoIdOrQuery, outputPath, { ...this.defaultOptions, ...options });
  }

  getInfo(videoIdOrQuery, options = {}) {
    return getInfo(videoIdOrQuery, { ...this.defaultOptions, ...options });
  }

  search(query, limit = 5) {
    return searchVideos(query, limit);
  }

  serve(options = {}) {
    return startServer({ ...this.defaultOptions, ...options });
  }
}

module.exports = {
  Ytdlm,
  streamAudio: createSabrAudioStream,
  createSabrAudioStream,
  streamContinuous: createContinuousAudioStream,
  createContinuousAudioStream,
  downloadAudio: downloadSabrAudio,
  downloadSabrAudio,
  getInfo,
  resolveSabrContext,
  searchVideos,
  extractVideoId,
  sanitizeFilename,
  getGuestVisitorData,
  startServer,
  auth: {
    loadStoredAuth,
    clearStoredAuth,
    requestTvDeviceCode,
    pollTvDeviceToken,
    getValidTvAccessToken,
  },
  webm: {
    parseAndPatchWebmInit,
    buildStreamingWebmInit,
    buildSeekableWebmFile,
    WebmClusterAssembler,
  },
  protobuf: {
    buildFormatIdMsg,
    buildClientInfoMsg,
    buildAbrRequestBytes,
    demuxUmp,
  },
  decipher: {
    decipherSabrUrl,
    getPlayerContext,
  },
};
