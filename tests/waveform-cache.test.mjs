import test from 'node:test';
import assert from 'node:assert/strict';
import {WaveformCache} from '../dist/waveform-cache.js';
import {createWaveformAccumulator} from '../dist/waveform-data.js';

const tick = () => new Promise(resolve => setTimeout(resolve, 0));
function audio(length = 12000, channelCount = 2) {
  const channels = Array.from({length: channelCount}, (_, channel) => Float32Array.from({length}, (_, i) => Math.sin(i * .07) * (channel % 2 ? -.7 : .7)));
  return {length, sampleRate: 12000, numberOfChannels: channelCount, duration: length / 12000, getChannelData: i => channels[i]};
}
function workers({defer = false, fail = false} = {}) {
  const state = {starts: 0, chunks: [], active: 0, maximumActive: 0, waiting: [], terminated: 0};
  state.factory = () => ({
    postMessage(input, transfer = []) {
      const data = structuredClone(input, {transfer});
      const reply = message => { const emit = () => this.onmessage?.({data: message}); defer ? state.waiting.push(emit) : queueMicrotask(emit); };
      if (data.type === 'start') {
        state.starts++; state.active++; state.maximumActive = Math.max(state.maximumActive, state.active);
        if (fail) { state.active--; reply({type: 'error', id: data.id, message: 'fixture failure'}); return; }
        this.accumulator = createWaveformAccumulator(data.dimensions, data.options); reply({type: 'ready', id: data.id});
      } else if (data.type === 'chunk') {
        state.chunks.push(data.channels.reduce((bytes, channel) => bytes + channel.byteLength, 0));
        this.accumulator.append(data.channels); reply({type: 'ack', id: data.id});
      } else if (data.type === 'finish') {
        state.active--; reply({type: 'result', id: data.id, waveform: this.accumulator.finish()});
      }
    },
    terminate() { state.terminated++; },
  });
  state.flush = async () => { while (state.waiting.length) { state.waiting.shift()(); await tick(); } };
  return state;
}
function cache(options = {}, fixture = workers()) { return {instance: new WaveformCache({indexedDB: undefined, workerFactory: fixture.factory, ...options}), fixture}; }

test('file-backed audio generates identical whole-track waveforms through bounded serial reads', async () => {
  const original = audio(90000), calls = [];
  let active = 0, maximumActive = 0;
  const resource = {kind:'pcm-file', length:original.length, sampleRate:original.sampleRate,
    numberOfChannels:original.numberOfChannels, duration:original.duration, maxReadFrames:4096,
    async readFrames(start, count) {
      active++; maximumActive = Math.max(active, maximumActive); calls.push([start,count]);
      await tick(); active--;
      return Array.from({length:2}, (_, channel) => original.getChannelData(channel).slice(start,start+count));
    }};
  const {instance} = cache();
  const expected = await instance.get('decoded', original);
  const actual = await instance.get('file', resource);
  assert.deepEqual(actual, expected);
  assert.equal(maximumActive, 1);
  assert.ok(calls.every(([,count]) => count <= 4096));
  assert.equal(calls.reduce((sum,[,count])=>sum+count,0), original.length);
  instance.dispose();
});

test('file read errors and cancellation release waveform work without stale posts', async () => {
  const original = audio(), resource = {kind:'pcm-file', length:original.length, sampleRate:original.sampleRate,
    numberOfChannels:2, duration:original.duration, readFrames:async()=>{throw new Error('file removed');}};
  const {instance,fixture} = cache();
  await assert.rejects(instance.get('broken', resource), /file removed/);
  assert.equal(instance.stats.pending,0);
  let finishRead;
  const pending = instance.get('canceled', {...resource, readFrames:()=>new Promise(resolve=>{finishRead=resolve;})});
  const rejected = assert.rejects(pending, /中止/);
  await tick(); instance.dispose(); await rejected;
  finishRead([new Float32Array(original.length),new Float32Array(original.length)]);
  await tick();
  assert.equal(fixture.chunks.length,0);
});

// A fault-injected derived-data store exercises cache ordering independently of
// browser IndexedDB. The real IDB backend is separately exercised in browser QA.
class StoredCache extends WaveformCache {
  constructor(store, options = {}, fixture = workers()) { super({indexedDB: undefined, workerFactory: fixture.factory, ...options}); this.store = store; this.fixture = fixture; }
  async _readDisk(job) { return this.store.get(job.diskKey)?.waveform ?? null; }
  async _findDisk(key) {
    for (const [diskKey, entry] of this.store) {
      const signature = JSON.parse(diskKey)[1], dimensions = JSON.parse(signature);
      if (entry.key === key && dimensions[4] === this.options.framesPerSecond && dimensions[5] === this.options.maxFrames) return {signature, waveform: entry.waveform};
    }
    return null;
  }
  async _writeDisk(job, waveform) { if (!job.invalidated) this.store.set(job.diskKey, {key: job.key, waveform}); }
  async _deleteDisk(key) { for (const [id, item] of this.store) if (item.key === key) this.store.delete(id); }
  async _clearDisk() { this.store.clear(); }
}

