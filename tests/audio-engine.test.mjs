import test from 'node:test';
import assert from 'node:assert/strict';
import {AudioEngine} from '../dist/audio-engine.js';

const param = (value = 0) => ({value, setValueAtTime(v) {this.value = v;}, cancelScheduledValues() {}, setTargetAtTime(v) {this.value = v;}});
class Node {
  constructor() {
    this.connections = new Set();
    for (const name of ['gain', 'frequency', 'Q', 'threshold', 'knee', 'ratio', 'attack', 'release']) this[name] = param();
  }
  connect(node) {this.connections.add(node); return node;}
  disconnect() {this.connections.clear();}
  start(_when, offset) {this.offset = offset;}
  stop() {this.stopped = true;}
  getFloatTimeDomainData(samples) {samples.fill(0);}
}
class Worklet extends Node {
  static nodes = [];
  static autoReady = true;
  constructor(context, name) {
    super();
    this.name = name; this.context = context; this.messages = [];
    this.parameters = new Map([['pitch', param(1)], ['pitchSemitones', param(0)], ['playbackRate', param(1)]]);
    this.port = {
      onmessage: null, closed: false, close() {this.closed = true;},
      postMessage: message => {
        this.messages.push(message);
        if (message.type === 'load' && Worklet.autoReady) queueMicrotask(() => this.ready(message.id));
      },
    };
    Worklet.nodes.push(this);
  }
  ready(id = this.messages.find(message => message.type === 'load')?.id) {this.port.onmessage?.({data: {type: 'ready', id}});}
}
class Context {
  constructor() {
    this.currentTime = 0; this.sampleRate = 48000; this.state = 'suspended'; this.destination = new Node();
    this.audioWorklet = {addModule: async url => {if (this.failKeyLock && String(url).includes('soundtouch-processor')) throw new Error('unavailable');}};
  }
  createGain() {return new Node();} createBiquadFilter() {return new Node();}
  createDynamicsCompressor() {return new Node();} createAnalyser() {return new Node();}
  createBufferSource() {const source = new Node(); source.playbackRate = param(1); return source;}
  async resume() {this.state = 'running';} async close() {this.state = 'closed';}
}
globalThis.AudioContext = Context;
globalThis.AudioWorkletNode = Worklet;
const buffer = (duration = 60) => ({duration, length: duration * 1000, sampleRate: 1000, numberOfChannels: 1, getChannelData() {return new Float32Array(this.length);}});
const flush = () => new Promise(resolve => setImmediate(resolve));
const scratchNode = () => Worklet.nodes.filter(node => node.name === 'deckflow-scratch').at(-1);

test('transport preserves position through rate, pause, loop exit and CUE', async () => {
  const engine = new AudioEngine();
  try {
    engine.load('a', buffer()); await engine.play('a');
    engine.context.currentTime = 12; assert.equal(engine.getState('a').position, 12);
    engine.setRate('a', 2); engine.context.currentTime = 15; assert.equal(engine.getState('a').position, 18);
    engine.pause('a'); engine.context.currentTime = 115; assert.equal(engine.getState('a').position, 18);
    await engine.play('a'); engine.context.currentTime = 125; assert.equal(engine.getState('a').position, 38);
    engine.setLoop('a', 20, 24); assert.equal(engine.getState('a').position, 20);
    engine.context.currentTime = 130; assert.equal(engine.getState('a').position, 22);
    engine.clearLoop('a'); engine.context.currentTime = 131; assert.equal(engine.getState('a').position, 24);
    engine.setCue('a', 8); engine.setLoop('a', 20, 24); engine.jumpCue('a');
    assert.equal(engine.getState('a').position, 8); assert.equal(engine.getState('a').playing, false);
    assert.equal(engine.getState('a').loop, null);
  } finally {engine.dispose();}
});

