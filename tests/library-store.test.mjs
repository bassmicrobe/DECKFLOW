import test from 'node:test';
import assert from 'node:assert/strict';
import {openLibrary, validateLibrarySnapshot} from '../dist/library-store.js';
import {MAX_TRACK_TEXT_LENGTH} from '../dist/track-metadata.js';

const track = (patch = {}) => ({
  id: 'track-1', title: 'Night Walk', artist: 'DECKFLOW', bpm: 128,
  duration: 180, beatOffset: 0.12, cue: 1, hotcues: [1, 32, null, 128],
  filename: 'Night Walk.wav', fingerprint: 'Night Walk.wav|128|100',
  addedAt: 1_700_000_000_000, peaks: [0, 0.2, 1], confidence: 0.85, ...patch,
});
const snapshot = (patch = {}) => ({format: 'deckflow.library', version: 1, tracks: [track()],
  playlists: [{id: 'playlist-1', name: 'Opening', trackIds: ['track-1']}], ...patch});

async function withoutIndexedDB(run) {
  const descriptor = Object.getOwnPropertyDescriptor(globalThis, 'indexedDB');
  Object.defineProperty(globalThis, 'indexedDB', {configurable: true, value: undefined});
  try { return await run(); }
  finally {
    if (descriptor) Object.defineProperty(globalThis, 'indexedDB', descriptor);
    else delete globalThis.indexedDB;
  }
}

test('snapshot round trip retains cue/playlist order without trusting extra fields', () => {
  const original = snapshot({exportedAt: '2026-11-06T12:00:00Z', arbitraryPath: '/private/key'});
  original.tracks[0].extra = 'discard';
  const result = validateLibrarySnapshot(JSON.stringify(original));
  assert.equal(result.tracks[0].bpm, 128);
  assert.deepEqual(result.tracks[0].hotcues, [1, 32, null, 128, null, null, null, null]);
  assert.deepEqual(result.playlists[0].trackIds, ['track-1']);
  assert.equal(result.exportedAt, '2026-11-06T12:00:00.000Z');
  assert.equal(result.arbitraryPath, undefined);
  assert.equal(result.tracks[0].extra, undefined);
  result.tracks[0].hotcues[0] = 99;
  assert.equal(original.tracks[0].hotcues[0], 1);
});

test('long imported titles and artist credits retain their full text on edits and snapshot reloads', async () => {
  await withoutIndexedDB(async () => {
    const title = '題'.repeat(MAX_TRACK_TEXT_LENGTH), artist = 'A'.repeat(MAX_TRACK_TEXT_LENGTH);
    const store = await openLibrary();
    await store.putTrack(track({title,artist,comments:'note\r\nnext\tline'}), new Blob(['original']));
    await store.updateTrackDetails('track-1', {title,artist,bpm:64});
    const restored = validateLibrarySnapshot(JSON.stringify(snapshot({tracks:await store.getTracks()})));
    assert.equal(restored.tracks[0].title, title); assert.equal(restored.tracks[0].artist, artist);
    assert.equal(restored.tracks[0].comments, 'note\r\nnext\tline');
    assert.equal(await (await store.getAudio('track-1')).text(), 'original');
    for (const field of ['title','artist']) {
      await assert.rejects(store.putTrack(track({[field]:'x'.repeat(MAX_TRACK_TEXT_LENGTH + 1)})), /1024/);
      for (const character of ['\0','\n','\r','\t','\x7f']) await assert.rejects(store.putTrack(track({[field]:`bad${character}text`})), /テキスト/);
    }
    assert.equal((await store.getTracks())[0].title, title); assert.equal((await store.getTracks())[0].artist, artist);
  });
});

