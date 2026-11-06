import test from 'node:test';
import assert from 'node:assert/strict';
import {drawWaveform, getWaveformWindow, timeAtWaveformX, waveformBeats} from '../dist/waveform-view.js';

function canvasFixture(width = 10, height = 100, dpr = 1) {
  const calls = [], rect = {width, height};
  const context = {
    fillStyle: '', font: '', textBaseline: '',
    setTransform(...args) { calls.push({type: 'transform', args}); },
    clearRect(...args) { calls.push({type: 'clear', args}); },
    fillRect(x, y, width, height) { calls.push({type: 'rect', color: this.fillStyle, x, y, width, height}); },
    fillText(text, x, y, maxWidth) { calls.push({type: 'text', text, color: this.fillStyle, x, y, maxWidth}); },
    measureText(text) { return {width: text.length * 6}; },
  };
  return {calls, rect, canvas: {width: 0, height: 0, ownerDocument: {defaultView: {devicePixelRatio: dpr}},
    getBoundingClientRect: () => rect, getContext: () => context}};
}

function waveform(count, duration) {
  return {version: 1, duration, frameCount: count, framesPerSecond: count / duration,
    min: new Uint8Array(count), max: new Uint8Array(count),
    low: new Uint8Array(count), mid: new Uint8Array(count), high: new Uint8Array(count)};
}
const waveformRects = (calls, color = '#ef535b') => calls.filter(call => call.type === 'rect' && call.color === color);
const close = (a, b) => assert.ok(Math.abs(a - b) < .00001, `${a} ≠ ${b}`);

test('centered detail windows retain their span at track edges', () => {
  assert.deepEqual(getWaveformWindow(100, 50, 8), {start: 46, end: 54});
  assert.deepEqual(getWaveformWindow(100, 1, 8), {start: 0, end: 8});
  assert.deepEqual(getWaveformWindow(100, 99, 8), {start: 92, end: 100});
  assert.deepEqual(getWaveformWindow(3, 2, 32), {start: 0, end: 3});
  assert.deepEqual(getWaveformWindow(100, -10, 4), {start: 0, end: 4});
  assert.deepEqual(getWaveformWindow(100, 200, 4), {start: 96, end: 100});
  assert.deepEqual(getWaveformWindow(0, 0), {start: 0, end: 0});
  assert.deepEqual(getWaveformWindow(NaN, NaN, NaN), {start: 0, end: 0});
  assert.deepEqual(getWaveformWindow(100, 50, 0), {start: 46, end: 54});
});

test('pointer coordinates seek within the actual visible time range', () => {
  const range = {start: 46, end: 54};
  assert.equal(timeAtWaveformX(0, 400, range), 46);
  assert.equal(timeAtWaveformX(200, 400, range), 50);
  assert.equal(timeAtWaveformX(400, 400, range), 54);
  assert.equal(timeAtWaveformX(-20, 400, range), 46);
  assert.equal(timeAtWaveformX(500, 400, range), 54);
  assert.equal(timeAtWaveformX(200, 0, range), 46);
  assert.equal(timeAtWaveformX(NaN, 400, range), 46);
  assert.equal(timeAtWaveformX(100, 400, {start: 5, end: 2}), 5);
});

test('fallback beat grids respect beatOffset and include range-edge beats', () => {
  const track = {bpm: 120, beatOffset: .125};
  assert.deepEqual(waveformBeats(track, 0, 2.125), [
    {time: .125, major: true}, {time: .625, major: false},
    {time: 1.125, major: false}, {time: 1.625, major: false}, {time: 2.125, major: true},
  ]);
  assert.deepEqual(waveformBeats(track, .625, 1.125), [{time: .625, major: false}, {time: 1.125, major: false}]);
});

test('variable tempo boundaries belong to the new meter and beat phase without duplication', () => {
  const track = {bpm: 130, tempos: [
    {start: 0, bpm: 120, meter: '4/4', beat: 1},
    {start: 2, bpm: 60, meter: '3/4', beat: 2},
  ]};
  assert.deepEqual(waveformBeats(track, 1, 7), [
    {time: 1, major: false}, {time: 1.5, major: false}, {time: 2, major: false},
    {time: 3, major: false}, {time: 4, major: true}, {time: 5, major: false},
    {time: 6, major: false}, {time: 7, major: true},
  ]);
  assert.deepEqual(waveformBeats(track, 2, 2), [{time: 2, major: false}]);
});

test('decimal boundaries do not duplicate floating-point near-identical beats', () => {
  const track = {tempos: [
    {start: 0, bpm: 600, meter: '4/4', beat: 1},
    {start: .3, bpm: 300, meter: '4/4', beat: 4},
  ]};
  const beats = waveformBeats(track, .2, .5);
  assert.equal(beats.length, 3);
  close(beats[0].time, .2); close(beats[1].time, .3); close(beats[2].time, .5);
  assert.deepEqual(beats.map(beat => beat.major), [false, false, true]);
});

