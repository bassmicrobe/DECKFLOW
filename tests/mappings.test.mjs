import test, {afterEach} from 'node:test';
import assert from 'node:assert/strict';
import {MappingManager} from '../dist/mappings.js';

const actions = [
  {id: 'a.play', label: 'A 再生', kind: 'trigger'},
  {id: 'b.play', label: 'B 再生', kind: 'trigger'},
  {id: 'a.cue', label: 'A CUE', kind: 'trigger'},
  {id: 'mixer.crossfader', label: 'クロスフェーダー', kind: 'continuous'},
  {id: 'a.volume', label: 'A 音量', kind: 'continuous'},
];
const originalNavigator = Object.getOwnPropertyDescriptor(globalThis, 'navigator');
const originalStorage = Object.getOwnPropertyDescriptor(globalThis, 'localStorage');
const managers = [];
function manager(extra = {}) {
  const instance = new MappingManager({actions, ...extra});
  managers.push(instance);
  return instance;
}
function navigatorWith(value) { Object.defineProperty(globalThis, 'navigator', {configurable: true, value}); }
function key(code, extra = {}) {
  return {code, shiftKey: false, altKey: false, ctrlKey: false, metaKey: false,
    repeat: false, target: {tagName: 'BODY'}, prevented: false,
    preventDefault() { this.prevented = true; }, ...extra};
}
function profile(mappings) { return JSON.stringify({version: 1, name: 'テスト', mappings}); }
function midiMapping(actionId, type, number, mode = 'absolute', extra = {}) {
  const binding = {type, channel: 0, ...extra};
  if (type !== 'pitchbend') binding.number = number;
  return {id: `${actionId}-${type}-${number}-${extra.device || 'any'}`, actionId, source: 'midi', binding, mode};
}
function fakeMidi() {
  function port(id) {
    const listeners = new Map();
    return {id, name: `Controller ${id}`, state: 'connected', connection: 'closed', opened: 0,
      addEventListener(type, fn) { listeners.set(type, fn); },
      removeEventListener(type, fn) { if (listeners.get(type) === fn) listeners.delete(type); },
      open() { this.opened++; this.connection = 'open'; return Promise.resolve(this); },
      send(data) { listeners.get('midimessage')?.({data: new Uint8Array(data)}); },
      get listening() { return listeners.has('midimessage'); }};
  }
  const first = port('one'), second = port('two');
  let statechange = null;
  const access = {inputs: new Map([[first.id, first], [second.id, second]]),
    addEventListener(type, fn) { if (type === 'statechange') statechange = fn; },
    removeEventListener(type, fn) { if (statechange === fn) statechange = null; },
    changed() { statechange?.({}); }};
  let requests = 0;
  navigatorWith({requestMIDIAccess: async options => { assert.equal(options.sysex, false); requests++; return access; }});
  return {first, second, access, get requests() { return requests; }};
}

afterEach(() => {
  while (managers.length) managers.pop().dispose();
  if (originalNavigator) Object.defineProperty(globalThis, 'navigator', originalNavigator); else delete globalThis.navigator;
  if (originalStorage) Object.defineProperty(globalThis, 'localStorage', originalStorage); else delete globalThis.localStorage;
});

test('does not request MIDI until asked; reports unsupported browsers honestly', async () => {
  const midi = fakeMidi();
  const m = manager();
  assert.equal(midi.requests, 0);
  assert.equal(await m.enableMIDI(), true);
  assert.equal(midi.requests, 1);
  assert.equal(m.status.state, 'connected');
  assert.equal(m.status.inputs.length, 2);
  navigatorWith({});
  const unsupported = manager();
  assert.equal(await unsupported.enableMIDI(), false);
  assert.equal(unsupported.status.state, 'unavailable');
  assert.throws(() => unsupported.learn('a.play', 'midi'), /MIDI学習/);
});

test('key repeat, key-up and modifier changes do not toggle transport twice', () => {
  const calls = [];
  const m = manager({onAction: (...args) => calls.push(args)});
  assert.equal(m.handleKeyDown(key('KeyQ')), true);
  m.handleKeyDown(key('KeyQ', {repeat: true}));
  m.handleKeyDown(key('KeyQ'));
  m.handleKeyUp(key('KeyQ', {shiftKey: true}));
  assert.deepEqual(calls, [['a.play', 1, 'press']]);
  m.handleKeyDown(key('KeyQ'));
  assert.equal(calls.length, 2);
});

