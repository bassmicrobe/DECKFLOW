/** Read-only classic rekordbox Device Library / ANLZ reader, usable in a Worker.
 * PDB page/string handling adapted from baken 4.10.0 (revision 50d2ba0),
 * crates/baken-export/src/pdb/{read,rows,string}.rs and DECKFLOW usb-inspect.
 * Format reference: https://djl-analysis.deepsymmetry.org/rekordbox-export-analysis/
 * No encrypted database support, filesystem access, network access or audio decoding.
 *
 * MIT License — Copyright (c) 2025 Jesse Pinkman (JPHFA)
 * Permission is hereby granted, free of charge, to any person obtaining a copy
 * of this software and associated documentation files (the "Software"), to deal
 * in the Software without restriction, including without limitation the rights
 * to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
 * copies of the Software, and to permit persons to whom the Software is
 * furnished to do so, subject to the following conditions:
 * The above copyright notice and this permission notice shall be included in all
 * copies or substantial portions of the Software.
 * THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
 * IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
 * FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
 * AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
 * LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
 * OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
 * SOFTWARE.
 */
import {validateLibrarySnapshot} from './library-store.js?v=401613a8eaa5242c';
import {parseRekordboxLocation} from './rekordbox-model.js?v=401613a8eaa5242c';

const PAGE = 4096, MAX_DATABASE = 128 * 1024 * 1024, MAX_ANALYSIS = 32 * 1024 * 1024;
const fail = (detail = '') => { throw new Error(`Device Libraryを読み取れません。${detail}`); };
const control = /[\u0000-\u001f\u007f]/;
const view = bytes => new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
function uint(bytes, offset, size = 4, little = true) {
  if (!Number.isInteger(offset) || offset < 0 || offset + size > bytes.length) fail('データが途中で切れています。');
  return size === 2 ? view(bytes).getUint16(offset, little) : view(bytes).getUint32(offset, little);
}
const u16 = (bytes, offset, little = true) => uint(bytes, offset, 2, little);
const u32 = (bytes, offset, little = true) => uint(bytes, offset, 4, little);
const tagAt = (bytes, offset = 0) => String.fromCharCode(...bytes.subarray(offset, offset + 4));
const utf8 = new TextDecoder('utf-8', {fatal: true});
const utf16le = new TextDecoder('utf-16le', {fatal: true});
const utf16be = new TextDecoder('utf-16be', {fatal: true});
function text(value, max = 8192, empty = true) {
  if (typeof value !== 'string' || value.length > max || control.test(value) || (!empty && !value.trim())) fail('文字列の長さ・文字を確認してください。');
  return value;
}
function decode(decoder, bytes) {
  try { return decoder.decode(bytes); } catch { fail('文字コードが正しくありません。'); }
}
function deviceString(bytes, at) {
  if (!Number.isInteger(at) || at < 0 || at >= bytes.length) fail('文字列の位置が不正です。');
  const flag = bytes[at];
  if (flag & 1) {
    const size = flag >> 1;
    if (size < 1 || at + size > bytes.length) fail('文字列が途中で切れています。');
    return text(decode(utf8, bytes.subarray(at + 1, at + size)));
  }
  const size = u16(bytes, at + 1);
  if (size < 4 || at + size > bytes.length || ![0x40, 0x90].includes(flag) || (flag === 0x90 && size % 2)) fail('文字列の形式が未対応または破損しています。');
  return text(decode(flag === 0x90 ? utf16le : utf8, bytes.subarray(at + 4, at + size)));
}

