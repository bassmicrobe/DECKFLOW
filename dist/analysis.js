// Small, local-only tempo estimate for set preparation. This is not a substitute
// for rekordbox's analysis: changing tempo, swing and half/double tempo readings
// need listening and manual correction. No audio is sent to a server.
const TAU = Math.PI * 2;
const clamp = (value, low, high) => Math.max(low, Math.min(high, value));

function waveform(samples, count = 720) {
  const peaks = new Array(Math.min(count, Math.max(1, samples.length))).fill(0);
  // Bound waveform work even for a large decoded file. Each bin still gets
  // samples throughout its own range, rather than only from the song's intro.
  const stride = Math.max(1, Math.ceil(samples.length / 5_000_000));
  let largest = 0;
  for (let index = 0; index < peaks.length; index += 1) {
    const begin = Math.floor(index * samples.length / peaks.length);
    const end = Math.floor((index + 1) * samples.length / peaks.length);
    let peak = 0;
    for (let pos = begin; pos < end; pos += stride) {
      const value = samples[pos];
      if (Number.isFinite(value)) peak = Math.max(peak, Math.abs(value));
    }
    peaks[index] = peak;
    largest = Math.max(largest, peak);
  }
  if (largest > 0) {
    for (let index = 0; index < peaks.length; index += 1) {
      peaks[index] = clamp(peaks[index] / largest, 0, 1);
    }
  }
  return peaks;
}

function onsetEvents(samples, sampleRate, startSeconds, lengthSeconds) {
  // About 6 kHz and 100 envelope frames/s keep this well below the cost of a
  // full-track FFT. Bass and broadband attacks both contribute to the envelope.
  const stride = Math.max(1, Math.floor(sampleRate / 6000));
  const downRate = sampleRate / stride;
  const hop = Math.max(1, Math.round(downRate / 100));
  const frameSeconds = hop / downRate;
  const begin = Math.floor(startSeconds * sampleRate);
  const end = Math.min(samples.length, Math.floor((startSeconds + lengthSeconds) * sampleRate));
  const alpha = 1 - Math.exp(-TAU * 180 / downRate);
  const envelope = [];
  let bass = 0;
  let energy = 0;
  let bassEnergy = 0;
  let inFrame = 0;
  for (let pos = begin; pos < end; pos += stride) {
    const value = Number.isFinite(samples[pos]) ? samples[pos] : 0;
    bass += alpha * (value - bass);
    energy += value * value;
    bassEnergy += bass * bass;
    inFrame += 1;
    if (inFrame === hop) {
      envelope.push(Math.sqrt(energy / hop) + 1.7 * Math.sqrt(bassEnergy / hop));
      energy = 0;
      bassEnergy = 0;
      inFrame = 0;
    }
  }
  if (envelope.length < 20) return [];
  const novelty = new Float32Array(envelope.length);
  let smooth = envelope[0];
  let sum = 0;
  let squared = 0;
  let max = 0;
  for (let index = 1; index < envelope.length; index += 1) {
    const level = envelope[index];
    const attack = Math.max(0, level - smooth * 1.18) / (0.02 + smooth);
    const value = Math.min(attack, 12);
    novelty[index] = value;
    sum += value;
    squared += value * value;
    max = Math.max(max, value);
    smooth += (level - smooth) * 0.08;
  }
  if (max < 0.025) return [];
  const mean = sum / novelty.length;
  const deviation = Math.sqrt(Math.max(0, squared / novelty.length - mean * mean));
  const threshold = Math.max(mean + deviation * 0.5, max * 0.08, 0.025);
  const events = [];
  const gap = Math.max(1, Math.round(0.12 / frameSeconds));
  for (let index = 1; index < novelty.length - 1; index += 1) {
    const weight = novelty[index];
    if (weight < threshold || weight < novelty[index - 1] || weight < novelty[index + 1]) continue;
    const previous = events.at(-1);
    if (previous && index - previous.frame < gap) {
      if (weight > previous.weight) events[events.length - 1] = {
        frame: index, time: startSeconds + (index + 0.5) * frameSeconds, weight,
      };
    } else {
      events.push({frame: index, time: startSeconds + (index + 0.5) * frameSeconds, weight});
    }
  }
  return events;
}

function phaseAt(events, bpm) {
  let cosine = 0;
  let sine = 0;
  let total = 0;
  for (const event of events) {
    const weight = Math.sqrt(event.weight);
    const phase = TAU * event.time * bpm / 60;
    cosine += Math.cos(phase) * weight;
    sine += Math.sin(phase) * weight;
    total += weight;
  }
  return {
    coherence: total > 0 ? Math.hypot(cosine, sine) / total : 0,
    offset: ((Math.atan2(sine, cosine) / TAU + 1) % 1) * 60 / bpm,
  };
}

/**
 * Estimate a constant tempo and build 0..1 waveform peaks from mono PCM.
 * Analysis uses at most three 40-second sections; silence/insufficient rhythmic
 * evidence returns bpm:null rather than an invented default.
 */
