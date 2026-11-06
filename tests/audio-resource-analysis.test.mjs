import test from 'node:test';
import assert from 'node:assert/strict';
import {analyzeAudioResource, audioResourcePeaks} from '../dist/audio-resource-analysis.js';
import {analyzeSamples} from '../dist/analysis.js';

function resource({length = 1024 ** 3 / 4, sampleRate = 44100, silent = false} = {}) {
  const reads = [];
  return {kind: 'pcm-file', sampleRate, numberOfChannels: 3, length, duration: length / sampleRate,
    maxReadFrames: 32768, reads,
    async readFrames(start, count) {
      assert.ok(count <= 32768, 'analysis must chunk its reads');
      reads.push({start, count});
      const pulse = Float32Array.from({length: count}, (_, index) => {
        if (silent) return 0;
        const time = (start + index) / sampleRate, phase = ((time - .125) % .5 + .5) % .5;
        return Math.sin(2 * Math.PI * 60 * time) * Math.exp(-phase * 35);
      });
      return [new Float32Array(count), pulse, Float32Array.from(pulse, value => -value)];
    },
  };
}

test('1 GiB-equivalent analysis uses three bounded sections and preserves absolute BPM phase', async () => {
  const audio = resource(), sections = [];
  const result = await analyzeAudioResource(audio, {analyze: async (samples, sampleRate) => {
    sections.push(samples.length / sampleRate);
    assert.ok(samples.length <= 40 * 24000);
    return analyzeSamples(samples, sampleRate);
  }});
  assert.equal(result.duration, audio.duration);
  assert.equal(sections.length, 3);
  assert.ok(sections.every(duration => duration <= 40));
  assert.ok(Math.abs(result.bpm - 120) < .5, `BPM ${result.bpm}`);
  assert.ok(Math.abs(result.beatOffset - .125) < .04, `offset ${result.beatOffset}`);
  assert.equal(result.peaks.length, 900);
  assert.ok(result.peaks.some(peak => peak > 0));
  assert.ok(audio.reads.reduce((sum, item) => sum + item.count, 0) < 8_000_000);
  assert.ok(audio.reads.some(item => item.start > audio.length * .9));
});

test('display-only peaks never estimate BPM and silence does not acquire a made-up tempo', async () => {
  const audio = resource({length: 48000 * 6, sampleRate: 48000, silent: true});
  const peaks = await audioResourcePeaks(audio);
  assert.ok(peaks.every(value => value === 0));
  const result = await analyzeAudioResource(audio);
  assert.equal(result.bpm, null);
  assert.equal(result.beatOffset, 0);
  assert.equal(result.confidence, 0);
  assert.equal(result.duration, 6);
});

test('analysis aborts before reads and fails explicitly for malformed PCM pages', async () => {
  const controller = new AbortController(); controller.abort();
  const audio = resource();
  await assert.rejects(analyzeAudioResource(audio, {signal: controller.signal}), {name: 'AbortError'});
  assert.equal(audio.reads.length, 0);
  await assert.rejects(audioResourcePeaks({...audio, readFrames: async () => [new Float32Array(1)]}), /音声/);
});