// Keep the real opening/retry path while replacing only IDB record requests.
// Successful writes are shared with a fresh cache to prove persistent reuse.
class OpeningCache extends WaveformCache {
  async _readDisk(job) { return (await this._database())?.records.get(job.diskKey) ?? null; }
  async _writeDisk(job, waveform) { (await this._database())?.records.set(job.diskKey, waveform); }
}

test('an opening timeout retries persistence, closes the late connection and preserves a successful retry', async () => {
  const records = new Map(), requests = [], connections = [], fixture = workers();
  const connection = () => ({records, closed: 0, close() { this.closed++; }});
  const indexedDB = {open() {
    const request = {}; requests.push(request);
    if (requests.length > 1) queueMicrotask(() => {
      const database = connection(); connections.push(database);
      request.result = database; request.onsuccess();
    });
    return request;
  }};
  const first = new OpeningCache({indexedDB, workerFactory: fixture.factory});
  try {
    const waveform = await first.get('slow-open', audio());
    await first.diskTail;
    assert.equal(records.size, 1, 'A timeout must not permanently disable later writes.');
    assert.equal(requests.length, 2);
    assert.equal(first.stats.diskErrors, 1);
    const late = connection(); requests[0].result = late; requests[0].onsuccess();
    assert.equal(late.closed, 1, 'Late success must close only the timed-out connection.');
    assert.equal(connections[0].closed, 0);
    const next = new OpeningCache({indexedDB, workerFactory: workers({fail: true}).factory});
    try {
      assert.equal(await next.get('slow-open', audio()), waveform);
      assert.equal(next.stats.persistentHits, 1);
      assert.equal(next.stats.generated, 0);
    } finally { next.dispose(); }
  } finally { first.dispose(); }
});

test('synchronous open errors and blocked/error events can recover without poisoning the cached promise', async () => {
  for (const failure of ['throw', 'error', 'blocked']) {
    const records = new Map(); let attempts = 0;
    const indexedDB = {open() {
      attempts++;
      if (attempts === 1 && failure === 'throw') throw new DOMException('Denied', 'SecurityError');
      const request = {};
      queueMicrotask(() => {
        if (attempts === 1) {
          request[`on${failure}`]();
          request.onerror(); // More than one failure event still counts once.
        } else { request.result = {records, close() {}}; request.onsuccess(); }
      });
      return request;
    }};
    const instance = new OpeningCache({indexedDB, workerFactory: workers().factory});
    try {
      await instance.get(failure, audio()); await instance.diskTail;
      assert.equal(records.size, 1, failure);
      assert.equal(attempts, 2, failure);
      assert.equal(instance.stats.diskErrors, 1, failure);
    } finally { instance.dispose(); }
  }
});

test('deduplicates generation, reuses RAM and transfers only bounded owned PCM copies', async () => {
  const {instance, fixture} = cache();
  const buffer = audio(90000, 16), before = buffer.getChannelData(0).slice();
  const first = instance.get('song:audio-v1', buffer), shared = instance.get('song:audio-v1', buffer);
  assert.equal(first, shared);
  const result = await first;
  assert.equal(await instance.get('song:audio-v1', buffer), result);
  assert.equal(fixture.starts, 1); assert.equal(instance.stats.shared, 1);
  assert.ok(fixture.chunks.length > 1 && Math.max(...fixture.chunks) <= 1024 * 1024);
  assert.equal(buffer.getChannelData(0).byteLength, before.byteLength);
  assert.deepEqual(buffer.getChannelData(0), before);
  instance.dispose();
});

test('serializes generation, invalidates changed dimensions and bounds LRU memory', async () => {
  const {instance, fixture} = cache({maxEntries: 1, maxBytes: 4000});
  const a = instance.get('a', audio()), b = instance.get('b', audio());
  await Promise.all([a, b]);
  assert.equal(fixture.maximumActive, 1); assert.equal(instance.stats.entries, 1);
  assert.ok(instance.stats.bytes <= 4000);
  await instance.get('b', audio(24000));
  assert.equal(fixture.starts, 3); assert.equal(instance.stats.entries, 0);
  assert.equal(instance.stats.evictions, 1);
  instance.dispose();
});

test('delete during pending work prevents RAM or disk resurrection and permits a new request', async () => {
  const store = new Map(), fixture = workers({defer: true}), instance = new StoredCache(store, {}, fixture);
  const old = instance.get('a', audio()); await tick(); await instance.delete('a');
  await fixture.flush(); await old; await instance.diskTail;
  assert.equal(instance.stats.entries, 0); assert.equal(store.size, 0);
  const next = instance.get('a', audio()); await tick(); await fixture.flush(); await next; await instance.diskTail;
  assert.equal(instance.stats.entries, 1); assert.equal(store.size, 1);
  instance.dispose();
});

