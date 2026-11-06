import test from 'node:test';
import assert from 'node:assert/strict';
import {parseRekordboxXml} from '../dist/rekordbox-import.js';
import {parseRekordboxLocation} from '../dist/rekordbox-model.js';

const track = `<TRACK TrackID="42" Name="Night &amp; Day &#x266B;" Artist="A &quot;B&quot;" TotalTime="180" AverageBpm="128.00" Size="123456" DateAdded="2026-11-07" Location="file://localhost/Music/Night%20%26%20Day.wav">
<TEMPO Inizio="0.125" Bpm="128" Metro="4/4" Battito="1"/>
<TEMPO Inizio="60" Bpm="130" Metro="4/4" Battito="3"/>
<POSITION_MARK Name="Memory" Type="0" Start="1.5" Num="-1"/>
<POSITION_MARK Name="Drop" Type="0" Start="32" Num="0" Red="255" Green="128" Blue="0"/>
<POSITION_MARK Name="Outro" Type="4" Start="160" End="168" Num="7" Red="0" Green="0" Blue="255"/>
</TRACK>`;
const lists = `<PLAYLISTS><NODE Type="0" Name="ROOT" Count="1"><NODE Type="0" Name="Club &amp; home" Count="2"><NODE Type="1" Name="Opening" KeyType="0" Entries="1"><TRACK Key="42"/></NODE><NODE Type="1" Name="Empty" KeyType="0" Entries="0"/></NODE></NODE></PLAYLISTS>`;
const xml = (tracks = track, playlist = lists) => `<?xml version="1.0" encoding="UTF-8"?>\n<DJ_PLAYLISTS Version="1.0.0"><PRODUCT Name="rekordbox"/><COLLECTION Entries="1">${tracks}</COLLECTION>${playlist}</DJ_PLAYLISTS>`;

test('imports Unicode metadata, source location, variable tempo, 8 hot cues, memory cues and colored loops', () => {
  const parsed = parseRekordboxXml(xml());
  assert.equal(parsed.tracks.length, 1);
  const song = parsed.tracks[0];
  assert.equal(song.title, 'Night & Day ♫');
  assert.equal(song.artist, 'A "B"');
  assert.equal(song.filename, 'Night & Day.wav');
  assert.equal(song.bpm, 128);
  assert.equal(song.audioMissing, true);
  assert.equal(song.rekordbox.size, 123456);
  assert.deepEqual(song.tempos, [{start:.125,bpm:128,meter:'4/4',beat:1},{start:60,bpm:130,meter:'4/4',beat:3}]);
  assert.deepEqual(song.hotcues, [32,null,null,null,null,null,null,160]);
  assert.equal(song.cue, 1.5);
  assert.deepEqual(song.positionMarks[2], {name:'Outro',type:4,start:160,end:168,num:7,color:[0,0,255]});
  assert.deepEqual(parsed.playlists.map(list => [list.name, list.folderPath, list.trackIds.length]), [['Opening',['Club & home'],1], ['Empty',['Club & home'],0]]);
  assert.equal(parsed.playlists[0].trackIds[0], song.id);
  assert.deepEqual(parseRekordboxXml(xml()), parsed, 'source IDs and metadata are stable across repeated imports');
});

test('same basename at different locations gets different IDs; Location-key playlists resolve canonical local URLs', () => {
  const original = parseRekordboxXml(xml());
  const moved = parseRekordboxXml(xml().replace('/Music/Night', '/Music/Other/Night'));
  assert.notEqual(original.tracks[0].id, moved.tracks[0].id);
  assert.notEqual(original.playlists[0].id, moved.playlists[0].id, 'different collections do not silently collide at same-name playlists');
  const byLocation = xml().replace('KeyType="0" Entries="1"><TRACK Key="42"', 'KeyType="1" Entries="1"><TRACK Key="file:///Music/Night%20%26%20Day.wav"');
  assert.equal(parseRekordboxXml(byLocation).playlists[0].trackIds[0], original.tracks[0].id);
  assert.deepEqual(parseRekordboxLocation('file:///Music/%E5%A4%9C.wav'), {location:'file:///Music/%E5%A4%9C.wav',path:'/Music/夜.wav',filename:'夜.wav',identity:'/Music/夜.wav'});
});

