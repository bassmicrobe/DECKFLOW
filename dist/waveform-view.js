// Waveform arrays are immutable after generation. Pass a new array or increment
// revision when editing them in place. Canvas-owned caches are released by GC.
const canvasCache = new WeakMap();
const clamp = (value, min, max) => Math.max(min, Math.min(max, value));
const finite = (value, fallback = 0) => Number.isFinite(value) ? value : fallback;
const positive = value => Math.max(0, finite(value));
const same = (a, b) => !!a && a.length === b.length && a.every((value, i) => Object.is(value, b[i]));

/** A centered time window, shifted at either edge to retain its requested span. */
export function getWaveformWindow(duration, position, spanSeconds = 8) {
  duration = positive(duration);
  const span = Math.min(duration, spanSeconds > 0 && Number.isFinite(spanSeconds) ? spanSeconds : 8);
  const start = clamp(finite(position), 0, duration);
  const left = clamp(start - span / 2, 0, duration - span);
  return {start: left, end: left + span};
}

/** x and width use the same units (normally CSS pixels from the pointer rect). */
export function timeAtWaveformX(x, width, range) {
  const start = positive(range?.start), end = Math.max(start, finite(range?.end, start));
  return start + (end - start) * (width > 0 && Number.isFinite(width) ? clamp(finite(x), 0, width) / width : 0);
}

/** Visible beat grid only. TEMPO anchors carry their own meter and bar phase. */
export function waveformBeats(track, start, end) {
  if (!Number.isFinite(start) || !Number.isFinite(end) || end < start || end < 0) return [];
  start = Math.max(0, start);
  const valid = tempo => Number.isFinite(tempo?.start) && Number.isFinite(tempo?.bpm) && tempo.bpm > 0;
  const tempos = (Array.isArray(track?.tempos) ? track.tempos : []).filter(valid).sort((a, b) => a.start - b.start);
  if (!tempos.length) {
    const fallback = {start: finite(track?.beatOffset), bpm: track?.bpm, meter: '4/4', beat: 1};
    if (!valid(fallback)) return [];
    tempos.push(fallback);
  }
  const result = [];
  for (let segment = 0; segment < tempos.length && result.length < 2000; segment++) {
    const tempo = tempos[segment], next = tempos[segment + 1]?.start ?? Infinity;
    if (tempo.start > end) break;
    if (next <= start || next <= tempo.start) continue;
    const left = Math.max(start, tempo.start), right = Math.min(end, next);
    const step = 60 / tempo.bpm;
    const firstIndex = (left - tempo.start) / step, lastIndex = (right - tempo.start) / step;
    // A small relative tolerance prevents a decimal beat exactly at the range
    // edge being lost to floating-point rounding, including late in long tracks.
    const firstTolerance = Math.max(1e-9, Math.abs(firstIndex) * Number.EPSILON * 8);
    const lastTolerance = Math.max(1e-9, Math.abs(lastIndex) * Number.EPSILON * 8);
    const first = Math.max(0, Math.ceil(firstIndex - firstTolerance));
    const last = Math.floor(lastIndex + lastTolerance);
    if (!Number.isSafeInteger(first) || !Number.isSafeInteger(last)) continue;
    const numerator = Number(String(tempo.meter ?? '4/4').split('/')[0]);
    const meter = Number.isSafeInteger(numerator) && numerator > 0 ? numerator : 4;
    const beat = Number.isSafeInteger(tempo.beat) ? tempo.beat : 1;
    const phase = ((beat - 1) % meter + meter) % meter;
    for (let index = first; index <= last && result.length < 2000; index++) {
      const time = tempo.start + index * step;
      const tolerance = Math.max(1e-10, Math.abs(time) * Number.EPSILON * 8);
      // The next anchor owns a boundary beat, even if the two grids agree.
      if (time >= next - tolerance) break;
      if (time < left - tolerance || time > right + tolerance) continue;
      result.push({time: clamp(time, left, right), major: (phase + index % meter) % meter === 0});
    }
  }
  return result;
}

