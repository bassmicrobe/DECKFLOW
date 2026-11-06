import test from 'node:test';
import assert from 'node:assert/strict';
import {bindPlatterGesture} from '../dist/platter-gesture.js';

function harness({begin = () => {}, position = 20, duration = 60} = {}) {
  const element = new EventTarget(), document = new EventTarget(), host = new EventTarget();
  element.ownerDocument = document; document.defaultView = host;
  const captured = new Set();
  let rectReads = 0;
  element.getBoundingClientRect = () => { rectReads++; return {left: 0, top: 0, width: 200, height: 200}; };
  element.setPointerCapture = id => captured.add(id);
  element.hasPointerCapture = id => captured.has(id);
  element.releasePointerCapture = id => { captured.delete(id); emit('lostpointercapture', {pointerId: id}); };
  const moves = [], rotations = [], changes = [], errors = [], calls = [];
  const state = {loaded: true, position, duration, rotation: 10};
  const controller = bindPlatterGesture(element, {
    getState: () => state,
    onBegin: () => { calls.push('begin'); return begin(); },
    onEnd: () => calls.push('end'),
    onMove: (value, timestamp) => moves.push([value, timestamp]),
    onRotate: value => rotations.push(value),
    onChange: value => changes.push(value), onError: error => errors.push(error),
  });
  function emit(type, properties = {}, receiver = element) {
    const event = new Event(type, {cancelable: true});
    for (const [key, value] of Object.entries({pointerId: 1, button: 0, clientX: 190, clientY: 100, timeStamp: 0, ...properties})) {
      Object.defineProperty(event, key, {value});
    }
    receiver.dispatchEvent(event);
    return event;
  }
  const at = (degrees, timeStamp, pointerId = 1) => ({
    clientX: 100 + 90 * Math.cos(degrees * Math.PI / 180),
    clientY: 100 + 90 * Math.sin(degrees * Math.PI / 180), timeStamp, pointerId,
  });
  return {element, document, host, state, controller, moves, rotations, changes, errors, calls, emit, at, captured, get rectReads() {return rectReads;}};
}
const close = (actual, expected) => assert.ok(Math.abs(actual - expected) < 1e-8, `${actual} != ${expected}`);
const flush = () => new Promise(resolve => setImmediate(resolve));

test('begins synchronously, captures one finger and does not end for a second finger', () => {
  const h = harness();
  assert.equal(h.emit('pointerdown').defaultPrevented, true);
  assert.deepEqual(h.calls, ['begin']);
  assert.deepEqual(h.changes, [true]);
  assert.deepEqual([...h.captured], [1]);
  h.emit('pointerdown', h.at(45, 10, 2));
  h.emit('pointermove', h.at(90, 20, 2));
  h.emit('pointerup', h.at(90, 30, 2));
  h.emit('pointercancel', {pointerId: 2});
  assert.equal(h.controller.active, true);
  assert.equal(h.moves.length, 1);
  h.emit('pointermove', h.at(45, 40));
  close(h.moves.at(-1)[0], 20.225);
  h.emit('pointerup', h.at(90, 50));
  close(h.moves.at(-1)[0], 20.45);
  assert.deepEqual(h.calls, ['begin', 'end']);
  assert.deepEqual(h.changes, [true, false]);
  assert.equal(h.controller.active, false);
  assert.equal(h.captured.size, 0);
  assert.equal(h.rectReads, 1);
  h.controller.dispose();
});

test('coalesced path preserves complete rotations and sends one latest audio target', () => {
  const h = harness();
  h.emit('pointerdown', h.at(0, 0));
  const samples = [90, 180, 270, 360].map((angle, i) => h.at(angle, (i + 1) * 10));
  h.emit('pointermove', {...h.at(360, 40), getCoalescedEvents: () => samples});
  assert.equal(h.moves.length, 2);
  close(h.moves.at(-1)[0], 21.8);
  assert.equal(h.moves.at(-1)[1], 40);
  close(h.rotations.at(-1), 370);
  h.controller.dispose();
});

test('angle wrap is continuous and reversing at a track boundary responds immediately', () => {
  const h = harness({position: 0});
  h.emit('pointerdown', h.at(179, 0));
  h.emit('pointermove', h.at(-179, 10));
  close(h.moves.at(-1)[0], .01);
  h.emit('pointermove', h.at(90, 20));
  close(h.moves.at(-1)[0], 0);
  h.emit('pointermove', h.at(100, 30));
  close(h.moves.at(-1)[0], .05);
  h.controller.dispose();
  const end = harness({position: 60});
  end.emit('pointerdown', end.at(0, 0));
  end.emit('pointermove', end.at(45, 10));
  close(end.moves.at(-1)[0], 60);
  end.emit('pointermove', end.at(0, 20));
  close(end.moves.at(-1)[0], 59.775);
  end.controller.dispose();
});

