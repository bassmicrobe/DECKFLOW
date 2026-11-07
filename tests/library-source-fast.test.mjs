import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {indexDirectory,createSourceIndex,databaseCandidates,databaseBytes} from '../dist/library-source.js';
import {cacheSourceLibrary} from '../dist/source-import.js';
import {openLibrary} from '../dist/library-store.js';
import {parseDeviceDatabase} from '../dist/rekordbox-device.js';
import {parseRekordboxDatabase} from '../dist/rekordbox-sqlite.js';
import {image,deviceTables} from './helpers/rekordbox-sqlite-fixture.mjs';

const pdb=new Uint8Array(await readFile(new URL('./fixtures/device-library/export.pdb',import.meta.url)));
const parsed=parseDeviceDatabase(pdb,{sourceId:'fixture'});
const sourceEntry=parsed.entries[0];
const error=name=>new DOMException(name,name);

function tree({name='USB',insensitive=false,enumerate=false}={}){
  const calls=[],reads=[],enumerations=[],settings={before:null,active:0,maxActive:0};
  const key=value=>insensitive?value.normalize('NFC').toLowerCase():value;
  const make=(name,kind,path,bytes)=>{
    const node={name,kind,path,children:new Map(),bytes,
      async getFile(){reads.push(path);return new File([node.bytes??new Uint8Array(1)],node.name,{lastModified:100});},
      async isSameEntry(other){return node===other;},
      async getDirectoryHandle(name,options){return access(name,'directory',options);},
      async getFileHandle(name,options){return access(name,'file',options);},
      async *values(){enumerations.push(path);assert.ok(enumerate,'targeted lookup must not enumerate folders');yield* node.children.values();},
    };
    async function access(name,kind,options){
      assert.deepEqual(options,{create:false});
      const requested=path?`${path}/${name}`:name;calls.push({path:requested,kind});
      settings.maxActive=Math.max(settings.maxActive,++settings.active);
      try{
        await settings.before?.(requested,kind);
        const child=node.children.get(key(name));
        if(!child)throw error('NotFoundError');
        if(child.kind!==kind)throw error('TypeMismatchError');
        return child;
      }finally{settings.active--;}
    }
    return node;
  };
  const root=make(name,'directory','');
  function add(path,bytes=new Uint8Array(1),kind='file'){
    const parts=path.replace(/^\/+/,'').split('/');let parent=root;
    for(const part of parts.slice(0,-1)){
      if(!parent.children.has(key(part)))parent.children.set(key(part),make(part,'directory',parent.path?`${parent.path}/${part}`:part));
      parent=parent.children.get(key(part));
    }
    const leaf=parts.at(-1),node=make(leaf,kind,parent.path?`${parent.path}/${leaf}`:leaf,bytes);
    parent.children.set(key(leaf),node);return node;
  }
  function remove(path){const parts=path.split('/');let parent=root;for(const part of parts.slice(0,-1))parent=parent.children.get(key(part));parent.children.delete(key(parts.at(-1)));}
  return {root,add,remove,calls,reads,enumerations,settings};
}

test('USB DB-first selection and preparation skip a 10,000-file unrelated folder',async()=>{
  const t=tree({name:'Cafe\u0301 USB'});
  t.add('PIONEER/rekordbox/export.pdb',pdb);
  t.add('PIONEER/rekordbox/exportLibrary.db',image(deviceTables()));
  t.add(sourceEntry.sourcePath,new Uint8Array(882044));
  t.add(sourceEntry.analysisPath);
  t.add(sourceEntry.analysisPath.replace('.DAT','.EXT'));
  for(let i=0;i<10_000;i++)t.add(`Backups/unrelated/private-${i}.wav`);
  const index=await indexDirectory(t.root),candidates=databaseCandidates(index);
  assert.equal(index.targetedDevice,true);assert.deepEqual(candidates.map(item=>item.kind),['pdb','sqlite']);
  assert.equal(candidates[0].path,'Café USB/PIONEER/rekordbox/export.pdb');
  assert.equal(index.label,'Cafe\u0301 USB');assert.equal(t.reads.length,0);assert.equal(index.entries.size,2);
  assert.ok(t.calls.length<=10,'DB discovery cost must not grow with unrelated file count');
  const progress=[];
  await index.prepareEntries([sourceEntry,sourceEntry],{candidate:candidates[0],onProgress:(completed,total)=>progress.push([completed,total])});
  assert.deepEqual(progress,[[0,3],[1,3],[2,3],[3,3]]);
  assert.ok(index.find(sourceEntry.sourcePath));assert.ok(index.find(sourceEntry.analysisPath));
  assert.equal(t.reads.length,0);assert.equal(t.enumerations.length,0);
  assert.equal(t.calls.some(call=>call.path.startsWith('Backups')),false);
  assert.equal(t.calls.filter(call=>call.path==='PIONEER/USBANLZ').length,1);
  assert.ok(t.settings.maxActive<=4);
});

