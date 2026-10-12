import cjs from './index.js';

export const {
  Ytdlm,
  streamAudio,
  createSabrAudioStream,
  streamContinuous,
  createContinuousAudioStream,
  downloadAudio,
  downloadSabrAudio,
  getInfo,
  resolveSabrContext,
  searchVideos,
  extractVideoId,
  sanitizeFilename,
  getGuestVisitorData,
  normalizePlaybackSpeed,
  buildAtempoFilter,
  MIN_PLAYBACK_SPEED,
  MAX_PLAYBACK_SPEED,
  startServer,
  auth,
  webm,
  protobuf,
  decipher,
} = cjs;

export default cjs;
