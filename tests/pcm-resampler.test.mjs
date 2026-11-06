import test from 'node:test';
import assert from 'node:assert/strict';
import {createPcmResampler} from '../dist/pcm-resampler.js';
import * as resamplers from '../dist/pcm-resampler.js';

function toneGain({sourceRate,outputRate,tone,rate = 1}) {
  const step = sourceRate / outputRate * rate;
  const resampler = createPcmResampler(step);
  const start = resampler.radius * 2;
  const count = 4096;
  const samples = Array.from({length:count}, (_, i) => resampler.sample(start + i * step,
    frame => Math.sin(2 * Math.PI * tone * frame / sourceRate)));
  return Math.sqrt(2 * samples.reduce((sum, sample) => sum + sample * sample, 0) / count);
}

test('downsampling removes ultrasonic tones rather than aliasing them into audible output', () => {
  assert.ok(toneGain({sourceRate:96000,outputRate:48000,tone:30000}) < .001);
  assert.ok(toneGain({sourceRate:96000,outputRate:48000,tone:42000}) < .001);
  assert.ok(toneGain({sourceRate:48000,outputRate:48000,tone:20000,rate:1.5}) < .001);
  assert.ok(toneGain({sourceRate:384000,outputRate:48000,tone:30000}) < .001);
});

test('audible passband survives sample-rate conversion and fractional playback rates', () => {
  for (const options of [
    {sourceRate:96000,outputRate:48000,tone:10000},
    {sourceRate:44100,outputRate:48000,tone:10000},
    {sourceRate:48000,outputRate:44100,tone:8000,rate:1.25},
    {sourceRate:384000,outputRate:48000,tone:10000},
  ]) assert.ok(Math.abs(toneGain(options) - 1) < .01, JSON.stringify(options));
});

test('unity samples remain exact and fractional interpolation preserves DC without gaps', () => {
  const resampler = createPcmResampler(1);
  const reads = [];
  assert.equal(resampler.sample(5, frame => {reads.push(frame); return frame === 5 ? .625 : null;}), .625);
  assert.deepEqual(reads,[5]);
  for (const position of [50,50.0001,50.25,50.9999,51]) {
    assert.ok(Math.abs(resampler.sample(position, () => .375) - .375) < 1e-6);
  }
  const pcm = Array.from({length:100}, (_, i) => Math.sin(i / 10));
  assert.ok(Math.abs(resampler.sample(50.9999, frame => pcm[frame]) - resampler.sample(51.0001, frame => pcm[frame])) < .001);
});

test('missing pages suspend sampling and per-sample work has a fixed upper bound', () => {
  const resampler = createPcmResampler(2);
  assert.equal(resampler.sample(100.25, () => null), null);
  const visited = [];
  assert.ok(Number.isFinite(resampler.sample(100.25, frame => {visited.push(frame); return .5;})));
  assert.ok(visited.length <= 64);
  assert.ok(Math.max(...visited) - Math.min(...visited) <= 63);
  assert.ok(resampler.radius <= 32);
  const extreme = createPcmResampler(64), calls = [];
  assert.ok(Number.isFinite(extreme.sample(1000.25, frame => {calls.push(frame); return .5;})));
  assert.ok(calls.length <= 256); assert.ok(extreme.radius <= 128);
  for (const step of [0,-1,NaN,Infinity]) assert.throws(() => createPcmResampler(step), RangeError);
});

test('serialized kernels reconstruct the same audio without computing trigonometric coefficients', () => {
  const original = createPcmResampler(2.125);
  const kernel = structuredClone(original.kernel);
  const previousSin = Math.sin, previousCos = Math.cos;
  let reconstructed;
  try {
    Math.sin = Math.cos = () => {throw new Error('Coefficient generation reached the audio thread.');};
    reconstructed = resamplers.createPcmResamplerFromKernel(kernel);
    assert.ok(Math.abs(reconstructed.sample(100.25, () => .5) - .5) < 1e-6);
  } finally {Math.sin = previousSin; Math.cos = previousCos;}
  const tone = frame => Math.sin(frame / 10);
  for (const position of [100,100.125,100.5,100.999]) {
    assert.equal(reconstructed.sample(position,tone),original.sample(position,tone));
  }
  assert.notEqual(kernel.values.buffer,original.kernel.values.buffer);
});

test('kernel messages reject malformed dimensions, detached storage and nonfinite coefficients', () => {
  const kernel = createPcmResampler(2).kernel;
  for (const change of [{radius:0}, {radius:129}, {radius:32.5}, {taps:1}, {phases:1},
    {identity:1}, {values:[]}, {values:new Float32Array(1)},
    {values:new Float32Array(kernel.values.length).fill(NaN)},
    {values:new Float32Array(kernel.values.length).fill(Infinity)}]) {
    assert.throws(() => resamplers.createPcmResamplerFromKernel({...kernel,...change}), /kernel/i);
  }
  const detached = structuredClone(kernel);
  structuredClone(detached.values,{transfer:[detached.values.buffer]});
  assert.throws(() => resamplers.createPcmResamplerFromKernel(detached), /kernel/i);
  for (const value of [null,undefined,{},[]]) assert.throws(() => resamplers.createPcmResamplerFromKernel(value), /kernel/i);
});