test('centre touches and fast spindle crossings rebase without half-turn jumps', () => {
  const h = harness();
  h.emit('pointerdown', {clientX: 100, clientY: 100});
  h.emit('pointermove', {clientX: 101, clientY: 98, timeStamp: 10});
  h.emit('pointermove', h.at(0, 20));
  close(h.moves.at(-1)[0], 20);
  h.emit('pointermove', h.at(180, 30));
  close(h.moves.at(-1)[0], 20);
  h.emit('pointermove', h.at(225, 40));
  close(h.moves.at(-1)[0], 20.225);
  h.emit('pointermove', {clientX: 100, clientY: 100, timeStamp: 50});
  h.emit('pointermove', h.at(0, 60));
  close(h.moves.at(-1)[0], 20.225);
  h.controller.dispose();
});

test('pending audio preparation preserves the final position and cannot resurrect a released gesture', async () => {
  let ready;
  const h = harness({begin: () => new Promise(resolve => {ready = resolve;})});
  h.emit('pointerdown');
  h.emit('pointermove', h.at(45, 10));
  h.emit('pointerup', h.at(90, 20));
  close(h.moves.at(-1)[0], 20.45);
  assert.deepEqual(h.calls, ['begin', 'end']);
  const count = h.moves.length;
  ready(); await flush();
  assert.equal(h.moves.length, count);
  assert.equal(h.controller.active, false);
  h.controller.dispose();
});

test('cancellation does not integrate cancellation coordinates and lifecycle listeners clean up', () => {
  const h = harness();
  for (const type of ['pointercancel', 'lostpointercapture']) {
    h.emit('pointerdown');
    h.emit(type, h.at(90, 10));
    close(h.moves.at(-1)[0], 20);
    assert.equal(h.controller.active, false);
  }
  for (const type of ['blur', 'pagehide', 'resize']) {
    h.emit('pointerdown'); h.emit(type, {}, h.host);
    assert.equal(h.controller.active, false);
  }
  h.emit('pointerdown'); h.document.hidden = false;
  h.emit('visibilitychange', {}, h.document); assert.equal(h.controller.active, true);
  h.document.hidden = true; h.emit('visibilitychange', {}, h.document);
  assert.equal(h.controller.active, false);
  h.emit('pointerdown'); h.controller.cancel(); h.controller.cancel();
  assert.equal(h.calls.filter(call => call === 'end').length, 7);
  h.emit('pointerdown'); h.controller.dispose(); h.controller.dispose();
  assert.equal(h.calls.filter(call => call === 'end').length, 8);
  h.emit('pointerdown'); assert.equal(h.controller.active, false);
  assert.equal(h.captured.size, 0);
});

test('each deck can own a different touch simultaneously', () => {
  const a = harness(), b = harness();
  a.emit('pointerdown', a.at(0, 0, 1)); b.emit('pointerdown', b.at(0, 0, 2));
  a.emit('pointermove', a.at(45, 10, 1)); b.emit('pointermove', b.at(-45, 10, 2));
  close(a.moves.at(-1)[0], 20.225); close(b.moves.at(-1)[0], 19.775);
  a.emit('pointerup', a.at(45, 20, 1));
  assert.equal(a.controller.active, false); assert.equal(b.controller.active, true);
  a.controller.dispose(); b.controller.dispose();
});

test('scrolling releases the cached geometry and the next gesture reads it again', () => {
  const h = harness();
  h.emit('pointerdown');
  h.emit('pointermove', h.at(45, 10));
  const position = h.moves.at(-1)[0];
  h.emit('scroll', {}, h.host);
  assert.equal(h.controller.active, false);
  assert.equal(h.captured.size, 0);
  assert.deepEqual(h.calls, ['begin', 'end']);
  h.emit('pointermove', h.at(90, 20));
  close(h.moves.at(-1)[0], position);
  h.emit('pointerdown');
  assert.equal(h.rectReads, 2);
  h.controller.dispose();
  h.emit('scroll', {}, h.host);
  assert.deepEqual(h.calls, ['begin', 'end', 'begin', 'end']);
});

test('begin failures release capture and stale failures cannot cancel a subsequent gesture', async () => {
  let reject, attempts = 0;
  const h = harness({begin: () => ++attempts === 1 ? new Promise((_, fail) => {reject = fail;}) : Promise.resolve()});
  h.emit('pointerdown'); h.controller.cancel(); h.emit('pointerdown');
  reject(new Error('old preparation failed')); await flush();
  assert.equal(h.controller.active, true); assert.equal(h.errors.length, 0);
  h.controller.dispose();
  const broken = harness({begin: () => Promise.reject(new Error('audio unavailable'))});
  broken.emit('pointerdown'); await flush();
  assert.equal(broken.controller.active, false); assert.equal(broken.captured.size, 0);
  assert.equal(broken.errors.length, 1); assert.deepEqual(broken.calls, ['begin', 'end']);
  broken.controller.dispose();
});

test('empty decks, non-primary buttons and malformed samples are ignored', () => {
  const h = harness();
  h.state.loaded = false; h.emit('pointerdown');
  h.state.loaded = true; h.emit('pointerdown', {button: 2});
  h.emit('pointerdown', {clientX: NaN});
  assert.deepEqual(h.calls, []);
  h.emit('pointerdown');
  h.emit('pointermove', {clientX: Infinity, timeStamp: 10});
  close(h.moves.at(-1)[0], 20);
  assert.equal(h.moves.at(-1)[1], 0);
  h.controller.dispose();
});
