import test from 'node:test';
import assert from 'node:assert/strict';
import {openAudioFile, readWavInfo, isPcmFileResource} from '../dist/audio-resource.js';
import {wavHeader, sparseWave} from './helpers/wav-fixture.mjs';

test('an unavailable source file produces an actionable local-language error', async () => {
  const cause = new DOMException('File backing disappeared', 'NotFoundError');
  const file = {size:44,slice:()=>({arrayBuffer:async()=>{throw cause;}})};
  await assert.rejects(openAudioFile(file, {}), error => /元の音源.*読み取れません/.test(error.message) && error.cause === cause);
});

test('a virtual 1 GiB WAV opens and seeks with bounded slices and no full-file decode', async () => {
  const file = sparseWave({dataBytes: 1024 ** 3, sampleRate: 44100}, (offset) => [0, 64, 0, 192][offset % 4]);
  const resource = await openAudioFile(file, {decodeAudioData() { assert.fail('large WAV must not decode in full'); }});
  assert.ok(isPcmFileResource(resource));
  assert.equal(resource.length, 1024 ** 3 / 4);
  assert.equal(resource.duration, resource.length / 44100);
  assert.equal(resource.numberOfChannels, 2);
  const channels = await resource.readFrames(resource.length - 3, 32768);
  assert.deepEqual(channels, [new Float32Array([.5, .5, .5]), new Float32Array([-.5, -.5, -.5])]);
  assert.ok(file.reads.every(([start, end]) => end - start <= 8 * 1024 ** 2));
  assert.ok(file.reads.reduce((sum, [start, end]) => sum + end - start, 0) < 1024);
  await assert.rejects(resource.readFrames(0, resource.maxReadFrames + 1), /読み取り/);
  await assert.rejects(resource.readFrames(.5, 1), /読み取り/);
  assert.deepEqual(await resource.readFrames(-10, 1), [new Float32Array([.5]), new Float32Array([-.5])]);
  assert.deepEqual(await resource.readFrames(resource.length, 1), [new Float32Array(), new Float32Array()]);
});

test('small browser formats and small WAV keep native decoding without an arbitrary duration rejection', async () => {
  const decoded = {duration: 7200, length: 7200 * 8000, sampleRate: 8000, numberOfChannels: 1};
  const context = {decodeAudioData: async bytes => {assert.ok(bytes instanceof ArrayBuffer); return decoded;}};
  assert.equal(await openAudioFile(new Blob([new Uint8Array([1, 2, 3])]), context), decoded);
  assert.equal(await openAudioFile(new Blob([wavHeader(), new Uint8Array(16)]), context), decoded);
  await assert.rejects(openAudioFile(new Blob([]), context), /音声/);
  await assert.rejects(openAudioFile(new Blob(['not audio']), {decodeAudioData: async () => {throw new Error('decoder details');}}), /音声/);
});

test('PCM16, 24, 32 and floating-point WAV samples decode precisely with all channels retained', async () => {
  for (const [bits, format, samples] of [
    [16, 1, new Uint8Array([0, 128, 0, 64])],
    [24, 1, new Uint8Array([0, 0, 128, 0, 0, 64])],
    [32, 1, new Uint8Array([0, 0, 0, 128, 0, 0, 0, 64])],
    [32, 3, new Uint8Array(new Float32Array([-1, .5]).buffer)],
    [64, 3, new Uint8Array(new Float64Array([-1, .5]).buffer)],
  ]) {
    const blockAlign = bits / 8 * 2;
    const dataBytes = Math.floor(128 * 1024 ** 2 / blockAlign) * blockAlign;
    const file = sparseWave({dataBytes, bits, format}, offset => samples[offset % samples.length]);
    const resource = await openAudioFile(file, {});
    assert.deepEqual(await resource.readFrames(0, 1), [new Float32Array([-1]), new Float32Array([.5])]);
  }
});