test('KEY LOCK mirrors source rate and failure reports a usable fallback', async () => {
  const engine = new AudioEngine();
  try {
    engine.load('a', buffer()); await engine.play('a');
    assert.equal(engine.getState('a').keyLock, true);
    engine.setRate('a', 1.08);
    assert.equal(engine.decks.a.source.playbackRate.value, 1.08);
    assert.equal(engine.decks.a.keyLockNode.playbackRate.value, 1.08);
    engine.decks.a.keyLockNode.onprocessorerror();
    assert.equal(engine.getState('a').playing, true);
    assert.equal(engine.getState('a').keyLock, false);
    assert.ok(engine.getState('a').keyLockError.includes('ピッチ連動'));
    engine.setKeyLock('a', true);
    engine.setKeyLock('a', false); assert.equal(engine.getState('a').keyLock, false);
    assert.equal(engine.decks.a.keyLockNode, null);
  } finally {engine.dispose();}
  const fallback = new AudioEngine();
  try {
    fallback.load('a', buffer()); fallback.context.failKeyLock = true; await fallback.play('a');
    assert.equal(fallback.getState('a').playing, true);
    assert.equal(fallback.getState('a').keyLock, false);
    assert.ok(fallback.getState('a').keyLockError.includes('音程'));
  } finally {fallback.dispose();}
});

test('KEY LOCK construction and connection failures keep playback at the current position', async () => {
  for (const failure of ['construct', 'connect']) {
    const statuses = [], engine = new AudioEngine({onStatus: status => statuses.push(status)});
    let failedProcessor = null;
    try {
      engine.load('a', buffer()); await engine.play('a');
      engine.context.currentTime = 7;
      const SoundTouchNode = engine.SoundTouchNode;
      engine.SoundTouchNode = class extends Node {
        constructor() {
          super();
          if (failure === 'construct') throw new Error('processor unavailable');
          this.playbackRate = param(1); this.pitch = param(1);
          this.port = {closed: false, close() {this.closed = true;}};
          failedProcessor = this;
        }
        connect() { throw new Error('processor connection failed'); }
      };
      engine.setRate('a', 1.08);
      assert.equal(engine.getState('a').playing, true);
      assert.equal(engine.getState('a').position, 7);
      assert.equal(engine.getState('a').keyLock, false);
      assert.match(engine.getState('a').keyLockError, /ピッチ連動/);
      assert.equal(engine.decks.a.source.playbackRate.value, 1.08);
      assert.deepEqual([...engine.decks.a.source.connections], [engine.decks.a.transportGain]);
      assert.equal(statuses.at(-1).enabled, false);
      if (failedProcessor) {
        assert.equal(failedProcessor.connections.size, 0);
        assert.equal(failedProcessor.port.closed, true);
      }
      engine.SoundTouchNode = SoundTouchNode;
      engine.setKeyLock('a', true);
      assert.equal(engine.getState('a').playing, true);
      assert.equal(engine.getState('a').position, 7);
      assert.equal(engine.getState('a').keyLock, true);
      assert.equal(engine.getState('a').keyLockError, null);
    } finally {engine.dispose();}
  }
});

test('grab renders from the original position, release resumes at the finger target', async () => {
  const engine = new AudioEngine();
  try {
    engine.load('a', buffer()); await engine.play('a'); engine.context.currentTime = 1;
    const beginning = engine.beginScratch('a');
    engine.scratchTo('a', 2); await beginning;
    assert.equal(engine.getState('a').scratching, true); assert.equal(engine.getState('a').playing, false);
    const node = scratchNode();
    assert.equal(node.messages.find(message => message.type === 'begin').position, 1);
    assert.equal(node.messages.filter(message => message.type === 'target').at(-1).position, 2);
    node.port.onmessage({data: {type: 'position', position: 1.8, session: engine.decks.a.scratch.token}});
    assert.equal(engine.getState('a').position, 1.8);
    await engine.endScratch('a');
    assert.equal(engine.getState('a').position, 2); assert.equal(engine.getState('a').playing, true);
    assert.equal(engine.getState('a').scratching, false); assert.equal(node.connections.size, 0);
  } finally {engine.dispose();}
});