test('rejects malformed XML, DTD/entities, unknown processing instructions and invalid XML characters', () => {
  for (const value of [xml().replace('</TRACK>', '</TEMPO>'), xml() + '<ROOT/>', xml().replace('TrackID="42"', 'TrackID="42" TrackID="43"'),
    '<!DOCTYPE x [<!ENTITY secret SYSTEM "file:///etc/passwd">]>' + xml(), xml().replace('Night &amp;', 'Night &secret;'),
    xml().replace('Night &amp;', 'Night &bad'), xml().replace('Night &amp;', 'Night &#0;'), xml().replace('<PRODUCT', '<?fetch foo?><PRODUCT'),
    xml().replace('Night &amp;', 'Night <'), xml().replace('Night &amp;', 'Night \u0000'), xml().slice(0,-5), '<html/>']) {
    assert.throws(() => parseRekordboxXml(value), Error);
  }
});

test('rejects malformed metadata and dangling references instead of silently dropping prepared information', () => {
  for (const value of [xml().replace('Key="42"', 'Key="99"'), xml().replace('Bpm="130"', 'Bpm="NaN"'),
    xml().replace('Inizio="60"', 'Inizio="0.125"'), xml().replace('Battito="3"', 'Battito="5"'),
    xml().replace('Num="7"', 'Num="8"'), xml().replace('Type="4" Start="160"', 'Type="3" Start="160"'),
    xml().replace('End="168"', 'End="159"'), xml().replace('Red="255"', 'Red="256"'),
    xml().replace('Start="160"', 'Start="182"'), xml().replace('Entries="1"', 'Entries="2"'),
    xml().replace('TotalTime="180"', 'TotalTime="0"'), xml().replace('Size="123456"', 'Size="-1"')]) {
    assert.throws(() => parseRekordboxXml(value), Error, value);
  }
});

test('never accepts remote URLs or malformed file URLs', () => {
  for (const location of ['https://example.com/song.wav','file://server/music/song.wav','file:///Music/bad%00.wav','file:///Music/bad%GG.wav','file:///Music/song.wav?foo=1','file:///Music/']) {
    assert.throws(() => parseRekordboxXml(xml().replace('file://localhost/Music/Night%20%26%20Day.wav', location)));
  }
});

test('preserves fractional last-second marks from whole-second TotalTime; handles unanalyzed tracks without guessing BPM', () => {
  const partial = xml().replace('TotalTime="180"', 'TotalTime="167"').replace('End="168"', 'End="167.8"');
  const last = parseRekordboxXml(partial).tracks[0];
  assert.ok(Math.abs(last.duration - 167.801) < 1e-9);
  assert.equal(last.positionMarks[2].end, 167.8);
  assert.throws(() => parseRekordboxXml(xml().replace('TotalTime="180"', 'TotalTime="167"')));
  const noAnalysis = xml(track.replace(/<TEMPO[^>]*\/>/g, '').replace('AverageBpm="128.00"', 'AverageBpm="0"'));
  assert.equal(parseRekordboxXml(noAnalysis).tracks[0].bpm, null);
});


test('same-name playlists remain distinct and empty folders produce a visible warning', () => {
  const listXml = '<PLAYLISTS><NODE Type="0" Name="ROOT"><NODE Type="0" Name="Empty folder"/><NODE Type="1" Name="Set" KeyType="0"><TRACK Key="42"/></NODE><NODE Type="1" Name="Set" KeyType="0"/></NODE></PLAYLISTS>';
  const parsed = parseRekordboxXml(xml(track, listXml));
  assert.equal(parsed.playlists.length, 2);
  assert.notEqual(parsed.playlists[0].id, parsed.playlists[1].id);
  assert.match(parsed.warnings.join(' '), /空のフォルダー1件/);
  assert.throws(() => parseRekordboxXml(xml(track, listXml.replace('<NODE Type="1" Name="Set" KeyType="0"/>', '<NODE Type="0" Name="Empty folder"/>'))), /同名フォルダー/);
});
