import test from 'node:test';
import assert from 'node:assert/strict';
import {bindTouchSlider} from '../dist/touch-slider.js';

function harness({min = '0', max = '1', step = '0.01', value = '0.5', rtl = false, width = 224} = {}) {
  const element = new EventTarget(), document = new EventTarget(), host = new EventTarget();
  element.ownerDocument = document; document.defaultView = host;
  host.Event = Event; host.getComputedStyle = () => ({direction: rtl ? 'rtl' : 'ltr'});
  const attributes = {min, max, step};
  element.getAttribute = name => attributes[name] ?? null;
  element.value = value; element.disabled = false;
  let rectReads = 0;
  element.getBoundingClientRect = () => {rectReads++; return {left: 10, width};};
  const captured = new Set();
  element.setPointerCapture = id => captured.add(id);
  element.hasPointerCapture = id => captured.has(id);
  element.releasePointerCapture = id => {captured.delete(id); emit('lostpointercapture', {pointerId: id});};
  const inputs = [], changes = [];
  element.addEventListener('input', event => inputs.push({value: element.value, bubbles: event.bubbles}));
  element.addEventListener('change', event => changes.push({value: element.value, bubbles: event.bubbles}));
  const controller = bindTouchSlider(element);
  function emit(type, properties = {}, receiver = element) {
    const event = new Event(type, {cancelable: true});
    Object.assign(event, {pointerId: 2, pointerType: 'touch', isPrimary: false, button: 0, clientX: 122, ...properties});
    receiver.dispatchEvent(event);
    return event;
  }
  return {element, document, host, attributes, captured, inputs, changes, controller, emit, get rectReads() {return rectReads;}};
}

test('a secondary touch controls the full range, with input changes and one commit', () => {
  const h = harness();
  assert.equal(h.emit('pointerdown', {clientX: 22}).defaultPrevented, true);
  assert.equal(h.element.value, '0');
  assert.deepEqual([...h.captured], [2]);
  assert.equal(h.emit('pointermove', {clientX: 172}).defaultPrevented, true);
  assert.equal(h.element.value, '0.75');
  h.emit('pointermove', {clientX: 172});
  assert.equal(h.inputs.length, 2);
  h.emit('pointerup', {clientX: 222});
  assert.equal(h.element.value, '1');
  assert.deepEqual(h.changes, [{value: '1', bubbles: true}]);
  assert.equal(h.inputs.every(event => event.bubbles), true);
  assert.equal(h.captured.size, 0);
  assert.equal(h.rectReads, 1);
  h.emit('pointerup'); assert.equal(h.changes.length, 1);
  h.controller.dispose();
});

test('another finger cannot move or release the captured slider', () => {
  const h = harness();
  h.emit('pointerdown');
  for (const type of ['pointerdown', 'pointermove', 'pointerup', 'pointercancel', 'lostpointercapture']) {
    h.emit(type, {pointerId: 3, clientX: 222});
  }
  assert.equal(h.element.value, '0.5');
  assert.deepEqual([...h.captured], [2]);
  h.emit('pointermove', {clientX: 72});
  assert.equal(h.element.value, '0.25');
  h.controller.dispose();
});

test('decimal and negative ranges round to valid steps and clamp beyond both ends', () => {
  const h = harness({min: '-24', max: '12', step: '0.1', value: '0'});
  h.emit('pointerdown', {clientX: 123});
  assert.equal(h.element.value, '-5.8');
  h.emit('pointermove', {clientX: -100}); assert.equal(h.element.value, '-24');
  h.emit('pointermove', {clientX: 900}); assert.equal(h.element.value, '12');
  h.controller.dispose();
  const uneven = harness({min: '0', max: '10', step: '3', value: '3'});
  uneven.emit('pointerdown', {clientX: 222}); assert.equal(uneven.element.value, '9');
  uneven.controller.dispose();
});

test('pen input and RTL reverse the track correctly; step any stays continuous', () => {
  const h = harness({rtl: true, step: 'any'});
  h.emit('pointerdown', {pointerType: 'pen', clientX: 22}); assert.equal(h.element.value, '1');
  h.emit('pointermove', {pointerType: 'pen', clientX: 123}); assert.equal(h.element.value, '0.495');
  h.emit('pointerup', {pointerType: 'pen', clientX: 222}); assert.equal(h.element.value, '0');
  h.controller.dispose();
});

test('pointer cancellation retains the last input value and commits only once', () => {
  for (const type of ['pointercancel', 'lostpointercapture']) {
    const h = harness();
    h.emit('pointerdown', {clientX: 172});
    h.emit(type, {clientX: 22});
    h.emit('pointerup', {clientX: 22});
    assert.equal(h.element.value, '0.75');
    assert.deepEqual(h.changes, [{value: '0.75', bubbles: true}]);
    assert.equal(h.captured.size, 0);
    h.controller.dispose();
  }
});

test('focus, viewport, scrolling and hidden-page changes release active touches', () => {
  for (const type of ['blur', 'pagehide', 'resize', 'scroll', 'visibilitychange']) {
    const h = harness();
    h.emit('pointerdown', {clientX: 172});
    h.document.hidden = true;
    h.emit(type, {}, type === 'visibilitychange' ? h.document : h.host);
    h.emit('pointermove', {clientX: 222});
    assert.equal(h.element.value, '0.75');
    assert.equal(h.changes.length, 1);
    assert.equal(h.captured.size, 0);
    h.controller.dispose();
  }
});

test('cancel and dispose are idempotent; unchanged gestures do not emit a commit', () => {
  const h = harness();
  h.emit('pointerdown'); h.emit('pointerup');
  assert.equal(h.inputs.length, 0); assert.equal(h.changes.length, 0);
  h.emit('pointerdown', {clientX: 172}); h.controller.cancel(); h.controller.cancel();
  assert.equal(h.changes.length, 1);
  h.emit('pointerdown', {clientX: 22}); h.controller.dispose(); h.controller.dispose();
  assert.equal(h.changes.length, 2);
  h.emit('pointerdown', {clientX: 222});
  assert.equal(h.element.value, '0');
});

test('mouse and keyboard behavior remain native, and invalid or disabled controls are ignored', () => {
  const h = harness();
  for (const type of ['pointerdown', 'pointermove', 'pointerup']) {
    assert.equal(h.emit(type, {pointerType: 'mouse', clientX: 222}).defaultPrevented, false);
  }
  assert.equal(h.emit('keydown', {key: 'ArrowRight'}).defaultPrevented, false);
  h.element.disabled = true;
  assert.equal(h.emit('pointerdown', {clientX: 222}).defaultPrevented, false);
  h.element.disabled = false;
  h.emit('pointerdown', {clientX: NaN}); h.emit('pointerdown', {button: 2});
  assert.equal(h.inputs.length, 0); assert.equal(h.captured.size, 0);
  h.controller.dispose();
  for (const width of [0, 12]) {
    const narrow = harness({width}); narrow.emit('pointerdown');
    assert.equal(narrow.captured.size, 0); narrow.controller.dispose();
  }
});

test('separate sliders accept simultaneous touches independently', () => {
  const a = harness(), b = harness();
  a.emit('pointerdown', {pointerId: 2, clientX: 72});
  b.emit('pointerdown', {pointerId: 3, clientX: 172});
  assert.equal(a.element.value, '0.25'); assert.equal(b.element.value, '0.75');
  a.emit('pointerup', {pointerId: 2, clientX: 72});
  assert.deepEqual([...b.captured], [3]);
  a.controller.dispose(); b.controller.dispose();
});