test('targeted lookup requires exact DB paths and never applies suffix or basename guesses',async()=>{
  const t=tree();t.add('PIONEER/rekordbox/export.pdb',pdb);t.add('Contents/Artist/song.wav');
  const index=await indexDirectory(t.root);
  await index.prepareEntries([
    {sourcePath:'/Contents/Artist/song.wav'},
    {sourcePath:'/Old/Artist/song.wav'},
    {sourcePath:'/USB/Contents/Artist/song.wav'},
  ]);
  assert.equal(index.find('/Contents/Artist/song.wav').path,'USB/Contents/Artist/song.wav');
  for(const path of ['/Old/Artist/song.wav','/Artist/song.wav','/song.wav','/USB/Contents/Artist/song.wav'])assert.equal(index.find(path,{suffix:true}),null);
});

test('targeted DAT and EXT lookups are independent and missing paths are retried on the next import',async()=>{
  const t=tree();t.add('.PIONEER/rekordbox/exportLibrary.db',image(deviceTables()));
  t.add('Contents/song.wav');t.add('.PIONEER/USBANLZ/A/ANLZ0000.EXT');
  const index=await indexDirectory(t.root),entry={sourcePath:'/Contents/song.wav',analysisPath:'/.PIONEER/USBANLZ/A/ANLZ0000.DAT'};
  await index.prepareEntries([entry]);
  assert.equal(index.find(entry.analysisPath),null);assert.ok(index.find(entry.analysisPath.replace('.DAT','.EXT')));
  t.add('.PIONEER/USBANLZ/A/ANLZ0000.DAT');t.remove('.PIONEER/USBANLZ/A/ANLZ0000.EXT');
  await index.prepareEntries([entry]);
  assert.ok(index.find(entry.analysisPath));assert.equal(index.find(entry.analysisPath.replace('.DAT','.EXT')),null);
});

test('referenced file resolution uses at most four concurrent calls and shares directory lookups',async()=>{
  const t=tree();t.add('PIONEER/rekordbox/export.pdb',pdb);
  const references=Array.from({length:12},(_,i)=>({sourcePath:`/Contents/Album/${i}.wav`}));
  for(const entry of references)t.add(entry.sourcePath);
  const index=await indexDirectory(t.root);t.calls.length=0;t.settings.maxActive=0;
  t.settings.before=async()=>{await new Promise(resolve=>setTimeout(resolve,1));};
  await index.prepareEntries(references);
  assert.equal(t.settings.maxActive,4);
  assert.equal(t.calls.filter(call=>call.path==='Contents').length,1);
  assert.equal(t.calls.filter(call=>call.path==='Contents/Album').length,1);
  assert.equal(t.calls.filter(call=>call.kind==='file').length,12);
  assert.equal(t.reads.length,0);
});

test('normalization aliases resolve to the canonical returned handle path without duplicating file entries',async()=>{
  const t=tree({insensitive:true});t.add('PIONEER/rekordbox/export.pdb',pdb);t.add('Contents/Cafe\u0301.wav');
  const index=await indexDirectory(t.root);
  await index.prepareEntries([{sourcePath:'/Contents/Cafe\u0301.wav'},{sourcePath:'/Contents/Café.wav'}]);
  assert.equal(index.find('/Contents/Cafe\u0301.wav'),index.find('/Contents/Café.wav'));
  assert.equal(index.find('/Contents/Café.wav').path,'USB/Contents/Café.wav');
  assert.equal(index.entries.size,2);
});

