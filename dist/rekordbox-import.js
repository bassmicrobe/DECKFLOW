/** rekordbox's documented playlist XML → DECKFLOW metadata, without audio access.
 * Spec: https://cdn.rekordbox.com/files/20200410160904/xml_format_list.pdf
 * This bounded subset parser deliberately has no DTD, external entity, network,
 * script or processing-instruction support. Works in browsers and Node alike.
 */
import {validateLibrarySnapshot} from './library-store.js?v=401613a8eaa5242c';
import {parseRekordboxLocation} from './rekordbox-model.js?v=401613a8eaa5242c';
const fail = message => { throw new Error(message); };
const own = (object, key) => Object.prototype.hasOwnProperty.call(object, key);
const validCodepoint = value => value === 9 || value === 10 || value === 13 || (value >= 32 && value <= 0xD7FF) || (value >= 0xE000 && value <= 0xFFFD) || (value >= 0x10000 && value <= 0x10FFFF);
function decode(value) {
  if (value.includes('<')) fail('XMLの属性に不正な文字があります。');
  let result = '', position = 0;
  const entities = {amp:'&', lt:'<', gt:'>', quot:'"', apos:"'"};
  while (position < value.length) {
    const amp = value.indexOf('&', position);
    if (amp < 0) { result += value.slice(position); break; }
    result += value.slice(position, amp);
    const end = value.indexOf(';', amp + 1);
    if (end < 0 || end - amp > 16) fail('XMLの文字参照が正しくありません。');
    const entity = value.slice(amp + 1, end);
    if (own(entities, entity)) result += entities[entity];
    else {
      const match = /^#(?:(\d+)|x([0-9a-fA-F]+))$/.exec(entity);
      const code = match ? parseInt(match[1] || match[2], match[1] ? 10 : 16) : NaN;
      if (!validCodepoint(code)) fail('XMLの外部エンティティや不正な文字参照には対応していません。');
      result += String.fromCodePoint(code);
    }
    position = end + 1;
  }
  return result;
}
function parseDocument(source) {
  if (typeof source !== 'string' || source.length > 32 * 1024 * 1024) fail('XMLは32 MiB以下のテキストを選んでください。');
  source = source.replace(/^\uFEFF/, '');
  for (const character of source) if (!validCodepoint(character.codePointAt(0))) fail('XMLに不正な制御文字があります。');
  const stack = [], roots = [];
  let offset = 0, count = 0, declaration = false;
  while (offset < source.length) {
    if (source[offset] !== '<') {
      let end = source.indexOf('<', offset); if (end < 0) end = source.length;
      if (source.slice(offset, end).trim()) fail('XMLの要素の外に予期しないテキストがあります。');
      offset = end; continue;
    }
    if (source.startsWith('<!--', offset)) {
      const end = source.indexOf('-->', offset + 4);
      if (end < 0 || source.slice(offset + 4, end).includes('--')) fail('XMLコメントが閉じられていません。');
      offset = end + 3; continue;
    }
    if (source.startsWith('<?xml', offset)) {
      const end = source.indexOf('?>', offset + 5);
      if (end < 0 || roots.length || declaration || offset !== 0 || !/^<\?xml\s+version\s*=\s*(["'])1\.0\1(?:\s+encoding\s*=\s*(["'])UTF-?8\2)?(?:\s+standalone\s*=\s*(["'])(?:yes|no)\3)?\s*\?>$/i.test(source.slice(offset, end + 2))) fail('XML宣言を確認してください（UTF-8 / version 1.0）。');
      declaration = true; offset = end + 2; continue;
    }
    if (source.startsWith('<!', offset) || source.startsWith('<?', offset)) fail('DTD・外部エンティティ・処理命令を含むXMLは取り込めません。');
    let end = offset + 1, quote = null;
    for (; end < source.length; end++) {
      const char = source[end];
      if (quote) { if (char === quote) quote = null; }
      else if (char === '"' || char === "'") quote = char;
      else if (char === '>') break;
      else if (char === '<') fail('XMLタグの形式が正しくありません。');
    }
    if (end === source.length) fail('XMLタグが閉じられていません。');
    const tag = source.slice(offset + 1, end); offset = end + 1;
    if (tag.startsWith('/')) {
      const match = /^\/([A-Za-z_][\w.-]*)\s*$/.exec(tag);
      if (!match || stack.pop()?.name !== match[1]) fail('XMLの開始タグと終了タグが一致しません。');
      continue;
    }
    const match = /^([A-Za-z_][\w.-]*)/.exec(tag);
    if (!match) fail('XMLの要素名が正しくありません。');
    const name = match[1], attrs = Object.create(null);
    let rest = tag.slice(name.length), closed = false;
    while (rest.length) {
      if (/^\s*\/$/.test(rest)) { closed = true; rest = ''; break; }
      if (/^\s*$/.test(rest)) break;
      const attr = /^\s+([A-Za-z_][\w.-]*)\s*=\s*(?:"([^"]*)"|'([^']*)')/.exec(rest);
      if (!attr || own(attrs, attr[1])) fail('XMLの属性が不正、または重複しています。');
      attrs[attr[1]] = decode((attr[2] ?? attr[3]).replace(/[\t\n\r]/g, ' '));
      rest = rest.slice(attr[0].length);
    }
    const node = {name, attrs, children: []};
    if (++count > 250000 || stack.length >= 36) fail('XMLの要素数または階層が多すぎます。');
    if (stack.length) stack.at(-1).children.push(node); else roots.push(node);
    if (!closed) stack.push(node);
  }
  if (stack.length || roots.length !== 1 || roots[0].name !== 'DJ_PLAYLISTS') fail('rekordboxのDJ_PLAYLISTS XMLを選んでください。');
  return roots[0];
}
function number(attrs, name, fallback) {
  if (!own(attrs, name)) {
    if (fallback !== undefined) return fallback;
    fail(`XMLの${name}がありません。`);
  }
  if (!/^[+-]?(?:\d+(?:\.\d*)?|\.\d+)(?:[eE][+-]?\d+)?$/.test(attrs[name])) fail(`XMLの${name}が数値ではありません。`);
  const value = Number(attrs[name]);
  if (!Number.isFinite(value)) fail(`XMLの${name}が範囲外です。`);
  return value;
}
function required(attrs, name) { if (!own(attrs, name) || !attrs[name]) fail(`XMLの${name}がありません。`); return attrs[name]; }
// 64-bit FNV-1a over UTF-8. Any collision with an existing source is rejected by the store.
function stableId(kind, value) {
  let hash = 0xcbf29ce484222325n;
  for (const byte of new TextEncoder().encode(value)) hash = BigInt.asUintN(64, (hash ^ BigInt(byte)) * 0x100000001b3n);
  return `rb-${kind}-${hash.toString(16).padStart(16, '0')}`;
}
function children(node, expected) {
  for (const child of node.children) if (!expected.includes(child.name)) fail(`XMLの${node.name}内に未対応の${child.name}があります。`);
}

