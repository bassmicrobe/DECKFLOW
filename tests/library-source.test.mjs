import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {openLibrary} from '../dist/library-store.js';
import {createSourceIndex,indexFileList,indexDirectory,databaseCandidates,databaseBytes,normalizeSourcePath} from '../dist/library-source.js';
import {cacheSourceLibrary} from '../dist/source-import.js';
import {parseDeviceDatabase,parseDeviceAnalysis,mergeDeviceAnalysis} from '../dist/rekordbox-device.js';
import {rewriteAnalysisPath} from '../tools/analysis-source.mjs';
const fixture=async name=>new Uint8Array(await readFile(new URL(`./fixtures/device-library/${name}`,import.meta.url)));
const pdb=await fixture('export.pdb');
const metadata=parseDeviceDatabase(pdb,{sourceId:'fixture'}), entry=metadata.entries[0];

test('source import accepts a 1 GiB multi-hour audio Blob without decoding it', async () => {
  const size=1024**3, duration=6000;
  class LargeFile extends File {
    get size(){return size;}
    async arrayBuffer(){assert.fail('source import must not read whole audio');}
  }
  const file=new LargeFile([], 'long.wav', {type:'audio/wav'});
  const index=createSourceIndex([
    {path:'USB/PIONEER/rekordbox/export.pdb',getFile:async()=>new File([pdb],'export.pdb')},
    {path:'USB'+entry.sourcePath,getFile:async()=>file},
  ]);
  const reader={async read(op,data){
    assert.equal(op,'database');
    const parsed=parseDeviceDatabase(data.bytes,{sourceId:data.sourceId});
    return {...parsed,tracks:parsed.tracks.map(track=>({...track,duration,rekordbox:{...track.rekordbox,size}})),
      entries:parsed.entries.map(item=>({...item,analysisPath:null}))};
  }};
  const library=await openLibrary();
  const result=await cacheSourceLibrary({library,index,reader,candidate:databaseCandidates(index)[0]});
  assert.equal(result.copied,1);assert.equal(result.missing,0);
  const [track]=await library.getTracks();
  assert.equal(track.duration,duration);assert.equal(track.audioMissing,false);
  assert.equal((await library.getAudio(track.id)).size,size);
});
function setup({audio=true,analysis=true,size=882044,extensions=['DAT','EXT']}={}) {
  const calls={database:0,analysis:0,audioBytes:0};
  const items=[{path:'USB/PIONEER/rekordbox/export.pdb',getFile:async()=>new File([pdb],'export.pdb',{lastModified:1})}];
  if(audio){const file=new File([new Uint8Array(size)],'日本語 120.wav',{lastModified:100});file.arrayBuffer=async()=>{calls.audioBytes++;throw new Error('Do not decode audio during source import');};items.push({path:'USB'+entry.sourcePath,getFile:async()=>file});}
  if(analysis)for(const ext of extensions)items.push({path:'USB'+entry.analysisPath.replace('.DAT','.'+ext),getFile:async()=>new File([await fixture('ANLZ0000.'+ext)],'ANLZ0000.'+ext)});
  const index=createSourceIndex(items,'USB'),candidate=databaseCandidates(index)[0];
  const reader={async read(op,data){calls[op]++;return op==='database'?parseDeviceDatabase(data.bytes,{sourceId:data.sourceId}):mergeDeviceAnalysis(data.track,data.files.map(parseDeviceAnalysis));}};
  return {index,candidate,reader,calls};
}

test('exact scoped folder paths match relocated audio and refuse ambiguous basename guesses',()=>{
  const index=createSourceIndex([{path:'USB/Contents/artist/song.wav'},{path:'USB/Other/artist/song.wav'}]);
  assert.equal(index.find('/Contents/artist/song.wav',{suffix:true}).path,'USB/Contents/artist/song.wav');
  assert.equal(index.find('/old/artist/song.wav',{suffix:true}),null);
  assert.equal(index.find('/old/song.wav',{suffix:true}),null);
  assert.equal(index.find('/song.wav'),null);
  assert.throws(()=>normalizeSourcePath('../song.wav'));
  assert.throws(()=>normalizeSourcePath('folder/'.repeat(34)+'song.wav'));
  assert.throws(()=>createSourceIndex([{path:'a/é.wav'},{path:'a/é.wav'}]),/重複/);
});

