import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {parseDeviceDatabase, parseDeviceAnalysis, mergeDeviceAnalysis, devicePath} from '../dist/rekordbox-device.js';
import {validateLibrarySnapshot} from '../dist/library-store.js';

const fixture = name => readFile(new URL(`./fixtures/device-library/${name}`, import.meta.url));
const pdb = await fixture('export.pdb');
const dat = await fixture('ANLZ0000.DAT');
const ext = await fixture('ANLZ0000.EXT');
const two = await fixture('ANLZ0000.2EX');
function tableStart(bytes, type) {
  for (let i = 0; i < bytes.readUInt32LE(8); i++) if (bytes.readUInt32LE(28 + i * 16) === type) return bytes.readUInt32LE(36 + i * 16) * 4096;
  throw new Error('Missing fixture table');
}
function dataPage(bytes, type) {
  let offset = tableStart(bytes, type);
  while (bytes[offset + 27] & 0x40) offset = bytes.readUInt32LE(offset + 12) * 4096;
  return offset;
}
function section(tag, header, body) {
  const bytes = Buffer.alloc(12 + body.length); bytes.write(tag); bytes.writeUInt32BE(header, 4); bytes.writeUInt32BE(bytes.length, 8); body.copy(bytes, 12); return bytes;
}
function analysis(...sections) {
  const header = Buffer.alloc(28); header.write('PMAI'); header.writeUInt32BE(28, 4); header.writeUInt32BE(28 + sections.reduce((sum, value) => sum + value.length, 0), 8); return Buffer.concat([header, ...sections]);
}
function findSection(bytes, tag) {
  let offset = bytes.readUInt32BE(4);
  while (offset < bytes.length) { if (bytes.toString('ascii', offset, offset + 4) === tag) return offset; offset += bytes.readUInt32BE(offset + 8); }
  throw new Error('Missing fixture section');
}

test('pinned baken fixture imports Japanese metadata, folder/playlist order and empty playlists without audio', () => {
  const result = parseDeviceDatabase(pdb, {sourceId: 'my-usb'}), track = result.tracks[0];
  assert.equal(track.title, 'USB 日本語'); assert.equal(track.artist, 'DJ Fixture');
  assert.equal(track.filename, '日本語 120.wav'); assert.equal(track.duration, 5); assert.equal(track.bpm, 120);
  assert.equal(track.audioMissing, true); assert.equal(track.rekordbox.size, 882044);
  assert.equal(result.entries[0].sourcePath, '/Contents/DJ Fixture/UnknownAlbum/日本語 120.wav');
  assert.match(result.entries[0].analysisPath, /^\/PIONEER\/USBANLZ\/.+\/ANLZ0000.DAT$/);
  assert.deepEqual(result.playlists.find(item => item.name === 'Warmup').folderPath, ['Weekend']);
  assert.deepEqual(result.playlists.find(item => item.name === 'Warmup').trackIds, [track.id]);
  assert.deepEqual(result.playlists.find(item => item.name === 'Empty').trackIds, []);
  assert.deepEqual(result.warnings, []); validateLibrarySnapshot(result);
});

test('track identity is stable on repeat and isolated between devices even when raw IDs are identical', () => {
  const a = parseDeviceDatabase(pdb, {sourceId: 'device-A'});
  assert.deepEqual(a, parseDeviceDatabase(pdb, {sourceId: 'device-A'}));
  const b = parseDeviceDatabase(pdb, {sourceId: 'device-B'});
  assert.notEqual(a.tracks[0].id, b.tracks[0].id);
  assert.notEqual(a.playlists[0].id, b.playlists[0].id);
  const changed = Buffer.from(pdb), page = dataPage(changed, 7), firstRow = page + 40 + changed.readUInt16LE(page + 4096 - 6);
  changed[firstRow + 21] = 'X'.charCodeAt(0);
  const next = parseDeviceDatabase(changed, {sourceId: 'device-A'});
  assert.equal(a.tracks[0].id, next.tracks[0].id); assert.notEqual(a.playlists[0].id, next.playlists[0].id);
});