test('extensible PCM and float headers support valid container precision and unknown padded chunks', async () => {
  for (const format of [1, 3]) {
    const file = sparseWave({dataBytes: 64 * 1024 ** 2, bits: 32, format, extensible: true, validBits: format === 1 ? 24 : 32, extraBytes: 3});
    const info = await readWavInfo(file);
    assert.equal(info.format, format === 1 ? 'pcm' : 'float');
    assert.equal(info.bitsPerSample, 32);
    assert.equal(info.dataOffset, 80);
  }
});

test('floating WAV keeps finite headroom for the mixer and removes nonfinite samples', async () => {
  const samples = new Uint8Array(new Float32Array([2, -2, NaN, Infinity]).buffer);
  const file = sparseWave({dataBytes: 128 * 1024 ** 2, bits: 32, format: 3}, offset => samples[offset % samples.length]);
  const resource = await openAudioFile(file, {});
  assert.deepEqual(await resource.readFrames(0, 2), [new Float32Array([2, 0]), new Float32Array([-2, 0])]);
});

test('truncated headers, invalid frame geometry and unsupported format descriptors are rejected before reading audio', async () => {
  for (const mutate of [
    bytes => new DataView(bytes.buffer).setUint32(4, 0xffffffff, true),
    bytes => new DataView(bytes.buffer).setUint16(22, 0, true),
    bytes => new DataView(bytes.buffer).setUint32(24, 0, true),
    bytes => new DataView(bytes.buffer).setUint16(32, 3, true),
    bytes => new DataView(bytes.buffer).setUint32(bytes.length - 4, 15, true),
    bytes => new DataView(bytes.buffer).setUint32(16, 10, true),
  ]) {
    const bytes = wavHeader(); mutate(bytes);
    await assert.rejects(readWavInfo(new Blob([bytes, new Uint8Array(16)])), /WAV/);
  }
  const badGuid = wavHeader({extensible: true}); badGuid[59] = 0;
  await assert.rejects(readWavInfo(new Blob([badGuid, new Uint8Array(16)])), /WAV/);
  const badExtension = wavHeader({extensible: true}); new DataView(badExtension.buffer).setUint16(36, 64, true);
  await assert.rejects(readWavInfo(new Blob([badExtension, new Uint8Array(16)])), /WAV/);
  assert.equal(await readWavInfo(new Blob(['not a WAVE container'])), null);
  const aborted = new AbortController(); aborted.abort();
  await assert.rejects(readWavInfo(sparseWave(), {signal: aborted.signal}), {name: 'AbortError'});
});

test('a huge unknown RIFF chunk is skipped without copying it into memory', async () => {
  const junkBytes = 1024 ** 3, dataBytes = 16, first = wavHeader({dataBytes: junkBytes + dataBytes + 8});
  first.set(new TextEncoder().encode('JUNK'), 36);
  new DataView(first.buffer).setUint32(40, junkBytes, true);
  const second = new Uint8Array(8); second.set(new TextEncoder().encode('data'));
  new DataView(second.buffer).setUint32(4, dataBytes, true);
  const reads = [];
  const file = {size: first.length + junkBytes + second.length + dataBytes,
    slice(start, end) { reads.push(end - start); return {async arrayBuffer() {
      const out = new Uint8Array(end - start);
      if (start < first.length) out.set(first.subarray(start, end));
      if (start === first.length + junkBytes) out.set(second);
      return out.buffer;
    }};},
  };
  const info = await readWavInfo(file);
  assert.equal(info.dataOffset, first.length + junkBytes + second.length);
  assert.equal(info.length, 4);
  assert.ok(reads.reduce((sum, length) => sum + length, 0) < 100);
  const resource = await openAudioFile({...file, arrayBuffer: () => assert.fail('large ancillary chunks must never be read in full')}, {});
  assert.ok(isPcmFileResource(resource));
  assert.deepEqual(await resource.readFrames(0, 4), [new Float32Array(4), new Float32Array(4)]);
});