test('scratching a paused deck stays paused after release', async () => {
  const engine = new AudioEngine();
  try {
    engine.load('a', buffer()); engine.seek('a', 3);
    await engine.beginScratch('a'); engine.scratchTo('a', 2); await engine.endScratch('a');
    assert.equal(engine.getState('a').position, 2); assert.equal(engine.getState('a').playing, false);
  } finally {engine.dispose();}
});

test('release before PCM ready cannot reconnect scratch or restart the transport later', async () => {
  Worklet.autoReady = false;
  const engine = new AudioEngine();
  try {
    engine.load('a', buffer()); await engine.play('a'); await flush();
    engine.context.currentTime = 3;
    const beginning = engine.beginScratch('a'); engine.scratchTo('a', 4);
    await engine.endScratch('a'); await beginning;
    const source = engine.decks.a.source;
    scratchNode().ready(); await flush();
    assert.equal(engine.getState('a').scratching, false);
    assert.equal(engine.getState('a').playing, true); assert.equal(engine.getState('a').position, 4);
    assert.equal(engine.decks.a.source, source); assert.equal(scratchNode().connections.size, 0);
  } finally {engine.dispose(); Worklet.autoReady = true;}
});

test('loading another track cancels pending scratch and releases stale PCM', async () => {
  Worklet.autoReady = false;
  const engine = new AudioEngine();
  try {
    engine.load('a', buffer()); await flush();
    const old = scratchNode(); const beginning = engine.beginScratch('a');
    await flush(); engine.load('a', buffer(12)); await beginning; old.ready(); await flush();
    assert.equal(engine.getState('a').duration, 12);
    assert.equal(engine.getState('a').position, 0); assert.equal(engine.getState('a').playing, false);
    assert.equal(engine.getState('a').scratching, false); assert.ok(old.messages.some(message => message.type === 'dispose'));
  } finally {engine.dispose(); Worklet.autoReady = true;}
});

test('external seek exits scratch without a delayed pointer release overriding it', async () => {
  const engine = new AudioEngine();
  try {
    engine.load('a', buffer()); await engine.play('a'); await engine.beginScratch('a'); engine.scratchTo('a', 3);
    engine.seek('a', 8); await engine.endScratch('a');
    assert.equal(engine.getState('a').scratching, false);
    assert.equal(engine.getState('a').position, 8); assert.equal(engine.getState('a').playing, true);
  } finally {engine.dispose();}
});


test('unity KEY LOCK bypass avoids DSP priming and rate transitions retain position', async () => {
  const engine = new AudioEngine();
  try {
    engine.load('a', buffer()); await engine.play('a');
    assert.equal(engine.getState('a').keyLockRequested, true);
    assert.equal(engine.decks.a.keyLockNode, null, 'normal-speed playback uses the direct PCM path');
    engine.context.currentTime = 2;
    engine.setRate('a', 1.08);
    assert.equal(engine.getState('a').position, 2);
    assert.ok(engine.decks.a.keyLockNode, 'tempo change enables pitch correction');
    engine.context.currentTime = 3;
    engine.setRate('a', 1);
    assert.equal(engine.getState('a').position, 3.08);
    assert.equal(engine.decks.a.keyLockNode, null);
    assert.equal(engine.getState('a').keyLock, true, 'bypass must not change the requested setting');
    await engine.beginScratch('a'); engine.scratchTo('a', 4, 100);
    engine.setRate('a', 1.1);
    assert.equal(engine.decks.a.source, null, 'tempo changes must not resume a held platter');
    await engine.endScratch('a');
    assert.equal(engine.getState('a').position, 4);
    assert.ok(engine.decks.a.keyLockNode);
    await engine.beginScratch('a'); engine.setRate('a', 1); await engine.endScratch('a');
    assert.equal(engine.decks.a.keyLockNode, null);
    assert.equal(engine.getState('a').playing, true);
  } finally {engine.dispose();}
});

