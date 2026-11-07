import test from 'node:test';
import assert from 'node:assert/strict';
import {SelectedWaveformLoader} from '../dist/waveform-selection.js';

const tick = () => new Promise(resolve => setImmediate(resolve));
const deferred = () => { let resolve, reject; const promise = new Promise((yes, no) => {resolve = yes; reject = no;}); return {promise, resolve, reject}; };
function fixture(load) {
  const states = [], timers = new Set();
  const loader = new SelectedWaveformLoader({load, onState: state => states.push(state),
    setTimer: callback => {timers.add(callback); return callback;}, clearTimer: callback => timers.delete(callback)});
  return {loader, states, async flush() {for (const timer of [...timers]) {timers.delete(timer); timer();} await tick();}};
}

test('rapid row browsing prepares only the final selection, with no playback dependency', async () => {
  const loaded = [], {loader, states, flush} = fixture(async value => {loaded.push(value);});
  loader.select('a', {id: 'a'}); loader.select('b', {id: 'b'}); loader.select('c', {id: 'c'});
  await flush();
  assert.deepEqual(loaded, [{id: 'c'}]);
  assert.deepEqual(states.filter(state => state.status === 'ready'), [{key: 'c', status: 'ready'}]);
  loader.select('c', {id: 'c'}); await flush(); assert.equal(loaded.length, 1);
});

test('only one preparation runs and obsolete completions cannot replace the selected waveform', async () => {
  const first = deferred(), loaded = [], predicates = [];
  const {loader, states, flush} = fixture(async (value, current) => {
    loaded.push(value); predicates.push(current);
    if (value === 'a') await first.promise;
  });
  loader.select('a', 'a'); await flush();
  loader.select('b', 'b'); await flush(); loader.select('c', 'c'); await flush();
  assert.deepEqual(loaded, ['a']); assert.equal(predicates[0](), false);
  first.resolve(); await tick();
  assert.deepEqual(loaded, ['a', 'c']);
  assert.deepEqual(states.filter(state => state.status === 'ready'), [{key: 'c', status: 'ready'}]);
});

test('view changes cancel queued selection and suppress old errors while future selections still work', async () => {
  const first = deferred(), loaded = [];
  const {loader, states, flush} = fixture(async value => {loaded.push(value); if (value === 'a') await first.promise;});
  loader.select('a', 'a'); await flush(); loader.select('b', 'b'); await flush();
  loader.cancel(); first.reject(new Error('old file removed')); await tick();
  assert.deepEqual(loaded, ['a']); assert.equal(states.at(-1).status, 'idle');
  assert.equal(states.some(state => state.status === 'error'), false);
  loader.select('c', 'c'); await flush(); assert.equal(states.at(-1).status, 'ready');
});

test('missing audio and current errors are explicit and a changed fingerprint retries', async () => {
  const {loader, states, flush} = fixture(async value => {if (value === 'missing') return false; if (value === 'bad') throw new Error('decode failed');});
  loader.select('missing', 'missing'); await flush(); assert.equal(states.at(-1).status, 'unavailable');
  loader.select('id|v1', 'bad'); await flush(); assert.equal(states.at(-1).error.message, 'decode failed');
  loader.select('id|v2', 'good'); await flush(); assert.equal(states.at(-1).status, 'ready');
});

test('default browser timers retain the global receiver when selecting and canceling', async () => {
  const originalSet = globalThis.setTimeout, originalClear = globalThis.clearTimeout;
  const scheduled = new Set(), loaded = [];
  globalThis.setTimeout = function(callback) {
    assert.equal(this, globalThis, 'Browser setTimeout requires the Window receiver.');
    scheduled.add(callback); return callback;
  };
  globalThis.clearTimeout = function(timer) {
    assert.equal(this, globalThis, 'Browser clearTimeout requires the Window receiver.');
    scheduled.delete(timer);
  };
  try {
    const loader = new SelectedWaveformLoader({load: async value => {loaded.push(value);}});
    loader.select('a', 'a'); loader.select('b', 'b');
    assert.equal(scheduled.size, 1);
    for (const callback of [...scheduled]) {scheduled.delete(callback); callback();}
    await Promise.resolve();
    assert.deepEqual(loaded, ['b']);
    loader.select('c', 'c'); loader.cancel();
    assert.equal(scheduled.size, 0, 'Canceling selection removes its pending browser timer.');
  } finally {
    globalThis.setTimeout = originalSet; globalThis.clearTimeout = originalClear;
  }
});
