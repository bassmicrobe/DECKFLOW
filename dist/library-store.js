import {normalizeRekordboxMetadata, normalizeFolderPath, parseRekordboxLocation} from './rekordbox-model.js?v=e321e49da3ca54c5';
import {withOwnedAudio, readStoredAudio, deleteAudioChunks} from './audio-chunk-store.js?v=e321e49da3ca54c5';
/**
 * DECKFLOW local library. Metadata and encoded audio live in separate stores,
 * so listing a large library does not read every audio Blob into memory.
 * No upload or external service is involved.
 */
const DATABASE_NAME = 'deckflow-library';
const DATABASE_VERSION = 1;
const MAX_TRACKS = 10_000;
const MAX_PLAYLISTS = 1_000;
const MAX_SOURCES = 20;
const MAX_PEAKS = 2_000;
const ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const CONTROL = /[\u0000-\u001f\u007f]/;

const clone = value => globalThis.structuredClone
  ? globalThis.structuredClone(value)
  : JSON.parse(JSON.stringify(value));

function invalid(message) { throw new Error(message); }

function object(value, description) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) invalid(`${description}の形式が正しくありません。`);
  return value;
}

function identifier(value, description) {
  if (typeof value !== 'string' || !ID.test(value)) invalid(`${description}が正しくありません。`);
  return value;
}

function text(value, description, max, empty = false) {
  if (typeof value !== 'string' || value.length > max || CONTROL.test(value) || (!empty && !value.trim())) {
    invalid(`${description}は${empty ? '空欄または' : ''}${max}文字以内のテキストにしてください。`);
  }
  return value;
}

function finite(value, description, min, max) {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < min || value > max) {
    invalid(`${description}の値が範囲外です。`);
  }
  return value;
}

