/** Direct USB workflows. Only the iPad permission bridge mutates the volume;
 * audio and binary generation stay local. No download or remote server. */
import {createAudioReadSource} from './audio-read-source.js?v=88e0687b343dbe25';
import {createSourceIndex, databaseCandidates, databaseBytes, sourceDigest, normalizeSourcePath} from './library-source.js?v=88e0687b343dbe25';
import {cacheSourceLibrary} from './source-import.js?v=88e0687b343dbe25';
import {parseDeviceDatabase, parseDeviceAnalysis, mergeDeviceAnalysis} from './rekordbox-device.js?v=88e0687b343dbe25';
import {exportPositionMarks, encodeRekordboxLocation} from './usb-export.js?v=88e0687b343dbe25';
import {readUsbAudioInfo, feedUsbAudio} from './usb-audio.js?v=88e0687b343dbe25';
import {planLibrary, mergeLibrary, inspectLibrary, createAnalysisMeter, patchAnalysis} from './vendor/browser-usb/writer.js?v=88e0687b343dbe25';

import {inspectOneLibrary, updateOneLibrary} from './onelibrary-writer.js?v=88e0687b343dbe25';
import {planUSBMerge} from './usb-library-plan.js?v=88e0687b343dbe25';

const PDB = 'PIONEER/rekordbox/export.pdb';
const ONE = 'PIONEER/rekordbox/exportLibrary.db';
const MAX_ANALYSIS = 32 * 1024 * 1024;
const abort = signal => signal?.throwIfAborted();
const fail = message => { throw new Error(message); };
const bridgeOrFail = supplied => {
  const bridge = supplied ?? globalThis.nativeUSB;
  if (!nativeUSBAvailable(bridge)) fail('USBへ直接保存するにはDECKFLOWのiPadアプリで開いてください。SafariではUSBを読み取り専用で取り込めます。');
  return bridge;
};
export const nativeUSBAvailable = (bridge = globalThis.nativeUSB) => bridge?.available === true && typeof bridge.writeBatch === 'function';
const oneLibrary = session => [...session.index.entries.keys()].some(path => /(?:^|\/)exportLibrary\.db(?:-wal)?$/i.test(path));
const hotMarks = track => exportPositionMarks(track).filter(mark => mark.num >= 0).map(mark => ({...mark})).sort((a,b) => a.num-b.num);
const hotSignature = track => JSON.stringify(hotMarks(track));
const fingerprint = async (bridge, rootId, path) => {
  const stat = await bridge.stat(rootId, path);
  if (!stat.exists) return null;
  if (stat.kind !== 'file' || !/^[a-f0-9]{64}$/i.test(stat.fingerprint ?? '')) fail(`${path}: ファイルの変更を確認できません。`);
  return stat.fingerprint;
};
const progress = callback => event => callback(event.phase === 'committing' ? 'USBの変更を確定しています…' :
  event.phase === 'complete' ? 'USBへの保存が完了しました。' : `USBへ転送 ${Math.round(event.completedBytes / Math.max(1,event.totalBytes) * 100)}% — ${event.path ?? ''}`);

export async function openNativeUSB({rootId, bridge: supplied, signal} = {}) {
  const bridge = bridgeOrFail(supplied); abort(signal);
  const root = rootId ? await bridge.restoreDirectory(rootId) : await bridge.chooseDirectory();
  abort(signal);
  const entries = await bridge.list(root.id, {path:'',recursive:true}); abort(signal);
  const readHashes = new Map();
  const index = createSourceIndex(entries.filter(item => item.kind === 'file').map(item => ({path:item.path,
    async getFile() {
      const source = createAudioReadSource({name:item.name || item.path.split('/').at(-1),size:item.size,
        lastModified:item.modified || 0,read:async(offset,length) => {abort(signal); return bridge.readRange(root.id,item.path,{offset,length});}});
      // The hash is of the exact imported bytes, not a later filesystem stat.
      if (/\.(?:DAT|EXT|2EX|pdb|db)$/i.test(item.path)) return {...source, async arrayBuffer() {
        const bytes = await source.arrayBuffer(); readHashes.set(item.path,await sourceDigest(bytes)); return bytes;
      }};
      return source;
    },
  })),root.name);
  const session = {bridge,root,index,readHashes,candidate:databaseCandidates(index)[0] ?? null};
  index.nativeSession = session; return session;
}