/** Path relative to the selected device root. Never use it as a URL to fetch. */
export function devicePath(value, {empty = false} = {}) {
  if (empty && value === '') return '';
  text(value, 8192, false);
  if (!value.startsWith('/') || /[\\]/.test(value) || value.split('/').slice(1).some(part => !part || part === '.' || part === '..')) fail('USB内のファイルパスが不正です。');
  return value.normalize('NFC');
}
function hash(value) {
  let result = 0xcbf29ce484222325n;
  for (const byte of new TextEncoder().encode(value)) result = BigInt.asUintN(64, (result ^ BigInt(byte)) * 0x100000001b3n);
  return result.toString(16).padStart(16, '0');
}
function tableRows(bytes, tables, type, limit) {
  const table = tables.get(type);
  if (!table) return [];
  const result = [], visited = new Set();
  let index = table.first;
  while (true) {
    if (!index || index >= bytes.length / PAGE || visited.has(index)) fail('テーブルのページ参照が不正です。');
    visited.add(index);
    const page = bytes.subarray(index * PAGE, (index + 1) * PAGE);
    if (u32(page, 4) !== index || u32(page, 8) !== type) fail('テーブルのページ種別が一致しません。');
    if ((page[27] & 0x40) === 0) {
      const count = u16(page, 24) & 0x1fff;
      // used_size counts occupied bytes, not the highest heap address on an
      // edited/deleted page. The row index is the actual hard heap boundary.
      const directoryBytes = Math.floor(count / 16) * 36 + (count % 16 ? (count % 16) * 2 + 4 : 0);
      const heapEnd = PAGE - directoryBytes;
      if (heapEnd < 40 || u16(page, 30) > heapEnd - 40) fail('行インデックスが範囲外です。');
      const starts = [];
      for (let i = 0; i < count; i++) {
        const base = PAGE - Math.floor(i / 16) * 36;
        if ((u16(page, base - 4) >> (i % 16)) & 1) {
          const start = 40 + u16(page, base - 6 - (i % 16) * 2);
          if (start < 40 || start >= heapEnd) fail('行が範囲外です。');
          starts.push(start);
        }
      }
      const sorted = [...new Set(starts)].sort((a, b) => a - b);
      if (sorted.length !== starts.length) fail('行の位置が重複しています。');
      const ends = new Map(sorted.map((start, i) => [start, sorted[i + 1] ?? heapEnd]));
      for (const start of starts) {
        if (result.length >= limit) fail('ライブラリの件数が上限を超えています。');
        result.push(page.subarray(start, ends.get(start)));
      }
    }
    if (index === table.last) return result;
    index = u32(page, 12);
  }
}

/** Classic PIONEER/rekordbox/export.pdb. sourceId must identify the selected source. */
export function parseDeviceDatabase(bytes, {sourceId = 'device'} = {}) {
  text(sourceId, 1024, false);
  if (!(bytes instanceof Uint8Array) || bytes.length < PAGE || bytes.length > MAX_DATABASE || bytes.length % PAGE || u32(bytes, 4) !== PAGE) fail('classic export.pdb（128 MiB以下）を選んでください。');
  const count = u32(bytes, 8), tables = new Map(), warnings = [];
  if (!count || count > 64) fail('テーブル数が不正です。');
  for (let i = 0; i < count; i++) {
    const at = 28 + i * 16, type = u32(bytes, at);
    if (tables.has(type)) fail('テーブルが重複しています。');
    tables.set(type, {first: u32(bytes, at + 8), last: u32(bytes, at + 12)});
  }
  if (!tables.has(0)) fail('楽曲テーブルがありません。exportExt.pdbには対応していません。');
  const artists = new Map();
  for (const row of tableRows(bytes, tables, 2, 10000)) {
    const subtype = u16(row, 0), id = u32(row, 4);
    if (![0x60, 0x64].includes(subtype) || !id || artists.has(id)) fail('アーティストの形式が不正です。');
    artists.set(id, text(deviceString(row, subtype & 4 ? u16(row, 10) : row[9]), 180));
  }
  const tracks = [], entries = [], trackIds = new Map(), namespace = hash(sourceId);
  for (const row of tableRows(bytes, tables, 0, 10000)) {
    if (row.length < 136 || u16(row, 0) !== 0x24) fail('対応していない楽曲行です。');
    const string = i => { const at = u16(row, 94 + i * 2); if (at < 136) fail('楽曲の文字列位置が不正です。'); return deviceString(row, at); };
    const rawId = u32(row, 72), path = devicePath(string(20)), analysisPath = devicePath(string(14), {empty: true});
    if (!rawId || trackIds.has(rawId)) fail('曲IDが重複しています。');
    const duration = u16(row, 84), rawBpm = u32(row, 56) / 100;
    if (!duration) fail('曲の長さがありません。');
    const id = `usb-${namespace}-${rawId}-${hash(path)}`, filename = path.split('/').at(-1);
    const artistId = u32(row, 68);
    if (artistId && !artists.has(artistId)) warnings.push(`「${filename}」のアーティスト情報が見つかりません。`);
    if (rawBpm && (rawBpm < 30 || rawBpm > 300)) warnings.push(`「${filename}」のBPMが対応範囲外のため未設定にしました。`);
    const location = 'file://localhost' + path.split('/').map(encodeURIComponent).join('/');
    const track = {id, title: text(string(17) || filename, 180, false), artist: artists.get(artistId) ?? '',
      bpm: rawBpm >= 30 && rawBpm <= 300 ? rawBpm : null, duration, beatOffset: 0, cue: 0,
      hotcues: Array(8).fill(null), filename, fingerprint: '', addedAt: 0, peaks: [], confidence: 0,
      audioMissing: true, rekordbox: {trackId: String(rawId), location, size: u32(row, 16) || null}};
    tracks.push(track); entries.push({trackId: id, sourcePath: path, analysisPath}); trackIds.set(rawId, id);
  }
  const nodes = new Map();
  for (const row of tableRows(bytes, tables, 7, 2000)) {
    const id = u32(row, 12);
    if (!id || nodes.has(id)) fail('プレイリストIDが重複しています。');
    nodes.set(id, {id, parent: u32(row, 0), order: u32(row, 8), folder: !!u32(row, 16), name: text(deviceString(row, 20), 80, false), entries: []});
  }
  for (const row of tableRows(bytes, tables, 8, 100000)) {
    const node = nodes.get(u32(row, 8)), trackId = trackIds.get(u32(row, 4));
    if (!node || node.folder || !trackId) fail('プレイリストが存在しない曲またはフォルダを参照しています。');
    node.entries.push({order: u32(row, 0), trackId});
  }
  const folderPath = node => {
    const names = [], seen = new Set([node.id]);
    let parent = node.parent;
    while (parent) {
      const folder = nodes.get(parent);
      if (!folder?.folder || seen.has(parent) || names.length >= 32) fail('プレイリストの階層が不正です。');
      seen.add(parent); names.unshift(folder.name); parent = folder.parent;
    }
    return names;
  };
  const playlists = [];
  for (const node of [...nodes.values()].sort((a, b) => a.order - b.order || a.id - b.id)) {
    const folders = folderPath(node);
    if (node.folder) continue;
    const references = node.entries.sort((a, b) => a.order - b.order).map(entry => entry.trackId);
    if (new Set(references).size !== references.length || new Set(node.entries.map(entry => entry.order)).size !== references.length) fail('プレイリストの曲または曲順が重複しています。');
    // A changed playlist imports as a new snapshot; user-edited previous lists survive.
    playlists.push({id: `usb-pl-${namespace}-${node.id}-${hash(JSON.stringify([folders, node.name, references]))}`, name: node.name, folderPath: folders, trackIds: references});
  }
  const checked = validateLibrarySnapshot({format: 'deckflow.library', version: 1, tracks, playlists});
  return {...checked, entries, warnings};
}