test('late windows jump directly to their beat index and retain bar phase', () => {
  const start = 1_000_000_000.125;
  assert.deepEqual(waveformBeats({bpm: 120, beatOffset: .125}, start, start + 2), [
    {time: start, major: true}, {time: start + .5, major: false},
    {time: start + 1, major: false}, {time: start + 1.5, major: false},
    {time: start + 2, major: true},
  ]);
  const anchor = .123, step = 60 / 137, first = 100_000_003;
  const beats = waveformBeats({tempos: [{start: anchor, bpm: 137, meter: '3/4', beat: 2}]},
    anchor + first * step, anchor + (first + 4) * step);
  assert.equal(beats.length, 5);
  for (let i = 0; i < beats.length; i++) {
    close(beats[i].time, anchor + (first + i) * step);
    assert.equal(beats[i].major, (1 + first + i) % 3 === 0);
  }
});

test('beat grids are capped, tolerate absent metadata and do not mutate tempo entries', () => {
  assert.equal(waveformBeats({bpm: 120}, 0, 100_000).length, 2000);
  assert.deepEqual(waveformBeats(null, 0, 10), []);
  assert.deepEqual(waveformBeats({bpm: 0}, 0, 10), []);
  assert.deepEqual(waveformBeats({bpm: 120}, NaN, 10), []);
  assert.deepEqual(waveformBeats({bpm: 120}, 10, 0), []);
  const track = {tempos: [
    {start: 4, bpm: 120, meter: '4/4', beat: 1},
    {start: 2, bpm: 60, meter: '3/4', beat: 2},
    {start: 4, bpm: 60, meter: '4/4', beat: 3},
  ]};
  const original = JSON.stringify(track);
  assert.deepEqual(waveformBeats(track, 0, 5), [
    {time: 2, major: false}, {time: 3, major: false},
    {time: 4, major: false}, {time: 5, major: false},
  ]);
  assert.equal(JSON.stringify(track), original);
});

test('one-frame transients survive per-device-pixel aggregation in every interval', () => {
  const {canvas, calls} = canvasFixture(2);
  const wave = waveform(100_000, 100);
  wave.min[49_999] = wave.max[49_999] = wave.low[49_999] = 255;
  wave.min[99_999] = wave.max[99_999] = wave.low[99_999] = 255;
  assert.equal(drawWaveform(canvas, {waveform: wave}), true);
  const bars = waveformRects(calls);
  assert.equal(bars.length, 2);
  assert.deepEqual(bars.map(bar => bar.x), [0, 1]);
  for (const bar of bars) { assert.equal(bar.width, 1); close(bar.height, 86); }
});

test('frameCount / duration controls time alignment even when nominal FPS differs', () => {
  const {canvas, calls} = canvasFixture(2);
  const wave = waveform(10, 100);
  wave.framesPerSecond = 150;
  wave.min[6] = wave.max[6] = wave.low[6] = 255;
  wave.min[2] = wave.max[2] = wave.low[2] = 255; // Outside the visible window.
  drawWaveform(canvas, {waveform: wave, start: 60, end: 80});
  assert.deepEqual(waveformRects(calls).map(bar => bar.x), [0]);
});

test('asymmetric positive and negative peaks retain their actual envelope', () => {
  const {canvas, calls} = canvasFixture(1);
  const wave = waveform(1, 1);
  wave.max[0] = 128; wave.min[0] = 255; wave.low[0] = 255;
  drawWaveform(canvas, {waveform: wave});
  const [bar] = waveformRects(calls);
  close(bar.y, 50 - 128 / 255 * 43);
  close(bar.height, (128 / 255 + 1) * 43);
});

test('frequency layers use red, gray and white and silence stays silent', () => {
  const {canvas, calls} = canvasFixture(2);
  const wave = waveform(2, 1);
  wave.min[0] = wave.max[0] = 255;
  wave.low[0] = 200; wave.mid[0] = 120; wave.high[0] = 40;
  drawWaveform(canvas, {waveform: wave});
  const low = waveformRects(calls, '#ef535b'), mid = waveformRects(calls, '#a8a8a8'), high = waveformRects(calls, '#f2f2f2');
  assert.equal(low.length, 1); assert.equal(mid.length, 1); assert.equal(high.length, 1);
  assert.equal(low[0].x, 0); assert.ok(low[0].height > mid[0].height); assert.ok(mid[0].height > high[0].height);
});

test('legacy peaks retain brief transients without slicing or spreading arrays', () => {
  const {canvas, calls} = canvasFixture(2);
  const peaks = Array(100_000).fill(0);
  peaks[49_999] = 1; peaks[99_999] = .5;
  peaks.slice = () => { throw new Error('Do not slice waveform data'); };
  drawWaveform(canvas, {peaks, duration: 100});
  assert.deepEqual(waveformRects(calls).map(bar => bar.height), [86, 43]);
});

