import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import vm from 'node:vm';

async function processorFrom(path, sampleRate = 48000) {
  const source = await readFile(new URL(path, import.meta.url), 'utf8');
  let Processor;
  const messages = [];
  const sandbox = {
    sampleRate, Float32Array, Float64Array, Int32Array, Uint32Array, Math, Number,
    console: {log() {}, info() {}, warn() {}, error() {}},
    AudioWorkletProcessor: class {constructor() {this.port = {onmessage: null, postMessage: message => messages.push(message)};}},
    registerProcessor(_name, implementation) {Processor = implementation;},
  };
  vm.runInNewContext(source, sandbox, {filename: path});
  return {processor: new Processor({processorOptions: {}}), messages};
}

const rms = samples => Math.sqrt(samples.reduce((sum, sample) => sum + sample * sample, 0) / samples.length);

function frequency(samples, sampleRate) {
  // Positive zero crossings on a steady sine, after the processor's warm-up.
  const crossings = [];
  for (let index = 1; index < samples.length; index++) {
    if (samples[index - 1] <= 0 && samples[index] > 0) {
      crossings.push(index - 1 + -samples[index - 1] / (samples[index] - samples[index - 1]));
    }
  }
  return (crossings.length - 1) * sampleRate / (crossings.at(-1) - crossings[0]);
}

for (const rate of [0.92, 1.08, 1.25]) {
  test(`vendored SoundTouch preserves 440/660 Hz at source rate ${rate}`, async () => {
    const sampleRate = 48000;
    const {processor} = await processorFrom('../dist/vendor/soundtouchjs/packages/audio-worklet/.dist/soundtouch-processor.js', sampleRate);
    const left = [], right = [];
    const parameters = {pitch: new Float32Array([1]), pitchSemitones: new Float32Array([0]), playbackRate: new Float32Array([rate])};
    for (let block = 0; block < 1600; block++) {
      const input = [new Float32Array(128), new Float32Array(128)];
      const output = [new Float32Array(128), new Float32Array(128)];
      for (let frame = 0; frame < 128; frame++) {
        const time = (block * 128 + frame) / sampleRate;
        input[0][frame] = Math.sin(2 * Math.PI * 440 * rate * time) * 0.5;
        input[1][frame] = Math.sin(2 * Math.PI * 660 * rate * time) * 0.5;
      }
      processor.process([input], [output], parameters);
      if (block >= 600) {left.push(...output[0]); right.push(...output[1]);}
    }
    assert.ok(left.every(Number.isFinite) && right.every(Number.isFinite));
    assert.ok(rms(left) > 0.2 && rms(right) > 0.2, 'audio must stay audible after warm-up');
    assert.ok(Math.abs(frequency(left, sampleRate) - 440) < 3, `left: ${frequency(left, sampleRate)}`);
    assert.ok(Math.abs(frequency(right, sampleRate) - 660) < 4, `right: ${frequency(right, sampleRate)}`);
  });
}

test('scratch DSP renders fractional forward and reverse movement, then settles to silence', async () => {
  const sampleRate = 48000;
  const {processor, messages} = await processorFrom('../dist/scratch-worklet.js', sampleRate);
  const pcm = new Float32Array(sampleRate * 4);
  for (let index = 0; index < pcm.length; index++) pcm[index] = Math.sin(2 * Math.PI * 110 * index / sampleRate) * 0.5;
  processor.port.onmessage({data: {type: 'load', id: 1, sampleRate, channels: [pcm]}});
  assert.equal(messages[0].type, 'ready');
  processor.port.onmessage({data: {type: 'begin', position: 1}});
  const render = () => {
    const output = [new Float32Array(128), new Float32Array(128)];
    processor.process([], [output]);
    assert.deepEqual(output[0], output[1], 'mono input must feed both output channels');
    assert.ok(output[0].every(Number.isFinite));
    return output[0];
  };
  const forward = [];
  for (let block = 0; block < 100; block++) {
    processor.port.onmessage({data: {type: 'target', position: 1 + block * 128 / sampleRate * 0.8}});
    forward.push(...render());
  }
  const forwardPosition = processor.position;
  assert.ok(forwardPosition > sampleRate * 1.1);
  assert.ok(rms(forward) > 0.1);
  assert.ok(forwardPosition % 1 !== 0, 'transport must retain fractional sample positions');
  const reverse = [];
  let reversedBlocks = 0;
  for (let block = 0; block < 100; block++) {
    const before = processor.position;
    processor.port.onmessage({data: {type: 'target', position: forwardPosition / sampleRate - block * 128 / sampleRate * 0.8}});
    reverse.push(...render());
    if (processor.position < before) reversedBlocks++;
  }
  assert.ok(reversedBlocks > 90, 'the audio-thread read head must actually move backward');
  assert.ok(rms(reverse) > 0.1, 'reverse movement must produce audio');
  let settled;
  for (let block = 0; block < 500; block++) settled = render();
  assert.ok(rms(settled) < 0.0001, 'a stationary platter must not emit a held DC sample');
  processor.port.onmessage({data: {type: 'end'}});
  assert.equal(rms(render()), 0);
});

test('scratch boundaries and disposal remain finite and silent', async () => {
  const {processor} = await processorFrom('../dist/scratch-worklet.js');
  processor.port.onmessage({data: {type: 'load', id: 2, sampleRate: 48000, channels: [Float32Array.from([0, 1, -1, 0])]}});
  processor.port.onmessage({data: {type: 'begin', position: -200}});
  processor.port.onmessage({data: {type: 'target', position: 10000}});
  const output = [new Float32Array(128)];
  for (let index = 0; index < 50; index++) processor.process([], [output]);
  assert.ok(output[0].every(Number.isFinite));
  assert.ok(processor.position >= 0 && processor.position <= 3);
  processor.port.onmessage({data: {type: 'dispose'}});
  processor.process([], [output]);
  assert.equal(rms(output[0]), 0);
});
