/** DECKFLOW browser Device Library writer, MIT baken-derived binary core.
 * See NOTICE.md and LICENSE.baken. No native helper or network audio upload.
 * This module generates bytes; storage permissions and commit policy belong
 * to the caller. Existing export.pdb files must never be replaced with a plan
 * containing only a subset of their tracks.
 */
import {validateUsbLibrary, exportPositionMarks, exportTempos} from '../../usb-export.js?v=af0e2156cf5d84be';

let runtimePromise;
const encoder = new TextEncoder(), decoder = new TextDecoder();
const fail = message => { throw new Error(message); };
const number = (value, min, max, label) => {
  if (!Number.isSafeInteger(value) || value < min || value > max) fail(`${label}を確認してください。`);
  return value;
};

/** Optional bytes are for offline hosts/tests. Browser callers need no options. */
export function initWriter({wasmBytes} = {}) {
  if (!runtimePromise) runtimePromise = (async () => {
    const bytes = wasmBytes ?? await (async () => {
      const response = await fetch(new URL('./writer.wasm?v=baaadd3a8e072171', import.meta.url));
      if (!response.ok) fail('USB書き込みエンジンを読み込めません。');
      return response.arrayBuffer();
    })();
    const {instance} = await WebAssembly.instantiate(bytes, {});
    const api = instance.exports;
    const result = status => {
      const bytes = new Uint8Array(api.memory.buffer, api.df_result_ptr(), api.df_result_len()).slice();
      const length = new DataView(bytes.buffer).getUint32(0, true);
      const metadata = JSON.parse(decoder.decode(bytes.subarray(4, 4 + length)));
      if (status) fail(metadata.error || 'USBデータを生成できません。');
      return {metadata, bytes:bytes.subarray(4 + length)};
    };
    const allocation = bytes => {
      const ptr = api.df_alloc(bytes.byteLength);
      new Uint8Array(api.memory.buffer, ptr, bytes.byteLength).set(new Uint8Array(bytes.buffer, bytes.byteOffset, bytes.byteLength));
      return {ptr, length:bytes.byteLength, free:() => api.df_free(ptr, bytes.byteLength)};
    };
    const json = value => allocation(encoder.encode(JSON.stringify(value)));
    return {api, result, allocation, json};
  })().catch(error => { runtimePromise = undefined; throw error; });
  return runtimePromise;
}

