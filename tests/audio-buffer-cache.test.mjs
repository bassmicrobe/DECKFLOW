import test from 'node:test';
import assert from 'node:assert/strict';
import {AudioBufferCache} from '../dist/audio-buffer-cache.js';

const deferred = () => { let resolve, reject; const promise = new Promise((yes, no) => {resolve = yes; reject = no;}); return {promise, resolve, reject}; };
const flush = () => new Promise(resolve => setImmediate(resolve));
const pcm = (id, bytes = 16) => ({id, length: bytes / 4, numberOfChannels: 1, duration: 60});

test('file-backed PCM descriptors are reused without charging whole-file decoded memory', async () => {
  const cache = new AudioBufferCache({maxEntries: 1, maxBytes: 16});
  const resource = {kind:'pcm-file', length:268435456, numberOfChannels:2, sampleRate:44100,
    duration:268435456 / 44100, readFrames:async()=>assert.fail('cache must not read PCM')};
  assert.equal(await cache.get('large', () => resource), resource);
  assert.equal(await cache.get('large', () => assert.fail('descriptor was lost')), resource);
  assert.equal(cache.stats.bytes, 0);
  assert.equal(cache.stats.entries, 1);
  await cache.get('small', () => pcm('small'));
  assert.equal(cache.stats.entries, 1);
  assert.equal(cache.stats.evictions, 1);
});

test('cache deduplicates a pending load and shares the same PCM without invoking another loader', async () => {
  const cache = new AudioBufferCache(), wait = deferred();
  let calls = 0;
  const a = cache.get('A', () => { calls++; return wait.promise; });
  const b = cache.get('A', () => { throw new Error('duplicate decode'); });
  assert.equal(a, b);
  await flush();
  assert.equal(calls, 1);
  const buffer = pcm('A'); wait.resolve(buffer);
  assert.equal(await a, buffer);
  assert.equal(await b, buffer);
  assert.equal(await cache.get('A', () => { throw new Error('cache miss'); }), buffer);
  assert.deepEqual(cache.stats, {hits:1, misses:1, shared:1, evictions:0, entries:1, bytes:16, pending:0});
});

test('different track decoders run serially and rejected work does not block a retry', async () => {
  const cache = new AudioBufferCache(), wait = deferred(), starts = [];
  const a = cache.get('A', () => {starts.push('A'); return wait.promise;});
  const rejected = assert.rejects(a, /bad audio/);
  const b = cache.get('B', () => {starts.push('B'); return pcm('B');});
  await flush();
  assert.deepEqual(starts, ['A']);
  wait.reject(new Error('bad audio'));
  await rejected;
  assert.equal((await b).id, 'B');
  assert.deepEqual(starts, ['A', 'B']);
  assert.equal((await cache.get('A', () => pcm('repaired A'))).id, 'repaired A');
  assert.equal(cache.stats.pending, 0);
});

test('least recently used entries are evicted by both entry count and total PCM bytes', async () => {
  const cache = new AudioBufferCache({maxBytes:40, maxEntries:2});
  const a = await cache.get('A', () => pcm('A'));
  await cache.get('B', () => pcm('B'));
  assert.equal(await cache.get('A', () => assert.fail('A should be retained')), a);
  await cache.get('C', () => pcm('C', 24));
  assert.equal(cache.stats.bytes, 40);
  assert.equal(cache.stats.evictions, 1);
  const newB = await cache.get('B', () => pcm('new B', 32));
  assert.equal(newB.id, 'new B');
  assert.equal(cache.stats.entries, 1);
  assert.equal(cache.stats.bytes, 32);
  assert.equal(cache.stats.evictions, 3);
});

test('buffers exceeding the memory cap can play but are not retained or evict existing entries', async () => {
  const cache = new AudioBufferCache({maxBytes:16});
  const a = await cache.get('A', () => pcm('A'));
  const large = pcm('large', 32);
  assert.equal(await cache.get('large', () => large), large);
  assert.equal(cache.stats.bytes, 16);
  assert.equal(cache.stats.entries, 1);
  assert.equal(cache.stats.evictions, 0);
  assert.equal(await cache.get('A', () => assert.fail('small buffer was evicted')), a);
  let reloaded = false;
  await cache.get('large', () => {reloaded = true; return large;});
  assert.equal(reloaded, true);
});

test('delete and clear prevent stale pending work from repopulating the cache', async () => {
  for (const method of ['delete', 'clear']) {
    const cache = new AudioBufferCache(), wait = deferred();
    await cache.get('saved', () => pcm('saved'));
    const old = cache.get('A', () => wait.promise);
    await flush();
    cache[method]('A');
    const next = cache.get('A', () => pcm('new A'));
    wait.resolve(pcm('old A'));
    assert.equal((await old).id, 'old A');
    assert.equal((await next).id, 'new A');
    assert.equal((await cache.get('A', () => assert.fail('new A not cached'))).id, 'new A');
    assert.equal(cache.stats.entries, method === 'clear' ? 1 : 2);
    cache.clear();
    assert.equal(cache.stats.bytes, 0);
    assert.equal(cache.stats.entries, 0);
  }
});

test('queue bound includes invalidated pending work and permits coalescing at the limit', async () => {
  const cache = new AudioBufferCache({maxPending:1}), wait = deferred();
  const a = cache.get('A', () => wait.promise);
  assert.equal(cache.get('A', () => assert.fail('duplicate')), a);
  cache.clear();
  await assert.rejects(cache.get('B', () => pcm('B')), /音源を準備/);
  assert.equal(cache.stats.pending, 1);
  wait.resolve(pcm('A')); await a;
  assert.equal(cache.stats.entries, 0);
  assert.equal((await cache.get('B', () => pcm('B'))).id, 'B');
});

test('malformed PCM cannot poison the cache and zero retention remains usable', async () => {
  const cache = new AudioBufferCache();
  for (const invalid of [null, {}, pcm('bad', 1), {...pcm('bad'), numberOfChannels:Infinity}, {...pcm('bad'), duration:0}]) {
    await assert.rejects(cache.get('A', () => invalid), /音源の形式/);
    assert.equal(cache.stats.entries, 0);
    assert.equal(cache.stats.pending, 0);
  }
  const uncached = new AudioBufferCache({maxEntries:0});
  assert.equal((await uncached.get('A', () => pcm('A'))).id, 'A');
  assert.equal(uncached.stats.entries, 0);
  for (const options of [{maxBytes:-1}, {maxEntries:1.1}, {maxPending:0}]) assert.throws(() => new AudioBufferCache(options), TypeError);
});
