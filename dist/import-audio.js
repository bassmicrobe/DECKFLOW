/** Relink explicitly selected audio without replacing rekordbox preparation. */
export function findImportedAudio(tracks, file, duration, selectedId = null) {
  const missing = tracks.filter(track => track.audioMissing && track.rekordbox);
  const named = selectedId ? missing.filter(track => track.id === selectedId)
    : missing.filter(track => track.filename.normalize('NFC') === file.name.normalize('NFC'));
  if (selectedId && !named.length) throw new Error('関連付ける曲が見つかりません。画面を更新してください。');
  if (!named.length) return null;
  const matches = named.filter(track => Math.abs(track.duration - duration) <= 1.1 &&
    (track.rekordbox.size == null || track.rekordbox.size === file.size));
  if (matches.length !== 1) throw new Error(matches.length > 1
    ? '同名・同じ長さの曲が複数あります。曲ごとの「音源を選択」から関連付けてください。'
    : 'XMLの曲と音源の長さ、またはファイルサイズが一致しません。書き出し時の元音源を選んでください。');
  return matches[0];
}

/** Display-only peaks; never estimates BPM, beat positions, or cue points. */
export function audioPeaks(buffer, count = 900) {
  const result = new Array(Math.min(count, buffer.length)).fill(0);
  const channels = Array.from({length:buffer.numberOfChannels}, (_, i) => buffer.getChannelData(i));
  for (let i = 0; i < result.length; i++) {
    const start = Math.floor(i * buffer.length / result.length);
    const end = Math.floor((i + 1) * buffer.length / result.length);
    let peak = 0;
    for (let j = start; j < end; j++) for (const channel of channels) peak = Math.max(peak, Math.abs(channel[j]));
    result[i] = Math.min(1, peak);
  }
  return result;
}

export function relinkMetadata(track, file, duration, peaks) {
  const positions = [track.cue,track.beatOffset,...track.hotcues,
    ...(track.tempos || []).map(tempo=>tempo.start),
    ...(track.positionMarks || []).flatMap(mark=>[mark.start,mark.end])].filter(value=>value != null);
  if (positions.some(value=>value > duration)) throw new Error('XMLのCUE・ループ・拍位置が音源の終端を超えています。元の音源を確認してください。');
  return {...track,duration,peaks,fingerprint:`${file.name}|${file.size}|${file.lastModified||0}`,audioMissing:false};
}

export function tempoAt(track, seconds) {
  let tempo = {start:track.beatOffset || 0, bpm:track.bpm, meter:'4/4', beat:1};
  for (const entry of track.tempos || []) { if (entry.start > seconds) break; tempo = entry; }
  return tempo;
}

export function advanceBeats(track, start, beats) {
  let position = start, remaining = beats;
  for (const next of (track.tempos || []).filter(tempo => tempo.start > start)) {
    const bpm = tempoAt(track, position).bpm;
    const available = (next.start - position) * bpm / 60;
    if (remaining <= available) return position + remaining * 60 / bpm;
    remaining -= available;
    position = next.start;
  }
  return position + remaining * 60 / tempoAt(track, position).bpm;
}

export function barPositions(track, duration, limit = 6000) {
  const tempos = track.tempos?.length ? track.tempos : [tempoAt(track, 0)];
  const positions = [];
  let visited = 0;
  for (let i = 0; i < tempos.length; i++) {
    const tempo = tempos[i];
    if (!tempo.bpm) continue;
    const end = Math.min(duration, tempos[i + 1]?.start ?? duration);
    const beatsPerBar = Number(tempo.meter.split('/')[0]) || 4;
    for (let beat = 0, t = tempo.start; t < end && visited < limit; beat++, t = tempo.start + beat * 60 / tempo.bpm) {
      visited++;
      if ((tempo.beat - 1 + beat) % beatsPerBar === 0) positions.push(t);
    }
  }
  return positions;
}
