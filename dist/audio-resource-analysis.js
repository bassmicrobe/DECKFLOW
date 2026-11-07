import {isPcmFileResource} from './audio-resource.js?v=e321e49da3ca54c5';
import {analyzeSamples} from './analysis.js?v=e321e49da3ca54c5';

const PAGE_FRAMES = 32768;
const PEAK_COUNT = 900;
const PEAK_WINDOW_FRAMES = 1024;
const SECTION_SECONDS = 40;
const ANALYSIS_RATE = 22050;
const yieldTask = () => new Promise(resolve => setTimeout(resolve, 0));

function dimensions(resource) {
  if (!isPcmFileResource(resource) || !Number.isFinite(resource.duration) || resource.duration <= 0 ||
      Math.abs(resource.duration - resource.length / resource.sampleRate) > 1e-6 || resource.sampleRate < 1000 || resource.sampleRate > 384000) {
    throw new TypeError('解析する音声データの形式を確認してください。');
  }
  const limit = resource.maxReadFrames ?? PAGE_FRAMES;
  if (!Number.isSafeInteger(limit) || limit < 1) throw new TypeError('音声の読み取り上限を確認してください。');
  return Math.min(PAGE_FRAMES, limit);
}

async function read(resource, start, count, signal) {
  signal?.throwIfAborted();
  const channels = await resource.readFrames(start, count, {signal});
  signal?.throwIfAborted();
  if (!Array.isArray(channels) || channels.length !== resource.numberOfChannels ||
      !channels.every(channel => channel instanceof Float32Array && channel.length === count)) {
    throw new Error('音声チャンネルの読み取り結果が一致しません。');
  }
  return channels;
}

/** Sample a small window in every overview bin, including the file's tail.
 * This is a sampled display envelope, not a full-file maximum or beat analysis.
 */
export async function audioResourcePeaks(resource, {signal, onProgress = () => {}} = {}) {
  const page = dimensions(resource), count = Math.min(PEAK_COUNT, resource.length);
  const peaks = [];
  for (let index = 0; index < count; index++) {
    const begin = Math.floor(index * resource.length / count), end = Math.floor((index + 1) * resource.length / count);
    const frames = Math.min(PEAK_WINDOW_FRAMES, page, end - begin);
    const start = begin + Math.floor((end - begin - frames) / 2);
    const channels = await read(resource, start, frames, signal);
    let peak = 0;
    for (const channel of channels) for (const value of channel) if (Number.isFinite(value)) peak = Math.max(peak, Math.abs(value));
    peaks.push(Math.min(1, peak));
    if (index % 32 === 0) { onProgress(`全体波形を確認しています ${index + 1} / ${count}`); await yieldTask(); }
  }
  signal?.throwIfAborted();
  return peaks;
}

async function dominantChannel(resource, start, frames, page, signal) {
  if (resource.numberOfChannels === 1) return 0;
  const count = Math.min(frames, page), energy = new Float64Array(resource.numberOfChannels);
  const starts = [...new Set([0, Math.floor((frames - count) / 2), frames - count])];
  for (const offset of starts) {
    const channels = await read(resource, start + offset, count, signal);
    for (let channel = 0; channel < channels.length; channel++) {
      for (const value of channels[channel]) if (Number.isFinite(value)) energy[channel] += value * value;
    }
  }
  return Array.from(energy).reduce((best, value, index) => value > energy[best] ? index : best, 0);
}

async function sectionInput(resource, start, frames, page, signal) {
  const channel = await dominantChannel(resource, start, frames, page, signal);
  const step = Math.max(1, Math.floor(resource.sampleRate / ANALYSIS_RATE));
  const samples = new Float32Array(Math.ceil(frames / step));
  for (let offset = 0; offset < frames; offset += page) {
    const count = Math.min(page, frames - offset), channels = await read(resource, start + offset, count, signal);
    const values = channels[channel];
    for (let index = 0; index < count; index++) {
      const bin = Math.floor((offset + index) / step);
      const divisor = Math.min(step, frames - bin * step);
      samples[bin] += (Number.isFinite(values[index]) ? values[index] : 0) / divisor;
    }
    if (offset % (page * 8) === 0) await yieldTask();
  }
  return {samples, sampleRate: resource.sampleRate / step};
}

/** Three independent sections avoid treating unsampled gaps as beat intervals.
 * Each section is at most 40 seconds; its phase is translated to file time.
 */
export async function analyzeAudioResource(resource, {signal, onProgress = () => {}, analyze = analyzeSamples} = {}) {
  const page = dimensions(resource);
  if (typeof analyze !== 'function') throw new TypeError('音声解析の処理を確認してください。');
  const peaks = await audioResourcePeaks(resource, {signal, onProgress});
  const frames = Math.min(resource.length, Math.floor(SECTION_SECONDS * resource.sampleRate));
  const starts = [...new Set([0, Math.floor((resource.length - frames) / 2), resource.length - frames])];
  const candidates = [];
  for (const [index, start] of starts.entries()) {
    onProgress(`BPMを確認しています ${index + 1} / ${starts.length}`);
    const input = await sectionInput(resource, start, frames, page, signal);
    const result = await analyze(input.samples, input.sampleRate);
    signal?.throwIfAborted();
    if (!result || !Number.isFinite(result.confidence) || result.confidence < 0 || result.confidence > 1 ||
        !Number.isFinite(result.beatOffset) || (result.bpm !== null && (!Number.isFinite(result.bpm) || result.bpm < 30 || result.bpm > 300))) {
      throw new Error('音声解析の結果を確認できませんでした。');
    }
    if (result.bpm !== null) candidates.push({...result, startSeconds: start / resource.sampleRate});
  }
  const best = candidates.reduce((chosen, candidate) => !chosen || candidate.confidence > chosen.confidence ? candidate : chosen, null);
  if (!best) return {bpm: null, confidence: 0, beatOffset: 0, peaks, duration: resource.duration};
  const period = 60 / best.bpm;
  const agreement = candidates.filter(candidate => Math.abs(candidate.bpm - best.bpm) < 1).length / candidates.length;
  return {bpm: best.bpm, confidence: Math.round(best.confidence * agreement * 100) / 100,
    beatOffset: Math.round(((best.startSeconds + best.beatOffset) % period) * 1000) / 1000,
    peaks, duration: resource.duration};
}