test('clear deletes derived disk records and pending jobs cannot repopulate them', async () => {
  const store = new Map(), fixture = workers({defer: true}), instance = new StoredCache(store, {}, fixture);
  const first = instance.get('saved', audio()); await tick(); await fixture.flush(); await first; await instance.diskTail;
  assert.equal(store.size, 1);
  const pending = instance.get('pending', audio()); await tick(); await instance.clear();
  await fixture.flush(); await pending; await instance.diskTail;
  assert.equal(instance.stats.entries, 0); assert.equal(store.size, 0);
  instance.dispose();
});

test('dispose preserves completed persistent data, fresh instances reuse it, fingerprint changes regenerate', async () => {
  const store = new Map(), first = new StoredCache(store);
  const original = await first.get('id|fingerprint-v1', audio()); await first.diskTail; first.dispose();
  assert.equal(store.size, 1);
  const second = new StoredCache(store);
  assert.equal(await second.get('id|fingerprint-v1', audio()), original);
  assert.equal(second.fixture.starts, 0); assert.equal(second.stats.persistentHits, 1);
  await second.get('id|fingerprint-v2', audio());
  assert.equal(second.fixture.starts, 1);
  second.dispose();
});

test('optional persistent storage errors fall back to RAM without failing a waveform', async () => {
  const {instance} = cache();
  instance._readDisk = async () => { throw new Error('database unavailable'); };
  instance._writeDisk = async () => { throw Object.assign(new Error('disk full'), {name: 'QuotaExceededError'}); };
  const result = await instance.get('a', audio()); await instance.diskTail;
  assert.equal(result.frameCount, 600); assert.equal(instance.stats.diskErrors, 2);
  assert.equal(await instance.get('a', audio()), result);
  instance.dispose();
});

test('failed workers release queues; disposal cancels active and queued requests safely', async () => {
  const failing = workers({fail: true}), {instance} = cache({}, failing);
  await assert.rejects(instance.get('bad', audio()), /fixture failure/);
  assert.equal(instance.stats.pending, 0); assert.equal(failing.terminated, 1);
  instance.dispose();
  const fixture = workers({defer: true}), active = cache({maxPending: 2}, fixture).instance;
  const first = active.get('a', audio()), next = active.get('b', audio());
  const rejected = Promise.all([assert.rejects(first, /中止/), assert.rejects(next, /中止/)]);
  await assert.rejects(active.get('overflow', audio()), /準備/);
  await tick(); active.dispose(); await rejected;
  assert.equal(active.stats.pending, 0); assert.equal(active.stats.entries, 0);
  await assert.rejects(active.get('again', audio()), /中止/);
});

test('malformed audio and options are rejected before retaining work', async () => {
  const {instance, fixture} = cache();
  await assert.rejects(instance.get('', audio()), /invalid/);
  await assert.rejects(instance.get('bad', {...audio(), length: 0}), /invalid/);
  await assert.rejects(instance.get('bad', {...audio(), getChannelData: () => new Float32Array(1)}), /channels/);
  assert.equal(fixture.starts, 0); assert.equal(instance.stats.pending, 0);
  assert.throws(() => new WaveformCache({maxFrames: 600001}), /options/);
  instance.dispose();
});

test('selection restores persisted detail by fingerprint without opening or decoding audio', async () => {
  const store = new Map(), first = new StoredCache(store);
  const expected = await first.get('id|audio-v1', audio());
  await first.diskTail; first.dispose();
  const next = new StoredCache(store, {}, workers({fail: true}));
  assert.equal(await next.find('id|audio-v1'), expected);
  assert.equal(next.stats.persistentHits, 1); assert.equal(next.stats.generated, 0);
  assert.equal(await next.find('id|audio-v1'), expected);
  assert.equal(next.stats.hits, 1);
  assert.equal(await next.find('id|audio-v2'), null);
  next.dispose();
});

test('selection lookup shares existing generation and stale disk reads cannot resurrect deleted audio', async () => {
  const {instance, fixture} = cache({}, workers({defer: true}));
  const pending = instance.get('a', audio()), selected = instance.find('a');
  await tick(); await fixture.flush();
  assert.equal(await selected, await pending); assert.equal(fixture.starts, 1);
  await instance.delete('a');
  let finishRead;
  instance._findDisk = () => new Promise(resolve => { finishRead = resolve; });
  const stale = instance.find('a'); await tick();
  const deleting = instance.delete('a');
  finishRead({signature: '[]', waveform: await pending});
  assert.equal(await stale, null); await deleting;
  assert.equal(instance.stats.entries, 0);
  instance.dispose();
});