function peaksOf(values, count, valueAt) {
  if (!count) return [];
  const length = Math.min(1200, count), peaks = Array(length).fill(0);
  for (let i = 0; i < count; i++) {
    const at = Math.floor(i * length / count);
    peaks[at] = Math.max(peaks[at], valueAt(values, i));
  }
  return peaks;
}
function mark(number, kind, start, end, name = '', color = null) {
  if (!Number.isInteger(number) || number < 0 || number > 8 || ![1, 2].includes(kind) || start < 0 || start > 86400 || (kind === 2 && (end <= start || end > 86400))) fail('CUEの位置・番号が不正です。');
  return {name: text(name, 1024), type: kind === 2 ? 4 : 0, start, end: kind === 2 ? end : null, num: number - 1, color};
}
const markKey = item => item.num >= 0 ? `hot:${item.num}` : `memory:${item.type}:${item.start}:${item.end}`;
function combineMarks(ordinary, detailed, extendedTypes = new Set()) {
  const map = new Map();
  for (const item of ordinary) {
    if (extendedTypes.has(item.num < 0 ? 0 : 1)) continue;
    const key = markKey(item);
    if (map.has(key) && JSON.stringify(map.get(key)) !== JSON.stringify(item)) fail('CUE情報が競合しています。');
    map.set(key, item);
  }
  // Extended cues carry the same positions plus names and colours.
  for (const item of detailed) {
    const key = markKey(item);
    if (map.has(key) && JSON.stringify(map.get(key)) !== JSON.stringify(item)) fail('拡張CUE情報が競合しています。');
    map.set(key, item);
  }
  if (map.size > 1000) fail('CUEの数が上限を超えています。');
  return [...map.values()].sort((a, b) => a.start - b.start || a.num - b.num);
}
function tempoSegments(beats) {
  const result = [];
  let base, ordinal = 0;
  for (const item of beats) {
    const expected = base ? base.start + ordinal * 60 / base.bpm : -1;
    if (!base || item.bpm !== base.bpm || item.beat !== (base.beat - 1 + ordinal) % 4 + 1 || Math.abs(item.time - expected) > .002) {
      base = {start: item.time, bpm: item.bpm, meter: '4/4', beat: item.beat}; result.push(base); ordinal = 0;
    }
    ordinal++;
  }
  if (result.length > 10000) fail('ビートグリッドの変化点が多すぎます。');
  return result;
}