test('ANLZ existing waveform, variable beat grid and named eight-slot hot cues transfer without analysis', () => {
  const originalPdb = Buffer.from(pdb), originalDat = Buffer.from(dat);
  const source = parseDeviceDatabase(pdb).tracks[0];
  const parsed = [dat, ext, two].map(parseDeviceAnalysis);
  assert.equal(parsed[0].peaks.length, 400); assert.equal(parsed[1].peaks.length, 750);
  const result = mergeDeviceAnalysis(source, parsed);
  assert.equal(result.beatOffset, .125); assert.equal(result.cue, .5);
  assert.deepEqual(result.tempos, [{start: .125, bpm: 120, meter: '4/4', beat: 1}, {start: 2.125, bpm: 150, meter: '4/4', beat: 1}]);
  assert.equal(result.hotcues[7], 4.25); assert.equal(result.positionMarks.length, 2);
  assert.deepEqual(result.positionMarks[0], {name: 'Memory loop', type: 4, start: .5, end: 1, num: -1, color: null});
  assert.deepEqual(result.positionMarks[1], {name: 'Hot H', type: 0, start: 4.25, end: null, num: 7, color: [255, 0, 0]});
  assert.ok(result.peaks.some(value => value > 0)); assert.ok(result.peaks.every(value => value >= 0 && value <= 1));
  assert.equal(result.audioMissing, true); assert.deepEqual(pdb, originalPdb); assert.deepEqual(dat, originalDat);
});

test('old DAT-only cache preserves legacy memory loop and rejects analysis for another audio path', () => {
  const track = parseDeviceDatabase(pdb).tracks[0], parsed = parseDeviceAnalysis(dat);
  const result = mergeDeviceAnalysis(track, [parsed]);
  assert.equal(result.positionMarks[0].type, 4); assert.equal(result.positionMarks[0].end, 1);
  assert.equal(result.peaks.length, 400);
  assert.throws(() => mergeDeviceAnalysis(track, [{...parsed, path: '/Contents/Other.wav'}]), /別の音源/);
  assert.throws(() => mergeDeviceAnalysis({...track, duration: 2}, [parsed, parseDeviceAnalysis(ext)]), /曲の長さ/);
});

test('malformed table chains, row pointers, strings and unsupported inputs fail boundedly', () => {
  for (const bytes of [new Uint8Array(), new Uint8Array(4096), pdb.subarray(0, pdb.length - 1), {length: 4096}]) assert.throws(() => parseDeviceDatabase(bytes));
  let changed = Buffer.from(pdb), start = tableStart(changed, 0); changed.writeUInt32LE(start / 4096, start + 12);
  assert.throws(() => parseDeviceDatabase(changed), /ページ参照/);
  changed = Buffer.from(pdb); let page = dataPage(changed, 0); changed.writeUInt16LE(4095, page + 4096 - 6);
  assert.throws(() => parseDeviceDatabase(changed), /行が範囲外/);
  changed = Buffer.from(pdb); page = dataPage(changed, 0); const row = page + 40 + changed.readUInt16LE(page + 4096 - 6);
  changed.writeUInt16LE(2, row + 94 + 17 * 2);
  assert.throws(() => parseDeviceDatabase(changed), /文字列位置/);
  assert.throws(() => parseDeviceDatabase(pdb, {sourceId: ''}));
});

test('deleted row slots are ignored even when their pointer contains garbage', () => {
  const changed = Buffer.from(pdb), page = dataPage(changed, 2);
  changed.writeUInt16LE(0, page + 4096 - 4); changed.writeUInt16LE(65535, page + 4096 - 6);
  const result = parseDeviceDatabase(changed);
  assert.equal(result.tracks[0].artist, ''); assert.equal(result.warnings.length, 1);
});

