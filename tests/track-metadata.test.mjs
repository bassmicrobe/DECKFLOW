import test from 'node:test';
import assert from 'node:assert/strict';
import {metadataDate, trackDateValue, normalizeTrackMetadata} from '../dist/track-metadata.js';
import {sortLibraryTracks} from '../dist/library-sort.js';
import {parseRekordboxXml} from '../dist/rekordbox-import.js';
import {parseRekordboxDatabase} from '../dist/rekordbox-sqlite.js';
import {image,deviceTables,masterTables} from './helpers/rekordbox-sqlite-fixture.mjs';

test('source dates never become import time and local modifications use the latest known time',()=>{
  assert.equal(metadataDate('2024-02-30'),''); assert.equal(metadataDate(''),'');
  assert.equal(metadataDate('2024-02-29'),'2024-02-29');
  assert.equal(trackDateValue({addedAt:123},'dateModified'),null);
  assert.equal(trackDateValue({dateAdded:'2024-01-02',addedAt:Date.now()},'dateAdded'),Date.parse('2024-01-02'));
  assert.equal(trackDateValue({dateModified:'2024-01-02',updatedAt:Date.parse('2025-01-01')},'dateModified'),Date.parse('2025-01-01'));
});
test('extended columns sort correctly, rating zero is known and missing dates stay last both ways',()=>{
  const tracks=[{id:'new',dateAdded:'2025-01-01',rating:0},{id:'old',dateAdded:'2024-01-01',rating:5},{id:'unknown'}];
  assert.deepEqual(sortLibraryTracks(tracks,{field:'dateAdded'}).map(t=>t.id),['old','new','unknown']);
  assert.deepEqual(sortLibraryTracks(tracks,{field:'dateAdded',direction:'descending'}).map(t=>t.id),['new','old','unknown']);
  assert.deepEqual(sortLibraryTracks(tracks,{field:'rating'}).map(t=>t.id),['new','old','unknown']);
  assert.deepEqual(sortLibraryTracks([{filename:'2.wav'},{filename:'10.wav'}],{field:'fileName'}).map(t=>t.filename),['2.wav','10.wav']);
});
test('XML album, comments, technical metadata, rating and source dates survive normalization',()=>{
  const [track]=parseRekordboxXml('<DJ_PLAYLISTS><COLLECTION Entries="1"><TRACK TrackID="1" Name="Song" Album="Album" Artist="Artist" Genre="House" Tonality="8A" Comments="line 1&#10;line 2" Rating="204" BitRate="320" SampleRate="44100" DateAdded="2024-01-02" TotalTime="180" AverageBpm="120" Location="file://localhost/Music/song.mp3"/></COLLECTION></DJ_PLAYLISTS>').tracks;
  assert.equal(track.album,'Album');assert.equal(track.genre,'House');assert.equal(track.key,'8A');assert.equal(track.rating,4);
  assert.equal(track.bitRate,320);assert.equal(track.sampleRate,44100);assert.equal(track.dateAdded,'2024-01-02');
  assert.equal(track.comments,'line 1\nline 2');assert.equal(track.dateModified,'');
  assert.throws(()=>normalizeTrackMetadata({rating:6}));
});
test('OneLibrary and master metadata/date columns are carried through the actual SQLite reader',async()=>{
  for(const master of [false,true]) {
    const tables=master?masterTables():deviceTables(), t=tables[0];
    t.columns.push(...(master?['Rating','BitRate','SampleRate','DateAdded','updated_at','Commnt']:['rating','bitrate','samplingRate','dateAdded','dateModified','djComment']));
    t.rows[0].push(3,320,48000,'2024-01-02','2025-02-03 04:05:06','Test comment');
    const track=(await parseRekordboxDatabase(image(tables))).tracks[0];
    assert.equal(track.rating,3);assert.equal(track.bitRate,320);assert.equal(track.sampleRate,48000);
    assert.equal(track.dateAdded,'2024-01-02');assert.equal(Date.parse(track.dateModified),Date.parse('2025-02-03 04:05:06'));
    assert.equal(track.comments,'Test comment');
  }
});
