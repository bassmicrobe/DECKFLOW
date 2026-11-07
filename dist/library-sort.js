import {trackDateValue, trackFileType} from './track-metadata.js?v=7c8bf604d2c9c1e4';
const textFields = new Set(['title','artist','album','genre','key','comments','fileType','fileName','label','composer','remixer']);
const fields = new Set(['added', ...textFields, 'bpm', 'duration', 'rating', 'dateAdded', 'dateModified', 'bitRate', 'sampleRate', 'bitDepth', 'year', 'playCount']);
const collator = new Intl.Collator('ja', {numeric: true, sensitivity: 'base'});

/** Return a stable sorted copy. Unknown values stay last in both directions. */
export function sortLibraryTracks(tracks, {field = 'added', direction = 'ascending', playlistOrder = null} = {}) {
  if (!fields.has(field)) field = 'added';
  const sign = direction === 'descending' ? -1 : 1;
  const text = textFields.has(field);
  const value = track => {
    if (field === 'dateAdded' || field === 'dateModified') return trackDateValue(track, field);
    const raw = field === 'fileName' ? track.filename : field === 'fileType' ? trackFileType(track) : track[field];
    if (text) return typeof raw === 'string' ? raw.trim() || null : null;
    const number = field === 'added' ? (playlistOrder ? playlistOrder.get(track.id) : track.addedAt) : track[field];
    return Number.isFinite(number) && (['added','rating','playCount'].includes(field) ? number >= 0 : number > 0) ? number : null;
  };
  return tracks.map((track, index) => ({track, index, value: value(track)})).sort((a, b) => {
    if (a.value === null || b.value === null) {
      if (a.value === null && b.value !== null) return 1;
      if (b.value === null && a.value !== null) return -1;
      return a.index - b.index;
    }
    const difference = text ? collator.compare(a.value, b.value) : a.value - b.value;
    return difference * sign || a.index - b.index;
  }).map(entry => entry.track);
}