test('snapshot rejects broken IDs, unsupported formats, dangling and duplicate playlist references', () => {
  assert.throws(() => validateLibrarySnapshot(snapshot({version: 2})), /version 1/);
  assert.throws(() => validateLibrarySnapshot(snapshot({tracks: [track(), track()]})), /曲IDが重複/);
  assert.throws(() => validateLibrarySnapshot(snapshot({tracks: [track({id: '../escape'})]})), /曲ID/);
  assert.throws(() => validateLibrarySnapshot(snapshot({playlists: [{id: 'p', name: 'P', trackIds: ['missing']}]})), /存在しない曲/);
  assert.throws(() => validateLibrarySnapshot(snapshot({playlists: [{id: 'p', name: 'P', trackIds: ['track-1', 'track-1']}]})), /曲IDが重複/);
  assert.throws(() => validateLibrarySnapshot('{broken'), /JSON/);
});

test('metadata rejects tempo/audio-position/peak data that cannot be played safely', () => {
  for (const patch of [{bpm: NaN}, {bpm: 301}, {bpm: '128'}, {duration: 0}, {duration: Infinity},
    {beatOffset: -1}, {cue: 181}, {hotcues: [0, 181, null, null]}, {hotcues: [1]},
    {peaks: [0, NaN]}, {peaks: [1.01]}, {confidence: 2}, {addedAt: 'not a date'}]) {
    assert.throws(() => validateLibrarySnapshot(snapshot({tracks: [track(patch)]})), Error, JSON.stringify(patch));
  }
  const result = validateLibrarySnapshot(snapshot({tracks: [track({bpm: null, addedAt: '2026-11-06T12:00:00Z'})]}));
  assert.equal(result.tracks[0].bpm, null);
  assert.equal(typeof result.tracks[0].addedAt, 'number');
});

test('snapshot filenames stay basenames across Mac, Windows and USB export paths', () => {
  for (const filename of ['../song.wav', '/song.wav', 'folder/song.wav', '..\\song.wav', 'C:\\song.wav', '..', '.', 'song.wav.', 'song.wav ', 'bad\u0000.wav']) {
    assert.throws(() => validateLibrarySnapshot(snapshot({tracks: [track({filename})]})), Error, filename);
  }
  const result = validateLibrarySnapshot(snapshot({tracks: [track({filename: '夜の選曲 🎧.wav'})]}));
  assert.equal(result.tracks[0].filename, '夜の選曲 🎧.wav');
});

test('memory fallback is explicit and editing metadata does not erase encoded audio', async () => {
  await withoutIndexedDB(async () => {
    const store = await openLibrary();
    assert.equal(store.persistent, false);
    assert.match(store.warning, /ページを閉じると/);
    const audio = new Blob(['encoded original'], {type: 'audio/wav'});
    await store.putTrack(track(), audio);
    await store.putTrack(track({title: 'Edited title', bpm: 64}));
    const tracks = await store.getTracks();
    assert.equal(tracks[0].title, 'Edited title');
    assert.equal(tracks[0].blob, undefined);
    assert.equal(await (await store.getAudio('track-1')).text(), 'encoded original');
    tracks[0].hotcues[0] = 100;
    assert.equal((await store.getTracks())[0].hotcues[0], 1);
    const freshStore = await openLibrary();
    assert.deepEqual(await freshStore.getTracks(), []);
  });
});

test('failed save leaves previous metadata and original audio unchanged', async () => {
  await withoutIndexedDB(async () => {
    const store = await openLibrary();
    await store.putTrack(track(), new Blob(['original']));
    await assert.rejects(store.putTrack(track({bpm: -10}), new Blob(['replacement'])), /BPM/);
    await assert.rejects(store.putTrack(track({title: 'Uncommitted'}), 'not a blob'), /Blob/);
    assert.equal((await store.getTracks())[0].title, 'Night Walk');
    assert.equal(await (await store.getAudio('track-1')).text(), 'original');
  });
});

