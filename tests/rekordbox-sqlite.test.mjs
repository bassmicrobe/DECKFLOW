import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {parseRekordboxDatabase} from '../dist/rekordbox-sqlite.js';
import {decrypt} from '../dist/vendor/onelibrary/sqlcipher.js';
import {SQLiteDatabase,parseColumns} from '../dist/vendor/onelibrary/sqlite.js';
import {image,masterTables,deviceTables,encryptFixture,DEFAULT_KEY} from './helpers/rekordbox-sqlite-fixture.mjs';
import {MAX_TRACK_TEXT_LENGTH} from '../dist/track-metadata.js';

const master=image(masterTables()),device=image(deviceTables());
const encryptedMaster=encryptFixture(master),encryptedDevice=encryptFixture(device,DEFAULT_KEY);

test('master and OneLibrary retain long track text and multiline comments with bounded validation', async () => {
  for (const make of [masterTables, deviceTables]) {
    const tables = make(), title = 'T'.repeat(MAX_TRACK_TEXT_LENGTH), artist = 'A'.repeat(MAX_TRACK_TEXT_LENGTH);
    tables[0].rows[0][1] = title; tables[1].rows[0][1] = artist;
    tables[0].columns.push(make === masterTables ? 'Commnt' : 'djComment');
    tables[0].rows[0].push('Opening\r\nNext\tline');
    const result = await parseRekordboxDatabase(image(tables));
    assert.equal(result.tracks[0].title, title); assert.equal(result.tracks[0].artist, artist);
    assert.equal(result.tracks[0].comments, 'Opening\r\nNext\tline');
    for (const table of [0,1]) {
      tables[table].rows[0][1] = 'x'.repeat(MAX_TRACK_TEXT_LENGTH + 1);
      await assert.rejects(parseRekordboxDatabase(image(tables)), table === 0 ? /曲名/ : /アーティスト名/);
      tables[table].rows[0][1] = 'bad\ntext';
      await assert.rejects(parseRekordboxDatabase(image(tables)), table === 0 ? /曲名/ : /アーティスト名/);
      tables[table].rows[0][1] = table === 0 ? title : artist;
    }
  }
});

test('master and OneLibrary omit invalid optional release years while retaining every track and playlist', async () => {
  for (const make of [masterTables, deviceTables]) {
    const tables = make(), master = make === masterTables;
    tables[0].columns.push(master ? 'ReleaseYear' : 'releaseYear'); tables[0].rows[0].push(2019);
    const second = [...tables[0].rows[0]];
    second[0] = master ? '43' : 43; second[5] = master ? '/Music/Second.wav' : '/Contents/Second.wav'; second[8] = 2026;
    tables[0].rows.push(second);
    tables[3].rows.push(master ? ['21','11','43',2] : [11,43,2]);
    const before = await parseRekordboxDatabase(image(tables));
    tables[0].rows[0][8] = 12000;
    const after = await parseRekordboxDatabase(image(tables));
    assert.equal(after.tracks.length, 2); assert.equal(after.tracks[0].year, 0); assert.equal(after.tracks[1].year, 2026);
    assert.deepEqual(after.tracks.map(({year, ...track}) => track), before.tracks.map(({year, ...track}) => track));
    assert.deepEqual(after.playlists, before.playlists); assert.deepEqual(after.entries, before.entries);
    assert.equal(after.warnings.length, before.warnings.length + 1);
    assert.ok(after.warnings.some(message => /曲ID 42 のリリース年.*未設定/.test(message)));
  }
});