const preparation = track => JSON.stringify({bpm:track.bpm,beatOffset:track.beatOffset||0,cue:track.cue||0,
  hotcues:track.hotcues??Array(8).fill(null),tempos:track.tempos??[],positionMarks:track.positionMarks??[]});
const canonical = value => '/' + normalizeSourcePath(value);
const physicalTrack = (track, binding) => ({...track,rekordbox:{trackId:String(binding.pdbId||binding.oneLibraryId),
  location:encodeRekordboxLocation(binding.audioPath),size:track.rekordbox?.size??track.size??null}});

async function deviceSnapshot(session, signal, source) {
  abort(signal);
  const found = {pdb:[],one:[]};
  for(const entry of session.index.entries.values()) {
    const name=entry.path.split('/').at(-1).toLowerCase();
    if(name==='export.pdb')found.pdb.push(entry);
    if(name==='exportlibrary.db')found.one.push(entry);
  }
  if(found.pdb.length>1||found.one.length>1)fail('複数のUSBライブラリが見つかりました。USBのルートを1つ選び直してください。');
  for(const entry of [...found.pdb,...found.one]) if(!/^(?:\.?PIONEER)\/rekordbox\/(?:export\.pdb|exportLibrary\.db)$/i.test(entry.path)) fail('USBのルートフォルダーを選択してください。PIONEERフォルダー内やバックアップのDBへは保存しません。');
  const base=(found.pdb[0]??found.one[0])?.path.split('/').slice(0,-1).join('/')??'PIONEER/rekordbox';
  const paths={pdb:found.pdb[0]?.path??base+'/export.pdb',one:found.one[0]?.path??base+'/exportLibrary.db'};
  const databases={},guards=[],data={};
  for(const key of ['pdb','one']) {
    const entry=found[key][0],dbPath=paths[key];
    // Protect absent/empty WALs too: a writer opening after this snapshot
    // cannot make us commit over an uncheckpointed database.
    for(const suffix of ['-wal','-journal']) {
      const stat=await session.bridge.stat(session.root.id,dbPath+suffix);
      if(stat.exists&&stat.size>0)fail('未反映の変更（WAL・journal）があるUSBです。rekordboxを終了してから読み込み直してください。');
      guards.push({path:dbPath+suffix,expectedFingerprint:stat.exists?stat.fingerprint:null});
    }
    data[key]=entry?await databaseBytes(session.index,{...entry,kind:key==='pdb'?'pdb':'sqlite'}):null;
    databases[key]={path:dbPath,fingerprint:data[key]?await sourceDigest(data[key]):null};
  }
  for(const alternate of [PDB,ONE,'.PIONEER/rekordbox/export.pdb','.PIONEER/rekordbox/exportLibrary.db']) {
    if(Object.values(paths).includes(alternate))continue;
    guards.push({path:alternate,expectedFingerprint:await fingerprint(session.bridge,session.root.id,alternate)});
  }
  abort(signal);sameSnapshot(source,{databases});
  let one=null;
  if(data.one)try{one=await inspectOneLibrary(data.one,{signal});}catch(error){if(signal?.aborted)throw error;fail(`OneLibraryを読み取れません: ${error.message}`);}
  return {data,databases,guards,pdb:data.pdb?await inspectLibrary(data.pdb):null,one};
}
function sameSnapshot(source,snapshot) {
  if(!source?.nativeUSB)return;
  const stored=source.nativeUSB.databases;
  if(stored)for(const key of ['pdb','one']) {
    if((stored[key]?.fingerprint??null)!==snapshot.databases[key].fingerprint||stored[key]?.path&&stored[key].path!==snapshot.databases[key].path)
      fail('USBのライブラリが読み込み後に変更されています。USBを読み込み直してください。');
  }
  else if(source.nativeUSB.databaseFingerprint!==Object.values(snapshot.databases).find(db=>db.path===source.databasePath)?.fingerprint)
    fail('USBのライブラリが読み込み後に変更されています。USBを読み込み直してください。');
}