test('typing in forms/dialogs and browser shortcuts do not control decks', () => {
  const calls = [];
  const m = manager({onAction: (...args) => calls.push(args)});
  for (const tagName of ['INPUT', 'TEXTAREA', 'SELECT']) m.handleKeyDown(key('KeyQ', {target: {tagName}}));
  m.handleKeyDown(key('KeyQ', {target: {closest: () => ({})}}));
  m.handleKeyDown(key('KeyQ', {ctrlKey: true}));
  m.handleKeyDown(key('KeyQ', {metaKey: true}));
  assert.equal(calls.length, 0);
  m.learn('a.play', 'keyboard');
  assert.equal(m.handleKeyDown(key('KeyQ', {ctrlKey: true})), false);
  assert.ok(m.learning);
  m.handleKeyDown(key('Escape'));
  assert.equal(m.learning, null);
});

test('learning captures Shift/Alt, replaces conflicts, and never executes learned key', () => {
  const calls = [], statuses = [];
  const m = manager({onAction: (...args) => calls.push(args), onStatus: value => statuses.push(value)});
  m.learn('b.play', 'keyboard');
  m.handleKeyDown(key('KeyQ', {target: {tagName: 'INPUT'}}));
  assert.equal(calls.length, 0);
  assert.equal(m.getMappings('a.play').length, 0);
  assert.match(statuses.at(-1).message, /置き換え/);
  m.handleKeyDown(key('KeyQ', {repeat: true}));
  m.handleKeyUp(key('KeyQ'));
  m.handleKeyDown(key('KeyQ'));
  assert.deepEqual(calls, [['b.play', 1, 'press']]);
  m.learn('a.cue', 'keyboard');
  m.handleKeyDown(key('KeyK', {altKey: true, shiftKey: true}));
  m.handleKeyUp(key('KeyK'));
  m.handleKeyDown(key('KeyK'));
  assert.equal(calls.length, 1);
  m.handleKeyDown(key('KeyK', {altKey: true, shiftKey: true}));
  assert.equal(calls.at(-1)[0], 'a.cue');
  assert.throws(() => m.learn('a.volume', 'keyboard'), /ボタン操作/);
});

test('MIDI note-off and velocity-zero release never fire a toggle', async () => {
  const midi = fakeMidi(), calls = [];
  const m = manager({onAction: (...args) => calls.push(args)});
  await m.enableMIDI();
  m.learn('a.play', 'midi');
  midi.first.send([0x90, 36, 100]);
  assert.equal(calls.length, 0);
  assert.equal(m.getMappings('a.play').find(x => x.source === 'midi').binding.device, undefined);
  midi.first.send([0x90, 36, 110]);
  assert.equal(calls.length, 0);
  midi.first.send([0x90, 36, 0]);
  midi.first.send([0x90, 36, 127]);
  midi.first.send([0x80, 36, 64]);
  assert.deepEqual(calls, [['a.play', 1, 'press']]);
  midi.second.send([0x90, 36, 90]);
  assert.equal(calls.length, 2, 'profile is portable to another input device');
});

test('CC buttons use rising edges; channels and 14-bit pitchbend remain distinct', async () => {
  const midi = fakeMidi(), calls = [];
  const m = manager({onAction: (...args) => calls.push(args)});
  await m.enableMIDI();
  m.importProfile(profile([midiMapping('a.play', 'cc', 22), midiMapping('a.volume', 'pitchbend')]));
  midi.first.send([0xb0, 22, 127]);
  midi.first.send([0xb0, 22, 100]);
  midi.first.send([0xb0, 22, 0]);
  midi.first.send([0xb1, 22, 127]);
  midi.first.send([0xb0, 22, 127]);
  assert.equal(calls.length, 2);
  midi.first.send([0xe0, 127, 127]);
  assert.deepEqual(calls.at(-1), ['a.volume', 1, 'change']);
  midi.first.send([0xe0, 0, 0]);
  assert.deepEqual(calls.at(-1), ['a.volume', 0, 'change']);
});

test('relative encoders follow current action value and clamp without wraparound', async () => {
  const midi = fakeMidi(), calls = [];
  const m = manager({onAction: (...args) => calls.push(args)});
  await m.enableMIDI();
  m.importProfile(profile([midiMapping('mixer.crossfader', 'cc', 3, 'relative-twos'), midiMapping('a.volume', 'cc', 4, 'relative-offset')]));
  m.setActionValue('mixer.crossfader', .25);
  midi.first.send([0xb0, 3, 1]);
  assert.ok(Math.abs(calls.at(-1)[1] - (.25 + 1 / 127)) < 1e-8);
  midi.first.send([0xb0, 3, 127]);
  assert.ok(Math.abs(calls.at(-1)[1] - .25) < 1e-8);
  m.setActionValue('a.volume', .999);
  midi.first.send([0xb0, 4, 65]);
  assert.equal(calls.at(-1)[1], 1);
  const count = calls.length;
  midi.first.send([0xb0, 4, 64]);
  assert.equal(calls.length, count);
  m.setActionValue('a.volume', 0);
  midi.first.send([0xb0, 4, 63]);
  assert.equal(calls.at(-1)[1], 0);
});