export function parseRekordboxXml(source) {
  const document = parseDocument(source), warnings = [];
  if (document.attrs.Version && document.attrs.Version !== '1.0.0') fail('対応するrekordbox XMLバージョンは1.0.0です。');
  children(document, ['PRODUCT', 'COLLECTION', 'PLAYLISTS']);
  const collections = document.children.filter(node => node.name === 'COLLECTION');
  if (collections.length !== 1) fail('XMLのCOLLECTIONがありません、または重複しています。');
  const collection = collections[0]; children(collection, ['TRACK']);
  if (collection.children.length > 10000) fail('一度に取り込める曲は10,000曲までです。');
  if (own(collection.attrs, 'Entries') && number(collection.attrs, 'Entries') !== collection.children.length) fail('XMLのCOLLECTION Entriesが曲数と一致しません。');
  const sourceIds = new Map(), locations = new Map(), ids = new Set();
  const tracks = collection.children.map(node => {
    children(node, ['TEMPO', 'POSITION_MARK']);
    if (node.children.filter(child => child.name === 'TEMPO').length > 10000 || node.children.filter(child => child.name === 'POSITION_MARK').length > 1000) fail('1曲のTEMPOは10,000件、POSITION_MARKは1,000件までです。');
    const a = node.attrs, trackId = required(a, 'TrackID'), location = parseRekordboxLocation(required(a, 'Location'));
    if (sourceIds.has(trackId)) fail('XMLのTrackIDが重複しています。');
    const id = stableId('track', JSON.stringify([trackId, location.identity]));
    if (ids.has(id)) fail('XMLの曲IDが衝突しています。'); ids.add(id);
    const declaredDuration = number(a, 'TotalTime'), average = number(a, 'AverageBpm', 0);
    if (declaredDuration <= 0) fail('XMLのTotalTimeは0秒より長い値が必要です。');
    const tempos = node.children.filter(child => child.name === 'TEMPO').map(child => {
      children(child, []);
      return {start: number(child.attrs, 'Inizio'), bpm: number(child.attrs, 'Bpm'), meter: child.attrs.Metro ?? '4/4', beat: number(child.attrs, 'Battito', 1)};
    });
    const positionMarks = node.children.filter(child => child.name === 'POSITION_MARK').map(child => {
      children(child, []);
      const mark = child.attrs, type = number(mark, 'Type'), hasColor = ['Red','Green','Blue'].some(key => own(mark, key));
      return {name: mark.Name ?? '', type, start: number(mark, 'Start'), end: type === 4 ? number(mark, 'End') : null,
        num: number(mark, 'Num', -1), color: hasColor ? ['Red','Green','Blue'].map(key => number(mark, key)) : null};
    });
    const lastPosition = Math.max(0, ...tempos.map(item => item.start), ...positionMarks.map(item => item.end ?? item.start));
    // rekordbox writes TotalTime as whole seconds. Preserve fractional marks in
    // that final second without accepting arbitrary out-of-bounds metadata.
    const duration = lastPosition >= declaredDuration && lastPosition < declaredDuration + 1 ? lastPosition + .001 : declaredDuration;
    const hotcues = Array(8).fill(null);
    for (const mark of positionMarks) if (Number.isInteger(mark.num) && mark.num >= 0 && mark.num < 8) hotcues[mark.num] = mark.start;
    const firstMemory = positionMarks.find(mark => mark.num === -1 && mark.type === 0);
    const addedAt = a.DateAdded ? Date.parse(a.DateAdded) : 0;
    if (!Number.isFinite(addedAt)) fail('XMLのDateAddedが正しくありません。');
    const track = {id, title: a.Name || location.filename.replace(/\.[^.]+$/, ''), artist: a.Artist || '', duration,
      bpm: average || tempos[0]?.bpm || null, beatOffset: tempos[0]?.start ?? 0, cue: firstMemory?.start ?? 0, hotcues,
      filename: location.filename, fingerprint: '', addedAt, peaks: [], confidence: 0, audioMissing: true,
      tempos, positionMarks, rekordbox: {trackId, location: location.location, size: own(a, 'Size') ? number(a, 'Size') : null}};
    sourceIds.set(trackId, id);
    if (!locations.has(location.identity)) locations.set(location.identity, []);
    locations.get(location.identity).push(id);
    return track;
  });
  const playlists = [], playlistKeys = new Map();
  let emptyFolders = 0;
  function visit(node, folderPath, root = false) {
    if (folderPath.length > 32) fail('プレイリスト階層は32段までです。');
    const type = required(node.attrs, 'Type'), name = required(node.attrs, 'Name');
    if (type === '0') {
      children(node, ['NODE']);
      const path = root ? folderPath : [...folderPath, name];
      if (own(node.attrs, 'Count') && number(node.attrs, 'Count') !== node.children.length) fail('XMLのフォルダーCountが一致しません。');
      if (!root && !node.children.length) emptyFolders++;
      const folderNames = new Set();
      for (const child of node.children) {
        if (child.attrs.Type === '0') {
          if (folderNames.has(child.attrs.Name)) fail('同じ階層の同名フォルダーは区別できません。rekordbox側で名前を変更してください。');
          folderNames.add(child.attrs.Name);
        }
        visit(child, path);
      }
    } else if (type === '1' && !root) {
      children(node, ['TRACK']);
      if (playlists.length >= 1000) fail('プレイリストは1,000件までです。');
      if (own(node.attrs, 'Entries') && number(node.attrs, 'Entries') !== node.children.length) fail('XMLのプレイリストEntriesが曲数と一致しません。');
      const keyType = node.attrs.KeyType ?? '0';
      if (!['0', '1'].includes(keyType)) fail('未対応のプレイリストKeyTypeです。');
      const trackIds = node.children.map(child => {
        children(child, []);
        const key = required(child.attrs, 'Key');
        if (keyType === '0') { const id = sourceIds.get(key); if (!id) fail(`${name}: COLLECTIONにない曲を参照しています。`); return id; }
        const matches = locations.get(parseRekordboxLocation(key).identity) ?? [];
        if (matches.length !== 1) fail(`${name}: Locationの参照先がない、または複数の曲に一致します。`);
        return matches[0];
      });
      const identity = JSON.stringify([...folderPath, name]);
      const occurrence = playlistKeys.get(identity) ?? 0; playlistKeys.set(identity, occurrence + 1);
      playlists.push({id: stableId('playlist', JSON.stringify([identity, occurrence, trackIds])), name, folderPath, trackIds});
    } else fail('XMLのプレイリストNODE Typeが正しくありません。');
  }
  const containers = document.children.filter(node => node.name === 'PLAYLISTS');
  if (containers.length > 1) fail('XMLのPLAYLISTSが重複しています。');
  if (containers[0]) {
    children(containers[0], ['NODE']);
    if (containers[0].children.length !== 1) fail('XMLのプレイリストROOTを確認してください。');
    visit(containers[0].children[0], [], true);
  }
  if (emptyFolders) warnings.push(`空のフォルダー${emptyFolders}件は取り込みません。曲がないプレイリストは保持します。`);
  warnings.push('XMLに音源・波形データは含まれません。元の音源を追加するとBPM・CUEを保って接続します。');
  const normalized = validateLibrarySnapshot({format: 'deckflow.library', version: 1, tracks, playlists});
  return {tracks: normalized.tracks, playlists: normalized.playlists, warnings};
}