test('the 10,000-track limit rejects additional audio without blocking edits or a replacement after deletion', async () => {
  await withoutIndexedDB(async () => {
    const store = await openLibrary();
    const existing = Array.from({length: 10_000}, (_, index) => track({id: `limit-${index}`}));
    await store.importTracks(existing, []);
    await store.putTrack({...existing[0], title: 'Edited at capacity'}, new Blob(['original']));

    await assert.rejects(store.putTrack(track({id: 'overflow'}), new Blob(['uncommitted'])), /10,000/);
    assert.equal((await store.getTracks()).length, 10_000);
    assert.equal(await store.getAudio('overflow'), null);
    assert.equal((await store.getTracks()).find(item => item.id === 'limit-0').title, 'Edited at capacity');
    assert.equal(await (await store.getAudio('limit-0')).text(), 'original');

    await store.removeTrack('limit-1');
    await store.putTrack(track({id: 'replacement'}), new Blob(['replacement']));
    assert.equal((await store.getTracks()).length, 10_000);
    assert.equal(await (await store.getAudio('replacement')).text(), 'replacement');
    assert.equal(validateLibrarySnapshot(snapshot({tracks: await store.getTracks(), playlists: []})).tracks.length, 10_000);
  });
});

test('editing track details adds playlist membership together and preserves the latest cue and audio', async () => {
  await withoutIndexedDB(async () => {
    const store = await openLibrary();
    await store.putTrack(track({cue: 42}), new Blob(['original']));
    await store.putPlaylists([{id: 'set', name: 'Set', trackIds: []}]);
    const result = await store.updateTrackDetails('track-1', {title: 'Edited', artist: 'Artist', bpm: 64}, 'set');
    assert.equal(result.track.title, 'Edited');
    assert.equal(result.track.cue, 42);
    assert.deepEqual(result.playlists[0].trackIds, ['track-1']);
    assert.equal((await store.getTracks())[0].title, 'Edited');
    assert.deepEqual((await store.getPlaylists())[0].trackIds, ['track-1']);
    assert.equal(await (await store.getAudio('track-1')).text(), 'original');
    await store.updateTrackDetails('track-1', {title: 'Again', artist: '', bpm: null}, 'set');
    assert.deepEqual((await store.getPlaylists())[0].trackIds, ['track-1']);
  });
});

test('a missing playlist or invalid edit does not partially save track details or recreate a deleted track', async () => {
  await withoutIndexedDB(async () => {
    const store = await openLibrary();
    await store.putTrack(track(), new Blob(['original']));
    await store.putPlaylists([{id: 'set', name: 'Set', trackIds: []}]);
    const before = await store.getTracks();
    const lists = await store.getPlaylists();
    await assert.rejects(store.updateTrackDetails('track-1', {title: 'Uncommitted', artist: '', bpm: 64}, 'missing'), /プレイリスト/);
    await assert.rejects(store.updateTrackDetails('track-1', {title: 'Uncommitted', artist: '', bpm: 301}, 'set'), /BPM/);
    assert.deepEqual(await store.getTracks(), before);
    assert.deepEqual(await store.getPlaylists(), lists);
    assert.equal(await (await store.getAudio('track-1')).text(), 'original');
    await store.removeTrack('track-1');
    await assert.rejects(store.updateTrackDetails('track-1', {title: 'Uncommitted', artist: '', bpm: 64}), /削除/);
    assert.deepEqual(await store.getTracks(), []);
  });
});

test('creating playlists retains other creations and rejects conflicting IDs or missing tracks without replacing data', async () => {
  await withoutIndexedDB(async () => {
    const store = await openLibrary();
    await store.putTrack(track());
    await Promise.all([
      store.createPlaylist({id: 'first', name: 'First', trackIds: ['track-1']}),
      store.createPlaylist({id: 'second', name: 'Second', trackIds: []}),
    ]);
    const before = await store.getPlaylists();
    assert.deepEqual(before.map(item => item.id), ['first', 'second']);
    await assert.rejects(store.createPlaylist({id: 'first', name: 'Replacement', trackIds: []}), /重複/);
    await assert.rejects(store.createPlaylist({id: 'third', name: 'Dangling', trackIds: ['missing']}), /存在しない曲/);
    assert.deepEqual(await store.getPlaylists(), before);
  });
});

