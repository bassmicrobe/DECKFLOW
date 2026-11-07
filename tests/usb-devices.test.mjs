import test from 'node:test';
import assert from 'node:assert/strict';
import {normalizeUSBDevices, sourcePlaylistIds, USBDeviceMonitor, isDeviceLibrarySource} from '../dist/usb-devices.js';

const tick = () => new Promise(resolve => setImmediate(resolve));
const deferred = () => {let resolve, reject; const promise = new Promise((yes, no) => {resolve = yes; reject = no;}); return {promise, resolve, reject};};
function fixture(listDevices) {
  const timers = new Map(), states = [], errors = [], state = {visible: true, busy: false};
  const monitor = new USBDeviceMonitor({listDevices, onChange: devices => states.push(devices), onError: error => errors.push(error),
    isVisible: () => state.visible, isBusy: () => state.busy,
    setTimer: (callback, delay) => {timers.set(callback, delay); return callback;}, clearTimer: timer => timers.delete(timer)});
  return {monitor, timers, states, errors, state,
    async next() {const callback = timers.keys().next().value; if (callback) {timers.delete(callback); callback();} await tick();}};
}

test('authorized devices retain connected/offline/recovery status and discard malformed entries', () => {
  assert.deepEqual(normalizeUSBDevices([
    {id: 'usb-a', name: 'Main USB', connected: true, libraryFormats: ['pdb', 'onelibrary', 'pdb', 'invalid'], pendingTransactions: 2},
    {id: 'usb-b', name: 'Backup', connected: false, error: '取り外されています'},
    {id: 'usb-a', name: 'Duplicate', connected: false}, null, {id: ''},
  ]), [
    {id: 'usb-a', name: 'Main USB', connected: true, libraryFormats: ['pdb', 'onelibrary'], pendingTransactions: 2},
    {id: 'usb-b', name: 'Backup', connected: false, libraryFormats: [], pendingTransactions: 0, error: '取り外されています'},
  ]);
  assert.throws(() => normalizeUSBDevices({devices: []}), /一覧/);
});

test('three-second polling never overlaps slow native scans and reports removal/reconnection', async () => {
  const first = deferred(); let calls = 0;
  const f = fixture(() => {calls++; return calls === 1 ? first.promise : Promise.resolve([{id: 'a', connected: calls > 2}]);});
  f.monitor.start(); f.monitor.start(); f.monitor.refresh(); f.monitor.refresh();
  assert.equal(calls, 1); assert.equal(f.timers.size, 0);
  first.resolve([{id: 'a', connected: true}]); await tick();
  assert.equal(calls, 2); assert.deepEqual(f.states.map(items => items[0].connected), [true, false]);
  assert.deepEqual([...f.timers.values()], [3000]);
  await f.next(); assert.equal(calls, 3); assert.equal(f.states.at(-1)[0].connected, true);
  f.monitor.stop(); assert.equal(f.timers.size, 0);
});

test('hidden and importing states never start scans; becoming visible resumes detection', async () => {
  let calls = 0; const f = fixture(async () => {calls++; return [];});
  f.state.visible = false; f.monitor.start(); await tick(); assert.equal(calls, 0); assert.equal(f.timers.size, 0);
  f.state.visible = true; f.state.busy = true; f.monitor.refresh(); await tick(); assert.equal(calls, 0);
  await f.next(); assert.equal(calls, 0);
  f.state.busy = false; f.monitor.refresh(); await tick(); assert.equal(calls, 1);
  f.state.visible = false; await f.next(); assert.equal(calls, 1); assert.equal(f.timers.size, 0);
  f.monitor.stop();
});

test('pagehide or a USB operation invalidates late results without overlapping a restart', async () => {
  const first = deferred(); let calls = 0;
  const f = fixture(() => ++calls === 1 ? first.promise : Promise.resolve([{id: 'new', connected: true}]));
  f.monitor.start(); f.monitor.stop(); f.monitor.start(); assert.equal(calls, 1);
  first.resolve([{id: 'old', connected: true}]); await tick();
  assert.equal(calls, 2); assert.deepEqual(f.states.map(items => items[0].id), ['new']);
  f.monitor.stop();
});

test('native detection errors are visible and do not stop later polls', async () => {
  let calls = 0; const f = fixture(async () => {if (++calls === 1) throw new Error('USB unavailable'); return [];});
  f.monitor.start(); await tick(); assert.equal(f.errors[0].message, 'USB unavailable');
  await f.next(); assert.deepEqual(f.states, [[]]); f.monitor.stop();
});

test('USB playlist scope uses local aliases and preserves empty playlists without borrowing another USB', () => {
  const source = {nativeUSB: {playlists: {'usb-a:empty': {id: 4}}}, parsed: {playlists: [{id: 'usb-a:warmup', trackIds: ['shared-song']}]}};
  const ids = sourcePlaylistIds(source);
  assert.deepEqual([...ids], ['usb-a:empty', 'usb-a:warmup']);
  assert.equal(ids.has('usb-b:warmup'), false);
  assert.deepEqual([...sourcePlaylistIds(null)], []);
});

test('device database sources are recognized without treating a folder name or local master DB as a connected USB',()=>{
  for(const databasePath of ['PIONEER/rekordbox/export.pdb','USB/PIONEER/rekordbox/exportLibrary.db','EXPORT.PDB'])assert.equal(isDeviceLibrarySource({databasePath}),true);
  for(const databasePath of ['USB/master.db','export.pdb.backup','USB/library.xml',''])assert.equal(isDeviceLibrarySource({databasePath}),false);
  assert.equal(isDeviceLibrarySource({label:'USB',databasePath:'master.db'}),false);
  assert.equal(isDeviceLibrarySource({nativeUSB:{rootId:'allowed'}}),true);
});