/** Refresh device metadata with stable local aliases; cached audio is reused.
 * USB originals supply write baselines, even while local CUE edits are pending. */
export async function importNativeUSB(options) {
  const {session,library,reader,signal}=options;
  if(session.root.pendingTransactions)fail('中断されたUSBへの保存を「復旧」してから読み込んでください。');
  const candidate=options.candidate??session.candidate;
  if(!candidate)fail('選択したUSBにライブラリが見つかりません。新規ライブラリを転送できます。');
  const previous=options.sources?.find(source=>source.nativeUSB?.rootId===session.root.id);
  const snapshot=await deviceSnapshot(session,signal);
  const model=planUSBMerge({pdb:snapshot.pdb,one:snapshot.one,state:previous?.nativeUSB});
  const byPath=new Map(model.nodes.map(node=>[node.audioPath,node]));
  const state={rootId:session.root.id,rootName:session.root.name,databases:snapshot.databases,
    databaseFingerprint:snapshot.databases[candidate.kind==='pdb'?'pdb':'one'].fingerprint,
    oneLibrary:!!snapshot.one,tracks:{},playlists:{},baselines:{}};
  const captured=new Map();
  const transformParsed=async(parsed,{sourceId})=>{
    const primary=candidate.kind==='pdb'?'pdb':'one',secondary=primary==='pdb'?'one':'pdb';
    const datasets=[{parsed,format:primary}];
    if(snapshot.data[secondary]) {
      abort(signal);
      // The worker takes ownership of its input buffer. Keep the exact snapshot
      // bytes for fingerprints and pass an independent copy to the second read.
      const bytes=snapshot.data[secondary].slice();
      const other=await reader.read('database',{kind:secondary==='pdb'?'pdb':'sqlite',bytes,sourceId,
        databaseKind:secondary==='one'?'device':undefined},[bytes.buffer]);
      abort(signal);datasets.push({parsed:other,format:secondary});
    }
    const tracks=new Map(),entries=new Map(),trackOwners=new Map();
    // Primary metadata wins for shared audio paths. Secondary-only tracks are
    // still imported and cached under the same source and stable local aliases.
    for(const dataset of datasets) {
      dataset.aliases=new Map();
      const entriesById=new Map(dataset.parsed.entries.map(entry=>[entry.trackId,entry]));
      for(const track of dataset.parsed.tracks) {
        const entry=entriesById.get(track.id),node=entry&&byPath.get(canonical(entry.sourcePath));
        if(!node)fail('USB内の音源参照を確認できません。');
        const id=node.localId??track.id;
        if(trackOwners.has(id)&&trackOwners.get(id)!==node)fail('USB内の曲のローカル参照が重複しています。');
        trackOwners.set(id,node);dataset.aliases.set(track.id,id);node.localId=id;
        if(!tracks.has(id)){tracks.set(id,{...track,id});entries.set(id,{...entry,trackId:id});}
        else if(!entries.get(id).analysisPath&&entry.analysisPath)entries.get(id).analysisPath=entry.analysisPath;
        state.tracks[id]={pdbId:node.pdb?.numericId??null,oneLibraryId:node.one?.contentId??null,audioPath:node.audioPath,
          analysisPaths:[...new Set([node.pdb?.analysisPath,node.one?.analysisPath].filter(Boolean).map(canonical))]};
      }
    }
    const lists=new Map(),listOwners=new Map(),playlistEntries=[];
    const byDevice={pdb:new Map(model.lists.filter(unit=>unit.pdb).map(unit=>[unit.pdb.numericId,unit])),
      one:new Map(model.lists.filter(unit=>unit.one).map(unit=>[unit.one.playlistId,unit]))};
    for(const dataset of datasets) {
      const numeric=new Map((dataset.parsed.playlistEntries??[]).map(entry=>[entry.localId,entry.deviceId]));
      for(const playlist of dataset.parsed.playlists) {
        const deviceId=numeric.get(playlist.id)??Number(/^usb-pl-[^-]+-(\d+)-/.exec(playlist.id)?.[1]);
        const unit=byDevice[dataset.format].get(deviceId);
        if(!unit)fail('USB内のプレイリスト参照を確認できません。');
        const id=unit.localId??playlist.id;
        if(listOwners.has(id)&&listOwners.get(id)!==unit)fail('USB内のプレイリストのローカル参照が重複しています。');
        listOwners.set(id,unit);unit.localId=id;
        const members=playlist.trackIds.map(trackId=>dataset.aliases.get(trackId));
        if(members.some(trackId=>!tracks.has(trackId)))fail('USBのプレイリストに不明な曲があります。');
        if(!lists.has(id)){
          lists.set(id,{...playlist,id,trackIds:members});
          playlistEntries.push({localId:id,deviceId,deviceFormat:dataset.format});
        }else{
          const target=lists.get(id),seen=new Set(target.trackIds);
          for(const trackId of members)if(!seen.has(trackId)){seen.add(trackId);target.trackIds.push(trackId);}
        }
      }
    }
    for(const [id,playlist] of lists) {
      const unit=listOwners.get(id);
      state.playlists[id]={pdbId:unit.pdb?.numericId??null,oneLibraryId:unit.one?.playlistId??null,
        baseline:previous?.nativeUSB?.playlists?.[id]?.baseline??structuredClone(playlist)};
    }
    return {...parsed,tracks:[...tracks.values()],entries:[...entries.values()],playlists:[...lists.values()],playlistEntries,
      warnings:[...new Set(datasets.flatMap(dataset=>dataset.parsed.warnings??[]))]};
  };
  const proxy={async read(operation,data,transfer) {
    if(operation==='analysis') {
      const original=data.track.rekordbox;
      const result=await reader.read(operation,{...data,track:physicalTrack(data.track,state.tracks[data.track.id])},transfer);
      captured.set(data.track.id,structuredClone(result));
      if(original)result.rekordbox=original;else delete result.rekordbox;
      return result;
    }
    return reader.read(operation,data,transfer);
  }};
  // Parsing is small compared with audio; refresh old caches/aliases and ANLZ,
  // while source-import's audio stamps still avoid copying encoded tracks.
  const sources=(options.sources??[]).map(source=>source.id===previous?.id?{...source,cacheVersion:0,analysisExtensions:{}}:source);
  const result=await cacheSourceLibrary({...options,index:session.index,candidate,reader:proxy,sources,
    sourceId:previous?.id??options.sourceId,transformParsed,sourceExtras:{nativeUSB:state}});
  const saved=(await library.getSources()).find(source=>source.nativeUSB?.rootId===session.root.id);
  if(!saved)fail('読み込んだUSBの参照を保存できませんでした。');
  for(const [id,binding] of Object.entries(state.tracks)) {
    abort(signal);const original=captured.get(id);if(!original)continue;
    const files=[];
    for(const analysisPath of binding.analysisPaths) for(const kind of ['DAT','EXT']) {
      const item=session.index.find(analysisPath.replace(/\.(DAT|EXT|2EX)$/i,`.${kind}`));
      if(!item||files.some(file=>file.path===item.path))continue;
      const hash=session.readHashes.get(item.path)??await sourceDigest(await readAnalysis(session,item.path,signal));
      files.push({path:item.path,kind,fingerprint:hash});
    }
    state.baselines[id]={signature:hotSignature(original),bpm:original.bpm,duration:original.duration,
      beatOffset:original.beatOffset,tempos:original.tempos,files};
  }
  for(const playlist of saved.parsed.playlists)state.playlists[playlist.id].baseline=structuredClone(playlist);
  saved.nativeUSB=state;await library.putSource(saved);
  return {...result,source:saved};
}