function filename(value) {
  text(value, '音源ファイル名', 255);
  // A library snapshot is also consumed by the desktop export helper. Keep
  // only a portable basename, never an absolute/relative filesystem path.
  if (value === '.' || value === '..' || /[/\\:<>"|?*]/.test(value) || /[. ]$/.test(value)) {
    invalid('音源ファイル名にはパスや特殊な区切り文字を指定できません。');
  }
  return value;
}

function normalizeTrack(input) {
  const track = object(input, '曲情報');
  const duration = finite(track.duration, '曲の長さ', Number.MIN_VALUE, 86_400);
  const bpm = track.bpm == null ? null : finite(track.bpm, 'BPM', 30, 300);
  const hotcues = track.hotcues ?? Array(8).fill(null);
  if (!Array.isArray(hotcues) || ![4, 8].includes(hotcues.length)) invalid('HOT CUEは8個（旧形式は4個）の位置またはnullで指定してください。');
  if (track.audioMissing !== undefined && typeof track.audioMissing !== 'boolean') invalid('音源の接続状態が正しくありません。');
  const peaks = track.peaks ?? [];
  if ((!Array.isArray(peaks) && !(peaks instanceof Float32Array)) || peaks.length > MAX_PEAKS) {
    invalid(`波形データは${MAX_PEAKS}個以内で指定してください。`);
  }
  let addedAt = track.addedAt ?? 0;
  if (typeof addedAt === 'string') addedAt = Date.parse(addedAt);
  return {
    id: identifier(track.id, '曲ID'),
    title: text(track.title, '曲名', 180),
    artist: text(track.artist ?? '', 'アーティスト名', 180, true),
    bpm,
    duration,
    beatOffset: finite(track.beatOffset ?? 0, '拍の開始位置', 0, duration),
    cue: finite(track.cue ?? 0, 'CUEの位置', 0, duration),
    hotcues: Array.from({length: 8}, (_, index) => hotcues[index] == null ? null : finite(hotcues[index], 'HOT CUEの位置', 0, duration)),
    filename: filename(track.filename),
    fingerprint: text(track.fingerprint ?? '', '音源の識別情報', 1_024, true),
    addedAt: finite(addedAt, '追加日時', 0, 8_640_000_000_000_000),
    peaks: Array.from(peaks, value => finite(value, '波形データ', 0, 1)),
    confidence: finite(track.confidence ?? 0, '解析の信頼度', 0, 1),
    audioMissing: track.audioMissing ?? false,
    ...normalizeRekordboxMetadata(track, duration),
  };
}

function normalizePlaylists(input, trackIds = null) {
  if (!Array.isArray(input) || input.length > MAX_PLAYLISTS) invalid(`プレイリストは${MAX_PLAYLISTS}件以内で指定してください。`);
  const ids = new Set();
  return input.map(value => {
    const playlist = object(value, 'プレイリスト');
    const id = identifier(playlist.id, 'プレイリストID');
    if (ids.has(id)) invalid('プレイリストIDが重複しています。');
    ids.add(id);
    if (!Array.isArray(playlist.trackIds) || playlist.trackIds.length > MAX_TRACKS) {
      invalid(`プレイリストの曲は${MAX_TRACKS}件以内で指定してください。`);
    }
    const contained = new Set();
    const references = playlist.trackIds.map(trackId => {
      identifier(trackId, 'プレイリストの曲ID');
      if (contained.has(trackId)) invalid('プレイリスト内の曲IDが重複しています。');
      if (trackIds && !trackIds.has(trackId)) invalid('プレイリストに存在しない曲が含まれています。');
      contained.add(trackId);
      return trackId;
    });
    return {id, name: text(playlist.name, 'プレイリスト名', 80), trackIds: references, folderPath: normalizeFolderPath(playlist.folderPath)};
  });
}

/** Validate metadata-only JSON before using it as a backup/export manifest. */
export function validateLibrarySnapshot(input) {
  let value = input;
  if (typeof value === 'string') {
    if (value.length > 32 * 1024 * 1024) invalid('ライブラリファイルが大きすぎます。');
    try { value = JSON.parse(value); }
    catch { invalid('ライブラリファイルをJSONとして読み取れません。'); }
  }
  const snapshot = object(value, 'ライブラリ');
  if (snapshot.format !== 'deckflow.library' || snapshot.version !== 1) {
    invalid('対応するDECKFLOWライブラリ（version 1）を選んでください。');
  }
  if (!Array.isArray(snapshot.tracks) || snapshot.tracks.length > MAX_TRACKS) invalid(`曲は${MAX_TRACKS}件以内で指定してください。`);
  const tracks = snapshot.tracks.map(normalizeTrack);
  const ids = new Set();
  for (const track of tracks) {
    if (ids.has(track.id)) invalid('曲IDが重複しています。');
    ids.add(track.id);
  }
  const result = {
    format: 'deckflow.library', version: 1, tracks,
    playlists: normalizePlaylists(snapshot.playlists ?? [], ids),
  };
  if (snapshot.exportedAt != null) {
    if (typeof snapshot.exportedAt !== 'string' || !Number.isFinite(Date.parse(snapshot.exportedAt))) invalid('書き出し日時が正しくありません。');
    result.exportedAt = new Date(snapshot.exportedAt).toISOString();
  }
  return result;
}

/** An XML import adds new IDs only; existing edits and encoded audio stay intact. */
function mergeImport(existingTracks, existingPlaylists, incomingTracks, incomingPlaylists) {
  const previous = new Map(existingTracks.map(track => [track.id, track]));
  const next = new Map(previous);
  for (const track of incomingTracks) {
    const existing = previous.get(track.id);
    if (existing) {
      if (!existing.rekordbox || !track.rekordbox || existing.rekordbox.trackId !== track.rekordbox.trackId || parseRekordboxLocation(existing.rekordbox.location).identity !== parseRekordboxLocation(track.rekordbox.location).identity) {
        invalid('曲IDが既存の別の曲と衝突しています。取り込みは保存していません。');
      }
    } else next.set(track.id, track);
  }
  const playlistMap = new Map(existingPlaylists.map(playlist => [playlist.id, playlist]));
  const addedPlaylists = incomingPlaylists.filter(playlist => !playlistMap.has(playlist.id));
  for (const playlist of addedPlaylists) playlistMap.set(playlist.id, playlist);
  if (next.size > MAX_TRACKS) invalid(`曲は${MAX_TRACKS}件以内で指定してください。`);
  const playlists = normalizePlaylists([...playlistMap.values()], new Set(next.keys()));
  return {tracks: [...next.values()], playlists, result: {
    addedTracks: next.size - previous.size, addedPlaylists: addedPlaylists.length,
    skippedTracks: incomingTracks.length - (next.size - previous.size), skippedPlaylists: incomingPlaylists.length - addedPlaylists.length,
  }};
}

function validateImport(tracks, playlists) {
  const candidate = validateLibrarySnapshot({format: 'deckflow.library', version: 1, tracks, playlists: []});
  candidate.playlists = normalizePlaylists(playlists);
  return candidate;
}

function checkBlob(blob) {
  if (blob !== undefined && !(blob instanceof Blob)) invalid('保存する音源はBlobまたはFileで指定してください。');
}

function mergeSources(existing, source) {
  identifier(source.id, 'ライブラリの参照ID');
  const exists = existing.some(item => item.id === source.id);
  if (!exists && existing.length >= MAX_SOURCES) {
    invalid(`保存できるライブラリの参照は${MAX_SOURCES}件までです。不要な参照を一覧から外してください。変更は保存していません。`);
  }
  return exists ? existing.map(item => item.id === source.id ? source : item) : [...existing, source];
}

function trackLimitError() {
  return new Error(`保存できる曲は${MAX_TRACKS.toLocaleString('en-US')}件までです。不要な曲を削除してから追加してください。変更は保存していません。`);
}

function editFields(input) {
  const fields = object(input, '曲の編集内容');
  return {title: fields.title, artist: fields.artist, bpm: fields.bpm};
}

function editedTrackDetails(current, fields, playlistId, existingPlaylists) {
  if (!current) invalid('この曲は削除されています。画面を更新してください。');
  const track = normalizeTrack({...current, ...fields});
  const playlists = normalizePlaylists(existingPlaylists);
  if (playlistId == null || playlistId === '') return {track, playlists};
  identifier(playlistId, 'プレイリストID');
  if (!playlists.some(playlist => playlist.id === playlistId)) invalid('追加先のプレイリストが見つかりません。画面を更新してください。変更は保存していません。');
  return {track, playlists: playlists.map(playlist => playlist.id === playlistId
    ? {...playlist, trackIds: [...new Set([...playlist.trackIds, track.id])]}
    : playlist)};
}

function storageError(error) {
  const quota = error?.name === 'QuotaExceededError';
  return new Error(quota
    ? '端末の保存容量が足りません。不要な曲を削除するか、ブラウザの空き容量を確認してください。変更は保存していません。'
    : '端末のライブラリを読み書きできませんでした。ページを再読み込みして、保存領域の設定を確認してください。', {cause: error});
}

function readTrackWithAudio(transaction, id, done) {
  const track = transaction.objectStore('tracks').get(id), audio = transaction.objectStore('audio').get(id);
  let trackReady = false, audioReady = false;
  const finish = () => { if (trackReady && audioReady) done({track: track.result, audio: audio.result}); };
  track.onsuccess = () => { trackReady = true; finish(); };
  audio.onsuccess = () => { audioReady = true; finish(); };
}

function audioTrackIdentity({track, audio}) {
  // Every newly owned audio copy has a distinct descriptor prefix, including
  // replacements whose filename, size and track metadata happen to be equal.
  return JSON.stringify({track, audio: audio instanceof Blob ? {legacy: true, size: audio.size, type: audio.type} : audio});
}

class MemoryLibrary {
  constructor() {
    this.persistent = false;
    this.warning = '端末の保存領域を開けないため、この画面を開いている間だけ曲を保持します。ページを閉じると曲とプレイリストは失われます。';
    this.tracks = new Map();
    this.audio = new Map();
    this.playlists = [];
    this.sources = new Map();
  }
  async getTracks() { return [...this.tracks.values()].map(clone); }
  async getSources() { return [...this.sources.values()].map(clone); }
  async putSource(source) { this.sources = new Map(mergeSources([...this.sources.values()], clone(source)).map(item => [item.id, item])); }
  async removeSource(id) { this.sources.delete(id); }
  async putTrack(metadata, blob) {
    const track = normalizeTrack(metadata);
    checkBlob(blob);
    if (!this.tracks.has(track.id) && this.tracks.size >= MAX_TRACKS) throw trackLimitError();
    this.tracks.set(track.id, track);
    if (blob !== undefined) this.audio.set(track.id, blob);
  }
  async updateTrackDetails(id, fields, playlistId = null) {
    identifier(id, '曲ID');
    const result = editedTrackDetails(this.tracks.get(id), editFields(fields), playlistId, this.playlists);
    this.tracks = new Map([...this.tracks, [id, result.track]]);
    this.playlists = result.playlists;
    return clone(result);
  }
  async createPlaylist(playlist) {
    const candidate = normalizePlaylists([playlist])[0];
    const playlists = normalizePlaylists([...this.playlists, candidate], new Set(this.tracks.keys()));
    this.playlists = playlists;
    return clone(playlists);
  }
  async importTracks(tracks, playlists, source = null) {
    const candidate = validateImport(tracks, playlists);
    const merged = mergeImport([...this.tracks.values()], this.playlists, candidate.tracks, candidate.playlists);
    const sources = source == null ? this.sources : new Map(mergeSources([...this.sources.values()], clone(source)).map(item => [item.id, item]));
    this.tracks = new Map(merged.tracks.map(track => [track.id, track]));
    this.playlists = merged.playlists;
    this.sources = sources;
    return merged.result;
  }
  async getAudio(id) { identifier(id, '曲ID'); return this.audio.get(id) ?? null; }
  async removeTrack(id) {
    identifier(id, '曲ID');
    this.tracks.delete(id);
    this.audio.delete(id);
    this.playlists = this.playlists.map(playlist => ({...playlist, trackIds: playlist.trackIds.filter(value => value !== id)}));
  }
  async getPlaylists() { return clone(this.playlists); }
  async putPlaylists(playlists) { this.playlists = normalizePlaylists(playlists, new Set(this.tracks.keys())); }
}

class IndexedLibrary {
  constructor(database) {
    this.database = database;
    this.persistent = true;
    this.warning = null;
    this.closed = false;
    database.onversionchange = () => {
      this.closed = true;
      this.persistent = false;
      this.warning = '別の画面で保存領域が更新されました。このページを再読み込みしてください。';
      database.close();
    };
    database.onclose = () => {
      this.closed = true;
      this.persistent = false;
      this.warning ??= '端末の保存領域が閉じられました。このページを再読み込みしてください。';
    };
  }

  _transaction(names, mode, operation) {
    if (this.closed) return Promise.reject(new Error(this.warning));
    return new Promise((resolve, reject) => {
      let transaction;
      let result;
      let explicitError;
      const setResult = value => { result = value; };
      const fail = error => {
        explicitError = typeof DOMException === 'function' && error instanceof DOMException ? storageError(error) : error;
        try { transaction.abort(); }
        catch { reject(explicitError); }
      };
      try { transaction = this.database.transaction(names, mode); }
      catch (error) { reject(storageError(error)); return; }
      transaction.oncomplete = () => resolve(result);
      transaction.onabort = () => reject(explicitError || storageError(transaction.error));
      transaction.onerror = () => { /* The abort event is the transaction's final result. */ };
      try { operation(transaction, setResult, fail); }
      catch (error) { fail(error); }
    });
  }

  async getSources() {
    return this._transaction(['config'], 'readonly', (transaction, done) => {
      const request = transaction.objectStore('config').get('sources');
      request.onsuccess = () => done(request.result ?? []);
    });
  }
  async putSource(source) {
    const candidate = clone(source);
    identifier(candidate.id, 'ライブラリの参照ID');
    return this._transaction(['config'], 'readwrite', (transaction, done, fail) => {
      const config = transaction.objectStore('config'), request = config.get('sources');
      request.onsuccess = () => {
        try {
          config.put(mergeSources(request.result ?? [], candidate), 'sources');
        } catch (error) { fail(error); }
      };
    });
  }
  async removeSource(id) {
    identifier(id, 'ライブラリの参照ID');
    return this._transaction(['config'], 'readwrite', transaction => {
      const config = transaction.objectStore('config'), request = config.get('sources');
      request.onsuccess = () => config.put((request.result ?? []).filter(source => source.id !== id), 'sources');
    });
  }

  async getTracks() {
    return this._transaction(['tracks'], 'readonly', (transaction, done, fail) => {
      const request = transaction.objectStore('tracks').getAll();
      request.onsuccess = () => {
        try { done(request.result.map(normalizeTrack)); }
        catch (error) { fail(error); }
      };
    });
  }

  async putTrack(metadata, blob, options = {}) {
    const track = normalizeTrack(metadata);
    checkBlob(blob);
    const expected = blob === undefined ? null : await this._transaction(['tracks', 'audio'], 'readonly', (transaction, done) => {
      readTrackWithAudio(transaction, track.id, value => done(audioTrackIdentity(value)));
    });
    const commit = (audio, stageKey) => this._transaction(audio === undefined ? ['tracks'] : ['tracks', 'audio'], 'readwrite', (transaction, _, fail) => {
      const tracks = transaction.objectStore('tracks');
      const write = () => {
        try {
          if (audio === undefined) { tracks.put(track); return; }
          readTrackWithAudio(transaction, track.id, previous => {
            try {
              if (options.signal?.aborted) throw new Error('音源の保存を中止しました。変更は保存していません。');
              if (audioTrackIdentity(previous) !== expected) {
                throw new Error('保存中に別の画面でこの曲が変更または削除されました。画面を更新して再試行してください。変更は保存していません。');
              }
              const store = transaction.objectStore('audio');
              deleteAudioChunks(store, previous.audio);
              tracks.put(track);
              store.put(audio, track.id);
              store.delete(stageKey);
            } catch (error) { fail(error); }
          });
        } catch (error) { fail(error); }
      };
      // The count and insert share one write transaction, including across tabs.
      const count = tracks.count();
      count.onsuccess = () => {
        if (count.result < MAX_TRACKS) { write(); return; }
        const existing = tracks.getKey(track.id);
        existing.onsuccess = () => existing.result === undefined ? fail(trackLimitError()) : write();
      };
    });
    return blob === undefined ? commit() : withOwnedAudio(blob, this._transaction.bind(this), commit,
      {signal: options.signal, databaseName: this.database.name});
  }

  async updateTrackDetails(id, fields, playlistId = null) {
    identifier(id, '曲ID');
    const candidate = editFields(fields);
    return this._transaction(['tracks', 'config'], 'readwrite', (transaction, done, fail) => {
      const tracks = transaction.objectStore('tracks'), config = transaction.objectStore('config');
      const current = tracks.get(id), lists = config.get('playlists');
      let trackReady = false, listsReady = false;
      const commit = () => {
        if (!trackReady || !listsReady) return;
        try {
          const result = editedTrackDetails(current.result, candidate, playlistId, lists.result ?? []);
          tracks.put(result.track);
          if (playlistId != null && playlistId !== '') config.put(result.playlists, 'playlists');
          done(result);
        } catch (error) { fail(error); }
      };
      current.onsuccess = () => { trackReady = true; commit(); };
      lists.onsuccess = () => { listsReady = true; commit(); };
    });
  }

  async createPlaylist(playlist) {
    const candidate = normalizePlaylists([playlist])[0];
    return this._transaction(['tracks', 'config'], 'readwrite', (transaction, done, fail) => {
      const config = transaction.objectStore('config');
      const keys = transaction.objectStore('tracks').getAllKeys(), lists = config.get('playlists');
      let keysReady = false, listsReady = false;
      const commit = () => {
        if (!keysReady || !listsReady) return;
        try {
          const playlists = normalizePlaylists([...(lists.result ?? []), candidate], new Set(keys.result));
          config.put(playlists, 'playlists');
          done(playlists);
        } catch (error) { fail(error); }
      };
      keys.onsuccess = () => { keysReady = true; commit(); };
      lists.onsuccess = () => { listsReady = true; commit(); };
    });
  }

  async importTracks(tracks, playlists, source = null) {
    const candidate = validateImport(tracks, playlists);
    const sourceCandidate = source == null ? null : clone(source);
    if (sourceCandidate) identifier(sourceCandidate.id, 'ライブラリの参照ID');
    return this._transaction(['tracks', 'config'], 'readwrite', (transaction, done, fail) => {
      const trackStore = transaction.objectStore('tracks'), config = transaction.objectStore('config');
      const trackRequest = trackStore.getAll(), playlistRequest = config.get('playlists');
      const sourceRequest = sourceCandidate ? config.get('sources') : null;
      let existingTracks, existingPlaylists;
      let existingSources = sourceCandidate ? null : [];
      const commit = () => {
        if (!existingTracks || !existingPlaylists || !existingSources) return;
        try {
          const merged = mergeImport(existingTracks.map(normalizeTrack), normalizePlaylists(existingPlaylists), candidate.tracks, candidate.playlists);
          const sources = sourceCandidate ? mergeSources(existingSources, sourceCandidate) : null;
          const existingIds = new Set(existingTracks.map(track => track.id));
          for (const track of merged.tracks) if (!existingIds.has(track.id)) trackStore.put(track);
          config.put(merged.playlists, 'playlists');
          if (sources) config.put(sources, 'sources');
          done(merged.result);
        } catch (error) { fail(error); }
      };
      trackRequest.onsuccess = () => { existingTracks = trackRequest.result; commit(); };
      playlistRequest.onsuccess = () => { existingPlaylists = playlistRequest.result ?? []; commit(); };
      if (sourceRequest) sourceRequest.onsuccess = () => { existingSources = sourceRequest.result ?? []; commit(); };
    });
  }

  async getAudio(id) {
    identifier(id, '曲ID');
    return this._transaction(['audio'], 'readonly', (transaction, done, fail) => {
      const request = transaction.objectStore('audio').get(id);
      request.onsuccess = () => readStoredAudio(transaction.objectStore('audio'), request.result, done, fail);
    });
  }

  async removeTrack(id) {
    identifier(id, '曲ID');
    return this._transaction(['tracks', 'audio', 'config'], 'readwrite', (transaction, _, fail) => {
      transaction.objectStore('tracks').delete(id);
      const audio = transaction.objectStore('audio'), previous = audio.get(id);
      previous.onsuccess = () => {
        try { deleteAudioChunks(audio, previous.result); audio.delete(id); }
        catch (error) { fail(error); }
      };
      const config = transaction.objectStore('config');
      const request = config.get('playlists');
      request.onsuccess = () => {
        try {
          const playlists = normalizePlaylists(request.result ?? []);
          config.put(playlists.map(playlist => ({...playlist, trackIds: playlist.trackIds.filter(value => value !== id)})), 'playlists');
        } catch (error) { fail(error); }
      };
    });
  }

  async getPlaylists() {
    return this._transaction(['config'], 'readonly', (transaction, done, fail) => {
      const request = transaction.objectStore('config').get('playlists');
      request.onsuccess = () => {
        try { done(normalizePlaylists(request.result ?? [])); }
        catch (error) { fail(error); }
      };
    });
  }

  async putPlaylists(playlists) {
    // Validate shape before starting a write; references are validated inside
    // the same transaction as the replacement to avoid cross-tab races.
    const candidate = normalizePlaylists(playlists);
    return this._transaction(['tracks', 'config'], 'readwrite', (transaction, _, fail) => {
      const request = transaction.objectStore('tracks').getAllKeys();
      request.onsuccess = () => {
        try { transaction.objectStore('config').put(normalizePlaylists(candidate, new Set(request.result)), 'playlists'); }
        catch (error) { fail(error); }
      };
    });
  }
}

function openDatabase() {
  return new Promise((resolve, reject) => {
    let request;
    let settled = false;
    const finish = (error, database) => {
      if (settled) { database?.close(); return; }
      settled = true;
      clearTimeout(timer);
      if (error) reject(error); else resolve(database);
    };
    const timer = setTimeout(() => finish(new Error('保存領域を開く操作がタイムアウトしました。')), 8_000);
    try { request = globalThis.indexedDB.open(DATABASE_NAME, DATABASE_VERSION); }
    catch (error) { finish(error); return; }
    request.onupgradeneeded = () => {
      if (settled) { request.transaction?.abort(); return; }
      const database = request.result;
      if (!database.objectStoreNames.contains('tracks')) database.createObjectStore('tracks', {keyPath: 'id'});
      if (!database.objectStoreNames.contains('audio')) database.createObjectStore('audio');
      if (!database.objectStoreNames.contains('config')) database.createObjectStore('config');
    };
    request.onsuccess = () => finish(null, request.result);
    request.onerror = () => finish(request.error || new Error('保存領域を開けませんでした。'));
    request.onblocked = () => finish(new Error('別の画面が保存領域を使用しています。'));
  });
}

/** Open without uploading files or requesting MIDI/audio permission. */
export async function openLibrary() {
  try {
    if (!globalThis.indexedDB) return new MemoryLibrary();
    return new IndexedLibrary(await openDatabase());
  } catch {
    return new MemoryLibrary();
  }
}
