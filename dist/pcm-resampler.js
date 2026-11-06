/** Fixed-work Blackman-windowed sinc interpolation with anti-alias filtering.
 * Coefficients are generated on the main thread and sent as a kernel.
 * readFrame owns file/loop edge handling and returns null for missing pages.
 */
const MIN_RADIUS = 32;
const MAX_RADIUS = 128;
const DOWNSAMPLE_RADIUS = 16;
const PHASES = 256;
const MAX_TABLES = 4;
let tables = [];

function coefficients(cutoff, radius) {
  const taps = radius * 2;
  const found = tables.find(entry => entry.cutoff === cutoff && entry.radius === radius);
  if (found) return found.values;
  const values = new Float32Array((PHASES + 1) * taps);
  for (let phase = 0; phase <= PHASES; phase++) {
    const fraction = phase / PHASES;
    const weights = Array.from({length:taps}, (_, tap) => {
      const distance = tap - radius + 1 - fraction;
      if (Math.abs(distance) >= radius) return 0;
      const window = .42 + .5 * Math.cos(Math.PI * distance / radius) +
        .08 * Math.cos(2 * Math.PI * distance / radius);
      return window * (distance === 0 ? cutoff : Math.sin(Math.PI * cutoff * distance) / (Math.PI * distance));
    });
    const total = weights.reduce((sum, value) => sum + value, 0);
    values.set(weights.map(value => Math.abs(value) < 1e-12 ? 0 : value / total), phase * taps);
  }
  tables = [...tables.slice(-(MAX_TABLES - 1)), {cutoff,radius,values}];
  return values;
}

export function createPcmResampler(step) {
  if (!Number.isFinite(step) || step <= 0) throw new RangeError('Invalid PCM sample step.');
  // Leave a narrow transition band below the destination Nyquist frequency
  // when downsampling. At unity, the integer phase is an exact identity.
  const cutoff = step > 1 ? .96 / step : 1;
  const radius = Math.min(MAX_RADIUS, Math.max(MIN_RADIUS, Math.ceil(DOWNSAMPLE_RADIUS * step)));
  const taps = radius * 2;
  const kernel = {radius,taps,phases:PHASES,identity:step <= 1,values:coefficients(cutoff, radius).slice()};
  return samplerFromKernel(kernel);
}

/** Audio-thread entry point: validate a cloned message, with no coefficient work. */
export function createPcmResamplerFromKernel(kernel) {
  if (!kernel || !Number.isInteger(kernel.radius) || kernel.radius < MIN_RADIUS || kernel.radius > MAX_RADIUS ||
      kernel.taps !== kernel.radius * 2 || kernel.phases !== PHASES || typeof kernel.identity !== 'boolean' ||
      !(kernel.values instanceof Float32Array) || kernel.values.length !== (PHASES + 1) * kernel.taps) {
    throw new TypeError('Invalid PCM resampler kernel.');
  }
  for (let index = 0; index < kernel.values.length; index++) {
    const value = kernel.values[index];
    if (!Number.isFinite(value) || Math.abs(value) > 2) throw new TypeError('Invalid PCM resampler kernel coefficient.');
  }
  return samplerFromKernel(kernel);
}

function samplerFromKernel(kernel) {
  const {radius,taps,phases,identity,values:table} = kernel;
  return {radius,kernel, sample(position, readFrame) {
    if (!Number.isFinite(position)) return null;
    const first = Math.floor(position);
    if (identity && first === position) {
      const value = readFrame(first);
      return Number.isFinite(value) ? value : null;
    }
    const phase = (position - first) * phases;
    const row = Math.floor(phase), blend = phase - row;
    const lower = row * taps, upper = (row + 1) * taps;
    let result = 0;
    for (let tap = 0; tap < taps; tap++) {
      const weight = table[lower + tap] + (table[upper + tap] - table[lower + tap]) * blend;
      if (Math.abs(weight) < 1e-12) continue;
      const value = readFrame(first - radius + 1 + tap);
      if (value == null || !Number.isFinite(value)) return null;
      result += value * weight;
    }
    return result;
  }};
}