test('folder file input preserves paths; missing database and unsafe WAL are explicit',async()=>{
  const file=new File([pdb],'export.pdb');Object.defineProperty(file,'webkitRelativePath',{value:'USB/PIONEER/rekordbox/export.pdb'});
  const index=indexFileList([file]);assert.equal(index.label,'USB');assert.equal(databaseCandidates(index)[0].kind,'pdb');
  const bad=createSourceIndex([{path:'master.db',getFile:async()=>new File(['x'],'master.db')},{path:'master.db-wal',getFile:async()=>new File(['wal'],'master.db-wal')}]);
  await assert.rejects(databaseBytes(bad,databaseCandidates(bad)[0]),/WAL/);
  assert.deepEqual(databaseCandidates(createSourceIndex([{path:'masterPlaylists6.xml'},{path:'song.mp3'}])),[]);
});

test('directory handles enumerate lazily and cancellation never reads audio',async()=>{
  let reads=0;const handle={name:'USB',kind:'directory',async *values(){yield {kind:'file',name:'song.wav',getFile:async()=>{reads++;return new File([],'song.wav');}};}};
  const index=await indexDirectory(handle);assert.equal(index.entries.size,1);assert.equal(reads,0);
  const controller=new AbortController();controller.abort();await assert.rejects(indexDirectory(handle,{signal:controller.signal}),{name:'AbortError'});
});

test('source import persists preparation and encoded audio without decoding, and cached reopen skips DB/ANLZ parsing',async()=>{
  const library=await openLibrary(),s=setup();
  const first=await cacheSourceLibrary({library,...s});
  assert.equal(first.source.databasePath,s.candidate.path);
  assert.equal(first.source.id,(await library.getSources())[0].id);
  assert.ok(first.source.parsed.playlists.length>0);
  assert.equal(first.addedTracks,1);assert.equal(first.copied,1);assert.equal(s.calls.audioBytes,0);
  const tracks=await library.getTracks();assert.equal(tracks[0].audioMissing,false);assert.equal(tracks[0].hotcues[7],4.25);assert.ok(tracks[0].peaks.length);assert.equal((await library.getAudio(tracks[0].id)).size,882044);
  const saved=await library.getSources();assert.equal(saved.length,1);assert.equal(saved[0].cachedAudio,1);
  await library.putTrack({...tracks[0],title:'Local edit',cue:.75});
  const second=await cacheSourceLibrary({library,...s,sources:saved});
  assert.equal(second.metadataCached,true);assert.equal(second.copied,0);assert.equal(second.reused,1);assert.equal(s.calls.database,1);assert.equal(s.calls.analysis,1);assert.equal(s.calls.audioBytes,0);
  assert.equal((await library.getTracks())[0].title,'Local edit');assert.equal((await library.getTracks())[0].cue,.75);
});

test('missing audio remains a metadata placeholder and can be connected on a later folder selection',async()=>{
  const library=await openLibrary(),s=setup({audio:false});
  const first=await cacheSourceLibrary({library,...s});assert.equal(first.missing,1);assert.equal((await library.getTracks())[0].audioMissing,true);
  const next=setup(),second=await cacheSourceLibrary({library,...next,sources:await library.getSources()});
  assert.equal(second.metadataCached,true);assert.equal(second.addedTracks,0);assert.equal(second.copied,1);assert.equal((await library.getTracks())[0].audioMissing,false);
});