async function readAnalysis(session,path,signal) {
  abort(signal); const info = await session.bridge.stat(session.root.id,path);
  if (!info.exists || info.kind !== 'file' || info.size > MAX_ANALYSIS) fail(`${path}: 元の解析ファイルを読み取れません。`);
  const file = createAudioReadSource({name:path.split('/').at(-1),size:info.size,
    read:(offset,length) => {abort(signal); return session.bridge.readRange(session.root.id,path,{offset,length});}});
  const bytes=new Uint8Array(await file.arrayBuffer());
  session.readHashes.set(path,await sourceDigest(bytes));return bytes;
}
function verifyHotCues(track,files) {
  const expected = hotMarks(track), actual = mergeDeviceAnalysis(track,files.map(parseDeviceAnalysis),{allowAnonymousPath:true}).positionMarks.filter(mark=>mark.num>=0);
  if (expected.length !== actual.length || expected.some(mark => !actual.some(row => row.num === mark.num && row.type === mark.type &&
      Math.abs(row.start-mark.start) <= .003 && (mark.end == null ? row.end == null : Math.abs(row.end-mark.end) <= .003) &&
      row.name === mark.name.replace(/^\s*\[active\]\s*/i,'')))) fail('生成したHOT CUEの読み戻しが一致しません。USBは変更していません。');
}