test('relative learning waits for CC instead of accidentally binding notes', async () => {
  const midi = fakeMidi(), calls = [];
  const m = manager({onAction: (...args) => calls.push(args)});
  await m.enableMIDI();
  m.learn('a.volume', 'midi', {mode: 'relative-twos'});
  midi.first.send([0x90, 44, 127]);
  assert.ok(m.learning);
  midi.first.send([0xb0, 8, 1]);
  assert.equal(m.learning, null);
  assert.equal(calls.length, 0);
  assert.equal(m.getMappings('a.volume')[0].binding.number, 8);
});

test('profile imports validate before mutation and reject unsupported/ambiguous inputs', () => {
  const m = manager();
  const before = m.exportProfile();
  const valid = midiMapping('a.volume', 'cc', 9);
  for (const bad of [
    '{', JSON.stringify({version: 2, name: 'x', mappings: []}),
    profile([{...valid, actionId: 'arbitrary-code'}]),
    profile([{...valid, binding: {type: 'cc', channel: -1, number: 9}}]),
    profile([valid, {...valid, id: 'different-id', actionId: 'mixer.crossfader'}]),
    profile([{...valid, mode: 'relative-twos', binding: {type: 'note', channel: 0, number: 9}}]),
  ]) {
    assert.throws(() => m.importProfile(bad));
    assert.equal(m.exportProfile(), before, 'failed import must leave current profile intact');
  }
  m.importProfile(profile([valid]));
  const exported = m.exportProfile();
  const second = manager();
  second.importProfile(exported);
  assert.deepEqual(second.profile, m.profile);
  const exposed = m.profile;
  exposed.mappings[0].actionId = 'arbitrary-code';
  assert.equal(m.profile.mappings[0].actionId, 'a.volume', 'returned profiles must not mutate internal state');
});

test('saved mappings survive reload; corrupt storage falls back to usable defaults', () => {
  const saved = new Map();
  Object.defineProperty(globalThis, 'localStorage', {configurable: true, value: {
    getItem: key => saved.get(key), setItem: (key, value) => saved.set(key, value),
  }});
  const m = manager();
  m.importProfile(profile([midiMapping('a.play', 'note', 50)]));
  assert.deepEqual(manager().profile, m.profile);
  for (const key of saved.keys()) saved.set(key, 'invalid');
  const recovered = manager();
  assert.equal(recovered.getMappings('a.play')[0].binding.code, 'KeyQ');
  assert.match(recovered.status.message, /初期割り当て/);
});

test('hotplug and dispose remove old listeners without accumulating callbacks', async () => {
  const midi = fakeMidi(), calls = [];
  const m = manager({onAction: (...args) => calls.push(args)});
  await m.enableMIDI();
  await m.enableMIDI();
  assert.equal(midi.requests, 1);
  assert.equal(midi.first.opened, 1);
  m.importProfile(profile([midiMapping('a.play', 'note', 20)]));
  midi.first.state = 'disconnected';
  midi.access.changed();
  assert.equal(midi.first.listening, false);
  assert.equal(m.status.inputs.length, 1);
  midi.first.send([0x90, 20, 127]);
  assert.equal(calls.length, 0);
  midi.first.state = 'connected';
  midi.access.changed();
  midi.first.send([0x90, 20, 127]);
  assert.equal(calls.length, 1);
  m.dispose();
  assert.equal(midi.first.listening, false);
  assert.equal(midi.second.listening, false);
  midi.first.send([0x90, 20, 127]);
  assert.equal(calls.length, 1);
});

test('permission denial remains a truthful disconnected error without fake inputs', async () => {
  navigatorWith({requestMIDIAccess: async () => { throw new Error('denied'); }});
  const m = manager();
  assert.equal(await m.enableMIDI(), false);
  assert.equal(m.status.state, 'error');
  assert.deepEqual(m.status.inputs, []);
});

test('concurrent MIDI permission requests are shared and disposal prevents late attachment', async () => {
  const midi = fakeMidi();
  let resolveAccess, requests = 0;
  navigatorWith({requestMIDIAccess: () => { requests++; return new Promise(resolve => { resolveAccess = resolve; }); }});
  const m = manager();
  const first = m.enableMIDI(), second = m.enableMIDI();
  assert.equal(requests, 1);
  m.dispose();
  resolveAccess(midi.access);
  assert.deepEqual(await Promise.all([first, second]), [false, false]);
  assert.equal(midi.first.listening, false);
  assert.equal(midi.second.listening, false);
});

test('a synchronous permission error can be retried instead of caching failure forever', async () => {
  let requests = 0;
  navigatorWith({requestMIDIAccess: () => { requests++; throw new Error('SecurityError'); }});
  const m = manager();
  assert.equal(await m.enableMIDI(), false);
  assert.equal(await m.enableMIDI(), false);
  assert.equal(requests, 2);
});