test('touch timestamps survive preparation and stale scratch positions cannot move a new gesture', async () => {
  const engine = new AudioEngine();
  try {
    engine.load('a', buffer());
    const beginning = engine.beginScratch('a');
    engine.scratchTo('a', 2, 1234.5); await beginning;
    const node = scratchNode();
    const oldSession = engine.decks.a.scratch.token;
    assert.equal(node.messages.filter(message => message.type === 'target').at(-1).timeStamp, 1234.5);
    await engine.endScratch('a'); await engine.beginScratch('a');
    node.port.onmessage({data: {type: 'position', position: 9, session: oldSession}});
    assert.equal(engine.getState('a').position, 2);
    node.port.onmessage({data: {type: 'position', position: 2.1, session: engine.decks.a.scratch.token}});
    assert.equal(engine.getState('a').position, 2.1);
  } finally {engine.dispose();}
});

test('release followed by explicit pause cannot resurrect playback', async () => {
  const engine = new AudioEngine();
  try {
    engine.load('a', buffer()); await engine.play('a'); await engine.beginScratch('a');
    engine.scratchTo('a', 2);
    const releasing = engine.endScratch('a');
    engine.pause('a'); await releasing; await flush();
    assert.equal(engine.getState('a').playing, false);
    assert.equal(engine.getState('a').scratching, false);
    assert.equal(engine.decks.a.source, null);
    assert.equal(engine.getState('a').position, 2);
  } finally {engine.dispose();}
});

test('rapid release and regrab retain resume intent without a stale play command', async () => {
  const engine = new AudioEngine();
  try {
    engine.load('a', buffer()); await engine.play('a'); await engine.beginScratch('a');
    engine.scratchTo('a', 3);
    const releasing = engine.endScratch('a');
    const grabbing = engine.beginScratch('a');
    engine.scratchTo('a', 4); await Promise.all([releasing, grabbing]);
    assert.equal(engine.getState('a').scratching, true);
    assert.equal(engine.decks.a.source, null);
    await engine.endScratch('a');
    assert.equal(engine.getState('a').playing, true);
    assert.equal(engine.getState('a').position, 4);
  } finally {engine.dispose();}
});

for (const mode of ['paused', 'playing', 'pending-play', 'scratch', 'pending-scratch']) {
  test(`unloading a ${mode} deck releases PCM and prevents delayed playback`, async () => {
    const engine = new AudioEngine();
    Worklet.autoReady = mode !== 'pending-scratch';
    try {
      engine.load('a', buffer()); await flush();
      engine.setCue('a', 3); engine.setLoop('a', 2, 6); engine.seek('a', 4);
      let pending;
      if (mode === 'playing' || mode === 'scratch') await engine.play('a');
      if (mode === 'scratch') await engine.beginScratch('a');
      if (mode === 'pending-scratch') {pending = engine.beginScratch('a'); await flush();}
      if (mode === 'pending-play') pending = engine.play('a');
      const source = engine.decks.a.source, scratch = scratchNode();
      engine.unload('a');
      await pending;
      scratch.ready(); await flush();
      const state = engine.getState('a');
      assert.equal(state.loaded, false);
      assert.equal(state.playing, false);
      assert.equal(state.scratching, false);
      assert.equal(state.position, 0);
      assert.equal(state.duration, 0);
      assert.equal(state.cue, 0);
      assert.equal(state.loop, null);
      assert.equal(engine.decks.a.buffer, null);
      assert.equal(engine.decks.a.source, null);
      assert.equal(engine.decks.a.scratch.buffer, null);
      assert.equal(engine.decks.a.scratch.node, null);
      assert.ok(scratch.messages.some(message => message.type === 'dispose'));
      assert.equal(scratch.port.closed, true);
      assert.equal(scratch.connections.size, 0);
      if (source) {assert.equal(source.stopped, true); assert.equal(source.connections.size, 0);}
      await engine.endScratch('a'); await engine.play('a');
      assert.equal(engine.getState('a').playing, false);
      Worklet.autoReady = true;
      engine.load('a', buffer(12)); await engine.play('a');
      assert.equal(engine.getState('a').playing, true);
      assert.equal(engine.getState('a').duration, 12);
      assert.equal(engine.getState('a').position, 0);
    } finally {engine.dispose(); Worklet.autoReady = true;}
  });
}