export function analyzeSamples(samples, sampleRate, {minBpm = 70, maxBpm = 180} = {}) {
  if (!(samples instanceof Float32Array) || samples.length === 0) {
    throw new TypeError('解析する音声データがありません。');
  }
  if (!Number.isFinite(sampleRate) || sampleRate < 1000 || sampleRate > 384000) {
    throw new RangeError('音声のサンプルレートを確認してください。');
  }
  if (!Number.isFinite(minBpm) || !Number.isFinite(maxBpm) || minBpm < 30 || maxBpm > 300 || maxBpm <= minBpm) {
    throw new RangeError('BPMの解析範囲を確認してください。');
  }
  const duration = samples.length / sampleRate;
  const peaks = waveform(samples);
  const empty = {bpm: null, confidence: 0, peaks, duration, beatOffset: 0};
  if (duration < 4) return empty;
  const sectionLength = Math.min(duration, 40);
  const starts = duration <= 40 ? [0] : duration <= 80 ? [0, duration - 40] : [
    Math.min(duration - 40, duration * 0.12),
    Math.min(duration - 40, duration * 0.46),
    Math.min(duration - 40, duration * 0.78),
  ];
  // Pair intervals only inside a section; gaps between sampled sections should
  // not themselves appear to be beat intervals.
  const sections = [...new Set(starts)].map(start => onsetEvents(samples, sampleRate, start, sectionLength));
  const events = sections.flat();
  if (events.length < 6) return empty;
  const binsPerBpm = 4;
  const histogram = new Float64Array(Math.ceil((maxBpm - minBpm) * binsPerBpm) + 1);
  const votes = [];
  for (const section of sections) {
    for (let index = 0; index < section.length; index += 1) {
      for (let distance = 1; distance <= 10 && index + distance < section.length; distance += 1) {
        const left = section[index];
        const right = section[index + distance];
        const interval = right.time - left.time;
        if (interval < 0.25 || interval > 8) continue;
        let bpm = 60 / interval;
        let folds = 0;
        while (bpm < minBpm) { bpm *= 2; folds += 1; }
        while (bpm > maxBpm) { bpm /= 2; folds += 1; }
        if (bpm < minBpm || bpm > maxBpm) continue;
        const weight = Math.sqrt(left.weight * right.weight) / distance * Math.pow(0.7, folds);
        votes.push({bpm, weight});
        const bin = Math.round((bpm - minBpm) * binsPerBpm);
        histogram[bin] += weight;
      }
    }
  }
  if (!votes.length) return empty;
  const smoothHistogram = Float64Array.from(histogram, (_, index) => {
    let value = 0;
    for (let offset = -16; offset <= 16; offset += 1) {
      const bin = index + offset;
      if (bin >= 0 && bin < histogram.length) value += histogram[bin] * Math.exp(-offset * offset / 72);
    }
    return value;
  });
  const candidates = [];
  const ordered = Array.from(smoothHistogram, (value, index) => ({value, bpm: minBpm + index / binsPerBpm}))
    .sort((left, right) => right.value - left.value);
  for (const candidate of ordered) {
    if (!candidates.some(other => Math.abs(other.bpm - candidate.bpm) < 3)) candidates.push(candidate);
    if (candidates.length === 6) break;
  }
  const histogramAt = bpm => {
    const index = clamp(Math.round((bpm - minBpm) * binsPerBpm), 0, smoothHistogram.length - 1);
    return smoothHistogram[index];
  };
  let best = null;
  for (const candidate of candidates) {
    // At fast tempos a 10 ms onset envelope splits the adjacent-interval vote
    // into two peaks several BPM apart. Search across that quantisation gap.
    const low = Math.max(minBpm, candidate.bpm - 3.5);
    const high = Math.min(maxBpm, candidate.bpm + 3.5);
    for (let bpm = low; bpm <= high + 0.001; bpm += 0.05) {
      const phase = phaseAt(events, bpm);
      const score = histogramAt(bpm) * phase.coherence * phase.coherence;
      if (!best || score > best.score) best = {bpm, score, ...phase};
    }
  }
  if (!best || best.coherence < 0.4) return empty;
  const alternate = candidates.filter(item => Math.abs(item.bpm - best.bpm) > 3)
    .reduce((max, item) => Math.max(max, item.value), 0);
  const prominence = histogramAt(best.bpm) / Math.max(0.001, histogramAt(best.bpm) + alternate);
  const reliability = Math.min(1, (events.length - 3) / 17);
  const confidence = clamp((best.coherence * 0.75 + prominence * 0.25) * reliability, 0, 1);
  if (confidence < 0.3) return empty;
  return {
    bpm: Math.round(best.bpm * 10) / 10,
    confidence: Math.round(confidence * 100) / 100,
    peaks,
    duration,
    beatOffset: Math.round(best.offset * 1000) / 1000,
  };
}