test('independently generated master.db decrypts and imports hierarchical metadata with exact source paths',async()=>{
  const result=await parseRekordboxDatabase(encryptedMaster,{sourceId:'test-source',kind:'master'});
  assert.equal(result.format,'master');assert.equal(result.tracks.length,1);
  const track=result.tracks[0];
  assert.equal(track.title,'Synthetic 120');assert.equal(track.artist,'DECKFLOW Test');assert.equal(track.bpm,120);assert.equal(track.duration,180);assert.equal(track.audioMissing,true);
  assert.equal(track.rekordbox.location,'file://localhost/Music/Synthetic%20120.wav');assert.equal(track.rekordbox.size,12345);
  assert.deepEqual(result.playlists[0].folderPath,['Weekend']);assert.equal(result.playlists[0].name,'Warmup');assert.deepEqual(result.playlists[0].trackIds,[track.id]);
  assert.deepEqual(result.entries,[{trackId:track.id,sourcePath:'/Music/Synthetic 120.wav',analysisPath:'/share/PIONEER/USBANLZ/P001/00000001/ANLZ0000.DAT'}]);
  assert.equal(track.positionMarks[0].start,1);assert.equal(track.positionMarks[0].num,-1);assert.equal(track.cue,1);
  const again=await parseRekordboxDatabase(master,{sourceId:'test-source'});
  assert.deepEqual(again,result);
  const other=await parseRekordboxDatabase(master,{sourceId:'another-source'});assert.notEqual(other.tracks[0].id,track.id);
});

test('OneLibrary encrypted database imports without a server or WASM and autodetects its key',async()=>{
  const result=await parseRekordboxDatabase(encryptedDevice,{sourceId:'usb',kind:'device'});
  assert.equal(result.format,'onelibrary');assert.equal(result.tracks[0].bpm,120);assert.equal(result.entries[0].sourcePath,'/Contents/Synthetic 120.wav');
  assert.deepEqual(await parseRekordboxDatabase(encryptedDevice,{sourceId:'usb'}),result);
  await assert.rejects(()=>parseRekordboxDatabase(device,{kind:'master'}),/形式/);
});

test('verifies every encrypted page MAC and rejects tampering, truncation and wrong keys',async()=>{
  for(const offset of [80,4096+100,encryptedMaster.length-1]) {
    const damaged=encryptedMaster.slice();damaged[offset]^=1;
    await assert.rejects(()=>decrypt(damaged,'402fd482c38817c35ffa8ffb8c7d93143b749e7d315df7a81732a1ff43608497'),/authentication/);
  }
  await assert.rejects(()=>decrypt(encryptedMaster,'wrong-passphrase'),/authentication/);
  await assert.rejects(()=>decrypt(encryptedMaster.subarray(0,-1)),/whole number/);
  await assert.rejects(()=>parseRekordboxDatabase(new Uint8Array(2)),/128 MB/);
});

test('reads pinned upstream independently authored SQLCipher fixture including overflow and Unicode',async()=>{
  const raw=new Uint8Array(await readFile(new URL('./fixtures/onelibrary/upstream-sample.db',import.meta.url)));
  const db=new SQLiteDatabase(await decrypt(raw,'testpassphrase'));
  assert.deepEqual(db.tableNames(),['content','playlist','playlist_content','property']);
  const rows=db.select('content');assert.equal(rows[0].title,'Alpha Track');assert.equal(rows[1].title,'Бета Трек');assert.ok(rows[2].title.length>900);assert.ok(rows[2].title.endsWith('long'));
});

test('rejects malicious SQLite b-trees, page bounds, invalid UTF8 and nonlocal traversal paths',async()=>{
  const cycle=master.slice(),view=new DataView(cycle.buffer);cycle[4096]=5;view.setUint16(4096+3,0);view.setUint32(4096+8,2);
  assert.throws(()=>new SQLiteDatabase(cycle).select('djmdContent'),/cyclic/);
  const pointer=master.slice();new DataView(pointer.buffer).setUint16(4096+8,4095);
  assert.throws(()=>new SQLiteDatabase(pointer).select('djmdContent'),/truncated|invalid/);
  const utf=master.slice();const at=Buffer.from(utf).indexOf('Synthetic 120');utf[at]=255;assert.throws(()=>new SQLiteDatabase(utf).select('djmdContent'));
  const geometry=master.slice();new DataView(geometry.buffer).setUint16(16,513);assert.throws(()=>new SQLiteDatabase(geometry),/geometry/);
  for(const p of ['/Music/../secret.wav','https://example.com/song.wav','//server/song.wav']) {
    const tables=masterTables();tables[0].rows[0][5]=p;
    await assert.rejects(()=>parseRekordboxDatabase(image(tables)),/パス|区切り/);
  }
});

