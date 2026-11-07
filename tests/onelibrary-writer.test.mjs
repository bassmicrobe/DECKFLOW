import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {spawnSync} from 'node:child_process';
import {pbkdf2Sync,createDecipheriv,createHmac} from 'node:crypto';
import {initOneLibraryWriter,inspectOneLibrary,updateOneLibrary} from '../dist/onelibrary-writer.js';
import {decrypt,encrypt,DEFAULT_KEY} from '../dist/vendor/onelibrary/sqlcipher.js';

const SQL=await initOneLibraryWriter({wasmBytes:await readFile(new URL('../dist/vendor/sqlite-writer/sql-wasm.wasm',import.meta.url))});
const track=(title='QA 原曲')=>({title,artist:'QA Artist',album:'QA Album',genre:'House',key:'Am',label:'QA Label',composer:'QA Composer',remixer:'QA Remixer',
  originalArtist:'QA Original',duration:120,bpm:123.45,size:12000000,sampleRate:44100,bitRate:1411,bitDepth:16,dateAdded:'2021-03-04',dateCreated:'2020-02-03',
  comments:'QA retained comment',rating:4,playCount:17,positionMarks:[{num:-1,start:1,name:'memory'},{num:0,start:2,name:'A'},{num:3,start:4,end:8,type:4,name:'D loop'},{num:7,start:9,name:'H'}]});
const entry=(id,title='QA 原曲')=>({contentId:id,track:track(title),usbPath:`/Contents/QA-${id}.wav`,analysisPath:`/PIONEER/USBANLZ/P${id}/ANLZ0000.DAT`});
async function database(bytes) {return new SQL.Database(await decrypt(bytes));}
const values=(db,sql)=>db.exec(sql).map(result=>result.values).flat();
const one=(db,sql)=>values(db,sql)[0]?.[0];
async function modified(bytes,sql) {const db=await database(bytes);try{db.run(sql);return encrypt(db.export());}finally{db.close();}}
const base=await updateOneLibrary(null,{deviceName:'QA USB',addTracks:[entry(7),entry(10,'QA other')],addPlaylists:[
  {playlistId:100,name:'QA folder',attribute:1},{playlistId:101,name:'QA existing',parentId:100,trackIds:[10,7]}]});
const enriched=await modified(base,`
  ALTER TABLE content ADD COLUMN futureInteger INTEGER;
  ALTER TABLE cue ADD COLUMN futureBlob BLOB;
  ALTER TABLE cue ADD COLUMN inMpegFutureBlob BLOB;
  CREATE TABLE future_data(id INTEGER PRIMARY KEY,payload BLOB,huge INTEGER);
  INSERT INTO future_data VALUES(9223372036854775806,zeroblob(25000),9223372036854775805);
  CREATE INDEX future_index ON future_data(huge);
  CREATE VIEW future_view AS SELECT payload,huge FROM future_data;
  UPDATE content SET futureInteger=9223372036854775804 WHERE content_id=7;
  UPDATE cue SET cue_id=9007199254740997 WHERE content_id=7 AND kind=1;
  UPDATE cue SET colorTableIndex=37,futureBlob=X'00AAFF',inMpegFutureBlob=X'CAFE',inMpegFrameNumber=777,inFileOffsetInBlock=888 WHERE content_id=7;
  INSERT INTO cue(content_id,kind,inUsec,outUsec,cueComment,futureBlob) VALUES(7,42,5,6,'future kind',X'CAFEBABE');
  INSERT INTO hotCueBankList VALUES(1,1,'QA bank',NULL,0,0);
  INSERT INTO hotCueBankList_cue VALUES(1,9007199254740997,1);
  UPDATE content SET cueUpdateCount=41 WHERE content_id=7;
`);
const protectedQueries=[
  'SELECT CAST(id AS TEXT),hex(payload),CAST(huge AS TEXT) FROM future_data',
  'SELECT CAST(futureInteger AS TEXT) FROM content WHERE content_id=7',
  'SELECT * FROM playlist WHERE playlist_id IN(100,101) ORDER BY playlist_id',
  'SELECT * FROM playlist_content ORDER BY playlist_id,sequenceNo',
  'SELECT hex(futureBlob),cueComment,kind,inUsec,outUsec FROM cue WHERE content_id=7 AND kind IN(0,42) ORDER BY kind',
  'SELECT * FROM cue WHERE content_id=10 ORDER BY kind',
  'SELECT CAST(cue_id AS TEXT),hotCueBankList_id,sequenceNo FROM hotCueBankList_cue',
  "SELECT type,name,sql FROM sqlite_schema WHERE name LIKE 'future_%' ORDER BY name",
];

