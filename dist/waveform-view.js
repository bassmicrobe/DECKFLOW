// Waveform arrays are immutable after generation. Pass a new array or increment
// revision when editing them in place. Canvas-owned caches are released by GC.
const canvasCache = new WeakMap();
// Detached surfaces never retain their visible DOM canvas. Global LRU bounds
// retained rasters even when many library thumbnails have been drawn.
const rasterLayers = new Map();
const MAX_LAYER_PIXELS = 2 * 1024 * 1024;
const MAX_CACHE_PIXELS = 8 * 1024 * 1024;
const MAX_CACHE_LAYERS = 64;
let rasterPixels = 0;
let tryOffscreenCanvas = true;
function releaseRaster(layer) {
  if (!layer || !rasterLayers.delete(layer)) return;
  rasterPixels -= layer.width * layer.height;
  layer.valid = false;
  layer.canvas.width = layer.canvas.height = 1;
}
function touchRaster(layer) {
  rasterLayers.delete(layer);
  rasterLayers.set(layer, true);
}
function rasterFor(canvas, width, height, previous) {
  if (width * height > MAX_LAYER_PIXELS) { releaseRaster(previous); return null; }
  if (previous?.valid && previous.width === width && previous.height === height) {
    touchRaster(previous); return previous;
  }
  releaseRaster(previous);
  let surface, context;
  if (tryOffscreenCanvas && typeof globalThis.OffscreenCanvas === 'function') {
    try {
      surface = new globalThis.OffscreenCanvas(width, height);
      context = surface.getContext('2d', {alpha: false});
    } catch { /* Fall back to a detached HTML canvas on older WebKit. */ }
    if (!context) { tryOffscreenCanvas = false; surface = undefined; }
  }
  try {
    if (!context) {
      surface = canvas.ownerDocument?.createElement?.('canvas');
      if (!surface) return null;
      surface.width = width; surface.height = height;
      context = surface.getContext('2d', {alpha: false});
    }
  } catch { return null; }
  if (!context) return null;
  while (rasterLayers.size && (rasterLayers.size >= MAX_CACHE_LAYERS || rasterPixels + width * height > MAX_CACHE_PIXELS)) {
    releaseRaster(rasterLayers.keys().next().value);
  }
  const layer = {canvas: surface, context, width, height, valid: true};
  rasterPixels += width * height;
  touchRaster(layer);
  return layer;
}
// Neon 3-band palette: blue lows, amber mids, white highs on a deep ink ground.
export const WAVEFORM_COLORS = Object.freeze({
  background: '#06070d', axis: '#1c1f2e', beatMajor: '#ef4444b3', beatMinor: '#bac2dc55', beatLabel: '#ff8494',
  base: '#2a2f45', mono: '#8b7bff', low: '#3b7bff', mid: '#ffa040', high: '#f4f6ff',
  loopFill: '#8b7bff26', loop: '#8b7bff', marker: '#ff4d6d', labelBackground: '#06070d',
  labelText: '#f4f6ff', playhead: '#ffffff'
});
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

function tempoSegments(track) {
  const valid = tempo => Number.isFinite(tempo?.start) && Number.isFinite(tempo?.bpm) && tempo.bpm > 0;
  const ordered = (Array.isArray(track?.tempos) ? track.tempos : []).filter(valid).sort((a, b) => a.start - b.start);
  // A later imported anchor at the same time supersedes its predecessor.
  const tempos = ordered.filter((tempo, i) => ordered[i + 1]?.start !== tempo.start);
  if (!tempos.length) {
    const fallback = {start: finite(track?.beatOffset), bpm: track?.bpm, meter: '4/4', beat: 1};
    if (!valid(fallback)) return [];
    tempos.push(fallback);
  }
  const result = [];
  for (const tempo of tempos) {
    const numerator = Number(String(tempo.meter ?? '4/4').split('/')[0]);
    const meter = Number.isSafeInteger(numerator) && numerator > 0 ? numerator : 4;
    const beat = Number.isSafeInteger(tempo.beat) ? tempo.beat : 1;
    const phase = ((beat - 1) % meter + meter) % meter;
    const previous = result.at(-1);
    const elapsed = previous ? (tempo.start - previous.start) / previous.step : 0;
    const bars = previous ? Math.floor((previous.phase + elapsed + 1e-8) / previous.meter) : 0;
    result.push({...tempo, meter, phase, step: 60 / tempo.bpm, bar: previous ? previous.bar + bars : 1});
  }
  return result;
}