async function existingPreparation(session,node,signal) {
  const raw=node.pdb??node.one, analysisPath=raw.analysisPath;
  if(!analysisPath)fail(`${raw.title}: 既存の解析ファイル参照がありません。rekordboxで解析してから読み込み直してください。`);
  let track={...raw,id:node.id,filename:raw.filename??node.audioPath.split('/').at(-1),bpm:raw.bpm||null,
    hotcues:Array(8).fill(null),positionMarks:[],tempos:[],cue:0,beatOffset:0,peaks:[],
    rekordbox:{trackId:String(node.pdbId),location:encodeRekordboxLocation(node.audioPath),size:raw.size??null}};
  delete track.fileType;
  const files=[];
  for(const kind of ['DAT','EXT']) {
    const item=session.index.find(analysisPath.replace(/\.(DAT|EXT|2EX)$/i,`.${kind}`));
    if(item)files.push(await readAnalysis(session,item.path,signal));
  }
  if(files.length) track=mergeDeviceAnalysis(track,files.map(parseDeviceAnalysis),{allowAnonymousPath:true});
  return {...raw,...track,fileType:raw.fileType,dateAdded:raw.dateAdded??raw.addedDate??''};
}

/** One staged native batch contains both indexes, ANLZ changes and new audio.
 * Every existing file has a compare-and-swap guard and a rollback journal. */
