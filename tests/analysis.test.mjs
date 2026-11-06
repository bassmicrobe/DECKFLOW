import test from 'node:test';
import assert from 'node:assert/strict';
import {analyzeSamples} from '../dist/analysis.js';

const SAMPLE_RATE = 12000;

function beatTrack(bpm, seconds = 28, {offset = 0.17, noise = false} = {}) {
  const samples = new Float32Array(Math.floor(SAMPLE_RATE * seconds));
  let seed = 42;
  if (noise) {
    for (let index = 0; index < samples.length; index += 1) {
      seed = (seed * 1664525 + 1013904223) >>> 0;
      samples[index] = (seed / 0xFFFFFFFF - 0.5) * 0.025;
    }
  }
  for (let time = offset, beat = 0; time < seconds; time += 60 / bpm, beat += 1) {
    const begin = Math.floor(time * SAMPLE_RATE);
    const accent = beat % 4 === 0 ? 1 : 0.75;
    for (let index = 0; index < SAMPLE_RATE * 0.075 && begin + index < samples.length; index += 1) {
      const elapsed = index / SAMPLE_RATE;
      samples[begin + index] += accent * Math.exp(-elapsed * 60) * Math.sin(2 * Math.PI * 90 * elapsed);
    }
  }
  return samples;
}

for (const bpm of [90, 120, 128, 174]) {
  test(`estimates ${bpm} BPM from accented kick pulses with background noise`, () => {
    const result = analyzeSamples(beatTrack(bpm, 28, {noise: true}), SAMPLE_RATE);
    assert.ok(result.bpm !== null, 'tempo is present');
    assert.ok(Math.abs(result.bpm - bpm) < 0.7, `${result.bpm} is near ${bpm}`);
    assert.ok(result.confidence >= 0.6, `confidence ${result.confidence}`);
    assert.ok(Math.abs(result.beatOffset - 0.17) < 0.08, `offset ${result.beatOffset}`);
    assert.equal(result.peaks.length, 720);
    assert.ok(result.peaks.every(value => value >= 0 && value <= 1));
    assert.equal(result.duration, 28);
  });
}

test('silence and a steady tone do not invent a BPM', () => {
  assert.equal(analyzeSamples(new Float32Array(SAMPLE_RATE * 12), SAMPLE_RATE).bpm, null);
  const tone = Float32Array.from({length: SAMPLE_RATE * 12}, (_, index) => Math.sin(2 * Math.PI * 440 * index / SAMPLE_RATE) * 0.4);
  assert.equal(analyzeSamples(tone, SAMPLE_RATE).bpm, null);
});

test('too-short audio retains waveform/duration without assigning tempo', () => {
  const result = analyzeSamples(beatTrack(128, 2), SAMPLE_RATE);
  assert.equal(result.bpm, null);
  assert.equal(result.duration, 2);
  assert.ok(Math.max(...result.peaks) > 0.9);
});

test('long audio samples more than just a silent intro', () => {
  const samples = new Float32Array(SAMPLE_RATE * 100);
  samples.set(beatTrack(128, 75, {offset: 0.17}), SAMPLE_RATE * 25);
  const result = analyzeSamples(samples, SAMPLE_RATE);
  assert.ok(result.bpm !== null && Math.abs(result.bpm - 128) < 0.7, `${result.bpm}`);
  assert.equal(result.duration, 100);
});

test('invalid input fails with a message and nonfinite samples remain bounded', () => {
  assert.throws(() => analyzeSamples(new Float32Array(), SAMPLE_RATE), /音声データ/);
  assert.throws(() => analyzeSamples(beatTrack(120), 0), /サンプルレート/);
  assert.throws(() => analyzeSamples(beatTrack(120), SAMPLE_RATE, {minBpm: 180, maxBpm: 70}), /解析範囲/);
  const bad = new Float32Array(SAMPLE_RATE * 10).fill(NaN);
  const result = analyzeSamples(bad, SAMPLE_RATE);
  assert.equal(result.bpm, null);
  assert.ok(result.peaks.every(value => Number.isFinite(value) && value === 0));
});