test('size mismatch never marks a missing source as playable and cancellation keeps completed metadata',async()=>{
  const library=await openLibrary(),s=setup({size:12});
  const result=await cacheSourceLibrary({library,...s});assert.equal(result.copied,0);assert.match(result.warnings.join(''),/サイズ/);assert.equal((await library.getTracks())[0].audioMissing,true);
  const library2=await openLibrary(),controller=new AbortController();
  await assert.rejects(cacheSourceLibrary({library:library2,...setup(),signal:controller.signal,onMetadata:()=>controller.abort()}),{name:'AbortError'});
  assert.equal((await library2.getTracks()).length,1);assert.equal((await library2.getSources()).length,1);assert.equal((await library2.getTracks())[0].audioMissing,true);
});

test('canceling a source while its audio is being saved leaves the track unlinked',async()=>{
  const library=await openLibrary(),controller=new AbortController(),putTrack=library.putTrack.bind(library);
  library.putTrack=async(track,blob,options)=>{
    if(blob){controller.abort();options?.signal?.throwIfAborted();}
    return putTrack(track,blob);
  };
  await assert.rejects(cacheSourceLibrary({library,...setup({analysis:false}),signal:controller.signal}),{name:'AbortError'});
  const [track]=await library.getTracks();
  assert.equal(track.audioMissing,true);assert.equal(await library.getAudio(track.id),null);
});

test('removing a source reference leaves saved tracks and audio intact',async()=>{
  const library=await openLibrary();await cacheSourceLibrary({library,...setup()});
  const [source]=await library.getSources(),[track]=await library.getTracks();await library.removeSource(source.id);
  assert.equal((await library.getSources()).length,0);assert.equal((await library.getTracks()).length,1);assert.ok(await library.getAudio(track.id));
});

test('a full source list rejects a new import atomically and retrying cannot add orphan tracks or playlists',async()=>{
  const library=await openLibrary();
  for(let i=0;i<20;i++)await library.putSource({id:`existing-${i}`,label:`Existing ${i}`,trackIds:[]});
  const beforeSources=await library.getSources();
  for(let attempt=0;attempt<2;attempt++){
    const s=setup();
    await assert.rejects(cacheSourceLibrary({library,...s,sources:await library.getSources()}),/20件/);
    assert.deepEqual(await library.getTracks(),[]);
    assert.deepEqual(await library.getPlaylists(),[]);
    assert.deepEqual(await library.getSources(),beforeSources);
    assert.equal(s.calls.analysis,0);
    assert.equal(s.calls.audioBytes,0);
  }
});

test('resuming after cancellation restores the pending source grid/cues, while retaining a title edit',async()=>{
  const library=await openLibrary(),controller=new AbortController();
  await assert.rejects(cacheSourceLibrary({library,...setup(),signal:controller.signal,onMetadata:()=>controller.abort()}),{name:'AbortError'});
  const [placeholder]=await library.getTracks();assert.equal(placeholder.peaks.length,0);assert.equal(placeholder.hotcues[7],null);
  await library.putTrack({...placeholder,title:'My title'});
  const next=setup(),result=await cacheSourceLibrary({library,...next,sources:await library.getSources()});
  const [restored]=await library.getTracks();
  assert.equal(result.metadataCached,true);assert.equal(next.calls.database,0);assert.equal(next.calls.analysis,1);
  assert.equal(restored.title,'My title');assert.equal(restored.hotcues[7],4.25);assert.equal(restored.tempos.length,2);assert.equal(restored.audioMissing,false);
});

test('resume restores missing peaks but never replaces locally edited preparation',async()=>{
  const library=await openLibrary();await cacheSourceLibrary({library,...setup({audio:false,analysis:false})});
  const [placeholder]=await library.getTracks();
  await library.putTrack({...placeholder,bpm:123,cue:.75,hotcues:[1,...Array(7).fill(null)]});
  await cacheSourceLibrary({library,...setup(),sources:await library.getSources()});
  const [restored]=await library.getTracks();assert.ok(restored.peaks.length);assert.equal(restored.bpm,123);assert.equal(restored.cue,.75);assert.equal(restored.hotcues[0],1);assert.equal(restored.hotcues[7],null);
});

