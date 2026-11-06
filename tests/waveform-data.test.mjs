import test from 'node:test';
import assert from 'node:assert/strict';
import {buildWaveform, createWaveformAccumulator, validateWaveform, waveformBytes, waveformDimensions, WAVEFORM_FIELDS} from '../dist/waveform-data.js';

const sr = 12000;
const peak = array => array.reduce((max, value) => Math.max(max, value), 0);

test('short transients, both polarities and the final sample survive 150 Hz envelopes', () => {
  const samples = new Float32Array(sr);
  samples[800] = 0.8; samples[880] = -0.6; samples[samples.length - 1] = 1;
  const result = buildWaveform([samples], sr);
  assert.equal(result.frameCount, 150);
  assert.equal(result.framesPerSecond, 150);
  assert.equal(result.max[10], 204);
  assert.equal(result.min[11], 153);
  assert.equal(result.max[149], 255);
  assert.equal(result.max[9], 0);
  assert.equal(result.reducedResolution, false);
  assert.equal(waveformBytes(result), 750);
});

test('stereo anti-phase retains extrema and all envelope work leaves PCM intact', () => {
  const left = Float32Array.from({length: sr}, (_, i) => Math.sin(i * 2 * Math.PI * 80 / sr) * .8);
  const right = Float32Array.from(left, value => -value);
  const before = left.slice();
  const mono = buildWaveform([left], sr), stereo = buildWaveform([left, right], sr);
  assert.deepEqual(stereo.low, mono.low);
  assert.ok(peak(stereo.max) >= 203 && peak(stereo.min) >= 203);
  assert.deepEqual(left, before);
  assert.equal(stereo.channels, 2);
});

test('low, mid and high tones make their corresponding envelope dominant', () => {
  const rate = 44100;
  for (const [frequency, expected] of [[60, 'low'], [800, 'mid'], [9000, 'high']]) {
    const samples = Float32Array.from({length: rate}, (_, i) => Math.sin(i * 2 * Math.PI * frequency / rate) * .8);
    const wave = buildWaveform([samples], rate);
    const mean = name => wave[name].subarray(15).reduce((a, b) => a + b, 0) / (wave.frameCount - 15);
    for (const other of ['low', 'mid', 'high'].filter(name => name !== expected)) assert.ok(mean(expected) > mean(other) * 1.3, `${frequency} Hz: ${expected} > ${other}`);
  }
});

test('chunk boundaries preserve the same waveform and filter state as one pass', () => {
  const channels = [Float32Array.from({length: 24931}, (_, i) => Math.sin(i * .13) * .5), Float32Array.from({length: 24931}, (_, i) => Math.cos(i * .89) * .4)];
  const whole = buildWaveform(channels, sr);
  const accumulator = createWaveformAccumulator({sourceLength: channels[0].length, channels: 2, sampleRate: sr});
  for (let start = 0; start < channels[0].length; start += 997) accumulator.append(channels.map(channel => channel.subarray(start, start + 997)));
  assert.deepEqual(accumulator.finish(), whole);
  assert.throws(() => accumulator.finish(), /incomplete/);
});

test('silence stays silent, nonfinite samples are sanitized, clipping stays bounded', () => {
  const silence = buildWaveform([new Float32Array(sr)], sr);
  for (const name of WAVEFORM_FIELDS) assert.equal(peak(silence[name]), 0);
  const bad = new Float32Array(sr); bad[1] = NaN; bad[2] = Infinity; bad[3] = -Infinity;
  for (const name of WAVEFORM_FIELDS) assert.equal(peak(buildWaveform([bad], sr)[name]), 0);
  bad[5] = 2; bad[6] = -2;
  const clipped = buildWaveform([bad], sr);
  assert.equal(peak(clipped.max), 255); assert.equal(peak(clipped.min), 255);
});

test('limited frame budgets cover the complete track and expose reduced resolution', () => {
  const samples = new Float32Array(sr * 4); samples[samples.length - 1] = -1;
  const result = buildWaveform([samples], sr, {maxFrames: 80});
  assert.equal(result.frameCount, 80); assert.equal(result.framesPerSecond, 20);
  assert.equal(result.requestedFramesPerSecond, 150); assert.equal(result.reducedResolution, true);
  assert.equal(result.min[79], 255);
});

test('rejects incomplete chunks, invalid formats and malformed cache envelopes', () => {
  const accumulator = createWaveformAccumulator({sourceLength: 100, channels: 1, sampleRate: sr});
  assert.throws(() => accumulator.finish(), /incomplete/);
  assert.throws(() => accumulator.append([new Float32Array(101)]), /length/);
  assert.throws(() => buildWaveform([], sr), /channels/);
  assert.throws(() => waveformDimensions({length: 3, numberOfChannels: 0, sampleRate: sr}), /channels/);
  assert.throws(() => buildWaveform([new Float32Array(3)], 0), /rate/);
  assert.throws(() => buildWaveform([new Float32Array(3)], sr, {maxFrames: 300001}), /limit/);
  const result = buildWaveform([new Float32Array(sr)], sr);
  assert.equal(validateWaveform(result), result);
  for (const patch of [{version: 2}, {frameCount: 0}, {low: []}, {min: new Uint8Array(3)}, {framesPerSecond: NaN}, {duration: Infinity}, {reducedResolution: true}]) assert.throws(() => validateWaveform({...result, ...patch}));
});
