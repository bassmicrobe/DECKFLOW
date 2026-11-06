/** Shared, additive metadata carried by rekordbox XML imports. No file URL is fetched. */
const fail = message => { throw new Error(message); };
const string = (value, label, max = 1024, empty = true) => {
  if (typeof value !== 'string' || value.length > max || /[\u0000-\u001f\u007f]/.test(value) || (!empty && !value.trim())) fail(`${label}の文字列を確認してください。`);
  return value;
};
const number = (value, label, min, max) => {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < min || value > max) fail(`${label}の値が範囲外です。`);
  return value;
};
const integer = (value, label, min, max) => {
  number(value, label, min, max);
  if (!Number.isInteger(value)) fail(`${label}は整数で指定してください。`);
  return value;
};
const object = value => { if (!value || typeof value !== 'object' || Array.isArray(value)) fail('rekordbox情報の形式が正しくありません。'); return value; };

export function parseRekordboxLocation(value) {
  string(value, 'rekordboxのLocation', 8192, false);
  let url, path;
  try { url = new URL(value); path = decodeURIComponent(url.pathname); }
  catch { fail('rekordboxのLocationを読み取れません。'); }
  if (url.protocol !== 'file:' || !['', 'localhost'].includes(url.hostname) || url.search || url.hash || url.username || url.password || !path.startsWith('/') || /[\u0000-\u001f\u007f\\]/.test(path)) fail('rekordboxのLocationにはローカル音源のfile URLが必要です。');
  const filename = path.split('/').at(-1);
  if (!filename || filename === '.' || filename === '..') fail('rekordboxのLocationに音源ファイル名がありません。');
  return {location: value, path, filename, identity: path.normalize('NFC')};
}

export function normalizeRekordboxMetadata(track, duration) {
  const result = {};
  if (track.tempos !== undefined) {
    if (!Array.isArray(track.tempos) || track.tempos.length > 10000) fail('TEMPOは10,000件以内で指定してください。');
    let previous = -1;
    result.tempos = track.tempos.map(item => {
      object(item);
      const start = number(item.start, 'TEMPOの開始位置', 0, duration);
      if (start <= previous) fail('TEMPOの開始位置は重複せず昇順で指定してください。');
      previous = start;
      const meter = string(item.meter, 'TEMPOの拍子', 16, false);
      const match = /^(\d{1,2})\/(\d{1,2})$/.exec(meter);
      if (!match || +match[1] < 1 || +match[2] < 1) fail('TEMPOの拍子を確認してください。');
      return {start, bpm: number(item.bpm, 'TEMPOのBPM', 20, 600), meter, beat: integer(item.beat, 'TEMPOの小節内拍', 1, +match[1])};
    });
  }
  if (track.positionMarks !== undefined) {
    if (!Array.isArray(track.positionMarks) || track.positionMarks.length > 1000) fail('POSITION_MARKは1,000件以内で指定してください。');
    const hot = new Set();
    result.positionMarks = track.positionMarks.map(item => {
      object(item);
      if (item.type !== 0 && item.type !== 4) fail('対応していないPOSITION_MARK Typeです。CUE (0) とLOOP (4) に対応しています。');
      const start = number(item.start, 'POSITION_MARKの開始位置', 0, duration);
      const end = item.type === 4 ? number(item.end, 'LOOPの終了位置', start + Number.EPSILON, duration) : null;
      if (item.type === 4 && end <= start) fail('LOOPの終了位置は開始位置より後にしてください。');
      const num = integer(item.num, 'POSITION_MARKの番号', -1, 7);
      if (num >= 0 && hot.has(num)) fail('HOT CUEの番号が重複しています。');
      if (num >= 0) hot.add(num);
      let color = null;
      if (item.color != null) {
        if (!Array.isArray(item.color) || item.color.length !== 3) fail('CUE色はRGBの3値で指定してください。');
        color = item.color.map(value => integer(value, 'CUE色', 0, 255));
      }
      return {name: string(item.name ?? '', 'CUE名', 1024), type: item.type, start, end, num, color};
    });
  }
  if (track.rekordbox !== undefined) {
    const source = object(track.rekordbox);
    result.rekordbox = {trackId: string(source.trackId, 'rekordboxの曲ID', 128, false), location: parseRekordboxLocation(source.location).location,
      size: source.size == null ? null : integer(source.size, 'rekordboxの音源サイズ', 0, Number.MAX_SAFE_INTEGER)};
  }
  return result;
}

export function normalizeFolderPath(value = []) {
  if (!Array.isArray(value) || value.length > 32) fail('プレイリスト階層は32段以内で指定してください。');
  return value.map(name => string(name, 'プレイリストフォルダ名', 80, false));
}