test('distinct filesystem entries with colliding normalized paths are rejected instead of sharing audio',async()=>{
  const t=tree();t.add('PIONEER/rekordbox/export.pdb',pdb);t.add('Contents/Cafe\u0301.wav');t.add('Contents/Café.wav');
  const index=await indexDirectory(t.root);
  await assert.rejects(index.prepareEntries([{sourcePath:'/Contents/Cafe\u0301.wav'},{sourcePath:'/Contents/Café.wav'}]),/重複/);
  assert.equal(index.entries.size,1);assert.equal(index.find('/Contents/Café.wav'),null);
});

test('permission and I/O errors are not mistaken for absent device databases or files',async()=>{
  for(const failure of ['NotAllowedError','NotReadableError']){
    const t=tree({enumerate:true});t.settings.before=path=>{if(path==='PIONEER')throw error(failure);};
    await assert.rejects(indexDirectory(t.root),{name:failure});assert.equal(t.enumerations.length,0);
    t.settings.before=null;t.add('PIONEER/rekordbox/export.pdb',pdb);t.add('Contents/song.wav');
    const index=await indexDirectory(t.root);
    t.settings.before=path=>{if(path==='Contents/song.wav')throw error(failure);};
    await assert.rejects(index.prepareEntries([{sourcePath:'/Contents/song.wav'}]),{name:failure});
    assert.equal(index.find('/Contents/song.wav'),null);assert.equal(index.entries.size,1);
  }
});

test('cancelled probes and prepared file reads never publish a partial targeted index',async()=>{
  const t=tree();t.add('PIONEER/rekordbox/export.pdb',pdb);t.add('Contents/song.wav');
  const initial=new AbortController();t.settings.before=path=>{if(path==='PIONEER')initial.abort();};
  await assert.rejects(indexDirectory(t.root,{signal:initial.signal}),{name:'AbortError'});
  t.settings.before=null;const index=await indexDirectory(t.root),controller=new AbortController();
  t.settings.before=path=>{if(path==='Contents/song.wav')controller.abort();};
  await assert.rejects(index.prepareEntries([{sourcePath:'/Contents/song.wav'}],{signal:controller.signal}),{name:'AbortError'});
  assert.equal(index.find('/Contents/song.wav'),null);assert.equal(index.entries.size,1);
  t.settings.before=null;await index.prepareEntries([{sourcePath:'/Contents/song.wav'}]);
  assert.ok(index.find('/Contents/song.wav'));
});

test('unsafe DB paths are rejected before opening any referenced children',async()=>{
  const t=tree();t.add('PIONEER/rekordbox/export.pdb',pdb);const index=await indexDirectory(t.root);
  for(const sourcePath of ['../secret.wav','Contents/../secret.wav','Contents\\secret.wav','Contents/\u0000secret.wav']){
    const before=t.calls.length;
    await assert.rejects(index.prepareEntries([{sourcePath:'/Contents/valid.wav'},{sourcePath}]),/パス/);
    assert.equal(t.calls.length,before);
  }
});

test('canonical case aliases share one file path so distinct DB originals remain ambiguous',async()=>{
  const t=tree({insensitive:true});t.add('Pioneer/Rekordbox/export.pdb',pdb);t.add('Contents/Artist/Song.wav',new Uint8Array(882044));
  const entries=[{trackId:'case-1',sourcePath:'/Contents/Artist/Song.wav'},{trackId:'case-2',sourcePath:'/contents/artist/song.wav'}];
  const tracks=entries.map(entry=>({...parsed.tracks[0],id:entry.trackId,filename:'Song.wav'}));
  const index=await indexDirectory(t.root),library=await openLibrary();
  const result=await cacheSourceLibrary({library,index,candidate:databaseCandidates(index)[0],reader:{async read(){return {tracks,entries,playlists:[],warnings:[]};}}});
  assert.equal(index.find(entries[0].sourcePath).path,index.find(entries[1].sourcePath).path);
  assert.equal(result.copied,0);assert.equal(result.missing,2);
  assert.equal(result.warnings.filter(message=>message.includes('自動接続しませんでした')).length,2);
  assert.equal(t.reads.some(path=>path.endsWith('Song.wav')),false);
});