test('cancellation after worker analysis prevents the pending track/audio write',async()=>{
  const library=await openLibrary(),controller=new AbortController(),s=setup(),original=s.reader.read;
  s.reader.read=async(op,data)=>{const result=await original(op,data);if(op==='analysis')controller.abort();return result;};
  let writes=0;
  await assert.rejects(cacheSourceLibrary({library,...s,signal:controller.signal,saveTrack:async(...args)=>{writes++;await library.putTrack(args[0],args[1]);return args[0];}}),{name:'AbortError'});
  assert.equal(writes,0);const [track]=await library.getTracks();assert.equal(track.peaks.length,0);assert.equal(track.audioMissing,true);assert.equal(await library.getAudio(track.id),null);
});

test('serialized save callback can preserve a concurrent edit and its returned metadata becomes the next write base',async()=>{
  const library=await openLibrary();let calls=0;
  const saveTrack=async(next,blob,base)=>{
    calls++;assert.equal(base.id,next.id);
    if(calls===1){next={...next,title:'Concurrent title',cue:.875};}
    else {assert.equal(base.title,'Concurrent title');assert.equal(base.cue,.875);assert.equal(next.cue,.875);}
    await library.putTrack(next,blob);return next;
  };
  const result=await cacheSourceLibrary({library,...setup(),saveTrack});assert.equal(result.copied,1);assert.equal(calls,2);
  const [track]=await library.getTracks();assert.equal(track.title,'Concurrent title');assert.equal(track.cue,.875);assert.equal(track.audioMissing,false);
});

test('deleted records are not resurrected when the save callback returns null',async()=>{
  const library=await openLibrary();let calls=0;
  const result=await cacheSourceLibrary({library,...setup(),saveTrack:async(next)=>{calls++;await library.removeTrack(next.id);return null;}});
  assert.equal(calls,1);assert.equal(result.copied,0);assert.deepEqual(await library.getTracks(),[]);assert.equal((await library.getSources())[0].cachedAudio,0);
});

test('quota failure during waveform persistence stops copying instead of reporting only an analysis warning',async()=>{
  const library=await openLibrary();let calls=0;
  await assert.rejects(cacheSourceLibrary({library,...setup(),saveTrack:async()=>{calls++;throw new Error('端末の保存容量が足りません。',{cause:new DOMException('full','QuotaExceededError')});}}),/保存容量/);
  assert.equal(calls,1);const [track]=await library.getTracks();assert.equal(track.audioMissing,true);assert.equal(await library.getAudio(track.id),null);
});

test('later EXT selection restores richer hot cues without reparsing the DB or replacing local cue edits',async()=>{
  const library=await openLibrary(),first=await cacheSourceLibrary({library,...setup({extensions:['DAT']})});
  assert.match(first.warnings.join(''),/EXT/);assert.equal((await library.getTracks())[0].hotcues[7],null);
  const next=setup(),second=await cacheSourceLibrary({library,...next,sources:await library.getSources()});
  assert.equal(second.metadataCached,true);assert.equal(next.calls.database,0);assert.equal(next.calls.analysis,1);
  assert.equal((await library.getTracks())[0].hotcues[7],4.25);
  const again=setup();await cacheSourceLibrary({library,...again,sources:await library.getSources()});assert.equal(again.calls.analysis,0);
  const edited=await openLibrary();await cacheSourceLibrary({library:edited,...setup({extensions:['DAT']})});
  const [track]=await edited.getTracks();await edited.putTrack({...track,cue:1.75});
  await cacheSourceLibrary({library:edited,...setup(),sources:await edited.getSources()});
  assert.equal((await edited.getTracks())[0].cue,1.75);assert.equal((await edited.getTracks())[0].hotcues[7],null);
});