function text(value, label, max = 256) {
  if (typeof value !== 'string' || value.length > max || /[\u0000-\u001f]/u.test(value)) fail(`${label}を確認してください。`);
  return value;
}
function comment(value) {
  if (typeof value !== 'string' || value.length > 1024 || /[\u0000-\u0008\u000b\u000c\u000e-\u001f]/u.test(value)) fail('コメントを確認してください。');
  return value;
}
function prepareTrack(input, {hotOnly = false} = {}) {
  // Memory-cue sections are left byte-identical during HOT-only editing, so
  // they need not be expressible by our XML interchange model.
  const source = {...input};
  if (hotOnly && source.positionMarks) source.positionMarks = source.positionMarks.filter(mark => mark.num >= 0);
  const track = validateUsbLibrary({format:'deckflow.library',version:1,tracks:[source],playlists:[]}).tracks[0];
  return {...track, tempos:exportTempos(track), positionMarks:exportPositionMarks(track),
    album:text(input.album || input.rekordbox?.album || '', 'アルバム'),
    genre:text(input.genre || input.rekordbox?.genre || '', 'ジャンル'),
    key:text(input.key || input.rekordbox?.tonality || '', 'キー', 64),
    comments:comment(input.comments || input.rekordbox?.comments || ''),
    codec:text(input.codec || '', 'コーデック', 32),
    size:input.size ?? input.rekordbox?.size ?? 0,
    sampleRate:input.sampleRate ?? input.rekordbox?.sampleRate ?? 0,
    bitRate:input.bitRate ?? input.rekordbox?.bitRate ?? 0,
    bitDepth:input.bitDepth ?? 16,
    ...metadataFields(input)};
}
function metadataFields(input) {
  const result = {};
  for (const key of ['composer','originalArtist','remixer','label','dateCreated','releaseDate','mixName']) {
    result[key] = text(input[key] ?? input.rekordbox?.[key] ?? '', key);
  }
  const added = input.addedDate ?? input.dateAdded ?? input.rekordbox?.dateAdded;
  if (added != null) result.addedDate = text(added, '追加日', 32);
  for (const [key,max] of [['trackNumber',0xffffffff],['discNumber',65535],['playCount',65535],['year',65535],['rating',5],['colorId',255]]) {
    result[key] = number(input[key] ?? input.rekordbox?.[key] ?? 0, 0, max, key);
  }
  if (input.masterContentId != null) result.masterContentId = number(input.masterContentId,0,0xffffffff,'元の楽曲ID');
  return result;
}
function devicePath(value) {
  const path = text(value, 'USB内のパス', 4096);
  if (!path.startsWith('/') || path.includes('\\') || path.split('/').slice(1).some(part => !part || part === '.' || part === '..')) fail('USB内のパスを確認してください。');
  return path;
}
function usbPath(track) {
  // Stable ID folder avoids filename collisions without putting raw IDs into
  // paths. Collision detection in the Rust planner remains authoritative.
  let hash = 0xcbf29ce484222325n;
  for (const byte of encoder.encode(track.id)) hash = BigInt.asUintN(64, (hash ^ BigInt(byte)) * 0x100000001b3n);
  const original = track.filename.normalize('NFC');
  const dot = original.lastIndexOf('.');
  const ext = dot > 0 ? original.slice(dot).toLowerCase() : '';
  let stem = Array.from(dot > 0 ? original.slice(0, dot) : original).slice(0, 64).join('')
    .replace(/[<>:"/\\|?*\u0000-\u001f]/gu, '_').replace(/[ .]+$/u, '') || 'track';
  if (/^(con|prn|aux|nul|com[1-9]|lpt[1-9])$/iu.test(stem)) stem = `_${stem}`;
  return `/Contents/DECKFLOW/${hash.toString(16).padStart(16, '0')}/${stem}${ext}`;
}

function prepareTracks(tracks) {
  if (!Array.isArray(tracks) || tracks.length > 10000) fail('楽曲は10,000曲までです。');
  const ids = new Set();
  return tracks.map(input => {
    const reuse = input.reuseDeviceFile;
    let result;
    if (reuse) {
      // Mirroring metadata references existing files. Do not force an analysed
      // grid or rewrite CUEs merely to describe that existing track in a PDB.
      const path = devicePath(reuse.usbPath), analysis = devicePath(reuse.analysisPath);
      if (!/\/ANLZ\d+\.DAT$/u.test(analysis)) fail('既存ANLZのパスを確認してください。');
      const filename = path.split('/').at(-1);
      if (filename.length > 255) fail('既存音源ファイル名が長すぎます。');
      if (!Number.isFinite(input.bpm) || input.bpm < 0 || input.bpm > 655.35 || !Number.isFinite(input.duration) || input.duration < 0 || input.duration > 65535) fail('既存曲のBPM・時間を確認してください。');
      result = {...input, id:text(String(input.id ?? ''), '曲ID'), filename,
        title:text(input.title || filename, '曲名'), artist:text(input.artist || '', 'アーティスト'),
        album:text(input.album || '', 'アルバム'), genre:text(input.genre || '', 'ジャンル'),
        key:text(input.key || '', 'キー', 64), comments:comment(input.comments || ''),
        codec:text(input.codec || '', 'コーデック', 32), ...metadataFields(input),
        size:input.size, sampleRate:input.sampleRate ?? 0, bitRate:input.bitRate ?? 0, bitDepth:input.bitDepth ?? 0,
        tempos:[], positionMarks:[], usbPath:path,reuseDeviceFile:{usbPath:path,analysisPath:analysis}};
    } else {
      result = prepareTrack(input); result.usbPath = usbPath(result);
    }
    if (!result.id || ids.has(result.id)) fail('曲IDが空、または重複しています。');
    ids.add(result.id);
    number(result.size, 1, 0xffffffff, `${result.filename}: ファイルサイズ`);
    number(result.sampleRate, reuse && result.sampleRate === 0 ? 0 : 8000, 384000, `${result.filename}: サンプルレート`);
    number(result.bitRate, 0, 0xffffffff, `${result.filename}: ビットレート`);
    number(result.bitDepth, reuse ? 0 : 8, 32, `${result.filename}: ビット深度`);
    if (input.numericId != null) result.numericId = number(input.numericId, 1, 0xffffffff, '曲のデバイスID');
    return result;
  });
}
function floors(input = {}) {
  const result = {};
  for (const key of ['track','playlist','artist','album','genre','key','label']) if (input[key] != null) result[key] = number(input[key],0,0xffffffff,`${key}のID`);
  return result;
}
function preparePlaylists(playlists, trackIds) {
  if (!Array.isArray(playlists) || playlists.length > 1000) fail('プレイリストは1,000個までです。');
  const ids = new Set();
  return playlists.map((input, index) => {
    const id = text(String(input.id ?? index), 'プレイリストID'), name = text(input.name,'プレイリスト名',200);
    if (ids.has(id) || !name.trim()) fail('プレイリストID・名前を確認してください。');
    ids.add(id);
    if (!Array.isArray(input.trackIds) || input.trackIds.length > 100000) fail('プレイリストの曲順を確認してください。');
    const wanted = input.trackIds.map(value => String(value));
    if (wanted.some(value => !trackIds.has(value))) fail(`${name}: ライブラリにない曲が含まれています。`);
    const path = input.folderPath ?? [];
    if (!Array.isArray(path) || path.length > 32 || path.some(value => !text(value,'フォルダ名',200).trim())) fail('プレイリストのフォルダを確認してください。');
    return {id,name,trackIds:wanted,folderPath:path};
  });
}
function checkedPdb(bytes) {
  if (!(bytes instanceof Uint8Array) || bytes.length < 4096 || bytes.length > 128 * 1024 * 1024) fail('Device LibraryのPDBを指定してください。');
  return bytes;
}
function prepareDevicePlaylists(lists) {
  if (!Array.isArray(lists) || lists.length > 1000) fail('デバイスのプレイリストを確認してください。');
  return lists.map(list => {
    if (typeof list.isFolder !== 'boolean' || !Array.isArray(list.trackIds) || list.trackIds.length > 100000) fail('デバイスのプレイリスト形式を確認してください。');
    return {numericId:number(list.numericId,1,0xffffffff,'プレイリストID'),parentId:number(list.parentId,0,0xffffffff,'親フォルダID'),
      sortOrder:number(list.sortOrder,0,0xffffffff,'プレイリスト順序'),isFolder:list.isFolder,name:text(list.name,'プレイリスト名',200),
      trackIds:list.trackIds.map(id => number(id,1,0xffffffff,'曲のデバイスID'))};
  });
}

/** New complete conventional Device Library. Use mergeLibrary for an existing PDB. */
export async function planLibrary({tracks, playlists = [], devicePlaylists = [], includeAllPlaylist = true, deviceName = 'DECKFLOW', idFloors = {}}) {
  const prepared = prepareTracks(tracks);
  const lists = preparePlaylists(playlists,new Set(prepared.map(track => track.id)));
  const runtime = await initWriter();
  const input = runtime.json({tracks:prepared, playlists:lists,devicePlaylists:prepareDevicePlaylists(devicePlaylists),includeAllPlaylist:!!includeAllPlaylist,
    deviceName:text(deviceName, 'デバイス名', 128),idFloors:floors(idFloors)});
  try {
    const {metadata, bytes} = runtime.result(runtime.api.df_plan(input.ptr, input.length));
    if (metadata.pdbLength !== bytes.length) fail('USBデータの長さが一致しません。');
    return {...metadata,pdb:bytes};
  } finally { input.free(); }
}

/** Read live rows without regenerating them. Unknown tables stay opaque. */
export async function inspectLibrary(pdb) {
  const runtime = await initWriter(), binary = runtime.allocation(checkedPdb(pdb));
  try { return runtime.result(runtime.api.df_inspect(binary.ptr,binary.length)).metadata; }
  finally { binary.free(); }
}

/** Append tracks/nodes/membership; all existing live/deleted row bytes remain
 * at their original offsets. Existing membership is only extended explicitly.
 * Unknown tables, artwork/history/preferences and unrelated fields survive.
 */
export async function mergeLibrary({pdb,tracks = [],playlists = [],devicePlaylists = [],appendPlaylists = [],existingTrackIds = {},idFloors = {},deviceName = 'DECKFLOW'}) {
  const prepared = prepareTracks(tracks), aliases = Object.fromEntries(Object.entries(existingTrackIds).map(([key,id]) => [text(key,'既存曲ID'),number(id,1,0xffffffff,'既存曲のデバイスID')]));
  const known = new Set([...Object.keys(aliases),...prepared.map(track => track.id)]);
  const lists = preparePlaylists(playlists,known);
  if (!Array.isArray(appendPlaylists) || appendPlaylists.length > 1000) fail('追記プレイリストを確認してください。');
  const append = appendPlaylists.map(list => {
    if (!Array.isArray(list.trackIds) || list.trackIds.length > 100000) fail('追記する曲順を確認してください。');
    const wanted = list.trackIds.map(value => String(value));
    if (wanted.some(id => !known.has(id))) fail('追記プレイリストに不明な曲が含まれています。');
    return {playlistId:number(list.playlistId,1,0xffffffff,'追記先のデバイスID'),trackIds:wanted};
  });
  const runtime = await initWriter();
  const input = runtime.json({tracks:prepared,playlists:lists,devicePlaylists:prepareDevicePlaylists(devicePlaylists),appendPlaylists:append,existingTrackIds:aliases,idFloors:floors(idFloors),deviceName:text(deviceName,'デバイス名',128)});
  const binary = runtime.allocation(checkedPdb(pdb));
  try {
    const {metadata,bytes} = runtime.result(runtime.api.df_merge(binary.ptr,binary.length,input.ptr,input.length));
    if (metadata.pdbLength !== bytes.length) fail('USBデータの長さが一致しません。');
    return {...metadata,pdb:bytes};
  } finally { input.free(); binary.free(); }
}

/** Bounded PCM consumer: keeps 150 waveform columns per second, not PCM. */
export async function createAnalysisMeter({sampleRate, channels}) {
  number(sampleRate, 8000, 384000, 'サンプルレート'); number(channels, 1, 8, 'チャンネル数');
  const runtime = await initWriter();
  const {metadata:{id}} = runtime.result(runtime.api.df_meter_new(sampleRate, channels));
  let closed = false;
  return {
    push(interleaved) {
      if (closed) fail('波形解析は終了しています。');
      if (!(interleaved instanceof Float32Array) || interleaved.length % channels) fail('PCMはフレーム単位のFloat32Arrayで指定してください。');
      if (interleaved.length > 8 * 1024 * 1024) fail('PCMは小さいチャンクに分けてください。');
      const input = runtime.allocation(interleaved);
      try { runtime.result(runtime.api.df_meter_push(id, input.ptr, interleaved.length)); }
      finally { input.free(); }
    },
    finish(track, plannedTrack, {mp3AudioFrames} = {}) {
      if (closed) fail('波形解析は終了しています。');
      if (!plannedTrack?.usbPath?.startsWith('/')) fail('USB上の音源パスがありません。');
      if (mp3AudioFrames != null) number(mp3AudioFrames, 1, 0xffffffff, 'MP3フレーム数');
      const input = runtime.json({track:prepareTrack(track), usbPath:plannedTrack.usbPath, mp3AudioFrames});
      try {
        const {metadata, bytes} = runtime.result(runtime.api.df_meter_finish(id, input.ptr, input.length));
        let at = 0;
        const take = length => { const data = bytes.subarray(at, at + length); at += length; return data; };
        const files = {dat:take(metadata.datLength), ext:take(metadata.extLength), ex2:take(metadata.ex2Length)};
        if (at !== bytes.length) fail('波形データの長さが一致しません。');
        return files;
      } finally { input.free(); runtime.api.df_meter_free(id); closed = true; }
    },
    dispose() { if (!closed) runtime.api.df_meter_free(id); closed = true; },
  };
}

/** Replace CUE sections only. Header extensions, PPTH, grids, every waveform,
 * PSSI, unknown sections, and (by default) memory CUE sections stay identical.
 * The caller must preserve the existing PDB and reject unsupported DB formats.
 */
export async function patchAnalysis(bytes, track, {kind, hotOnly = true} = {}) {
  if (!(bytes instanceof Uint8Array) || !['DAT','EXT','2EX'].includes(kind)) fail('ANLZのバイト列と種類を指定してください。');
  if (bytes.length > 128 * 1024 * 1024) fail('ANLZが大きすぎます。');
  const runtime = await initWriter();
  const input = runtime.json({track:prepareTrack(track, {hotOnly}), kind, hotOnly:!!hotOnly});
  const binary = runtime.allocation(bytes);
  try {
    const result = runtime.result(runtime.api.df_patch(binary.ptr, binary.length, input.ptr, input.length));
    if (result.metadata.length !== result.bytes.length) fail('ANLZの長さが一致しません。');
    return result.bytes;
  } finally { input.free(); binary.free(); }
}