test('WAL created after folder selection or DB parsing blocks import and is rechecked after removal',async()=>{
  const t=tree();t.add('PIONEER/rekordbox/exportLibrary.db',image(deviceTables()));
  const index=await indexDirectory(t.root),candidate=databaseCandidates(index)[0];
  t.add('PIONEER/rekordbox/exportLibrary.db-wal',new Uint8Array(2));
  await assert.rejects(databaseBytes(index,candidate),/WAL/);
  t.remove('PIONEER/rekordbox/exportLibrary.db-wal');
  assert.ok((await databaseBytes(index,candidate)).length);
  t.add('PIONEER/rekordbox/exportLibrary.db-wal',new Uint8Array(2));
  await assert.rejects(index.prepareEntries([],{candidate}),/WAL/);
  t.remove('PIONEER/rekordbox/exportLibrary.db-wal');await index.prepareEntries([],{candidate});
});

test('DB-first PDB import reuses the previous full-scan source identity and cached audio',async()=>{
  const t=tree();const db=t.add('PIONEER/rekordbox/export.pdb',pdb),audio=t.add(sourceEntry.sourcePath,new Uint8Array(882044));
  const old=createSourceIndex([{path:'USB/PIONEER/rekordbox/export.pdb',getFile:()=>db.getFile()},
    {path:'USB'+sourceEntry.sourcePath,getFile:()=>audio.getFile()}],'USB');
  let parses=0;const reader={async read(_operation,data){parses++;return parseDeviceDatabase(data.bytes,{sourceId:data.sourceId});}};
  const library=await openLibrary(),first=await cacheSourceLibrary({library,index:old,candidate:databaseCandidates(old)[0],reader});
  const index=await indexDirectory(t.root),progress=[];
  const second=await cacheSourceLibrary({library,index,candidate:databaseCandidates(index)[0],reader,sources:await library.getSources(),onProgress:(_message,detail)=>progress.push(detail)});
  assert.equal(second.source.id,first.source.id);assert.equal(second.metadataCached,true);assert.equal(parses,1);
  assert.equal(second.copied,0);assert.equal(second.reused,1);assert.equal((await library.getSources()).length,1);
  assert.ok(progress.some(detail=>detail.phase==='files'&&detail.completed===detail.total));
  assert.doesNotThrow(()=>structuredClone(second.source));
});

test('DB-first OneLibrary uses parsed audio paths and keeps source handles out of saved data',async()=>{
  const t=tree();t.add('.PIONEER/rekordbox/exportLibrary.db',image(deviceTables()));t.add('Contents/Synthetic 120.wav',new Uint8Array(12345));
  const index=await indexDirectory(t.root),library=await openLibrary();
  const reader={read:(_operation,data)=>parseRekordboxDatabase(data.bytes,{sourceId:data.sourceId,kind:'device'})};
  const result=await cacheSourceLibrary({library,index,candidate:databaseCandidates(index)[0],reader});
  assert.equal(result.copied,1);assert.equal(result.missing,0);assert.equal(t.enumerations.length,0);
  assert.ok(index.find('/Contents/Synthetic 120.wav'));const saved=(await library.getSources())[0];assert.doesNotThrow(()=>structuredClone(saved));
});

test('non-device desktop/XML folders retain full enumeration and relocated path matching',async()=>{
  const t=tree({name:'Desktop',enumerate:true});t.add('exports/library.xml');t.add('Library/master.db');t.add('Music/song.wav');
  const index=await indexDirectory(t.root);
  assert.equal(index.targetedDevice,undefined);assert.equal(index.prepareEntries,undefined);
  assert.deepEqual(databaseCandidates(index).map(item=>item.kind),['sqlite','xml']);
  assert.equal(index.find('/old/Music/song.wav',{suffix:true}).path,'Desktop/Music/song.wav');
  assert.ok(t.enumerations.length>0);assert.equal(t.reads.length,0);
});