// Independent Node/OpenSSL implementation, separate from the WebCrypto codec.
function decryptNative(bytes) {
  const data=Buffer.from(bytes),salt=data.subarray(0,16),aes=pbkdf2Sync(DEFAULT_KEY,salt,256000,32,'sha512');
  const mac=pbkdf2Sync(aes,Buffer.from(salt.map(value=>value^0x3a)),2,32,'sha512'),out=Buffer.alloc(data.length);
  out.write('SQLite format 3\0');
  for(let page=0;page<data.length/4096;page++) {
    const start=page*4096,body=start+(page===0?16:0),end=start+4016,iv=data.subarray(end,end+16),ct=data.subarray(body,end);
    const number=Buffer.alloc(4);number.writeUInt32LE(page+1);
    assert.deepEqual(createHmac('sha512',mac).update(ct).update(iv).update(number).digest(),data.subarray(end+16,start+4096));
    const cipher=createDecipheriv('aes-256-cbc',aes,iv);cipher.setAutoPadding(false);
    Buffer.concat([cipher.update(ct),cipher.final()]).copy(out,body);
  }
  return out;
}

test('new OneLibrary uses native SQLite geometry, independently authenticated SQLCipher, full metadata and all initial cue slots',async()=>{
  const plain=decryptNative(base);assert.equal(plain[20],80);assert.equal(plain.readUInt16BE(16),4096);
  const checked=spawnSync('python3',['-c',`import sys,sqlite3,tempfile,pathlib
with tempfile.TemporaryDirectory() as folder:
 p=pathlib.Path(folder)/'qa.db';p.write_bytes(sys.stdin.buffer.read());db=sqlite3.connect(p)
 assert db.execute('PRAGMA integrity_check').fetchone()[0]=='ok'
 assert db.execute('SELECT COUNT(*) FROM content').fetchone()[0]==2
 assert db.execute('SELECT COUNT(*) FROM menuItem').fetchone()[0]==27
 print('native SQLite ok')`],{input:plain,encoding:'utf8'});
  assert.equal(checked.status,0,checked.stderr);assert.match(checked.stdout,/native SQLite ok/);
  const result=await inspectOneLibrary(base),first=result.tracks[0];
  assert.equal(first.contentId,7);assert.equal(first.path,'/Contents/QA-7.wav');assert.equal(first.bpm,123.45);
  assert.equal(first.remixer,'QA Remixer');assert.equal(first.composer,'QA Composer');assert.equal(first.originalArtist,'QA Original');
  assert.equal(first.dateAdded,'2021-03-04');assert.equal(first.dateCreated,'2020-02-03');assert.equal(first.bitRate,1411);assert.equal(first.comments,'QA retained comment');
  assert.deepEqual(result.cues.filter(cue=>cue.contentId===7).map(cue=>cue.kind),[0,1,4,8]);
  assert.deepEqual(result.playlists.find(list=>list.playlistId===101).trackIds,[10,7]);assert.equal(result.maxIds.track,10);assert.equal(result.maxIds.playlist,101);
});

test('targeted HOT update preserves unknown rows, 64-bit IDs, memory cues, bank links and untouched seek data',async()=>{
  const before=await database(enriched);
  const expected=protectedQueries.map(sql=>values(before,sql));
  const hBefore=values(before,'SELECT * FROM cue WHERE content_id=7 AND kind=8');before.close();
  const output=await updateOneLibrary(enriched,{hotCueUpdates:[{contentId:7,marks:[
    {num:0,start:3,name:'moved A'},{num:3,start:4,end:8,type:4,name:'D loop'},{num:7,start:9,name:'H'}]}]});
  const after=await database(output);
  try{
    protectedQueries.forEach((sql,index)=>assert.deepEqual(values(after,sql),expected[index],sql));
    assert.deepEqual(values(after,'SELECT * FROM cue WHERE content_id=7 AND kind=8'),hBefore);
    assert.deepEqual(values(after,'SELECT CAST(cue_id AS TEXT),inUsec,outUsec,in150FramePerSec,inMpegFrameNumber,inFileOffsetInBlock,colorTableIndex,hex(futureBlob) FROM cue WHERE content_id=7 AND kind=1'),
      [['9007199254740997',3000000,3000000,450,null,null,37,'00AAFF']]);
    assert.equal(one(after,'SELECT cueUpdateCount FROM content WHERE content_id=7'),42);
    assert.equal(one(after,'SELECT hex(inMpegFutureBlob) FROM cue WHERE content_id=7 AND kind=1'),'CAFE');
  }finally{after.close();}
});

test('unchanged HOT set leaves counter and every original cue value unchanged',async()=>{
  const original=await database(enriched),expected=values(original,'SELECT CAST(cue_id AS TEXT),* FROM cue ORDER BY cue_id');original.close();
  const output=await updateOneLibrary(enriched,{hotCueUpdates:[{contentId:7,marks:track().positionMarks.filter(mark=>mark.num>=0)}]});
  const db=await database(output);try{assert.deepEqual(values(db,'SELECT CAST(cue_id AS TEXT),* FROM cue ORDER BY cue_id'),expected);assert.equal(one(db,'SELECT cueUpdateCount FROM content WHERE content_id=7'),41);}finally{db.close();}
});

