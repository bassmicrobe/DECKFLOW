import test from 'node:test';
import assert from 'node:assert/strict';
import {AUDIO_CHUNK_BYTES, validateAudioDescriptor, readStoredAudio, withOwnedAudio} from '../dist/audio-chunk-store.js';

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

// Commit each transaction only after its async boundary. Observers can then
// distinguish queued bytes from durable staging bytes without a real browser.
function copyHarness(t, {failChunkAt = Infinity} = {}) {
  const original = Object.getOwnPropertyDescriptor(globalThis, 'IDBKeyRange');
  Object.defineProperty(globalThis, 'IDBKeyRange', {configurable: true,
    value: {bound: (lower, upper) => ({lower, upper})}});
  t.after(() => original ? Object.defineProperty(globalThis, 'IDBKeyRange', original) : delete globalThis.IDBKeyRange);
  let data = new Map(), chunks = 0, publications = 0;
  const transaction = async (_stores, _mode, run) => {
    const draft = new Map(data);let reject = false;
    const store = {
      put(value, key) { draft.set(key, value);if (value instanceof Blob && ++chunks === failChunkAt) reject = true; },
      delete(key) {
        if (typeof key === 'string') draft.delete(key);
        else for (const candidate of draft.keys()) if (candidate >= key.lower && candidate <= key.upper) draft.delete(candidate);
      },
      openCursor() { const request = {};queueMicrotask(() => request.onsuccess());return request; },
    };
    run({objectStore: () => store});
    await Promise.resolve();
    if (reject) throw new Error('chunk transaction failed');
    data = draft;
  };
  return {transaction,
    commit: async (audio, stageKey) => { publications++;data.set('saved-track', audio);data.delete(stageKey);return 'published'; },
    bytes: () => [...data.values()].reduce((sum, value) => sum + (value instanceof Blob ? value.size : 0), 0),
    size: () => data.size,
    publications: () => publications,
  };
}

test('copy progress reports only committed bytes including the exact final partial chunk', async t => {
  const harness = copyHarness(t), progress = [], size = AUDIO_CHUNK_BYTES * 2 + 7;
  const result = await withOwnedAudio(new Blob([new Uint8Array(size)]), harness.transaction, harness.commit,
    {onProgress: value => progress.push({...value, staged: harness.bytes(), published: harness.publications()})});
  assert.equal(result, 'published');
  assert.deepEqual(progress.map(value => value.completed), [0, AUDIO_CHUNK_BYTES, AUDIO_CHUNK_BYTES * 2, size]);
  for (const value of progress) {
    assert.equal(value.total, size);
    assert.equal(value.completed, value.staged);
    assert.equal(value.published, 0, 'byte progress precedes final track publication');
  }
  assert.equal(harness.publications(), 1);
});

test('failed chunk writes never advance progress and all staged audio is cleaned', async t => {
  const harness = copyHarness(t, {failChunkAt: 2}), progress = [];
  await assert.rejects(withOwnedAudio(new Blob([new Uint8Array(AUDIO_CHUNK_BYTES * 2 + 7)]), harness.transaction, harness.commit,
    {onProgress: value => progress.push(value.completed)}), /chunk transaction failed/);
  assert.deepEqual(progress, [0, AUDIO_CHUNK_BYTES]);
  assert.equal(harness.publications(), 0);
  assert.equal(harness.size(), 0);
});

test('cancelled copies stop byte progress without publishing and remove staged audio', async t => {
  const harness = copyHarness(t), controller = new AbortController(), progress = [];
  await assert.rejects(withOwnedAudio(new Blob([new Uint8Array(AUDIO_CHUNK_BYTES * 2 + 7)]), harness.transaction, harness.commit,
    {signal: controller.signal, onProgress: value => {
      progress.push(value.completed);if (value.completed) controller.abort();
    }}), {name: 'AbortError'});
  assert.deepEqual(progress, [0, AUDIO_CHUNK_BYTES]);
  assert.equal(harness.publications(), 0);
  assert.equal(harness.size(), 0);
});

test('throwing or rejecting progress observers cannot interrupt a successful save', async t => {
  const harness = copyHarness(t);let notifications = 0;
  const result = await withOwnedAudio(new Blob([new Uint8Array(AUDIO_CHUNK_BYTES + 7)]), harness.transaction, harness.commit,
    {onProgress: () => {
      if (++notifications === 1) throw new Error('observer failed');
      return Promise.reject(new Error('async observer failed'));
    }});
  assert.equal(result, 'published');
  assert.equal(notifications, 3);
  assert.equal(harness.publications(), 1);
});
