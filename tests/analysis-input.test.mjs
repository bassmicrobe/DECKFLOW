import test from 'node:test';
import assert from 'node:assert/strict';
import {createAnalysisInput} from '../dist/analysis-input.js';
import {analyzeSamples} from '../dist/analysis.js';

const sampleRate = 44100;
const pulses = Float32Array.from({length: sampleRate * 12}, (_, index) => {
  const time = index / sampleRate;
  return Math.sin(2 * Math.PI * 60 * time) * Math.exp(-(time % .5) * 35);
});
const audio = channels => ({sampleRate, length: channels[0].length,
  numberOfChannels: channels.length, getChannelData: index => channels[index]});
const analyze = channels => {
  const input = createAnalysisInput(audio(channels));
  return {...input, result: analyzeSamples(input.samples, input.sampleRate)};
};

test('mono analysis retains the existing downsampling, 120 BPM and nonzero peaks', () => {
  const {samples, sampleRate: rate, result} = analyze([pulses]);
  const expected = Float32Array.from({length: pulses.length / 2}, (_, index) =>
    (pulses[index * 2] + pulses[index * 2 + 1]) / 2);
  assert.ok(samples.every((value, index) => value === expected[index]));
  assert.equal(rate, 22050);
  assert.ok(Math.abs(result.bpm - 120) < .5);
  assert.ok(result.peaks.some(value => value > 0));
  assert.equal(result.duration, 12);
});

test('opposite-phase stereo retains the same BPM and waveform as the audible channel', () => {
  const inverse = Float32Array.from(pulses, value => -value);
  const expected = analyze([pulses]);
  const actual = analyze([pulses, inverse]);
  assert.equal(actual.result.bpm, expected.result.bpm);
  assert.deepEqual(actual.result.peaks, expected.result.peaks);
  assert.ok(actual.samples.every((value, index) => value === expected.samples[index]));
  assert.equal(pulses.buffer.byteLength, sampleRate * 12 * 4);
  assert.equal(inverse[100], -pulses[100]);
});

test('a silent first channel cannot hide the audible channel or change its analysis', () => {
  const expected = analyze([pulses]);
  const actual = analyze([new Float32Array(pulses.length), pulses]);
  assert.equal(actual.result.bpm, expected.result.bpm);
  assert.deepEqual(actual.result.peaks, expected.result.peaks);
  assert.ok(actual.samples.every((value, index) => value === expected.samples[index]));
});

test('all-silent channels remain silent and a partial final downsampling frame is retained', () => {
  const silent = analyze([new Float32Array(pulses.length), new Float32Array(pulses.length)]);
  assert.equal(silent.result.bpm, null);
  assert.ok(silent.result.peaks.every(value => value === 0));
  const input = createAnalysisInput(audio([new Float32Array([1, 3, 2, 4, 5])]));
  assert.deepEqual(input.samples, new Float32Array([2, 3, 5]));
});

test('malformed channels are rejected and nonfinite samples cannot contaminate the analysis', () => {
  assert.throws(() => createAnalysisInput({sampleRate, length: 4, numberOfChannels: 2,
    getChannelData: () => new Float32Array(3)}), /音声/);
  assert.throws(() => createAnalysisInput({sampleRate, length: 4, numberOfChannels: 1}), /音声/);
  const input = createAnalysisInput(audio([new Float32Array([NaN, Infinity, .5, -.5])]));
  assert.ok(input.samples.every(Number.isFinite));
  assert.deepEqual(input.samples, new Float32Array(2));
});