async function aliasSetup({sameOriginal=false,withAnalysis=false,separateAudio=false,sameAnalysisPath=false}={}){
  const paths=sameOriginal?['/Old1/Album/song.wav','/Old1/Album/song.wav']:['/Old1/Album/song.wav','/Old2/Album/song.wav'];
  const entries=paths.map((sourcePath,i)=>({trackId:`alias-${i}`,sourcePath,analysisPath:withAnalysis?`/${sameAnalysisPath?'Shared':`Old${i+1}`}/cache/ANLZ0000.DAT`:null}));
  const tracks=entries.map((entry,i)=>({...metadata.tracks[0],id:entry.trackId,title:`Track ${i+1}`,filename:'song.wav',
    rekordbox:{...metadata.tracks[0].rekordbox,trackId:String(i+1),location:'file://localhost'+entry.sourcePath}}));
  const calls={audio:0,analysis:0,analysisFiles:0};
  const items=[{path:'USB/PIONEER/rekordbox/export.pdb',getFile:async()=>new File([pdb],'export.pdb',{lastModified:1})}];
  const audio=new File([new Uint8Array(882044)],'song.wav',{lastModified:100});
  for(const path of separateAudio?[...new Set(paths)].map(p=>'USB'+p):['USB/Album/song.wav'])items.push({path,getFile:async()=>{calls.audio++;return audio;}});
  if(withAnalysis){
    const anonymous=rewriteAnalysisPath(await fixture('ANLZ0000.DAT'),'?/song.wav');
    items.push({path:'USB/cache/ANLZ0000.DAT',getFile:async()=>{calls.analysisFiles++;return new File([anonymous],'ANLZ0000.DAT');}});
  }
  const index=createSourceIndex(items,'USB'),candidate=databaseCandidates(index)[0];
  const reader={async read(op,data){if(op==='database')return {tracks,entries,playlists:[],warnings:[]};calls.analysis++;return mergeDeviceAnalysis(data.track,data.files.map(parseDeviceAnalysis),{allowAnonymousPath:true});}};
  return {index,candidate,reader,calls};
}

test('distinct original audio paths cannot both bind to one same-size suffix match, including the first entry',async()=>{
  const library=await openLibrary(),s=await aliasSetup();
  const result=await cacheSourceLibrary({library,...s});
  assert.equal(result.addedTracks,2);assert.equal(result.copied,0);assert.equal(result.missing,2);assert.equal(s.calls.audio,0);
  assert.equal(result.warnings.filter(message=>message.includes('自動接続しませんでした')).length,2);
  for(const track of await library.getTracks()){assert.equal(track.audioMissing,true);assert.equal(await library.getAudio(track.id),null);}
});

test('duplicate DB records for one identical full original audio path may share its selected file',async()=>{
  const library=await openLibrary(),s=await aliasSetup({sameOriginal:true});
  const result=await cacheSourceLibrary({library,...s});
  assert.equal(result.copied,2);assert.equal(result.missing,0);assert.equal(result.warnings.length,0);
  for(const track of await library.getTracks()){assert.equal(track.audioMissing,false);assert.equal((await library.getAudio(track.id)).size,882044);}
});

test('anonymous same-basename ANLZ cannot collapse different original analysis/audio paths onto one selected file',async()=>{
  for(const sameAnalysisPath of [false,true]){
    const library=await openLibrary(),s=await aliasSetup({withAnalysis:true,separateAudio:true,sameAnalysisPath});
    const result=await cacheSourceLibrary({library,...s});
    assert.equal(result.copied,2);assert.equal(s.calls.analysis,0);assert.equal(s.calls.analysisFiles,0);
    assert.equal(result.warnings.filter(message=>message.includes('同じANLZ')).length,2);
    for(const track of await library.getTracks()){assert.deepEqual(track.peaks,[]);assert.equal(track.beatOffset,0);assert.deepEqual(track.hotcues,Array(8).fill(null));}
  }
});

test('identical original audio and analysis paths across duplicate records can reuse anonymous ANLZ',async()=>{
  const library=await openLibrary(),s=await aliasSetup({sameOriginal:true,withAnalysis:true,sameAnalysisPath:true});
  const result=await cacheSourceLibrary({library,...s});assert.equal(result.copied,2);assert.equal(s.calls.analysis,2);
  assert.equal(result.warnings.some(message=>message.includes('同じANLZ')),false);
  for(const track of await library.getTracks()){assert.ok(track.peaks.length);assert.equal(track.beatOffset,.125);}
});