test('long file-backed decks keep reading bounded through seek, loop, tempo, scratch and unload', async () => {
  const reads = [], engine = new AudioEngine();
  const resource = {kind: 'pcm-file', length: 300_000_000, sampleRate: 48000, numberOfChannels: 2, duration: 6250,
    async readFrames(start, count) {reads.push({start, count}); return [new Float32Array(count), new Float32Array(count)];}};
  try {
    engine.load('a', resource); await engine.play('a');
    assert.equal(engine.getState('a').duration, 6250);
    assert.equal(reads.length, 0, 'loading must not copy a whole track or scratch buffer');
    const first = engine.decks.a.source;
    first.node.port.onmessage({data: {type: 'request', index: 0, generation: 1, wanted: [0]}}); await flush();
    assert.deepEqual(reads, [{start: 0, count: 32768}]);
    engine.context.currentTime = 300;
    assert.equal(engine.getState('a').position, 0, 'the audio thread, not wall time, owns the streamed playhead');
    first.node.port.onmessage({data: {type: 'position', position: 4.5}});
    engine.pause('a'); assert.equal(engine.getState('a').position, 4.5);
    engine.seek('a', 4000); engine.setLoop('a', 4000, 4002); await engine.play('a');
    assert.equal(engine.decks.a.source.loopStart, 4000);
    assert.equal(engine.decks.a.source.loopEnd, 4002);
    engine.setRate('a', 1.25); await flush();
    assert.equal(engine.decks.a.source.playbackRate.value, 1.25);
    assert.ok(engine.decks.a.keyLockNode, 'streamed PCM keeps the KEY LOCK signal path');
    await engine.beginScratch('a'); engine.scratchTo('a', 4001, 100);
    const scratch = engine.decks.a.scratch.node;
    assert.equal(engine.getState('a').scratching, true);
    assert.equal(scratch.resource, resource);
    assert.ok(scratch.node.messages.some(message => message.type === 'target' && message.position === 4001));
    await engine.endScratch('a');
    assert.equal(engine.getState('a').position, 4001);
    assert.equal(engine.getState('a').playing, true);
    engine.setCue('a', 3000); engine.jumpCue('a');
    assert.equal(engine.getState('a').position, 3000); assert.equal(engine.getState('a').playing, false);
    engine.unload('a'); assert.equal(engine.getState('a').loaded, false); assert.equal(scratch.disposed, true);
    assert.equal(reads.length, 1);
  } finally {engine.dispose();}
});

test('file read failures stop the deck and stale reads cannot restore an unloaded track', async () => {
  const statuses = [], engine = new AudioEngine({onStatus: status => statuses.push(status)});
  const resource = {kind: 'pcm-file', length: 300_000_000, sampleRate: 48000, numberOfChannels: 2, duration: 6250,
    async readFrames() {throw new Error('test file unavailable');}};
  try {
    engine.load('a', resource); await engine.play('a');
    engine.decks.a.source.node.port.onmessage({data: {type: 'request', index: 0, generation: 1, wanted: [0]}});
    await flush();
    assert.equal(engine.getState('a').playing, false);
    assert.match(statuses.at(-1).message, /test file unavailable/);
    const pending = engine.play('a'); engine.unload('a'); await pending;
    assert.equal(engine.getState('a').loaded, false); assert.equal(engine.decks.a.source, null);
  } finally {engine.dispose();}
});
