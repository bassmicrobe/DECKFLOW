/** Normalize imported/analyzed beat anchors once, outside the audio callback. */
export function normalizeBeatGrid(track = {}) {
  if (!track || typeof track !== 'object') return [];
  const anchors = (Array.isArray(track.tempos) ? track.tempos : []).filter(item =>
    Number.isFinite(item?.start) && item.start >= 0 && Number.isFinite(item.bpm) && item.bpm > 0)
    .map(item => ({start: item.start, bpm: item.bpm})).sort((a, b) => a.start - b.start);
  const grid = [];
  for (const anchor of anchors) {
    if (grid.at(-1)?.start === anchor.start) grid[grid.length - 1] = anchor;
    else grid.push(anchor);
  }
  if (!grid.length && Number.isFinite(track.bpm) && track.bpm > 0) {
    grid.push({start: Math.max(0, Number(track.beatOffset) || 0), bpm: track.bpm});
  }
  return grid;
}

export function beatSegment(grid, position) {
  if (!grid.length) return null;
  let low = 0, high = grid.length;
  while (low < high) {const middle = (low + high) >>> 1; if (grid[middle].start <= position) low = middle + 1; else high = middle;}
  const index = Math.max(0, low - 1);
  return {...grid[index], next: grid[index + 1]?.start ?? Infinity};
}

export function beatPosition(grid, position, direction = 'nearest') {
  const segment = beatSegment(grid, position);
  if (!segment) return position;
  const period = 60 / segment.bpm;
  const beats = (position - segment.start) / period;
  const rounded = direction === 'next' ? Math.ceil(beats - 1e-8) : direction === 'previous' ? Math.floor(beats + 1e-8) : Math.round(beats);
  return Math.max(0, Math.min(segment.next, segment.start + rounded * period));
}