/** Read one DAT/EXT/2EX file. Unknown tagged sections are skipped, never executed. */
export function parseDeviceAnalysis(bytes) {
  if (!(bytes instanceof Uint8Array) || bytes.length < 28 || bytes.length > MAX_ANALYSIS || tagAt(bytes) !== 'PMAI' || u32(bytes, 8, false) !== bytes.length) fail('ANLZファイルのヘッダーが不正です。');
  let at = u32(bytes, 4, false), path = null, peaks = [], waveformRank = 0;
  if (at < 28 || at > bytes.length) fail('ANLZヘッダーの長さが不正です。');
  const beats = [], ordinary = [], detailed = [], tags = [], warnings = [], cueLists = [];
  while (at < bytes.length) {
    if (tags.length >= 256) fail('ANLZセクションが多すぎます。');
    const length = u32(bytes, at + 8, false), header = u32(bytes, at + 4, false);
    if (header < 12 || length < header || at + length > bytes.length) fail('ANLZセクションが途中で切れています。');
    const section = bytes.subarray(at, at + length), tag = tagAt(section); tags.push(tag);
    if (tag === 'PPTH') {
      const size = u32(section, 12, false);
      if (size < 2 || size % 2 || 16 + size !== length || u16(section, length - 2, false) !== 0 || path !== null) fail('ANLZ音源パスが不正です。');
      const rawPath = decode(utf16be, section.subarray(16, length - 2));
      // Current desktop caches can identify audio as ?/basename. Parsing this
      // marker is safe, but attaching it still needs an explicit DB-path match
      // in mergeDeviceAnalysis; the marker must never locate an audio file.
      if (rawPath.startsWith('?/') && !rawPath.slice(2).includes('/')) {
        path = '?' + devicePath(rawPath.slice(1));
      } else path = devicePath(rawPath);
    } else if (tag === 'PQTZ') {
      const count = u32(section, 20, false);
      if (count > 500000 || 24 + count * 8 !== length || beats.length) fail('ANLZビートグリッドの長さが不正です。');
      for (let i = 0; i < count; i++) {
        const offset = 24 + i * 8, beat = u16(section, offset, false), bpm = u16(section, offset + 2, false) / 100, time = u32(section, offset + 4, false) / 1000;
        if (beat < 1 || beat > 4 || bpm < 20 || bpm > 600 || time > 86400 || (beats.length && time <= beats.at(-1).time)) fail('ANLZビートグリッドの値が不正です。');
        beats.push({beat, bpm, time});
      }
    } else if (tag === 'PCOB' || tag === 'PCO2') {
      const extended = tag === 'PCO2', list = u32(section, 12, false), count = u16(section, extended ? 16 : 18, false);
      if (list > 1 || count > 1000) fail('ANLZ CUE一覧が不正です。');
      cueLists.push({type: list, extended});
      let cursor = extended ? 20 : 24;
      for (let i = 0; i < count; i++) {
        const size = u32(section, cursor + 8, false), number = u32(section, cursor + 12, false);
        if (tagAt(section, cursor) !== (extended ? 'PCP2' : 'PCPT') || size < (extended ? 28 : 40) || cursor + size > length || (!extended && size !== 56) || (list === 0 ? number !== 0 : number === 0)) fail('ANLZ CUE行が不正です。');
        const row = section.subarray(cursor, cursor + size);
        const kind = row[extended ? 16 : 28], start = u32(row, extended ? 20 : 32, false) / 1000, end = u32(row, extended ? 24 : 36, false) / 1000;
        let name = '', color = null;
        if (extended && size >= 44) {
          const commentSize = u32(row, 40, false);
          if (commentSize % 2 || commentSize > 2050 || 44 + commentSize > size) fail('ANLZ CUE名の長さが不正です。');
          if (commentSize) {
            if (u16(row, 44 + commentSize - 2, false) !== 0) fail('ANLZ CUE名が閉じられていません。');
            name = decode(utf16be, row.subarray(44, 44 + commentSize - 2));
          }
          const colorAt = 44 + commentSize;
          if (number && colorAt + 4 <= size && row[colorAt]) color = Array.from(row.subarray(colorAt + 1, colorAt + 4));
          if (!number && row[28]) warnings.push('メモリーCUEの色番号は表示色に変換していません。');
        }
        (extended ? detailed : ordinary).push(mark(number, kind, start, end, name, color));
        cursor += size;
      }
      if (cursor !== length) fail('ANLZ CUE一覧の長さが一致しません。');
    } else if (['PWAV', 'PWV2', 'PWV3', 'PWV5', 'PWV6', 'PWV7'].includes(tag)) {
      const preview = tag === 'PWAV' || tag === 'PWV2';
      const width = preview ? 1 : u32(section, 12, false), count = u32(section, preview ? 12 : 16, false);
      const offset = preview || tag === 'PWV6' ? 20 : 24;
      const expectedWidth = tag === 'PWV5' ? 2 : ['PWV6', 'PWV7'].includes(tag) ? 3 : 1;
      if (width !== expectedWidth || count > 5000000 || offset + width * count !== length) fail('ANLZ波形データの長さが不正です。');
      const rank = tag === 'PWAV' ? 2 : tag === 'PWV2' ? 1 : tag === 'PWV6' ? 3 : 4;
      if (rank > waveformRank && count) {
        const body = section.subarray(offset);
        peaks = peaksOf(body, count, (data, i) => width === 3 ? Math.max(...data.subarray(i * 3, i * 3 + 3)) / 255 : width === 2 ? ((u16(data, i * 2, false) >> 2) & 31) / 31 : (data[i] & (tag === 'PWV2' ? 15 : 31)) / (tag === 'PWV2' ? 15 : 31));
        waveformRank = rank;
      }
    }
    at += length;
  }
  const positionMarks = combineMarks(ordinary, detailed, new Set(cueLists.filter(item => item.extended).map(item => item.type))), hotcues = Array(8).fill(null);
  for (const item of positionMarks) if (item.num >= 0) hotcues[item.num] = item.start;
  return {path, peaks, waveformRank, beats, tempos: tempoSegments(beats), positionMarks, ordinary, detailed, cueLists,
    hotcues, cue: positionMarks.find(item => item.num === -1)?.start ?? 0, beatOffset: beats[0]?.time ?? 0, tags, warnings};
}