/** Musical position derived from the saved grid, never from a new BPM estimate. */
export function waveformBeatPosition(track, position) {
  if (!Number.isFinite(position)) return null;
  const segments = tempoSegments(track);
  const tempo = segments.findLast(segment => segment.start <= position + 1e-10);
  if (!tempo) return null;
  const elapsed = Math.max(0, (position - tempo.start) / tempo.step);
  const index = Math.floor(elapsed + 1e-8), phase = tempo.phase + index;
  return {bar: tempo.bar + Math.floor(phase / tempo.meter), beat: phase % tempo.meter + 1,
    fraction: Math.max(0, elapsed - index), bpm: tempo.bpm, meter: tempo.meter};
}

/** Visible beat grid only. TEMPO anchors carry their own meter and bar phase. */
export function waveformBeats(track, start, end, {labels = false} = {}) {
  if (!Number.isFinite(start) || !Number.isFinite(end) || end < start || end < 0) return [];
  start = Math.max(0, start);
  const tempos = tempoSegments(track);
  const result = [];
  for (let segment = 0; segment < tempos.length && result.length < 2000; segment++) {
    const tempo = tempos[segment], next = tempos[segment + 1]?.start ?? Infinity;
    if (tempo.start > end) break;
    if (next <= start || next <= tempo.start) continue;
    const left = Math.max(start, tempo.start), right = Math.min(end, next);
    const step = tempo.step;
    const firstIndex = (left - tempo.start) / step, lastIndex = (right - tempo.start) / step;
    // A small relative tolerance prevents a decimal beat exactly at the range
    // edge being lost to floating-point rounding, including late in long tracks.
    const firstTolerance = Math.max(1e-9, Math.abs(firstIndex) * Number.EPSILON * 8);
    const lastTolerance = Math.max(1e-9, Math.abs(lastIndex) * Number.EPSILON * 8);
    const first = Math.max(0, Math.ceil(firstIndex - firstTolerance));
    const last = Math.floor(lastIndex + lastTolerance);
    if (!Number.isSafeInteger(first) || !Number.isSafeInteger(last)) continue;
    const {meter, phase} = tempo;
    for (let index = first; index <= last && result.length < 2000; index++) {
      const time = tempo.start + index * step;
      const tolerance = Math.max(1e-10, Math.abs(time) * Number.EPSILON * 8);
      // The next anchor owns a boundary beat, even if the two grids agree.
      if (time >= next - tolerance) break;
      if (time < left - tolerance || time > right + tolerance) continue;
      const major = (phase + index % meter) % meter === 0;
      const bar = tempo.bar + Math.floor((phase + index) / meter);
      result.push({time: clamp(time, left, right), major,
        ...(labels ? {bar, beat: (phase + index) % meter + 1, label: major ? String(bar) : ''} : {})});
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
    if (Number.isFinite(time) && time >= start && time <= end) result.push([time, !!beat?.major, String(beat?.label ?? '')]);
  }
  return result;
}

function paintAudio(context, columns, width, height, detailed, hasRange) {
  context.setTransform(1, 0, 0, 1, 0, 0);
  context.fillStyle = WAVEFORM_COLORS.background;
  context.fillRect(0, 0, width, height);
  context.fillStyle = WAVEFORM_COLORS.axis;
  context.fillRect(0, Math.floor(height / 2), width, 1);
  if (!hasRange) return;
  const center = height / 2, amplitude = height * .43;
  const drawLayer = (band, color) => {
    context.fillStyle = color;
    for (let x = 0; x < width; x++) {
      const upper = Math.min(columns.max[x], band ? band[x] : 1) * amplitude;
      const lower = Math.min(columns.min[x], band ? band[x] : 1) * amplitude;
      if (upper + lower > 0) context.fillRect(x, center - upper, 1, upper + lower);
    }
  };
  drawLayer(null, detailed ? WAVEFORM_COLORS.base : WAVEFORM_COLORS.mono);
  if (detailed) {
    drawLayer(columns.low, WAVEFORM_COLORS.low);
    drawLayer(columns.mid, WAVEFORM_COLORS.mid);
    drawLayer(columns.high, WAVEFORM_COLORS.high);
  }
}

function paintOverlays(context, {width, height, ratio, start, end, marks, grid, visibleLoop, overview}) {
  if (!(end > start)) return;
  const toX = time => (time - start) / (end - start) * width;
  // Grid stays above audio and moves at the exact time coordinate, independent
  // of the cached audio's at-most-one-device-pixel raster quantization.
  let lastMinor = -Infinity, lastLabelEnd = -Infinity;
  for (const [time, major, label] of grid) {
    const x = clamp(Math.round(toX(time)), 0, width - 1);
    if (!major && x - lastMinor < 7 * ratio) continue;
    lastMinor = x;
    context.fillStyle = major ? WAVEFORM_COLORS.beatMajor : WAVEFORM_COLORS.beatMinor;
    context.fillRect(x, 0, Math.min(major ? ratio : 1, width - x), height);
    if (!overview && major && label) {
      context.font = `${10 * ratio}px ui-monospace, monospace`;
      context.textBaseline = 'top';
      const text = label.slice(0, 12), padding = 3 * ratio;
      const textWidth = context.measureText(text).width;
      if (x >= lastLabelEnd + 12 * ratio && x + textWidth + padding < width) {
        context.fillStyle = WAVEFORM_COLORS.labelBackground;
        context.fillRect(x + ratio, 0, textWidth + padding * 2, 14 * ratio);
        context.fillStyle = WAVEFORM_COLORS.beatLabel;
        context.fillText(text, x + padding, 2 * ratio);
        lastLabelEnd = x + textWidth + padding * 2;
      }
    }
  }
  if (visibleLoop) {
    const left = toX(visibleLoop[0]), right = toX(visibleLoop[1]);
    context.fillStyle = WAVEFORM_COLORS.loopFill;
    context.fillRect(left, 0, right - left, height);
    context.fillStyle = WAVEFORM_COLORS.loop;
    context.fillRect(left, height - 2 * ratio, right - left, 2 * ratio);
  }
  for (const [time, label] of marks) {
    const x = clamp(Math.round(toX(time)), 0, width - 1);
    context.fillStyle = WAVEFORM_COLORS.marker;
    context.fillRect(x, 0, Math.max(1, ratio), height);
    if (!overview && label) {
      context.font = `${10 * ratio}px ui-monospace, monospace`;
      context.textBaseline = 'top';
      const text = label.slice(0, 32), padding = 3 * ratio;
      const textWidth = context.measureText(text).width;
      const labelX = clamp(x + padding, 0, Math.max(0, width - textWidth - padding));
      context.fillStyle = WAVEFORM_COLORS.labelBackground;
      context.fillRect(labelX, 0, Math.min(textWidth + padding, width - labelX), 14 * ratio);
      context.fillStyle = WAVEFORM_COLORS.labelText;
      context.fillText(text, labelX, 2 * ratio, Math.max(1, width - labelX));
    }
  }
}

/**
 * Draw a full or zoomed waveform. Returns false when hidden or unchanged.
 * markers: seconds or {time,label}; existing {start,name,num} marks also work.
 * beats: seconds or {time,major,label}; loop: {start,end}; position:null hides playhead.
 * overview omits labels. Frequency colors encode measured bands; red marks bars.
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
  const dataKey = [source.count, source.duration, source.min, source.max, source.low, source.mid, source.high, source.detailed, revision];
  const geometry = [width, start, end, ...dataKey];
  const marks = visibleMarkers(markers, start, end), grid = visibleBeats(beats, start, end);
  const visibleLoop = loop && Number.isFinite(loop.start) && Number.isFinite(loop.end) && loop.end > loop.start && loop.start < end && loop.end > start
    ? [Math.max(start, loop.start), Math.min(end, loop.end)] : null;
  const toX = time => (time - start) / (end - start) * width;
  const playhead = Number.isFinite(position) && position >= start && position <= end && end > start
    ? clamp(Math.round(toX(position)), 0, width - 1) : null;
  const staticSignature = [...geometry, height, ratio, !!overview, JSON.stringify(marks), JSON.stringify(grid), JSON.stringify(visibleLoop)];
  const signature = [...staticSignature, playhead];
  const previous = canvasCache.get(canvas);
  const resized = canvas.width !== width || canvas.height !== height;
  if (!resized && same(previous?.signature, signature)) return false;
  const context = canvas.getContext('2d');
  if (!context) return false;
  if (resized) { canvas.width = width; canvas.height = height; }
  context.setTransform(1, 0, 0, 1, 0, 0);
  const overlay = {width, height, ratio, start, end, marks, grid, visibleLoop, overview};
  let layer, columns;
  const copy = (raster, sourceX = 0, sourceWidth = width) => {
    // Equal-resolution nearest sampling keeps single-column transients at full
    // strength. Only the audio raster is quantized; scrub/grid timing is exact.
    context.imageSmoothingEnabled = false;
    context.drawImage(raster.canvas, sourceX, 0, sourceWidth, height, 0, 0, width, height);
  };
  if (typeof context.drawImage === 'function' && overview) {
    layer = rasterFor(canvas, width, height, previous?.raster);
    if (layer) {
      const reusable = !resized && layer === previous?.raster && same(previous.staticSignature, staticSignature);
      if (reusable) {
        // Restore only the previous playhead's antialiased pixel strip.
        if (previous.playhead !== null) {
          const x = Math.min(previous.playhead, width - Math.max(1, ratio));
          const left = Math.max(0, Math.floor(x) - 1), right = Math.min(width, Math.ceil(x + Math.max(1, ratio)) + 1);
          context.drawImage(layer.canvas, left, 0, right - left, height, left, 0, right - left, height);
        }
      } else {
        columns = same(previous?.geometry, geometry) && previous.columns ? previous.columns : columnsFor(source, width, start, end);
        paintAudio(layer.context, columns, width, height, source.detailed, end > start);
        paintOverlays(layer.context, overlay);
        layer.key = undefined; // A composite overview is not a reusable audio tile.
        copy(layer);
      }
    }
  } else if (typeof context.drawImage === 'function' && end > start) {
    // A two-window audio tile makes normal forward play and backspin cheap.
    // Rebuild only when seeking/zooming/data changes or crossing its edge.
    const step = (end - start) / width;
    const tileWidth = end - start >= duration ? width : Math.min(width * 2, Math.floor(MAX_LAYER_PIXELS / height));
    if (tileWidth >= width) layer = rasterFor(canvas, tileWidth, height, previous?.raster);
    if (layer) {
      const key = [width, height, ...dataKey];
      const tolerance = Math.max(1e-10, step * 1e-8);
      const reusable = same(layer.key, key) && Math.abs(layer.step - step) <= tolerance / width &&
        start >= layer.start - tolerance && end <= layer.end + tolerance;
      if (!reusable) {
        const padding = Math.floor((tileWidth - width) / 2);
        layer.step = step;
        layer.start = Math.max(0, Math.floor(start / step) - padding) * step;
        layer.end = layer.start + tileWidth * step;
        layer.key = key;
        columns = columnsFor(source, tileWidth, layer.start, layer.end);
        paintAudio(layer.context, columns, tileWidth, height, source.detailed, true);
      }
      copy(layer, clamp((start - layer.start) / layer.step, 0, tileWidth - width), width);
      paintOverlays(context, overlay);
    }
  }
  if (!layer) {
    releaseRaster(previous?.raster);
    columns = same(previous?.geometry, geometry) && previous.columns ? previous.columns : columnsFor(source, width, start, end);
    context.clearRect(0, 0, width, height);
    paintAudio(context, columns, width, height, source.detailed, end > start);
    paintOverlays(context, overlay);
  }
  if (playhead !== null) {
    context.fillStyle = WAVEFORM_COLORS.playhead;
    const line = Math.max(1, ratio);
    context.fillRect(Math.min(playhead, width - line), 0, line, height);
  }
  canvasCache.set(canvas, {signature, staticSignature, geometry, columns: layer ? undefined : columns, raster: layer, playhead});
  return true;
}
