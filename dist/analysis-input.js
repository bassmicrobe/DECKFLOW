import {waveformDimensions} from './waveform-data.js?v=88e0687b343dbe25';

const ANALYSIS_SAMPLE_RATE = 22050;

/** Build an owned PCM input; transferring it must not detach playback audio. */
export function createAnalysisInput(buffer) {
  if (typeof buffer?.getChannelData !== 'function') throw new TypeError('解析する音声データを確認してください。');
  const {sourceLength, channels: channelCount, sampleRate} = waveformDimensions(buffer);
  const channels = Array.from({length: channelCount}, (_, index) => buffer.getChannelData(index));
  if (!channels.every(channel => channel instanceof Float32Array && channel.length === sourceLength)) {
    throw new TypeError('解析する音声チャンネルの長さを確認してください。');
  }
  // Choose one complete channel before downsampling. Summing stereo can erase
  // audible opposite-phase audio; changing channels per sample adds transients.
  // Only references and one output array are retained, regardless of channels.
  const dominant = channels.length === 1 ? channels[0] : channels.reduce((best, channel) => {
    let energy = 0;
    for (let index = 0; index < sourceLength; index++) {
      const value = channel[index];
      if (Number.isFinite(value)) energy += value * value;
    }
    return energy > best.energy ? {channel, energy} : best;
  }, {channel: channels[0], energy: -1}).channel;
  const step = Math.max(1, Math.floor(sampleRate / ANALYSIS_SAMPLE_RATE));
  const samples = new Float32Array(Math.ceil(sourceLength / step));
  for (let index = 0; index < samples.length; index++) {
    let value = 0, count = 0;
    for (let position = index * step; position < Math.min((index + 1) * step, sourceLength); position++) {
      value += Number.isFinite(dominant[position]) ? dominant[position] : 0;
      count++;
    }
    samples[index] = value / count;
  }
  return {samples, sampleRate: sampleRate / step};
}