function sourceData(waveform, peaks, duration) {
  const count = waveform?.frameCount;
  if (Number.isInteger(count) && count > 0 && waveform.min?.length >= count && waveform.max?.length >= count) {
    return {count, duration: positive(waveform.duration) || duration, min: waveform.min, max: waveform.max,
      low: waveform.low, mid: waveform.mid, high: waveform.high, detailed: true};
  }
  return {count: peaks?.length || 0, duration, min: peaks, max: peaks, detailed: false};
}

// Every source frame intersecting a device pixel contributes to its maximum.
// No decimation, slices or spreading: a one-frame transient remains visible.
function columnsFor(source, width, start, end) {
  const columns = {min: new Float32Array(width), max: new Float32Array(width)};
  if (source.detailed) {
    columns.low = new Float32Array(width);
    columns.mid = new Float32Array(width);
    columns.high = new Float32Array(width);
  }
  if (!source.count || !source.duration || end <= start) return columns;
  const framesPerSecond = source.count / source.duration;
  const framesPerPixel = (end - start) * framesPerSecond / width;
  const offset = start * framesPerSecond;
  const scale = source.detailed ? 1 / 255 : 1;
  for (let x = 0; x < width; x++) {
    const from = clamp(Math.floor(offset + x * framesPerPixel), 0, source.count);
    const to = clamp(Math.ceil(offset + (x + 1) * framesPerPixel), 0, source.count);
    let min = 0, max = 0, low = 0, mid = 0, high = 0;
    for (let i = from; i < to; i++) {
      min = Math.max(min, finite(source.min[i]));
      max = Math.max(max, finite(source.max[i]));
      if (source.detailed) {
        low = Math.max(low, finite(source.low?.[i]));
        mid = Math.max(mid, finite(source.mid?.[i]));
        high = Math.max(high, finite(source.high?.[i]));
      }
    }
    columns.min[x] = clamp(min * scale, 0, 1);
    columns.max[x] = clamp(max * scale, 0, 1);
    if (source.detailed) {
      columns.low[x] = clamp(low * scale, 0, 1);
      columns.mid[x] = clamp(mid * scale, 0, 1);
      columns.high[x] = clamp(high * scale, 0, 1);
    }
  }
  return columns;
}

function visibleMarkers(markers, start, end) {
  const result = [];
  for (const marker of markers || []) {
    const time = typeof marker === 'number' ? marker : marker?.time ?? marker?.start;
    if (!Number.isFinite(time) || time < start || time > end) continue;
    const label = typeof marker === 'number' ? '' : String(marker.label ?? marker.name ?? (marker.num >= 0 ? marker.num + 1 : 'CUE'));
    result.push([time, label]);
  }
  return result;
}

function visibleBeats(beats, start, end) {
  const result = [];
  for (const beat of beats || []) {
    const time = typeof beat === 'number' ? beat : beat?.time;
    if (Number.isFinite(time) && time >= start && time <= end) result.push([time, !!beat?.major]);
  }
  return result;
}

/**
 * Draw a full or zoomed waveform. Returns false when hidden or unchanged.
 * markers: seconds or {time,label}; existing {start,name,num} marks also work.
 * beats: seconds or {time,major}; loop: {start,end}; position:null hides playhead.
 * overview omits marker labels. All drawing uses neutral gray, white and red.
 */