async function saveDevice({library,session,source,tracks=[],playlists=[],transfer=false,signal,onProgress=()=>{}}) {
  if(session.root.pendingTransactions)fail('中断されたUSBへの保存を「復旧」してから保存してください。');
  onProgress('Device Library・OneLibraryを確認しています…');
  const snapshot=await deviceSnapshot(session,signal,source);
  const old=source?.nativeUSB??{};
  const selected=transfer?tracks:tracks.filter(track=>old.tracks?.[track.id]);
  const model=planUSBMerge({pdb:snapshot.pdb,one:snapshot.one,state:old,tracks:selected,playlists});
  const blobs=new Map(),prepared=new Map(),writes=[],changed=new Map(),newBaselines={};
  const prepareInputs=[];
  for(const node of model.nodes) {
    abort(signal);
    if(node.isNew) {
      const track=node.localTrack,blob=await library.getAudio(track.id);
      if(!blob||track.audioMissing)fail(`${track.title}: 音源を先に接続してください。`);
      const info=await readUsbAudioInfo(blob,track.filename,{signal});
      if(Math.abs(info.duration-track.duration)>1.1)fail(`${track.title}: 音源と曲情報の長さが一致しません。`);
      const value={...track,...info,size:blob.size,numericId:node.pdbId};
      prepared.set(node.id,value);blobs.set(node.id,blob);prepareInputs.push(value);
    } else if(!node.pdb) {
      const raw=node.one;
      if(!raw.analysisPath)fail(`${raw.title}: 解析データの参照がないためDevice Libraryへ引き継げません。`);
      prepareInputs.push({...raw,id:node.id,numericId:node.pdbId,bpm:raw.bpm??0,
        reuseDeviceFile:{usbPath:node.audioPath,analysisPath:raw.analysisPath}});
    }
  }
  onProgress('両ライブラリの曲・プレイリストを準備しています…');
  const changes={tracks:prepareInputs,devicePlaylists:model.devicePlaylists,appendPlaylists:model.appendPlaylists,
    existingTrackIds:model.existingTrackIds,deviceName:session.root.name,includeAllPlaylist:false,
    idFloors:Object.fromEntries(['track','playlist','artist','album','genre','key','label'].map(key=>[key,Math.max(snapshot.pdb?.idFloors?.[key]||0,snapshot.one?.maxIds?.[key]||0)]))};
  const needsPdb=!snapshot.data.pdb||prepareInputs.length||model.devicePlaylists.length||model.appendPlaylists.length;
  const plan=needsPdb?(snapshot.data.pdb?await mergeLibrary({...changes,pdb:snapshot.data.pdb}):await planLibrary(changes)):{pdb:snapshot.data.pdb,tracks:[]};
  const plannedById=new Map(plan.tracks.map(item=>[item.id,item]));
  for(const node of model.nodes) {
    const planned=plannedById.get(node.id);
    if(planned){node.audioPath=planned.usbPath;node.analysisPath=planned.anlzPaths.dat;}
    else node.analysisPath=node.pdb?.analysisPath??node.one?.analysisPath;
  }
  const freshTracks=model.nodes.filter(node=>node.isNew);
  for(const [index,node] of freshTracks.entries()) {
    abort(signal);const track=prepared.get(node.id),planned=plannedById.get(node.id),blob=blobs.get(node.id);
    if(!planned||planned.numericId!==node.pdbId)fail('生成した曲IDの対応が一致しません。USBは変更していません。');
    onProgress(`波形・ビートグリッドを準備 ${index+1}/${freshTracks.length} — ${track.title}`);
    const meter=await createAnalysisMeter({sampleRate:track.sampleRate,channels:track.channels});let analysis;
    try{await feedUsbAudio(blob,track,meter,{signal});analysis=meter.finish(track,planned,{mp3AudioFrames:track.mp3AudioFrames});}
    finally{meter.dispose();}
    verifyHotCues(physicalTrack(track,{pdbId:node.pdbId,audioPath:node.audioPath}),[analysis.dat,analysis.ext]);
    writes.push({path:normalizeSourcePath(node.audioPath),blob,expectedFingerprint:null});
    const files=[];
    for(const [field,bytes] of Object.entries(analysis)) {
      const path=normalizeSourcePath(planned.anlzPaths[field]);
      writes.push({path,blob:new Blob([bytes]),expectedFingerprint:null});
      if(field==='dat'||field==='ext')files.push({path,kind:field.toUpperCase(),fingerprint:await sourceDigest(bytes)});
    }
    newBaselines[node.id]={signature:hotSignature(track),bpm:track.bpm,duration:track.duration,beatOffset:track.beatOffset,tempos:track.tempos,files};
    await new Promise(resolve=>setTimeout(resolve,0));
  }
  // Only explicitly edited, imported HOT CUEs are patched. Memory CUEs, grids,
  // waveforms and all unknown ANLZ sections remain byte-for-byte intact.
  for(const node of model.nodes) {
    const track=node.localTrack,baseline=old.baselines?.[node.localId];
    if(!track||node.isNew)continue;
    if(!baseline)fail(`${track.title}: USBを読み込み直してからCUEを保存してください。`);
    if(hotSignature(track)===baseline.signature)continue;
    if(!baseline.files.some(file=>file.kind==='DAT')||!baseline.files.some(file=>file.kind==='EXT'))fail(`${track.title}: 元のDAT・EXT解析ファイルが必要です。`);
    const cueTrack=physicalTrack({...track,bpm:baseline.bpm,duration:baseline.duration,beatOffset:baseline.beatOffset,tempos:baseline.tempos},
      {pdbId:node.pdbId,audioPath:node.audioPath});
    const patched=new Map(),files=[];
    for(const file of baseline.files) {
      const bytes=await readAnalysis(session,file.path,signal);
      if(await sourceDigest(bytes)!==file.fingerprint)fail(`${track.title}: USB側のCUEまたは波形が変更されています。USBを読み込み直してください。`);
      const next=await patchAnalysis(bytes,cueTrack,{kind:file.kind,hotOnly:true});abort(signal);
      const group=file.path.replace(/\.(DAT|EXT)$/i,'');
      if(!patched.has(group))patched.set(group,[]);patched.get(group).push(next);
      writes.push({path:file.path,blob:new Blob([next]),expectedFingerprint:file.fingerprint});
      files.push({...file,fingerprint:await sourceDigest(next)});
    }
    for(const group of patched.values())verifyHotCues(cueTrack,group);
    changed.set(node.id,{track,node});newBaselines[node.id]={...baseline,signature:hotSignature(track),files};
  }
  const addTracks=[];
  for(const node of model.nodes.filter(item=>!item.one)) {
    let track=prepared.get(node.id)??await existingPreparation(session,node,signal);
    if(changed.has(node.id))track={...track,hotcues:node.localTrack.hotcues,
      positionMarks:[...(track.positionMarks??[]).filter(mark=>mark.num<0),...hotMarks(node.localTrack)]};
    // Display labels such as "MP3 File" are not OneLibrary numeric file codes.
    if(typeof track.fileType!=='number'){track={...track};delete track.fileType;}
    addTracks.push({contentId:node.oneLibraryId,track:{...track,positionMarks:exportPositionMarks(track)},usbPath:node.audioPath,analysisPath:node.analysisPath});
  }
  const hotCueUpdates=[...changed.values()].filter(({node})=>node.one).map(({track,node})=>({contentId:node.oneLibraryId,marks:hotMarks(track)}));
  const needsOne=!snapshot.data.one||addTracks.length||model.addPlaylists.length||model.appendPlaylistTracks.length||hotCueUpdates.length;
  const one=needsOne?await updateOneLibrary(snapshot.data.one,{addTracks,addPlaylists:model.addPlaylists,
    appendPlaylistTracks:model.appendPlaylistTracks,hotCueUpdates,deviceName:session.root.name,signal}):snapshot.data.one;
  abort(signal);
  // Independent readers verify both formats before any USB write begins.
  const checkedPdb=await inspectLibrary(plan.pdb),checkedOne=await inspectOneLibrary(one,{signal});
  for(const node of model.nodes) {
    if(!checkedPdb.existingTracks.some(track=>track.numericId===node.pdbId&&canonical(track.usbPath)===canonical(node.audioPath))||
       !checkedOne.tracks.some(track=>track.contentId===node.oneLibraryId&&canonical(track.path)===canonical(node.audioPath)))fail('両ライブラリの音源参照が一致しません。USBは変更していません。');
  }
  const hashes={pdb:await sourceDigest(plan.pdb),one:await sourceDigest(one)};
  for(const [key,bytes] of [['pdb',plan.pdb],['one',one]]) if(hashes[key]!==snapshot.databases[key].fingerprint)
    writes.push({path:snapshot.databases[key].path,blob:new Blob([bytes]),expectedFingerprint:snapshot.databases[key].fingerprint});
  if(!writes.length)return {updatedTracks:0,updatedFiles:0,exportedTracks:0,writtenFiles:0};
  const writePaths=new Set(writes.map(item=>item.path));
  if(writePaths.size!==writes.length)fail('複数曲が同じ解析ファイルを参照しています。USBは変更していません。');
  const guards=[...new Map([...snapshot.guards,...Object.values(snapshot.databases).map(db=>({path:db.path,expectedFingerprint:db.fingerprint})),
    ...[...session.readHashes].map(([path,expectedFingerprint])=>({path,expectedFingerprint}))]
    .filter(item=>!writePaths.has(item.path)).map(item=>[item.path,item])).values()];
  abort(signal);
  await session.bridge.writeBatch(session.root.id,writes,{signal,onProgress:progress(onProgress),guards});
  for(const item of writes.filter(item=>!freshTracks.some(node=>normalizeSourcePath(node.audioPath)===item.path))) {
    if(await fingerprint(session.bridge,session.root.id,item.path)!==await sourceDigest(await item.blob.arrayBuffer()))
      fail('書き込んだUSBデータの照合に失敗しました。USBを外さず読み込み直してください。');
  }
  const next=source?structuredClone(source):{id:crypto.randomUUID(),label:session.root.name,trackIds:[],audioStamps:{},analysisExtensions:{},preparationHashes:{}};
  next.cacheVersion=0;next.kind='pdb';next.databasePath=snapshot.databases.pdb.path;next.digest=hashes.pdb;next.updatedAt=Date.now();
  next.trackIds=[...new Set([...next.trackIds,...model.nodes.map(node=>node.localId).filter(Boolean)])];
  next.nativeUSB={...old,rootId:session.root.id,rootName:session.root.name,oneLibrary:true,databaseFingerprint:hashes.pdb,
    databases:Object.fromEntries(Object.entries(snapshot.databases).map(([key,db])=>[key,{...db,fingerprint:hashes[key]}])),
    tracks:{...old.tracks},playlists:{...old.playlists},baselines:{...old.baselines,...newBaselines}};
  for(const node of model.nodes)if(node.localId)next.nativeUSB.tracks[node.localId]={pdbId:node.pdbId,oneLibraryId:node.oneLibraryId,audioPath:node.audioPath,
    analysisPaths:[...new Set([node.analysisPath,node.one?.analysisPath].filter(Boolean).map(canonical))]};
  for(const unit of model.lists)if(unit.localId)next.nativeUSB.playlists[unit.localId]={pdbId:unit.pdbId,oneLibraryId:unit.oneLibraryId,
    baseline:{name:unit.name,folderPath:unit.names.slice(0,-1),trackIds:unit.members.map(node=>node.localId).filter(Boolean)}};
  next.preparationHashes??={};
  for(const node of freshTracks)next.preparationHashes[node.localId]=await sourceDigest(new TextEncoder().encode(preparation(node.localTrack)));
  // Only mark exactly saved preparation as the baseline. A grid/BPM edit not
  // written by this HOT-only workflow remains pending on the next import.
  for(const {track,node} of changed.values()) {
    const base=newBaselines[node.id];
    if(track.bpm===base.bpm&&track.beatOffset===base.beatOffset&&JSON.stringify(track.tempos)===JSON.stringify(base.tempos))
      next.preparationHashes[track.id]=await sourceDigest(new TextEncoder().encode(preparation(track)));
  }
  await library.putSource(next);
  onProgress(`Device Library・OneLibraryへ保存しました（追加 ${freshTracks.length}曲・HOT CUE更新 ${changed.size}曲）。`);
  return {updatedTracks:changed.size,updatedFiles:writes.length,exportedTracks:freshTracks.length,writtenFiles:writes.length,source:next};
}

export async function writeNativeHotCues({library,source,tracks,signal,onProgress=()=>{},bridge}) {
  if(!source?.nativeUSB)fail('このUSBのライブラリを先に読み込んでください。');
  const session=await openNativeUSB({rootId:source.nativeUSB.rootId,bridge,signal});
  const playlists=(await library.getPlaylists()).filter(list=>source.nativeUSB.playlists?.[list.id]);
  return saveDevice({library,session,source,tracks,playlists,signal,onProgress});
}
export async function exportNativeUSB({library,session,tracks,playlists=[],signal,onProgress=()=>{}}) {
  if(!tracks.length)fail('転送する曲を選択してください。');
  const fresh=await openNativeUSB({rootId:session.root.id,bridge:session.bridge,signal});
  const source=(await library.getSources()).find(source=>source.nativeUSB?.rootId===fresh.root.id);
  return saveDevice({library,session:fresh,source,tracks,playlists,transfer:true,signal,onProgress});
}
