import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {createHash} from 'node:crypto';
import {initWriter,planLibrary,createAnalysisMeter,inspectLibrary} from '../dist/vendor/browser-usb/writer.js';
import {openNativeUSB,importNativeUSB,writeNativeHotCues,exportNativeUSB} from '../dist/native-usb-library.js';
import {parseDeviceDatabase,parseDeviceAnalysis,mergeDeviceAnalysis} from '../dist/rekordbox-device.js';
import {initOneLibraryWriter,inspectOneLibrary,updateOneLibrary} from '../dist/onelibrary-writer.js';
import {decrypt,encrypt} from '../dist/vendor/onelibrary/sqlcipher.js';
import {parseRekordboxDatabase} from '../dist/rekordbox-sqlite.js';
import {openLibrary} from '../dist/library-store.js';
import {inspectAnalysis,inspectPdb} from '../tools/usb-inspect.mjs';

await initWriter({wasmBytes:await readFile(new URL('../dist/vendor/browser-usb/writer.wasm',import.meta.url))});
// The production build versions module imports. Initialize that exact module
// instance too, without teaching the production browser code about Node paths.
const serviceUrl=new URL('../dist/native-usb-library.js',import.meta.url);
const serviceSource=await readFile(serviceUrl,'utf8');
const writerSpecifier=serviceSource.match(/from ['"]([^'"]+vendor\/browser-usb\/writer\.js[^'"]*)['"]/)[1];
await (await import(new URL(writerSpecifier,serviceUrl).href)).initWriter({
  wasmBytes:await readFile(new URL('../dist/vendor/browser-usb/writer.wasm',import.meta.url)),
});
await initOneLibraryWriter({wasmBytes:await readFile(new URL('../dist/vendor/sqlite-writer/sql-wasm.wasm',import.meta.url))});
const oneSpecifier=serviceSource.match(/from ['"]([^'"]+onelibrary-writer\.js[^'"]*)['"]/)[1];
await (await import(new URL(oneSpecifier,serviceUrl).href)).initOneLibraryWriter({wasmBytes:await readFile(new URL('../dist/vendor/sqlite-writer/sql-wasm.wasm',import.meta.url))});
const digest=bytes=>createHash('sha256').update(bytes).digest('hex');
const path=value=>value.replace(/^\/+/, '');
function wav() {
  const rate=44100,frames=rate*2,bytes=new Uint8Array(44+frames*4),view=new DataView(bytes.buffer);
  const tag=(at,value)=>bytes.set(new TextEncoder().encode(value),at);
  tag(0,'RIFF');view.setUint32(4,bytes.length-8,true);tag(8,'WAVEfmt ');view.setUint32(16,16,true);
  view.setUint16(20,1,true);view.setUint16(22,2,true);view.setUint32(24,rate,true);view.setUint32(28,rate*4,true);
  view.setUint16(32,4,true);view.setUint16(34,16,true);tag(36,'data');view.setUint32(40,frames*4,true);
  for(let i=0;i<frames;i++){view.setInt16(44+i*4,8192,true);view.setInt16(46+i*4,-4096,true);}return bytes;
}
const makeTrack=()=>({id:'track1',filename:'Song.wav',title:'Original song',artist:'Artist',bpm:120,duration:2,
  beatOffset:0,cue:0,hotcues:[.5,null,null,null,null,null,null,1.5],size:wav().length,sampleRate:44100,bitRate:1411,bitDepth:16,
  positionMarks:[{name:'Memory',type:0,start:.25,end:null,num:-1,color:null},{name:'A',type:0,start:.5,end:null,num:0,color:[230,40,40]},
    {name:'H',type:0,start:1.5,end:null,num:7,color:null}]});
function unknownSection(bytes) {
  const result=new Uint8Array(bytes.length+20);result.set(bytes);const view=new DataView(result.buffer);
  const at=bytes.length;result.set(new TextEncoder().encode('ZZZZ'),at);view.setUint32(at+4,12);view.setUint32(at+8,20);
  result.set([3,7,11,17,23,31,47,71],at+12);view.setUint32(8,result.length);return result;
}
class FakeBridge {
  available=true;root={id:'native-root',name:'Test USB',pendingTransactions:0};files=new Map();commits=0;batches=[];
  async chooseDirectory(){return {...this.root};}
  async restoreDirectory(id){assert.equal(id,this.root.id);return {...this.root};}
  async list(){return [...this.files].map(([path,bytes])=>({path,name:path.split('/').at(-1),kind:'file',size:bytes.length,modified:1}));}
  async stat(id,name){const bytes=this.files.get(path(name));return bytes?{exists:true,kind:'file',size:bytes.length,fingerprint:digest(bytes)}:{exists:false};}
  async readRange(id,name,{offset,length}){const bytes=this.files.get(path(name));if(!bytes)throw Error('Missing USB file');return bytes.slice(offset,offset+length);}
  async writeBatch(id,writes,{signal,guards=[],onProgress=()=>{}}={}) {
    this.batches.push({writes:writes.map(item=>({path:item.path,expectedFingerprint:item.expectedFingerprint})),guards:structuredClone(guards)});
    const staged=await Promise.all(writes.map(async item=>({...item,bytes:new Uint8Array(await item.blob.arrayBuffer())})));
    await this.beforeCommit?.();signal?.throwIfAborted();
    for(const item of [...guards,...writes]) {
      const bytes=this.files.get(path(item.path)),current=bytes?digest(bytes):null;
      if(current!==item.expectedFingerprint)throw Error('USB compare-and-swap conflict');
    }
    onProgress({phase:'committing'});for(const item of staged)this.files.set(path(item.path),item.bytes);this.commits++;
    onProgress({phase:'complete'});return {writtenFiles:writes.length};
  }
}
class MemoryLibrary {
  tracks=new Map();audio=new Map();sources=new Map();playlists=[];
  async getPlaylists(){return structuredClone(this.playlists);}
  async putPlaylists(lists){this.playlists=structuredClone(lists);}
  async getTracks(){return structuredClone([...this.tracks.values()]);}
  async getSources(){return structuredClone([...this.sources.values()]);}
  async getAudio(id){return this.audio.get(id);}
  async putSource(source){this.sources.set(source.id,structuredClone(source));}
  async putTrack(track,audio){this.tracks.set(track.id,structuredClone(track));if(audio!==undefined)this.audio.set(track.id,new Blob([await audio.arrayBuffer()],{type:audio.type}));}
  async importTracks(tracks,playlists,source){this.playlists=[...new Map([...this.playlists,...playlists].map(list=>[list.id,list])).values()];for(const track of tracks)if(!this.tracks.has(track.id))this.tracks.set(track.id,structuredClone(track));await this.putSource(source);return {added:tracks.length,updated:0};}
}
const reader={async read(operation,data){
  if(operation==='database')return data.kind==='sqlite'?parseRekordboxDatabase(data.bytes,{sourceId:data.sourceId,kind:data.databaseKind}):parseDeviceDatabase(data.bytes,{sourceId:data.sourceId});
  if(operation==='analysis')return mergeDeviceAnalysis(data.track,data.files.map(parseDeviceAnalysis),{preserveCues:data.preserveCues});
  throw Error('Unexpected reader operation');
}};
async function fixture() {
  const track=makeTrack(),plan=await planLibrary({tracks:[track],playlists:[{id:'p',name:'Set',trackIds:[track.id]}]});
  const meter=await createAnalysisMeter({sampleRate:44100,channels:2});meter.push(new Float32Array(44100*4).fill(.2));
  const files=meter.finish(track,plan.tracks[0]),bridge=new FakeBridge();
  bridge.files.set('PIONEER/rekordbox/export.pdb',plan.pdb);
  bridge.files.set(path(plan.tracks[0].usbPath),wav());
  for(const [key,bytes]of Object.entries(files))bridge.files.set(path(plan.tracks[0].anlzPaths[key]),unknownSection(bytes));
  bridge.files.set('unrelated/notes.txt',new TextEncoder().encode('Keep this file'));
  const library=new MemoryLibrary(),session=await openNativeUSB({bridge});
  const imported=await importNativeUSB({library,session,reader,sources:[]});
  return {bridge,library,session,imported,plan,track:(await library.getTracks())[0]};
}
function edited(track){const result=structuredClone(track);result.hotcues[0]=.75;result.positionMarks=result.positionMarks.map(mark=>mark.num===0?{...mark,start:.75,name:'Edited A'}:mark);return result;}

test('USB import → HOT CUE edit → direct write preserves PDB, audio, waveforms, grid and unknown sections',async()=>{
  const {bridge,library,imported,plan,track}=await fixture();
  assert.equal(imported.copied,1);assert.equal(track.audioMissing,false);assert.ok(track.peaks.length);
  const before=new Map([...bridge.files].map(([name,bytes])=>[name,bytes.slice()]));
  const result=await writeNativeHotCues({bridge,library,source:imported.source,tracks:[edited(track)]});
  assert.equal(result.updatedTracks,1);assert.equal(result.updatedFiles,3);assert.equal(bridge.commits,1);
  const changed=new Set(['dat','ext'].map(key=>path(plan.tracks[0].anlzPaths[key])));
  for(const [name,bytes]of before)if(!changed.has(name))assert.deepEqual(bridge.files.get(name),bytes,name);
  for(const name of changed){
    const original=inspectAnalysis(before.get(name)),next=inspectAnalysis(bridge.files.get(name));
    for(const [tag,hashes]of Object.entries(original.sectionHashes))if(!['PCOB','PCO2'].includes(tag))assert.deepEqual(next.sectionHashes[tag],hashes,tag);
    assert.ok(next.cues.some(cue=>cue.number===1&&cue.time===.75)||next.detailedCues.some(cue=>cue.number===1&&cue.time===.75));
  }
  const saved=(await library.getSources())[0];
  assert.equal((await writeNativeHotCues({bridge,library,source:saved,tracks:[edited(track)]})).updatedFiles,0);
});

test('refresh uses USB cue baselines while preserving locally edited track metadata',async()=>{
  const {bridge,library,track}=await fixture();const local=edited(track);local.title='Local title';await library.putTrack(local);
  const source=(await library.getSources())[0],session=await openNativeUSB({bridge});
  const imported=await importNativeUSB({library,session,reader,sources:[source]});
  const stored=(await library.getTracks())[0];assert.equal(stored.title,'Local title');assert.equal(stored.hotcues[0],.75);
  assert.equal(imported.reused,1);
  assert.equal((await writeNativeHotCues({bridge,library,source:imported.source,tracks:[stored]})).updatedTracks,1);
});

test('changed databases/analysis, pending recovery, OneLibrary and cancellation never silently overwrite USB',async()=>{
  for(const scenario of ['database','analysis','one','hidden-one','recovery','cancel','race']) {
    const {bridge,library,imported,track,plan}=await fixture();const controller=new AbortController();
    if(scenario==='database')bridge.files.get('PIONEER/rekordbox/export.pdb')[32]^=1;
    if(scenario==='analysis')bridge.files.get(path(plan.tracks[0].anlzPaths.dat))[31]^=1;
    if(scenario==='one')bridge.files.set('PIONEER/rekordbox/exportLibrary.db',Uint8Array.of(1));
    if(scenario==='hidden-one')bridge.files.set('.PIONEER/rekordbox/exportLibrary.db',Uint8Array.of(1));
    if(scenario==='recovery')bridge.root.pendingTransactions=1;
    if(scenario==='cancel')controller.abort();
    if(scenario==='race')bridge.beforeCommit=async()=>{bridge.files.get('PIONEER/rekordbox/export.pdb')[33]^=1;};
    const expected={database:/変更/,analysis:/変更/,one:/変更/,'hidden-one':/変更/,recovery:/復旧/,cancel:{name:'AbortError'},race:/compare-and-swap/}[scenario];
    await assert.rejects(writeNativeHotCues({bridge,library,source:imported.source,tracks:[edited(track)],signal:controller.signal}),expected);
    assert.equal(bridge.commits,0,scenario);
  }
});

test('new WAV export writes both device libraries and repeated export does not duplicate tracks',async()=>{
  const previous=globalThis.OfflineAudioContext;
  globalThis.OfflineAudioContext=class {constructor(channels,length,rate){this.channels=channels;this.rate=rate;}
    async decodeAudioData(buffer){const view=new DataView(buffer),frames=(buffer.byteLength-44)/4;
      const data=Array.from({length:this.channels},(_,channel)=>Float32Array.from({length:frames},(_,i)=>view.getInt16(44+i*4+channel*2,true)/32768));
      return {length:frames,duration:frames/this.rate,sampleRate:this.rate,numberOfChannels:this.channels,getChannelData:i=>data[i]};}};
  try {
    const bridge=new FakeBridge(),library=new MemoryLibrary(),track=makeTrack(),audio=new Blob([wav()]);
    await library.putTrack(track,audio);const session=await openNativeUSB({bridge});
    const result=await exportNativeUSB({library,session,tracks:[track],playlists:[{id:'p',name:'Set',trackIds:[track.id]}]});
    assert.equal(result.exportedTracks,1);assert.equal(result.writtenFiles,6);assert.equal(bridge.commits,1);
    const pdb=inspectPdb(bridge.files.get('PIONEER/rekordbox/export.pdb'));
    assert.equal(pdb.tracks[0].bitRate,1411);assert.equal(pdb.tracks[0].sampleRate,44100);
    assert.equal(digest(bridge.files.get(path(pdb.tracks[0].path))),digest(wav()));
    assert.ok(inspectAnalysis(bridge.files.get(path(pdb.tracks[0].analysisPath))).beats.length);
    const repeated=await exportNativeUSB({library,session,tracks:[track]});assert.equal(repeated.exportedTracks,0);assert.equal(repeated.writtenFiles,0);
    assert.equal((await inspectOneLibrary(bridge.files.get('PIONEER/rekordbox/exportLibrary.db'))).tracks.length,1);
    assert.equal(bridge.commits,1);
  } finally {if(previous===undefined)delete globalThis.OfflineAudioContext;else globalThis.OfflineAudioContext=previous;}
});

const PDB='PIONEER/rekordbox/export.pdb',ONE='PIONEER/rekordbox/exportLibrary.db';
async function withWavDecoder(run) {
  const previous=globalThis.OfflineAudioContext;
  globalThis.OfflineAudioContext=class {
    constructor(channels,length,rate){this.channels=channels;this.rate=rate;}
    async decodeAudioData(buffer){const input=new DataView(buffer),frames=(buffer.byteLength-44)/4;
      const data=Array.from({length:this.channels},(_,channel)=>Float32Array.from({length:frames},(_,i)=>input.getInt16(44+i*4+channel*2,true)/32768));
      return {length:frames,duration:frames/this.rate,sampleRate:this.rate,numberOfChannels:this.channels,getChannelData:i=>data[i]};}
  };
  try{return await run();}finally{if(previous===undefined)delete globalThis.OfflineAudioContext;else globalThis.OfflineAudioContext=previous;}
}
async function actualLibrary() {
  assert.equal(globalThis.indexedDB,undefined,'These tests intentionally exercise the production memory fallback');
  const store=await openLibrary();assert.equal(store.persistent,false);return store;
}
const sqlRows=(db,query)=>db.exec(query).flatMap(result=>result.values);
async function sqlDatabase(bytes){const SQL=await initOneLibraryWriter();return new SQL.Database(await decrypt(bytes));}

let preparedFixture;
async function bothFormatFixture() {
  if(!preparedFixture)preparedFixture=(async()=>{
    const tracks=Array.from({length:3},(_,i)=>({...makeTrack(),id:`original-${i}`,filename:`Original ${i}.wav`,title:`Original ${i}`}));
    const devicePlaylists=[
      {numericId:21,parentId:0,sortOrder:3,isFolder:true,name:'Folder',trackIds:[]},
      {numericId:22,parentId:21,sortOrder:2,isFolder:true,name:'Empty Folder',trackIds:[]},
      {numericId:23,parentId:21,sortOrder:5,isFolder:false,name:'Set',trackIds:[12,11,12]},
      {numericId:24,parentId:0,sortOrder:8,isFolder:false,name:'Other set',trackIds:[13]},
    ];
    const plan=await planLibrary({tracks:tracks.map((track,i)=>({...track,numericId:i+11})),includeAllPlaylist:false,devicePlaylists});
    const files=new Map([[PDB,plan.pdb]]);
    for(const [i,track] of tracks.entries()){
      const meter=await createAnalysisMeter({sampleRate:44100,channels:2});meter.push(new Float32Array(44100*4).fill(.2));
      const analysis=meter.finish(track,plan.tracks[i]);files.set(path(plan.tracks[i].usbPath),wav());
      for(const [key,bytes] of Object.entries(analysis))files.set(path(plan.tracks[i].anlzPaths[key]),unknownSection(bytes));
    }
    let one=await updateOneLibrary(null,{deviceName:'Fixture USB',
      addTracks:tracks.map((track,i)=>({contentId:91+i,track,usbPath:plan.tracks[i].usbPath,analysisPath:plan.tracks[i].anlzPaths.dat})),
      addPlaylists:devicePlaylists.map(list=>({playlistId:list.numericId+100,parentId:list.parentId?list.parentId+100:0,
        sequenceNo:list.sortOrder,attribute:list.isFolder?1:0,name:list.name,trackIds:list.trackIds.map(id=>id+80)}))});
    const db=await sqlDatabase(one);
    try{
      db.run("ALTER TABLE content ADD COLUMN futureInteger INTEGER; ALTER TABLE cue ADD COLUMN futureBlob BLOB; CREATE TABLE future_data(id INTEGER PRIMARY KEY,payload BLOB,huge INTEGER)");
      db.run("INSERT INTO future_data VALUES(9223372036854775806,X'CAFE1122',9223372036854775805)");
      db.run("UPDATE content SET futureInteger=9223372036854775804 WHERE content_id=91");
      db.run("UPDATE cue SET futureBlob=X'00AAFF' WHERE content_id=91");
      db.run("INSERT INTO cue(content_id,kind,inUsec,outUsec,cueComment,futureBlob) VALUES(91,42,5,6,'future cue',X'BEEF')");
      one=await encrypt(db.export());
    }finally{db.close();}
    files.set(ONE,one);files.set('unrelated/notes.txt',new TextEncoder().encode('Keep unrelated bytes'));
    return {files,plan,devicePlaylists};
  })();
  return preparedFixture;
}
async function realFixture(mode='both') {
  const raw=await bothFormatFixture(),bridge=new FakeBridge();
  bridge.files=new Map([...raw.files].map(([name,bytes])=>[name,bytes.slice()]));
  if(mode==='pdb')bridge.files.delete(ONE);if(mode==='one')bridge.files.delete(PDB);
  const library=await actualLibrary(),session=await openNativeUSB({bridge});
  const imported=await importNativeUSB({library,session,reader,sources:[]});
  return {bridge,library,session,imported,plan:raw.plan};
}
function protectedSql(){return [
  'SELECT CAST(id AS TEXT),hex(payload),CAST(huge AS TEXT) FROM future_data',
  'SELECT CAST(futureInteger AS TEXT) FROM content WHERE content_id=91',
  'SELECT kind,inUsec,outUsec,cueComment,hex(futureBlob) FROM cue WHERE content_id=91 AND kind IN(0,42) ORDER BY kind',
  'SELECT * FROM cue WHERE content_id IN(92,93) ORDER BY cue_id',
];}
function snapshotFiles(bridge){return new Map([...bridge.files].map(([name,bytes])=>[name,bytes.slice()]));}

test('existing dual libraries with different IDs append selected audio without losing old rows, memberships or cached local aliases',async()=>withWavDecoder(async()=>{
  const {bridge,library,session,imported}=await realFixture();
  const original=snapshotFiles(bridge),beforePdb=await inspectLibrary(original.get(PDB));
  const dbBefore=await sqlDatabase(original.get(ONE)),protectedBefore=protectedSql().map(query=>sqlRows(dbBefore,query));dbBefore.close();
  const next={...makeTrack(),id:'fcb3a2b1-0000-4000-8000-000000000001',title:'Selected new',filename:'Song.wav'};
  const omitted={...makeTrack(),id:'fcb3a2b1-0000-4000-8000-000000000002',title:'Not selected',filename:'Song.wav'};
  await library.putTrack(next,new Blob([wav()]));await library.putTrack(omitted,new Blob([wav()]));
  const lists=await library.getPlaylists(),set=lists.find(list=>list.name==='Set');
  await library.putPlaylists(lists.map(list=>list.id===set.id?{...list,trackIds:[...list.trackIds,next.id,omitted.id]}:list));
  const result=await exportNativeUSB({library,session,tracks:[next],playlists:[{...set,trackIds:[next.id]}]});
  assert.equal(result.exportedTracks,1);assert.equal(bridge.commits,1);
  for(const [name,bytes]of original)if(![PDB,ONE].includes(name))assert.deepEqual(bridge.files.get(name),bytes,name);
  const pdb=await inspectLibrary(bridge.files.get(PDB)),one=await inspectOneLibrary(bridge.files.get(ONE));
  assert.deepEqual(pdb.existingTracks.slice(0,3),beforePdb.existingTracks);assert.equal(pdb.existingTracks.length,4);assert.equal(one.tracks.length,4);
  const addedP=pdb.existingTracks.find(track=>track.title==='Selected new'),addedO=one.tracks.find(track=>track.title==='Selected new');
  assert.equal(addedP.numericId,94);assert.equal(addedO.contentId,94);
  assert.deepEqual(pdb.playlistMappings.find(list=>list.numericId===23).trackIds,[12,11,12,94]);
  assert.deepEqual(one.playlists.find(list=>list.playlistId===123).trackIds,[92,91,92,94]);
  assert.deepEqual(pdb.playlistMappings.find(list=>list.numericId===24).trackIds,[13]);
  assert.deepEqual(one.playlists.find(list=>list.playlistId===124).trackIds,[93]);
  const dbAfter=await sqlDatabase(bridge.files.get(ONE));try{protectedSql().forEach((query,i)=>assert.deepEqual(sqlRows(dbAfter,query),protectedBefore[i],query));}finally{dbAfter.close();}
  const repeated=await exportNativeUSB({library,session,tracks:[next],playlists:[{...set,trackIds:[next.id]}]});
  assert.equal(repeated.writtenFiles,0);assert.equal(bridge.commits,1);
  const sources=await library.getSources(),freshSession=await openNativeUSB({bridge});
  const refresh=await importNativeUSB({library,session:freshSession,reader,sources});
  assert.equal((await library.getTracks()).length,5,'reimport must reuse exported UUID instead of adding a USB-derived duplicate');
  assert.equal(refresh.source.nativeUSB.tracks[next.id].pdbId,94);
  assert.equal(refresh.source.nativeUSB.tracks[next.id].oneLibraryId,94);
  assert.equal((await library.getTracks()).filter(track=>track.title==='Selected new').length,1);
  const storedSet=(await library.getPlaylists()).find(list=>list.id===set.id);assert.ok(storedSet.trackIds.includes(omitted.id),'local untransferred member survives refresh');
  const refreshedTrack=(await library.getTracks()).find(t=>t.id===next.id);
  assert.equal((await exportNativeUSB({library,session:freshSession,tracks:[refreshedTrack]})).writtenFiles,0,
    JSON.stringify({baseline:refresh.source.nativeUSB.baselines[next.id].signature,marks:refreshedTrack.positionMarks,hotcues:refreshedTrack.hotcues}));
}));

test('each missing device format is mirrored with original paths, duplicate membership, empty folders and no audio/ANLZ rewrite',async()=>{
  for(const mode of ['pdb','one']){
    const {bridge,library,imported}=await realFixture(mode),before=snapshotFiles(bridge),tracks=await library.getTracks();
    const result=await writeNativeHotCues({bridge,library,source:imported.source,tracks});
    assert.equal(result.updatedTracks,0);assert.equal(result.updatedFiles,1,mode);
    for(const [name,bytes] of before)assert.deepEqual(bridge.files.get(name),bytes,`${mode}: ${name}`);
    const pdb=await inspectLibrary(bridge.files.get(PDB)),one=await inspectOneLibrary(bridge.files.get(ONE));
    assert.equal(pdb.existingTracks.length,3);assert.equal(one.tracks.length,3);
    for(const track of pdb.existingTracks){const peer=one.tracks.find(row=>row.path===track.usbPath);assert.ok(peer);assert.equal(peer.analysisPath,track.analysisPath);}
    const pSet=pdb.playlistMappings.find(list=>list.name==='Set'),oSet=one.playlists.find(list=>list.name==='Set');
    assert.equal(pSet.trackIds.length,3);assert.equal(oSet.trackIds.length,3);
    const pPaths=pSet.trackIds.map(id=>pdb.existingTracks.find(track=>track.numericId===id).usbPath);
    const oPaths=oSet.trackIds.map(id=>one.tracks.find(track=>track.contentId===id).path);
    assert.deepEqual(pPaths,oPaths);assert.equal(pPaths[0],pPaths[2]);
    assert.ok(pdb.playlistMappings.some(list=>list.name==='Empty Folder'&&list.isFolder));
    assert.ok(one.playlists.some(list=>list.name==='Empty Folder'&&list.attribute===1));
    assert.equal(bridge.batches[0].writes.length,1);assert.equal(bridge.batches[0].writes[0].path,mode==='pdb'?ONE:PDB);
  }
});

test('HOT CUE edits map differing format IDs by path and preserve SQL memory/unknown rows plus all non-CUE ANLZ sections',async()=>{
  const {bridge,library,imported,plan}=await realFixture(),before=snapshotFiles(bridge);
  const track=(await library.getTracks()).find(t=>t.title==='Original 0');assert.equal(imported.source.nativeUSB.tracks[track.id].pdbId,11);
  assert.equal(imported.source.nativeUSB.tracks[track.id].oneLibraryId,91);
  const sqlBefore=await sqlDatabase(before.get(ONE)),protectedBefore=protectedSql().map(query=>sqlRows(sqlBefore,query));
  const untouchedH=sqlRows(sqlBefore,'SELECT * FROM cue WHERE content_id=91 AND kind=8');sqlBefore.close();
  await writeNativeHotCues({bridge,library,source:imported.source,tracks:[edited(track)]});
  assert.deepEqual(bridge.files.get(PDB),before.get(PDB));
  const after=await sqlDatabase(bridge.files.get(ONE));
  try{
    assert.equal(sqlRows(after,'SELECT inUsec FROM cue WHERE content_id=91 AND kind=1')[0][0],750000);
    protectedSql().forEach((query,i)=>assert.deepEqual(sqlRows(after,query),protectedBefore[i],query));
    assert.deepEqual(sqlRows(after,'SELECT * FROM cue WHERE content_id=91 AND kind=8'),untouchedH);
  }finally{after.close();}
  const changed=new Set([ONE,path(plan.tracks[0].anlzPaths.dat),path(plan.tracks[0].anlzPaths.ext)]);
  for(const [name,bytes]of before)if(!changed.has(name))assert.deepEqual(bridge.files.get(name),bytes,name);
  for(const name of [path(plan.tracks[0].anlzPaths.dat),path(plan.tracks[0].anlzPaths.ext)]){
    const old=inspectAnalysis(before.get(name)),next=inspectAnalysis(bridge.files.get(name));
    for(const [tag,hashes]of Object.entries(old.sectionHashes))if(!['PCOB','PCO2'].includes(tag))assert.deepEqual(next.sectionHashes[tag],hashes);
    assert.deepEqual(next.cues.filter(cue=>cue.number===0),old.cues.filter(cue=>cue.number===0));
  }
});

test('union import immediately exposes One-only tracks/playlists with stable aliases, then mirrors them without copying existing audio or analysis',async()=>withWavDecoder(async()=>{
  const raw=await bothFormatFixture(),bridge=new FakeBridge();bridge.files=new Map([...raw.files].map(([name,bytes])=>[name,bytes.slice()]));
  const exclusive={...makeTrack(),id:'one-exclusive',title:'Only in OneLibrary',filename:'One only.wav',numericId:200};
  const exclusivePlan=await planLibrary({tracks:[exclusive],includeAllPlaylist:false}),planned=exclusivePlan.tracks[0];
  const meter=await createAnalysisMeter({sampleRate:44100,channels:2});meter.push(new Float32Array(44100*4).fill(.1));
  const analysis=meter.finish(exclusive,planned);bridge.files.set(path(planned.usbPath),wav());
  for(const [key,bytes]of Object.entries(analysis))bridge.files.set(path(planned.anlzPaths[key]),unknownSection(bytes));
  bridge.files.set(ONE,await updateOneLibrary(bridge.files.get(ONE),{addTracks:[{contentId:200,track:exclusive,usbPath:planned.usbPath,analysisPath:planned.anlzPaths.dat}],
    addPlaylists:[{playlistId:201,parentId:121,sequenceNo:6,name:'One-only set',trackIds:[200,91]}],
    appendPlaylistTracks:[{playlistId:123,trackIds:[200]}]}));
  const library=await actualLibrary(),session=await openNativeUSB({bridge});
  const imported=await importNativeUSB({library,session,reader,sources:[]});
  const firstTracks=await library.getTracks(),firstLists=await library.getPlaylists();
  assert.equal(firstTracks.length,4,'One-only track must be visible immediately when the primary candidate is PDB');
  assert.equal(imported.copied,4);assert.equal(imported.missing,0);
  const onlyTrack=firstTracks.find(track=>track.title===exclusive.title),onlyList=firstLists.find(list=>list.name==='One-only set');
  assert.ok(onlyTrack);assert.ok(onlyTrack.peaks.length);assert.equal(onlyTrack.audioMissing,false);
  assert.ok(onlyList);assert.deepEqual(onlyList.folderPath,['Folder']);assert.equal(onlyList.trackIds[0],onlyTrack.id);
  assert.ok(firstLists.find(list=>list.name==='Set').trackIds.includes(onlyTrack.id),'shared list imports the union of both formats');
  assert.equal(imported.source.nativeUSB.tracks[onlyTrack.id].pdbId,null,'import must not persist a PDB ID that does not exist yet');
  assert.equal(imported.source.nativeUSB.tracks[onlyTrack.id].oneLibraryId,200);
  assert.equal(imported.source.nativeUSB.playlists[onlyList.id].pdbId,null);
  assert.equal(imported.source.nativeUSB.playlists[onlyList.id].oneLibraryId,201);
  const oneSession=await openNativeUSB({bridge});
  const refreshed=await importNativeUSB({library,session:oneSession,candidate:{...oneSession.index.find(ONE),kind:'sqlite'},reader,sources:await library.getSources()});
  assert.equal(refreshed.copied,0);assert.equal(refreshed.reused,4);
  assert.deepEqual((await library.getTracks()).map(track=>track.id).sort(),firstTracks.map(track=>track.id).sort());
  assert.deepEqual((await library.getPlaylists()).map(list=>list.id).sort(),firstLists.map(list=>list.id).sort());
  const before=snapshotFiles(bridge),track={...makeTrack(),id:'new-after-union',title:'New after union'};await library.putTrack(track,new Blob([wav()]));
  const set=(await library.getPlaylists()).find(list=>list.name==='Set');
  const result=await exportNativeUSB({library,session,tracks:[track],playlists:[{...set,trackIds:[track.id]}]});
  assert.equal(result.exportedTracks,1);assert.equal(result.writtenFiles,6);
  for(const [name,bytes]of before)if(![PDB,ONE].includes(name))assert.deepEqual(bridge.files.get(name),bytes,name);
  const pdb=await inspectLibrary(bridge.files.get(PDB)),one=await inspectOneLibrary(bridge.files.get(ONE));
  assert.equal(pdb.existingTracks.length,5);assert.equal(one.tracks.length,5);
  const mirrored=pdb.existingTracks.find(item=>item.title===exclusive.title);assert.equal(mirrored.numericId,201);assert.equal(mirrored.usbPath,planned.usbPath);
  assert.equal(mirrored.analysisPath,planned.anlzPaths.dat);
  assert.deepEqual(pdb.playlistMappings.find(list=>list.numericId===23).trackIds,[12,11,12,201,202]);
  assert.deepEqual(one.playlists.find(list=>list.playlistId===123).trackIds,[92,91,92,200,202]);
  assert.equal(bridge.batches[0].writes.filter(item=>item.path.startsWith('Contents/')).length,1);
  const finalImport=await importNativeUSB({library,session:await openNativeUSB({bridge}),reader,sources:await library.getSources()});
  assert.equal((await library.getTracks()).length,5);
  assert.equal(finalImport.source.nativeUSB.tracks[onlyTrack.id].pdbId,201);
  assert.equal((await library.getPlaylists()).find(list=>list.name==='One-only set').id,onlyList.id);
}));

test('both database CAS guards, late WAL creation and mirrored ANLZ races reject before native commit',async()=>withWavDecoder(async()=>{
  for(const scenario of ['pdb-race','one-race','wal-existing','wal-race','hidden-one-race','cancel']){
    const {bridge,library,session}=await realFixture(),track={...makeTrack(),id:`added-${scenario}`,title:'New guarded track'};
    await library.putTrack(track,new Blob([wav()]));const before=snapshotFiles(bridge),controller=new AbortController();
    if(scenario==='pdb-race')bridge.beforeCommit=async()=>{bridge.files.get(PDB)[32]^=1;};
    if(scenario==='one-race')bridge.beforeCommit=async()=>{bridge.files.get(ONE)[80]^=1;};
    if(scenario==='wal-existing')bridge.files.set(ONE+'-wal',Uint8Array.of(1,2,3));
    if(scenario==='wal-race')bridge.beforeCommit=async()=>{bridge.files.set(ONE+'-wal',Uint8Array.of(1));};
    if(scenario==='hidden-one-race')bridge.beforeCommit=async()=>{bridge.files.set('.'+ONE,Uint8Array.of(1));};
    const onProgress=message=>{if(scenario==='cancel'&&message.includes('波形'))controller.abort();};
    await assert.rejects(exportNativeUSB({library,session,tracks:[track],signal:controller.signal,onProgress}),
      scenario==='cancel'?{name:'AbortError'}:scenario==='wal-existing'?/WAL/:/compare-and-swap/);
    assert.equal(bridge.commits,0,scenario);
    for(const [name,bytes]of before)if(![PDB,ONE].includes(name))assert.deepEqual(bridge.files.get(name),bytes,name);
    assert.equal([...bridge.files.keys()].filter(name=>name.startsWith('Contents/')).length,3);
  }
  const {bridge,library,imported,plan}=await realFixture('pdb');
  bridge.beforeCommit=async()=>{bridge.files.get(path(plan.tracks[0].anlzPaths.dat))[30]^=1;};
  await assert.rejects(writeNativeHotCues({bridge,library,source:imported.source,tracks:await library.getTracks()}),/compare-and-swap/);
  assert.equal(bridge.commits,0);assert.equal(bridge.files.has(ONE),false);
}));