test('DPR is capped at two and stopped equivalent inputs do not repaint', () => {
  const {canvas, calls, rect} = canvasFixture(100, 40, 3);
  const peaks = [.2, .8, 1];
  const options = {peaks, duration: 100, position: 20, markers: [{time: 40, label: 'A'}], beats: [10, 20]};
  assert.equal(drawWaveform(canvas, options), true);
  assert.equal(canvas.width, 200); assert.equal(canvas.height, 80);
  const count = calls.length;
  assert.equal(drawWaveform(canvas, {...options, markers: [{time: 40, label: 'A'}], beats: [10, 20]}), false);
  assert.equal(calls.length, count);
  assert.equal(drawWaveform(canvas, {...options, position: 20.01}), false); // Same device pixel.
  assert.equal(drawWaveform(canvas, {...options, position: 21}), true);
  rect.width = 200;
  assert.equal(drawWaveform(canvas, {...options, position: 21}), true);
  assert.equal(canvas.width, 400);
  canvas.width = 20; // External reset must not leave a blank cached canvas.
  assert.equal(drawWaveform(canvas, {...options, position: 21}), true);
  assert.equal(canvas.width, 400);
});

test('revision and replacement data invalidate geometry while caches stay per canvas', () => {
  const a = canvasFixture(2), b = canvasFixture(2), wave = waveform(2, 2);
  const options = {waveform: wave};
  assert.equal(drawWaveform(a.canvas, options), true);
  assert.equal(drawWaveform(b.canvas, options), true);
  assert.equal(drawWaveform(a.canvas, options), false);
  wave.min[0] = wave.max[0] = wave.low[0] = 255;
  assert.equal(drawWaveform(a.canvas, {...options, revision: 1}), true);
  assert.equal(waveformRects(a.calls).length, 1);
  assert.equal(drawWaveform(a.canvas, {...options, revision: 1}), false);
  const replacement = {...wave, max: new Uint8Array(wave.max)};
  assert.equal(drawWaveform(a.canvas, {waveform: replacement, revision: 1}), true);
});

test('moving the overview playhead reuses aggregated columns without scanning source frames', () => {
  const {canvas} = canvasFixture(100);
  let reads = 0;
  const peaks = new Proxy(Array(1000).fill(.5), {get(target, key) {
    if (/^\d+$/.test(String(key))) reads++;
    return target[key];
  }});
  const options = {peaks, duration: 100, overview: true};
  drawWaveform(canvas, {...options, position: 10});
  const scanned = reads;
  assert.ok(scanned >= 1000);
  assert.equal(drawWaveform(canvas, {...options, position: 20}), true);
  assert.equal(reads, scanned);
  drawWaveform(canvas, {...options, position: 20, revision: 1});
  assert.ok(reads > scanned);
});

test('markers, beat lines and loops are restricted to the visible window', () => {
  const {canvas, calls} = canvasFixture(100, 40);
  const options = {duration: 100, start: 40, end: 50, position: 10,
    markers: [{time: 30, label: 'OUT'}, {start: 45, name: 'CUE A'}, {time: 60, label: 'OUT'}],
    beats: [{time: 41, major: true}, {time: 20, major: true}], loop: {start: 35, end: 43}};
  drawWaveform(canvas, options);
  assert.deepEqual(calls.filter(call => call.type === 'text').map(call => call.text), ['CUE A']);
  assert.equal(waveformRects(calls, '#555555').length, 1);
  assert.deepEqual(waveformRects(calls, '#ffffff14').map(({x, width}) => ({x, width})), [{x: 0, width: 30}]);
  assert.equal(waveformRects(calls, '#ffffff').length, 0);
  const count = calls.length;
  assert.equal(drawWaveform(canvas, {...options, markers: [{time: 10, label: 'CHANGED OUTSIDE'}, {start: 45, name: 'CUE A'}]}), false);
  assert.equal(calls.length, count);
  assert.equal(drawWaveform(canvas, {...options, loop: {start: 80, end: 90}}), true);
});

test('overview omits labels and track-end playhead remains inside the canvas', () => {
  const {canvas, calls} = canvasFixture(100, 40, 2);
  drawWaveform(canvas, {duration: 100, position: 100, markers: [{time: 99, label: 'End'}], overview: true});
  assert.equal(calls.filter(call => call.type === 'text').length, 0);
  const [playhead] = waveformRects(calls, '#ffffff');
  assert.equal(playhead.x + playhead.width, 200);
});

test('hidden, missing-context and empty waveforms are safe without false cache hits', () => {
  const {canvas, calls, rect} = canvasFixture(0, 0);
  assert.equal(drawWaveform(canvas), false); assert.equal(calls.length, 0);
  rect.width = 20; rect.height = 20;
  assert.equal(drawWaveform(canvas, {duration: 0}), true);
  assert.equal(drawWaveform(canvas, {duration: 0}), false);
  assert.equal(calls.filter(call => call.type === 'rect').length, 2); // Background and center line only.
  assert.equal(drawWaveform(null), false);
  assert.equal(drawWaveform({...canvas, getContext: () => null}), false);
});
