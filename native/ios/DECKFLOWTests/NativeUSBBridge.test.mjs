import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import {readFile} from 'node:fs/promises';
const source = await readFile(new URL('../DECKFLOW/NativeUSBBridge.js', import.meta.url), 'utf8');
function bridge(respond) {
  const calls = [];
  const window = {webkit: {messageHandlers: {deckflowUSB: {async postMessage(value) { calls.push(value); return respond(value); }}}}};
  window.top = window;
  vm.runInNewContext(source, {window, Blob, Uint8Array, ArrayBuffer, DOMException, atob, btoa, Object, Error, TypeError, Number});
  return {api: window.nativeUSB, calls};
}
test('device inventory requests do not need a selected root or open the picker', async () => {
  const devices = [{id:'authorized',name:'USB',connected:true,libraryFormats:['pdb','onelibrary']}];
  const {api,calls} = bridge(() => devices);
  assert.deepEqual(await api.listDevices(), devices);
  assert.equal(calls.length,1); assert.equal(calls[0].command,'listDevices');
  assert.equal(calls[0].rootId,undefined);
});
test('native USB bridge chunks audio and commits files in caller order', async () => {
  const {api, calls} = bridge(message => message.command === 'beginTransaction' ? {id: 'test'} : {written: 2});
  const progress = [];
  const data = new Uint8Array(1024 * 1024 + 7); data[0] = 13; data[data.length - 1] = 31;
  const result = await api.writeBatch('root', [{path: 'Contents/a.wav', blob: new Blob([data]), expectedFingerprint: null}, {path: 'PIONEER/rekordbox/export.pdb', blob: Uint8Array.of(1, 2), expectedFingerprint: 'a'.repeat(64)}], {onProgress: value => progress.push(value)});
  assert.equal(result.written, 2);
  assert.deepEqual(calls.map(value => value.command), ['beginTransaction', 'writeChunk', 'writeChunk', 'writeChunk', 'commitTransaction']);
  assert.deepEqual(calls.filter(value => value.command === 'writeChunk').map(value => [value.path, value.offset, atob(value.data).length]), [['Contents/a.wav', 0, 1024 * 1024], ['Contents/a.wav', 1024 * 1024, 7], ['PIONEER/rekordbox/export.pdb', 0, 2]]);
  assert.equal(progress.at(-1).phase, 'complete');
  assert.equal(progress.at(-1).completedBytes, data.length + 2);
  assert.equal(Object.isFrozen(api), true);
});
test('cancellation after staging rolls back instead of committing', async () => {
  const controller = new AbortController();
  const {api, calls} = bridge(message => message.command === 'beginTransaction' ? {id: 'test'} : {});
  await assert.rejects(api.writeBatch('root', [{path: 'a', blob: new Blob([new Uint8Array(1024 * 1024 + 1)]), expectedFingerprint: null}], {signal: controller.signal, onProgress: () => controller.abort()}), {name: 'AbortError'});
  assert.deepEqual(calls.map(value => value.command), ['beginTransaction', 'writeChunk', 'rollbackTransaction']);
});
test('write errors retain recovery context if an unplug blocks rollback', async () => {
  const {api, calls} = bridge(message => {
    if (message.command === 'beginTransaction') return {id: 'test'};
    throw new Error('USB detached');
  });
  await assert.rejects(api.writeBatch('chosen', [{path: 'a', blob: new Blob(['x']), expectedFingerprint: null}]), error => error.recoveryRequired && error.rootId === 'chosen');
  assert.equal(calls.at(-1).command, 'rollbackTransaction');
});
test('range reads preserve binary bytes and malformed write requests never begin', async () => {
  const {api, calls} = bridge(() => ({data: btoa(String.fromCharCode(0, 128, 255))}));
  assert.deepEqual(await api.readRange('root', 'audio.wav', {offset: 5, length: 3}), Uint8Array.of(0, 128, 255));
  const before = calls.length;
  await assert.rejects(api.writeBatch('root', [{path: 'x', blob: new Blob(['x'])}]), /変更確認値/);
  await assert.rejects(api.writeBatch('root', [{path: 'x', expectedFingerprint: null}]), /Blob/);
  assert.equal(calls.length, before);
});
test('progress rendering failures cannot turn a committed write into failure', async () => {
  const {api, calls} = bridge(message => message.command === 'beginTransaction' ? {id: 'test'} : {written: 1});
  const result = await api.writeBatch('root', [{path: 'x', blob: new Blob(['x']), expectedFingerprint: null}], {onProgress() { throw new Error('UI failure'); }});
  assert.equal(result.written, 1);
  assert.equal(calls.at(-1).command, 'commitTransaction');
});

test('read-only CAS guards travel with the staged transaction', async () => {
  const {api, calls} = bridge(message => message.command === 'beginTransaction' ? {id: 'test'} : {written: 1});
  const guards = [{path: 'export.pdb', expectedFingerprint: 'a'.repeat(64)}, {path: 'exportLibrary.db', expectedFingerprint: null}];
  await api.writeBatch('root', [{path: 'cue.DAT', blob: new Blob(['x']), expectedFingerprint: null}], {guards});
  assert.deepEqual(calls[0].guards, guards);
});