test('rejects playlist reference corruption/cycles and preserves unknown BPM instead of guessing',async()=>{
  const cycle=masterTables();cycle[2].rows[0][3]='10';await assert.rejects(()=>parseRekordboxDatabase(image(cycle)),/循環/);
  const dangling=masterTables();dangling[3].rows[0][2]='404';await assert.rejects(()=>parseRekordboxDatabase(image(dangling)),/参照/);
  const bpm=masterTables();bpm[0].rows[0][4]=0;assert.equal((await parseRekordboxDatabase(image(bpm))).tracks[0].bpm,null);
  const streaming=masterTables();streaming[0].rows[0][5]=null;const result=await parseRekordboxDatabase(image(streaming));assert.equal(result.tracks.length,0);assert.match(result.warnings.join(' '),/1曲/);assert.deepEqual(result.playlists[0].trackIds,[]);
});

test('schema parser handles quoting, commas inside defaults and table constraints',()=>{
  assert.deepEqual(parseColumns('CREATE TABLE test ("ID" TEXT PRIMARY KEY, "Name" TEXT DEFAULT \'a,b\', amount DECIMAL(10,2), PRIMARY KEY ("ID"))'),['ID','Name','amount']);
});


test('master database is authoritative for memory cues, active loops and hot A through H (Kind4 is not D)',async()=>{
  const tables=masterTables();
  tables[4]={name:'djmdCue',columns:['ID','ContentID','Kind','InMsec','OutMsec','Comment','ActiveLoop','BeatLoopSize','Color','ColorTableIndex','rb_local_deleted'],rows:[
    ['1','42',0,1500,-1,'Memory',0,0,255,0,0],
    ['2','42',1,16000,-1,'A',0,0,-1,21,0],
    ['3','42',3,32000,-1,'C',0,0,-1,21,0],
    ['4','42',4,48000,52000,'Active memory',1,0,255,0,0],
    ['5','42',5,64000,-1,'D',0,0,-1,21,0],
    ['6','42',9,128000,132000,'H loop',0,0,-1,21,0],
    ['7','42',1,10000,-1,'Deleted old A',0,0,-1,21,1],
    ['8','42',10,150000,-1,'I (unsupported)',0,0,-1,21,0],
    ['9','42',0,170000,-1,'Unresolved beat loop',1,262145,255,0,0],
  ]};
  const result=await parseRekordboxDatabase(image(tables));const track=result.tracks[0];
  assert.deepEqual(track.hotcues,[16,null,32,64,null,null,null,128]);assert.equal(track.cue,1.5);
  const active=track.positionMarks.find(mark=>mark.name==='[active] Active memory');assert.deepEqual(active,{name:'[active] Active memory',type:4,start:48,end:52,num:-1,color:null});
  assert.equal(track.positionMarks.find(mark=>mark.num===7).end,132);
  assert.equal(track.positionMarks.length,6);assert.match(result.warnings.join(' '),/I以降/);assert.match(result.warnings.join(' '),/終了位置/);assert.match(result.warnings.join(' '),/CUE色/);
  tables[4].rows.push(['10','42',1,12000,-1,'Conflicting live A',0,0,-1,21,0]);
  await assert.rejects(()=>parseRekordboxDatabase(image(tables)),/重複/);
});

test('master tombstones are omitted and fractional endpoint in the final metadata second is preserved',async()=>{
  const tables=masterTables();
  tables[0].columns.push('rb_local_deleted');tables[0].rows[0].push(0);
  tables[0].rows.push(['deleted','Deleted','7',120,12000,'/Music/Deleted.wav',1,null,1]);
  tables[2].columns.push('rb_local_deleted');for(const row of tables[2].rows)row.push(0);
  tables[2].rows.push(['gone','Deleted list',0,'root',1,1]);
  tables[3].columns.push('rb_local_deleted');tables[3].rows[0].push(0);tables[3].rows.push(['gone','gone','deleted',1,1]);
  tables[4].columns.push('OutMsec');tables[4].rows[0].push(180500);
  const result=await parseRekordboxDatabase(image(tables));assert.equal(result.tracks.length,1);assert.equal(result.playlists.length,1);assert.equal(result.tracks[0].positionMarks[0].end,180.5);assert.equal(result.tracks[0].duration,180.501);
});