test('unsafe device paths and corrupt ANLZ bounds are rejected', () => {
  for (const path of ['../x', '/a/../x', '/a//x', '/a\\x', '/a/./x', '/a/\u0000x']) assert.throws(() => devicePath(path));
  assert.equal(devicePath('/Contents/曲.wav'), '/Contents/曲.wav');
  for (const bytes of [new Uint8Array(28), dat.subarray(0, dat.length - 1)]) assert.throws(() => parseDeviceAnalysis(bytes));
  let changed = Buffer.from(dat), offset = findSection(changed, 'PQTZ'); changed.writeUInt32BE(0xffffffff, offset + 20);
  assert.throws(() => parseDeviceAnalysis(changed), /ビートグリッド/);
  changed = Buffer.from(dat); offset = findSection(changed, 'PWAV'); changed.writeUInt32BE(0xffffffff, offset + 12);
  assert.throws(() => parseDeviceAnalysis(changed), /波形/);
  changed = Buffer.from(dat); offset = findSection(changed, 'PQTZ'); changed.writeUInt32BE(0, offset + 28 + 8);
  assert.throws(() => parseDeviceAnalysis(changed), /ビートグリッド/);
});

test('short extended cue records and unknown tagged sections are accepted without guessing missing fields', () => {
  const cue = Buffer.alloc(28); cue.write('PCP2'); cue.writeUInt32BE(16, 4); cue.writeUInt32BE(28, 8); cue.writeUInt32BE(8, 12); cue[16] = 1; cue.writeUInt32BE(1250, 20); cue.writeUInt32BE(0xffffffff, 24);
  const list = Buffer.alloc(8); list.writeUInt32BE(1); list.writeUInt16BE(1, 4);
  const result = parseDeviceAnalysis(analysis(section('PCO2', 20, Buffer.concat([list, cue])), section('XXXX', 12, Buffer.from([1, 2, 3]))));
  assert.deepEqual(result.positionMarks, [{name: '', type: 0, start: 1.25, end: null, num: 7, color: null}]);
  assert.equal(result.hotcues[7], 1.25); assert.deepEqual(result.tags, ['PCO2', 'XXXX']);
});

test('playlist cycles and orphan references are rejected before any library mutation', () => {
  let changed = Buffer.from(pdb), page = dataPage(changed, 7);
  const folder = page + 40 + changed.readUInt16LE(page + 4096 - 8);
  changed.writeUInt32LE(changed.readUInt32LE(folder + 12), folder);
  assert.throws(() => parseDeviceDatabase(changed), /階層/);
  changed = Buffer.from(pdb); page = dataPage(changed, 8); const row = page + 40 + changed.readUInt16LE(page + 4096 - 6);
  changed.writeUInt32LE(999999, row + 4);
  assert.throws(() => parseDeviceDatabase(changed), /存在しない曲/);
});

test('anonymous desktop cache paths require an explicit database-path association to be attached', () => {
  const track = parseDeviceDatabase(pdb).tracks[0];
  const utf16 = Buffer.from('?/日本語 120.wav\0', 'utf16le'); utf16.swap16();
  const length = Buffer.alloc(4); length.writeUInt32BE(utf16.length);
  const parsed = parseDeviceAnalysis(analysis(section('PPTH', 16, Buffer.concat([length, utf16]))));
  assert.equal(parsed.path, '?/日本語 120.wav');
  assert.throws(() => mergeDeviceAnalysis(track, [parsed]), /別の音源/);
  assert.doesNotThrow(() => mergeDeviceAnalysis(track, [parsed], {allowAnonymousPath: true}));
  assert.throws(() => mergeDeviceAnalysis(track, [{...parsed, path: '?/Other.wav'}], {allowAnonymousPath: true}), /別の音源/);
});

test('master database remains the cue authority even when local ANLZ lists are empty or stale', () => {
  const track = parseDeviceDatabase(pdb).tracks[0], cached = parseDeviceAnalysis(dat);
  const positionMarks = [{name: 'DB cue', type: 0, start: 2, end: null, num: 0, color: [20, 30, 40]}];
  const hotcues = [2, ...Array(7).fill(null)];
  const result = mergeDeviceAnalysis({...track, cue: .25, hotcues, positionMarks}, [cached], {preserveCues: true});
  assert.deepEqual(result.positionMarks, positionMarks); assert.deepEqual(result.hotcues, hotcues); assert.equal(result.cue, .25);
  assert.equal(result.peaks.length, 400); assert.equal(result.tempos.length, 2);
  const empty = mergeDeviceAnalysis({...track, positionMarks: []}, [cached], {preserveCues: true});
  assert.deepEqual(empty.positionMarks, []); assert.deepEqual(empty.hotcues, Array(8).fill(null));
});