export function drawWaveform(canvas, {waveform, peaks, duration, position = null, start = 0, end,
  markers = [], beats = [], loop = null, overview = false, revision = 0} = {}) {
  if (!canvas?.getBoundingClientRect) return false;
  const rect = canvas.getBoundingClientRect();
  if (!(rect.width > 0) || !(rect.height > 0)) return false;
  const ratio = clamp(finite(canvas.ownerDocument?.defaultView?.devicePixelRatio ?? globalThis.devicePixelRatio, 1), 1, 2);
  const width = Math.max(1, Math.round(rect.width * ratio)), height = Math.max(1, Math.round(rect.height * ratio));
  duration = positive(duration) || positive(waveform?.duration);
  start = clamp(finite(start), 0, duration);
  end = clamp(finite(end, duration), start, duration);
  const source = sourceData(waveform, peaks, duration);
  const geometry = [width, start, end, source.count, source.duration, source.min, source.max, source.low, source.mid, source.high, source.detailed, revision];
  const marks = visibleMarkers(markers, start, end), grid = visibleBeats(beats, start, end);
  const visibleLoop = loop && Number.isFinite(loop.start) && Number.isFinite(loop.end) && loop.end > loop.start && loop.start < end && loop.end > start
    ? [Math.max(start, loop.start), Math.min(end, loop.end)] : null;
  const toX = time => (time - start) / (end - start) * width;
  const playhead = Number.isFinite(position) && position >= start && position <= end && end > start
    ? clamp(Math.round(toX(position)), 0, width - 1) : null;
  const signature = [...geometry, height, ratio, playhead, !!overview, JSON.stringify(marks), JSON.stringify(grid), JSON.stringify(visibleLoop)];
  const previous = canvasCache.get(canvas);
  const resized = canvas.width !== width || canvas.height !== height;
  if (!resized && same(previous?.signature, signature)) return false;
  const context = canvas.getContext('2d');
  if (!context) return false;
  if (resized) { canvas.width = width; canvas.height = height; }
  const columns = same(previous?.geometry, geometry) ? previous.columns : columnsFor(source, width, start, end);
  context.setTransform(1, 0, 0, 1, 0, 0);
  context.clearRect(0, 0, width, height);
  context.fillStyle = '#0a0a0a';
  context.fillRect(0, 0, width, height);
  context.fillStyle = '#303030';
  context.fillRect(0, Math.floor(height / 2), width, 1);
  if (end > start) {
    for (const [time, major] of grid) {
      context.fillStyle = major ? '#555555' : '#292929';
      context.fillRect(clamp(Math.round(toX(time)), 0, width - 1), 0, 1, height);
    }
    const center = height / 2, amplitude = height * .43;
    const drawLayer = (band, color) => {
      context.fillStyle = color;
      for (let x = 0; x < width; x++) {
        const upper = Math.min(columns.max[x], band ? band[x] : 1) * amplitude;
        const lower = Math.min(columns.min[x], band ? band[x] : 1) * amplitude;
        if (upper + lower > 0) context.fillRect(x, center - upper, 1, upper + lower);
      }
    };
    drawLayer(null, source.detailed ? '#555555' : '#ef535b');
    if (source.detailed) {
      drawLayer(columns.low, '#ef535b');
      drawLayer(columns.mid, '#a8a8a8');
      drawLayer(columns.high, '#f2f2f2');
    }
    if (visibleLoop) {
      const left = toX(visibleLoop[0]), right = toX(visibleLoop[1]);
      context.fillStyle = '#ffffff14';
      context.fillRect(left, 0, right - left, height);
      context.fillStyle = '#ef535b';
      context.fillRect(left, height - 2 * ratio, right - left, 2 * ratio);
    }
    for (const [time, label] of marks) {
      const x = clamp(Math.round(toX(time)), 0, width - 1);
      context.fillStyle = '#ef535b';
      context.fillRect(x, 0, Math.max(1, ratio), height);
      if (!overview && label) {
        context.font = `${10 * ratio}px ui-monospace, monospace`;
        context.textBaseline = 'top';
        const text = label.slice(0, 32), padding = 3 * ratio;
        const textWidth = context.measureText(text).width;
        const labelX = clamp(x + padding, 0, Math.max(0, width - textWidth - padding));
        context.fillStyle = '#0a0a0a';
        context.fillRect(labelX, 0, Math.min(textWidth + padding, width - labelX), 14 * ratio);
        context.fillStyle = '#f2f2f2';
        context.fillText(text, labelX, 2 * ratio, Math.max(1, width - labelX));
      }
    }
    if (playhead !== null) {
      context.fillStyle = '#ffffff';
      const line = Math.max(1, ratio);
      context.fillRect(Math.min(playhead, width - line), 0, line, height);
    }
  }
  canvasCache.set(canvas, {signature, geometry, columns});
  return true;
}
