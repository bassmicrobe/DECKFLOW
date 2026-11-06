/** Read back the companion database with the same reader used by the Web app. */
import {readFile, lstat} from 'node:fs/promises';
import {join} from 'node:path';
import {parseRekordboxDatabase} from '../dist/rekordbox-sqlite.js';

const failure = () => { throw new Error('OneLibraryの曲情報・音源パス・プレイリストがDevice Libraryと一致しません。'); };

export async function readOneLibrary(output) {
  const path = join(output, 'PIONEER/rekordbox/exportLibrary.db');
  const info = await lstat(path);
  if (!info.isFile() || info.isSymbolicLink() || info.size > 128 * 1024 * 1024) failure();
  return parseRekordboxDatabase(new Uint8Array(await readFile(path)), {kind:'device',sourceId:'usb-verification'});
}

export function verifyOneLibrary(parsed, device, expectedPlaylists) {
  if (parsed.tracks.length !== device.tracks.length) failure();
  const deviceTracks = new Map(device.tracks.map(track => [String(track.id),track]));
  const ids = new Map(parsed.tracks.map(track => [track.id,Number(track.rekordbox.trackId)]));
  const paths = new Map(parsed.entries.map(entry => [entry.trackId,entry]));
  for (const track of parsed.tracks) {
    const expected = deviceTracks.get(track.rekordbox.trackId), entry = paths.get(track.id);
    if (!expected || !entry || track.title !== expected.title || track.bpm !== expected.bpm ||
        track.duration !== expected.duration || track.rekordbox.size !== expected.size ||
        entry.sourcePath !== expected.path || entry.analysisPath !== expected.analysisPath) failure();
  }
  const signature = (name, folderPath, trackIds) => JSON.stringify([name,folderPath,trackIds]);
  const expected = expectedPlaylists.map(list => signature(list.name,list.folderPath,list.trackIds));
  const actual = parsed.playlists.map(list => signature(list.name,list.folderPath,list.trackIds.map(id => ids.get(id))));
  if (JSON.stringify([...expected].sort()) !== JSON.stringify([...actual].sort())) failure();
}