test('append adds tracks and playlists without rebuilding old tables, memberships or schema',async()=>{
  const output=await updateOneLibrary(enriched,{addTracks:[entry(500,'QA addition')],addPlaylists:[
    {playlistId:601,name:'QA nested',parentId:600,trackIds:[500,7]},{playlistId:600,name:'QA new folder',attribute:1}],appendPlaylistTracks:[{playlistId:101,trackIds:[7,500]}]});
  const db=await database(output),old=await database(enriched);
  try{
    for(const sql of protectedQueries.filter(sql=>!sql.includes('FROM playlist_content'))) assert.deepEqual(values(db,sql),values(old,sql),sql);
    assert.deepEqual(values(db,'SELECT content_id,sequenceNo FROM playlist_content WHERE playlist_id=101 ORDER BY sequenceNo'),[[10,1],[7,2],[500,3]]);
    assert.equal(one(db,'SELECT numberOfContents FROM property'),3);assert.equal(one(db,'SELECT COUNT(*) FROM artist'),4);
    assert.equal(one(db,'SELECT COUNT(*) FROM content'),3);assert.equal(db.export()[20],80);
  }finally{db.close();old.close();}
  assert.deepEqual((await inspectOneLibrary(output)).playlists.find(list=>list.playlistId===601).trackIds,[500,7]);
});

test('removing an unreferenced HOT retains memory and unknown kinds; referenced bank cue deletion rejects',async()=>{
  const output=await updateOneLibrary(enriched,{hotCueUpdates:[{contentId:7,marks:track().positionMarks.filter(mark=>mark.num>=0&&mark.num!==7)}]});
  const db=await database(output);try{assert.deepEqual(values(db,'SELECT kind FROM cue WHERE content_id=7 ORDER BY kind'),[[0],[1],[4],[42]]);}finally{db.close();}
  await assert.rejects(updateOneLibrary(enriched,{hotCueUpdates:[{contentId:7,marks:[]}]}),/参照するCUE/);
});

test('reserve survives many new SQLite pages and original caller bytes are immutable',async()=>{
  const before=enriched.slice();
  const additions=Array.from({length:60},(_,index)=>entry(index+1000,'QA growth '+index+'界'.repeat(300)));
  const output=await updateOneLibrary(enriched,{addTracks:additions});
  assert.deepEqual(enriched,before);assert.ok(output.length>enriched.length);
  const plain=decryptNative(output);assert.equal(plain[20],80);
  const db=new SQL.Database(plain);try{assert.equal(one(db,'PRAGMA integrity_check'),'ok');assert.equal(one(db,'SELECT COUNT(*) FROM content'),62);}finally{db.close();}
});

test('damaged authentication, unsafe paths, collisions and unsupported schemas reject without modifying input',async()=>{
  const tampered=enriched.slice();tampered[4096+90]^=1;await assert.rejects(updateOneLibrary(tampered,{}),/authentication/);
  await assert.rejects(updateOneLibrary(enriched,{addTracks:[entry(7)]}),/パス|ID/);
  await assert.rejects(updateOneLibrary(enriched,{addTracks:[{...entry(60),usbPath:'/Contents/../escape.wav'}]}),/パス/);
  const missing=await modified(base,'ALTER TABLE cue RENAME COLUMN inUsec TO unknownTime');
  await assert.rejects(updateOneLibrary(missing,{hotCueUpdates:[{contentId:7,marks:[]}]}),/テーブル構造/);
  const unusual=await modified(base,'CREATE TRIGGER user_trigger AFTER INSERT ON content BEGIN DELETE FROM playlist; END;');
  await assert.rejects(updateOneLibrary(unusual,{addTracks:[entry(60)]}),/トリガー/);
  const plain=await decrypt(base);plain[20]=0;await assert.rejects(updateOneLibrary(plain,{}),/予約領域/);
});

test('abort during mutation returns no database and original stays valid',async()=>{
  const controller=new AbortController();
  await assert.rejects(updateOneLibrary(enriched,{signal:controller.signal,addTracks:[entry(60),entry(61)],onProgress(event){if(event.phase==='tracks')controller.abort();}}),{name:'AbortError'});
  assert.equal((await inspectOneLibrary(enriched)).tracks.length,2);
});

test('new memory loops retain active versus saved state and explicit native cue colors',async()=>{
  const added=entry(60);added.track.positionMarks=[{num:-1,start:10,end:14,type:4,name:'saved'},
    {num:-1,start:20,end:24,type:4,name:'[active] active loop'},{num:7,start:30,name:'H',colorTableIndex:51}];
  const bytes=await updateOneLibrary(base,{addTracks:[added]});
  const db=await database(bytes);try{
    assert.deepEqual(values(db,'SELECT kind,isActiveLoop,cueComment,colorTableIndex FROM cue WHERE content_id=60 ORDER BY inUsec'),[[0,0,'saved',0],[0,1,'active loop',0],[8,0,'H',51]]);
  }finally{db.close();}
});