test('removing a track removes its audio and playlist references while retaining other tracks', async () => {
  await withoutIndexedDB(async () => {
    const store = await openLibrary();
    await store.putTrack(track(), new Blob(['first']));
    await store.putTrack(track({id: 'track-2', filename: 'Second.wav'}), new Blob(['second']));
    await store.putPlaylists([{id: 'p', name: 'Set', trackIds: ['track-2', 'track-1']}]);
    await store.removeTrack('track-1');
    assert.equal(await store.getAudio('track-1'), null);
    assert.equal((await store.getTracks()).length, 1);
    assert.deepEqual((await store.getPlaylists())[0].trackIds, ['track-2']);
    assert.equal(await (await store.getAudio('track-2')).text(), 'second');
  });
});

test('playlist writes are validated before replacing the saved configuration', async () => {
  await withoutIndexedDB(async () => {
    const store = await openLibrary();
    await store.putTrack(track());
    const original = [{id: 'p', name: 'Set', trackIds: ['track-1']}];
    await store.putPlaylists(original);
    original[0].name = 'Mutated externally';
    await assert.rejects(store.putPlaylists([{id: 'bad', name: 'Bad', trackIds: ['missing']}]));
    assert.equal((await store.getPlaylists())[0].name, 'Set');
    const read = await store.getPlaylists();
    read[0].trackIds.length = 0;
    assert.deepEqual((await store.getPlaylists())[0].trackIds, ['track-1']);
  });
});

test('an initial SecurityError uses only explicit volatile storage', async () => {
  const descriptor = Object.getOwnPropertyDescriptor(globalThis, 'indexedDB');
  Object.defineProperty(globalThis, 'indexedDB', {configurable: true, value: {open() { throw new DOMException('Blocked', 'SecurityError'); }}});
  try {
    const store = await openLibrary();
    assert.equal(store.persistent, false);
    assert.match(store.warning, /保持/);
    await store.putTrack(track(), new Blob(['test']));
    assert.equal((await store.getTracks()).length, 1);
  } finally {
    if (descriptor) Object.defineProperty(globalThis, 'indexedDB', descriptor);
    else delete globalThis.indexedDB;
  }
});

test('an opened persistent store reports a later quota error instead of switching to volatile storage', async () => {
  const descriptor = Object.getOwnPropertyDescriptor(globalThis, 'indexedDB');
  const navigatorDescriptor = Object.getOwnPropertyDescriptor(globalThis, 'navigator');
  // This deliberately minimal database mock covers quota reporting without
  // pretending to implement browser Web Locks / cursor-based orphan cleanup.
  Object.defineProperty(globalThis, 'navigator', {configurable: true, value: undefined});
  const database = {
    transaction() {
      const transaction = {
        objectStore() { return {
          get() { const request = {}; queueMicrotask(() => { request.onsuccess?.(); queueMicrotask(() => transaction.oncomplete?.()); }); return request; },
          count() { const request = {}; queueMicrotask(() => { request.result = 0; request.onsuccess?.(); }); return request; },
          put() { throw new DOMException('Full', 'QuotaExceededError'); },
        }; },
        abort() { queueMicrotask(() => transaction.onabort?.()); },
      };
      return transaction;
    },
    close() {},
  };
  Object.defineProperty(globalThis, 'indexedDB', {configurable: true, value: {
    open() {
      const request = {};
      queueMicrotask(() => { request.result = database; request.onsuccess?.(); });
      return request;
    },
  }});
  try {
    const store = await openLibrary();
    assert.equal(store.persistent, true);
    await assert.rejects(store.putTrack(track(), new Blob(['data'])), /保存容量が足りません.*変更は保存していません/);
    assert.equal(store.persistent, true);
    database.onversionchange();
    assert.equal(store.persistent, false);
    await assert.rejects(store.putTrack(track()), /再読み込み/);
  } finally {
    if (navigatorDescriptor) Object.defineProperty(globalThis, 'navigator', navigatorDescriptor);
    else delete globalThis.navigator;
    if (descriptor) Object.defineProperty(globalThis, 'indexedDB', descriptor);
    else delete globalThis.indexedDB;
  }
});