/** Combine DAT/EXT reads; preserves richer extended cues and checks audio identity. */
export function mergeDeviceAnalysis(track, analyses, {allowAnonymousPath = false, preserveCues = false} = {}) {
  if (!analyses.length) return track;
  const path = parseRekordboxLocation(track.rekordbox.location).path.normalize('NFC');
  for (const analysis of analyses) {
    const explicitCache = allowAnonymousPath && analysis.path === '?/' + path.split('/').at(-1);
    if (analysis.path !== path && !explicitCache) fail('ANLZが別の音源を参照しています。');
  }
  const ordinary = analyses.flatMap(item => item.ordinary), detailed = analyses.flatMap(item => item.detailed);
  const extendedTypes = new Set(analyses.flatMap(item => item.cueLists).filter(item => item.extended).map(item => item.type));
  // Desktop caches can contain empty cue containers: master.db owns those
  // cues. Callers identify that database explicitly, including an empty list.
  const positionMarks = preserveCues ? (track.positionMarks ?? []) : combineMarks(ordinary, detailed, extendedTypes);
  const hotcues = preserveCues ? [...track.hotcues] : Array(8).fill(null);
  // PDB durations have only whole-second precision. Preserve cue points in its
  // final fractional second, but never conceal a clearly mismatched analysis.
  let duration = track.duration;
  for (const item of positionMarks) {
    const endpoint = item.end ?? item.start;
    if (endpoint >= track.duration + 1) fail('CUE位置が曲の長さを超えています。');
    duration = Math.max(duration, endpoint);
    if (item.num >= 0) hotcues[item.num] = item.start;
  }
  const gridSources = analyses.filter(item => item.beats.length);
  if (gridSources.length > 1 && gridSources.some(item => JSON.stringify(item.beats) !== JSON.stringify(gridSources[0].beats))) fail('ANLZのビートグリッドが競合しています。');
  const beats = (gridSources[0]?.beats ?? []).filter(item => item.time < track.duration + 1);
  if (beats.length) duration = Math.max(duration, beats.at(-1).time);
  const wave = [...analyses].sort((a, b) => b.waveformRank - a.waveformRank)[0];
  const result = {...track, duration, peaks: wave?.peaks.length ? wave.peaks : track.peaks,
    tempos: tempoSegments(beats), beatOffset: beats[0]?.time ?? track.beatOffset, positionMarks, hotcues,
    cue: preserveCues ? track.cue : positionMarks.find(item => item.num === -1)?.start ?? track.cue};
  return validateLibrarySnapshot({format: 'deckflow.library', version: 1, tracks: [result], playlists: []}).tracks[0];
}
