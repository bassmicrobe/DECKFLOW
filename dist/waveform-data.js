/** Compact display envelopes. These never estimate or change musical preparation. */
export const WAVEFORM_VERSION = 1;
export const WAVEFORM_FIELDS = ['min', 'max', 'low', 'mid', 'high'];
export const DEFAULT_WAVEFORM_FPS = 150;
export const MAX_WAVEFORM_FRAMES = 300_000;

function integer(value, min, max, name) {
  if (!Number.isSafeInteger(value) || value < min || value > max) throw new RangeError(`${name} is invalid.`);
  return value;
}
export function waveformDimensions(buffer) {
  const sourceLength = integer(buffer?.length, 1, 2_147_483_647, 'Audio length');
  const channels = integer(buffer?.numberOfChannels, 1, 32, 'Audio channels');
  const sampleRate = buffer?.sampleRate;
  if (!Number.isFinite(sampleRate) || sampleRate < 1000 || sampleRate > 384000) throw new RangeError('Audio sample rate is invalid.');
  const duration = sourceLength / sampleRate;
  if (duration > 86400) throw new RangeError('Audio duration is invalid.');
  return {sourceLength, channels, sampleRate, duration};
}

/** Sequential chunks retain filter state, so chunk boundaries never become attacks. */
export function createWaveformAccumulator({sourceLength, channels, sampleRate}, {framesPerSecond = DEFAULT_WAVEFORM_FPS, maxFrames = MAX_WAVEFORM_FRAMES} = {}) {
  const dimensions = waveformDimensions({length: sourceLength, numberOfChannels: channels, sampleRate});
  if (!Number.isFinite(framesPerSecond) || framesPerSecond < 1 || framesPerSecond > 1000) throw new RangeError('Waveform rate is invalid.');
  integer(maxFrames, 1, MAX_WAVEFORM_FRAMES, 'Waveform frame limit');
  const requestedFrames = Math.ceil(dimensions.duration * framesPerSecond);
  const frameCount = Math.min(sourceLength, maxFrames, Math.max(1, requestedFrames));
  const envelopes = Object.fromEntries(WAVEFORM_FIELDS.map(name => [name, new Float32Array(frameCount)]));
  const bass = new Float64Array(channels), upper = new Float64Array(channels);
  const bassAlpha = 1 - Math.exp(-2 * Math.PI * 250 / sampleRate);
  const upperAlpha = 1 - Math.exp(-2 * Math.PI * 2500 / sampleRate);
  let consumed = 0, finished = false;
  return {
    append(chunk) {
      if (finished) throw new Error('Waveform has already finished.');
      if (!Array.isArray(chunk) || chunk.length !== channels || !chunk.every(value => value instanceof Float32Array)) throw new TypeError('Waveform channels are invalid.');
      const length = chunk[0].length;
      if (!length || !chunk.every(value => value.length === length) || consumed + length > sourceLength) throw new RangeError('Waveform chunk length is invalid.');
      for (let offset = 0; offset < length; offset++) {
        const bin = Math.min(frameCount - 1, Math.floor((consumed + offset) * frameCount / sourceLength));
        for (let channel = 0; channel < channels; channel++) {
          const sample = Number.isFinite(chunk[channel][offset]) ? chunk[channel][offset] : 0;
          bass[channel] += bassAlpha * (sample - bass[channel]);
          upper[channel] += upperAlpha * (sample - upper[channel]);
          // Preserve channel extrema rather than averaging opposite-phase audio.
          envelopes.min[bin] = Math.max(envelopes.min[bin], -sample);
          envelopes.max[bin] = Math.max(envelopes.max[bin], sample);
          envelopes.low[bin] = Math.max(envelopes.low[bin], Math.abs(bass[channel]));
          envelopes.mid[bin] = Math.max(envelopes.mid[bin], Math.abs(upper[channel] - bass[channel]));
          envelopes.high[bin] = Math.max(envelopes.high[bin], Math.abs(sample - upper[channel]));
        }
      }
      consumed += length;
    },
    finish() {
      if (finished || consumed !== sourceLength) throw new Error('Waveform audio is incomplete.');
      finished = true;
      const result = {
        version: WAVEFORM_VERSION, ...dimensions, frameCount,
        framesPerSecond: frameCount / dimensions.duration,
        requestedFramesPerSecond: framesPerSecond,
        reducedResolution: frameCount < requestedFrames,
      };
      for (const name of WAVEFORM_FIELDS) result[name] = Uint8Array.from(envelopes[name], value => Math.round(Math.min(1, Math.max(0, value)) * 255));
      return result;
    },
  };
}

/** Pure entry point for fixtures and short buffers; production uses the Worker. */
export function buildWaveform(channels, sampleRate, options) {
  if (!Array.isArray(channels) || !channels.length) throw new TypeError('Waveform channels are invalid.');
  const builder = createWaveformAccumulator({sourceLength: channels[0]?.length, channels: channels.length, sampleRate}, options);
  builder.append(channels);
  return builder.finish();
}

export function validateWaveform(value) {
  if (!value || value.version !== WAVEFORM_VERSION) throw new TypeError('Waveform version is invalid.');
  const dimensions = waveformDimensions({length: value.sourceLength, numberOfChannels: value.channels, sampleRate: value.sampleRate});
  integer(value.frameCount, 1, Math.min(MAX_WAVEFORM_FRAMES, value.sourceLength), 'Waveform frames');
  if (Math.abs(value.duration - dimensions.duration) > 1e-9 || !Number.isFinite(value.duration) ||
      !Number.isFinite(value.framesPerSecond) || Math.abs(value.framesPerSecond - value.frameCount / value.duration) > 1e-6 ||
      !Number.isFinite(value.requestedFramesPerSecond) || value.requestedFramesPerSecond < 1 || value.requestedFramesPerSecond > 1000 ||
      typeof value.reducedResolution !== 'boolean' || value.reducedResolution !== (value.frameCount < Math.ceil(value.duration * value.requestedFramesPerSecond))) {
    throw new TypeError('Waveform dimensions are invalid.');
  }
  for (const name of WAVEFORM_FIELDS) if (!(value[name] instanceof Uint8Array) || value[name].length !== value.frameCount) throw new TypeError('Waveform envelope is invalid.');
  return value;
}

export const waveformBytes = waveform => WAVEFORM_FIELDS.reduce((sum, name) => sum + waveform[name].byteLength, 0);