test('rekordbox metadata survives snapshots including 8 hot cues, tempo segments, loops and hierarchy', () => {
  const source = track({hotcues: [1, 32, null, 128, null, null, null, 150], audioMissing: true,
    tempos: [{start: 0.12, bpm: 128, meter: '4/4', beat: 1}, {start: 60, bpm: 130, meter: '3/4', beat: 2}],
    positionMarks: [{name: 'Loop & color', type: 4, start: 150, end: 158, num: 7, color: [1, 2, 255]}],
    rekordbox: {trackId: '12', location: 'file://localhost/music/Night%20Walk.wav', size: 123456}});
  const result = validateLibrarySnapshot(snapshot({tracks: [source], playlists: [{id: 'p', name: 'Set', folderPath: ['Venue', 'Opening'], trackIds: [source.id]}]}));
  assert.deepEqual(result.tracks[0].tempos, source.tempos);
  assert.deepEqual(result.tracks[0].positionMarks, source.positionMarks);
  assert.deepEqual(result.tracks[0].rekordbox, source.rekordbox);
  assert.equal(result.tracks[0].audioMissing, true);
  assert.deepEqual(result.playlists[0].folderPath, ['Venue', 'Opening']);
  for (const patch of [{tempos: [{start: 1, bpm: 128, meter: '4/4', beat: 5}]},
    {positionMarks: [{name: '', type: 4, start: 1, end: 0, num: 7}]},
    {rekordbox: {trackId: '12', location: 'https://example.com/song.wav'}}, {audioMissing: 'true'}]) {
    assert.throws(() => validateLibrarySnapshot(snapshot({tracks: [track(patch)]})));
  }
});

test('XML import is additive and atomic, preserves existing edits/audio and skips repeated source IDs', async () => {
  await withoutIndexedDB(async () => {
    const store = await openLibrary();
    const source = track({rekordbox: {trackId: '12', location: 'file://localhost/music/song.wav'}, audioMissing: false});
    await store.putTrack(source, new Blob(['original music']));
    const incoming = track({id: 'track-2', audioMissing: true, rekordbox: {trackId: '13', location: 'file:///music/next.wav'}});
    const list = {id: 'p', name: 'Imported', trackIds: ['track-1', 'track-2'], folderPath: ['Party']};
    const result = await store.importTracks([source, incoming], [list]);
    assert.deepEqual(result, {addedTracks: 1, addedPlaylists: 1, skippedTracks: 1, skippedPlaylists: 0});
    await store.putTrack({...source, bpm: 64});
    const repeated = await store.importTracks([source, incoming], [list]);
    assert.equal(repeated.addedTracks, 0);
    assert.equal((await store.getTracks())[0].bpm, 64);
    assert.equal((await store.getTracks())[0].audioMissing, false);
    assert.equal(await (await store.getAudio('track-1')).text(), 'original music');
    assert.equal(await store.getAudio('track-2'), null);
    const before = await store.getTracks(), beforeLists = await store.getPlaylists();
    await assert.rejects(store.importTracks([track({id: 'track-3'})], [{id: 'bad', name: 'Dangling', trackIds: ['missing']}]));
    assert.deepEqual(await store.getTracks(), before);
    assert.deepEqual(await store.getPlaylists(), beforeLists);
    await assert.rejects(store.importTracks([track({id: 'track-1'})], []), /衝突/);
    assert.deepEqual(await store.getTracks(), before);
    const addList = await store.importTracks([], [{id: 'new-list', name: 'Existing reference', trackIds: ['track-1']}]);
    assert.equal(addList.addedPlaylists, 1);
  });
});
