import test from 'node:test';
import assert from 'node:assert/strict';
import {AUDIO_CHUNK_BYTES, validateAudioDescriptor, readStoredAudio} from '../dist/audio-chunk-store.js';

const descriptor = (patch = {}) => ({format: 'deckflow.audio-chunks', version: 1,
  prefix: '@audio/00000000-0000-4000-8000-000000000000/', chunkSize: AUDIO_CHUNK_BYTES,
  count: 1, size: 3, type: 'audio/wav', ...patch});
const read = (value, chunks = []) => new Promise((resolve, reject) => {
  const store = {get(key) {
    const request = {};
    queueMicrotask(() => { request.result = chunks[Number(key.slice(key.lastIndexOf('/') + 1))]; request.onsuccess(); });
    return request;
  }};
  readStoredAudio(store, value, resolve, reject);
});

test('owned descriptors validate sizes and reserved prefixes without imposing a large-audio cap', () => {
  for (const size of [0, 3, 1024 ** 3, 8 * 1024 ** 3]) {
    const value = descriptor({size, count: Math.ceil(size / AUDIO_CHUNK_BYTES)});
    assert.equal(validateAudioDescriptor(value), value);
  }
  for (const patch of [{version: 2}, {prefix: 'track-1'}, {prefix: '@audio/../../'},
    {size: -1}, {size: Number.MAX_SAFE_INTEGER + 1}, {count: 0}, {count: 1.5},
    {chunkSize: 1}, {type: 'audio/wav\n'}, {type: 'x'.repeat(256)}]) {
    assert.throws(() => validateAudioDescriptor(descriptor(patch)), /分割データ/);
  }
});

test('stored audio reads preserve legacy Blob and missing/empty audio behavior', async () => {
  const legacy = new Blob(['legacy bytes'], {type: 'audio/wav'});
  assert.equal(await (await read(legacy)).text(), 'legacy bytes');
  assert.equal(await read(undefined), null);
  const empty = await read(descriptor({count: 0, size: 0}));
  assert.equal(empty.size, 0);
  assert.equal(empty.type, 'audio/wav');
});

test('owned audio restores ordered chunks and rejects missing, malformed or short chunks', async () => {
  const value = descriptor({size: AUDIO_CHUNK_BYTES + 3, count: 2});
  const first = new Blob([new Uint8Array(AUDIO_CHUNK_BYTES).fill(42)]), last = new Blob(['end']);
  const audio = await read(value, [first, last]);
  assert.equal(audio.size, value.size);
  assert.equal(audio.type, 'audio/wav');
  assert.equal(await audio.slice(AUDIO_CHUNK_BYTES).text(), 'end');
  assert.ok(new Uint8Array(await audio.slice(0, AUDIO_CHUNK_BYTES).arrayBuffer()).every(byte => byte === 42));
  for (const chunks of [[first], [first, 'end'], [first, new Blob(['short'])], [new Blob(['too short']), last]]) {
    await assert.rejects(read(value, chunks), /分割データ/);
  }
  await assert.rejects(read({...value, prefix: 'other-track'}), /分割データ/);
});
