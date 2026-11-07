// Imported titles and artist credits can exceed the former editor-only limit.
// Keep one bounded limit across readers, local storage and metadata edits.
export const MAX_TRACK_TEXT_LENGTH = 1024;

/** Source dates describe the source record, never the time it was read. */
export function metadataDate(value) {
  if (value == null || value === '' || value === 0) return '';
  if (typeof value === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(value)) {
    const time = Date.parse(value);
    return Number.isFinite(time) && new Date(time).toISOString().slice(0, 10) === value ? value : '';
  }
  if (typeof value !== 'string' && typeof value !== 'number') return '';
  const time = typeof value === 'number' ? value : Date.parse(value);
  return Number.isFinite(time) && time > 0 && time <= 8_640_000_000_000_000 ? new Date(time).toISOString() : '';
}

export function trackDateValue(track, field) {
  const source = metadataDate(track[field]);
  const external = source ? Date.parse(source) : 0;
  const local = field === 'dateAdded' ? track.addedAt : track.updatedAt;
  const localTime = Number.isFinite(local) && local > 0 ? local : 0;
  return field === 'dateAdded' ? external || localTime || null : Math.max(external, localTime) || null;
}

export function trackFileType(track) {
  return track.fileType || track.filename?.split('.').at(-1)?.toUpperCase() || '';
}

/** Keep optional descriptive fields through local cache/snapshot round trips. */
export function normalizeTrackMetadata(track) {
  const result = {};
  for (const field of ['album', 'genre', 'key', 'label', 'composer', 'remixer', 'mix', 'comments', 'fileType']) {
    if (track[field] === undefined) continue;
    const value = track[field];
    const control = field === 'comments' ? /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/ : /[\u0000-\u001f\u007f]/;
    if (typeof value !== 'string' || value.length > (field === 'comments' ? 4096 : 1024) || control.test(value)) throw new Error('曲の詳細情報の文字列を確認してください。');
    result[field] = value;
  }
  for (const [field, max] of Object.entries({rating:5, bitRate:100000, sampleRate:768000, bitDepth:64,
    year:9999, trackNumber:65535, discNumber:65535, playCount:4294967295, size:Number.MAX_SAFE_INTEGER,
    updatedAt:8_640_000_000_000_000})) {
    if (track[field] == null) continue;
    const value = track[field];
    if (!Number.isSafeInteger(value) || value < 0 || value > max) throw new Error('曲の詳細情報の数値を確認してください。');
    result[field] = value;
  }
  for (const field of ['dateAdded', 'dateModified', 'dateCreated']) {
    if (track[field] !== undefined) result[field] = metadataDate(track[field]);
  }
  return result;
}
