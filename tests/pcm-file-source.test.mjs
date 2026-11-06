import test from 'node:test';
import assert from 'node:assert/strict';
import {PcmFileSource} from '../dist/pcm-file-source.js';

const flush = () => new Promise(resolve => setImmediate(resolve));
const deferred = () => {let resolve; const promise = new Promise(done => {resolve = done;}); return {promise, resolve};};
class Worklet {
  constructor(_context, _name, options) {
    this.options = options; this.messages = []; this.connections = new Set();
    this.port = {onmessage: null, closed: false, close() {this.closed = true;},
      postMessage: message => this.messages.push(message)};
  }
  connect(target) {this.connections.add(target); return target;}
  disconnect() {this.connections.clear();}
  emit(data) {this.port.onmessage?.({data});}
}
globalThis.AudioWorkletNode = Worklet;
const context = () => ({sampleRate: 48000, audioWorklet: {addModule: async () => {}}});
const resource = readFrames => ({kind: 'pcm-file', length: 300_000_000, sampleRate: 48000,
  duration: 6250, numberOfChannels: 2, readFrames});
const pcm = count => [new Float32Array(count), new Float32Array(count)];
const request = (index, generation = 1, wanted = [index]) => ({type: 'request', index, generation, wanted});

test('file source serializes bounded reads and supplies only the current six pages', async () => {
  let active = 0, maximum = 0; const reads = [];
  const source = new PcmFileSource(context(), resource(async (start, count) => {
    active++; maximum = Math.max(active, maximum); reads.push({start, count});
    await flush(); active--; return pcm(count);
  }));
  await source.start(0, 4000);
  const node = source.node;
  const wanted = [5859, 5860, 5861, 5862, 5863, 5864];
  for (const index of wanted) node.emit(request(index, 1, wanted));
  for (let i = 0; i < 8; i++) await flush();
  assert.equal(maximum, 1);
  assert.equal(reads.length, 6);
  assert.ok(reads.every(read => read.count === 32768));
  assert.equal(node.messages.filter(message => message.type === 'page').length, 6);
  source.stop();
  assert.equal(node.connections.size, 0); assert.equal(node.port.closed, true);
});

test('stop during reading drops late PCM and late initialization cannot reconnect a source', async () => {
  const read = deferred(), source = new PcmFileSource(context(), resource(() => read.promise));
  await source.start(0, 0); const node = source.node;
  node.emit(request(0)); source.stop(); read.resolve(pcm(32768)); await flush();
  assert.equal(node.messages.filter(message => message.type === 'page').length, 0);
  const registration = deferred();
  const pending = new PcmFileSource({sampleRate: 48000, audioWorklet: {addModule: () => registration.promise}}, resource(async (_start, count) => pcm(count)));
  pending.connect({}); const started = pending.start(0, 0); pending.stop();
  registration.resolve(); assert.equal(await started, false); assert.equal(pending.node, null);
});

test('new scratch sessions replace queued requests and reject results from the old position', async () => {
  const first = deferred(); let reads = 0;
  const source = new PcmFileSource(context(), resource(async (_start, count) => ++reads === 1 ? first.promise : pcm(count)));
  await source.ready; const node = source.node;
  node.emit(request(0)); node.emit(request(1, 1, [0, 1]));
  node.emit(request(1000, 2, [1000]));
  first.resolve(pcm(32768)); await flush(); await flush();
  const pages = node.messages.filter(message => message.type === 'page');
  assert.deepEqual(pages.map(page => page.index), [1000]);
  assert.equal(reads, 2);
  source.stop();
});

test('read errors stop the node once and malformed results cannot reach the audio thread', async () => {
  for (const failure of ['reject', 'malformed']) {
    const errors = [];
    const source = new PcmFileSource(context(), resource(async () => {
      if (failure === 'reject') throw new Error('read failed');
      return [new Float32Array(1)];
    }));
    source.onerror = error => errors.push(error);
    await source.start(0, 0); const node = source.node;
    node.emit(request(0)); await flush();
    assert.equal(errors.length, 1);
    assert.equal(source.disposed, true);
    assert.equal(node.port.closed, true);
    assert.equal(node.messages.filter(message => message.type === 'page').length, 0);
  }
});

test('stream position, completion and playback settings come from the actual audio source', async () => {
  const source = new PcmFileSource(context(), resource(async (_start, count) => pcm(count)));
  source.playbackRate.value = 1.25; source.loopStart = 123; source.loopEnd = 124; source.loop = true;
  await source.start(0, 123);
  assert.deepEqual(source.node.messages.find(message => message.type === 'start'),
    {type: 'start', position: 123, rate: 1.25, loop: {start: 123, end: 124}});
  source.node.emit({type: 'position', position: 123.5}); assert.equal(source.position, 123.5);
  source.node.emit({type: 'buffering', value: true}); assert.equal(source.buffering, true);
  let ended = 0; source.onended = () => {ended++;};
  source.node.emit({type: 'ended'});
  assert.equal(ended, 1); assert.equal(source.position, 6250); assert.equal(source.disposed, true);
});
