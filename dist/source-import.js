import {databaseBytes, sourceDigest, sourceFileStamp, normalizeSourcePath} from './library-source.js?v=15d483d12b5c45ed';
import {isAudioFile} from './file-drop.js?v=15d483d12b5c45ed';
const pause = () => new Promise(resolve=>setTimeout(resolve,0));
const preparation = track => JSON.stringify({bpm:track.bpm,beatOffset:track.beatOffset||0,cue:track.cue||0,
  hotcues:track.hotcues??Array(8).fill(null),tempos:track.tempos??[],positionMarks:track.positionMarks??[]});
function sourceBindings(index,entries,signal){
  const bindings=new Map(),audioOwners=new Map(),analysisOwners=new Map();
  const associate=(owners,item,identity)=>{
    if(!item)return;
    if(!owners.has(item.path))owners.set(item.path,new Set());
    owners.get(item.path).add(identity);
  };
  // Resolve every reference first. A unique suffix within the selected folder
  // is still ambiguous if two different original DB paths resolve to it.
  for(const entry of entries){
    signal?.throwIfAborted();
    const originalAudio=normalizeSourcePath(entry.sourcePath),audio=index.find(entry.sourcePath,{suffix:true});
    associate(audioOwners,audio,originalAudio);
    const analyses=entry.analysisPath?['DAT','EXT'].flatMap(extension=>{
      const path=entry.analysisPath.replace(/\.(?:DAT|EXT|2EX)$/i,`.${extension}`),item=index.find(path,{suffix:true});
      if(!item)return [];
      // The same anonymous ANLZ must not supply preparation to different
      // original audio paths, even when its '?/basename' happens to match.
      associate(analysisOwners,item,JSON.stringify([normalizeSourcePath(path),originalAudio]));
      return [{extension,item}];
    }):[];
    bindings.set(entry.trackId,{audio,analyses});
  }
  for(const binding of bindings.values()){
    binding.audioAmbiguous=!!binding.audio&&audioOwners.get(binding.audio.path).size>1;
    if(binding.audioAmbiguous)binding.audio=null;
    binding.analysisAmbiguous=binding.analyses.some(({item})=>analysisOwners.get(item.path).size>1);
    binding.analyses=binding.analyses.filter(({item})=>analysisOwners.get(item.path).size===1);
  }
  return bindings;
}
/** Additive, read-only import. Metadata opens first; audio is copied encoded, never decoded here. */
export async function cacheSourceLibrary({library,index,candidate,sources=[],sourceId,reader,signal,saveTrack,onProgress=()=>{},onTrack=()=>{},onMetadata=()=>{}}) {
  signal?.throwIfAborted(); onProgress('データベースを確認しています…');
  const bytes=await databaseBytes(index,candidate), digest=await sourceDigest(bytes);
  signal?.throwIfAborted();
  let previous=sourceId?sources.find(source=>source.id===sourceId):sources.find(source=>source.digest===digest && source.databasePath===candidate.path);
  if (sourceId && !previous) throw new Error('更新するライブラリが見つかりません。新しく開いてください。');
  const id=previous?.id || crypto.randomUUID();
  const cached=previous?.cacheVersion===1 && previous?.digest===digest && previous?.parsed;
  const parsed=cached?previous.parsed:await reader.read('database',{kind:candidate.kind,bytes,sourceId:id,databaseKind:candidate.kind==='sqlite'?(candidate.path.toLowerCase().endsWith('/master.db')||candidate.path.toLowerCase()==='master.db'?'master':'device'):undefined},[bytes.buffer]);
  signal?.throwIfAborted();
  const bindings=sourceBindings(index,parsed.entries,signal);
  const existing=new Map((await library.getTracks()).map(track=>[track.id,track]));
  const baseline=new Map((previous?.parsed?.tracks??parsed.tracks).map(track=>[track.id,track]));
  for(const track of parsed.tracks)if(!baseline.has(track.id))baseline.set(track.id,track);
  // The app serializes this callback with edits and returns the actual stored
  // record. null means the track was deleted meanwhile; never resurrect it.
  const persist=async(next,blob,base)=>{
    signal?.throwIfAborted();
    const stored=saveTrack?await saveTrack(next,blob,base,{signal}):(await library.putTrack(next,blob,{signal}),next);
    if(stored===null){existing.delete(next.id);return null;}
    const result=stored??next;existing.set(result.id,result);onTrack(result);return result;
  };
  signal?.throwIfAborted();
  const source={id,cacheVersion:1,label:index.label,databasePath:candidate.path,kind:candidate.kind,digest,parsed,trackIds:parsed.tracks.map(track=>track.id),audioStamps:{...previous?.audioStamps},
    analysisExtensions:{...previous?.analysisExtensions},preparationHashes:{...previous?.preparationHashes},updatedAt:Date.now(),cachedAudio:0};
  // Register the source and its metadata together. A full source list or a
  // failed reference write must not leave orphan tracks before audio copying.
  const imported=await library.importTracks(parsed.tracks,parsed.playlists,source);
  for (const track of parsed.tracks) if (!existing.has(track.id)) existing.set(track.id,track);
  const result={...imported,metadataCached:!!cached,copied:0,reused:0,missing:0,warnings:[...(parsed.warnings||[])]};
  // Later cancellation keeps the registered source and completed tracks usable.
  try {
    await onMetadata();
    let count=0;
    for (const entry of parsed.entries) {
      signal?.throwIfAborted();
      let track=existing.get(entry.trackId); if (!track) continue;
      onProgress(`音源をキャッシュ ${++count} / ${parsed.entries.length} — ${track.title}`);
      const binding=bindings.get(entry.trackId),availableAnalysis=binding.analyses;
      if(binding.audioAmbiguous)result.warnings.push(`${track.title}: 異なる元音源のパスが同じ選択ファイルに対応するため、自動接続しませんでした。元のフォルダ構成で選び直してください。`);
      if(binding.analysisAmbiguous)result.warnings.push(`${track.title}: 異なる元音源・解析パスが同じANLZファイルに対応するため、その解析情報を取り込みませんでした。`);
      const previousExtensions=source.analysisExtensions[track.id]??[];
      const newAnalysis=availableAnalysis.some(({extension})=>!previousExtensions.includes(extension));
      // Resume placeholders committed before a cancelled first import. Adopt
      // preparation only while unchanged from its original DB snapshot; local
      // cue/grid edits survive even when preview peaks are still missing.
      if (entry.analysisPath && (!track.peaks?.length || newAnalysis)) {
        const files=[];
        try {
          for (const {item} of availableAnalysis) {
            const file=await item.getFile();if(file.size>32*1024*1024) throw new Error('解析ファイルは32 MB以内で選んでください。');
            signal?.throwIfAborted();
            files.push(new Uint8Array(await file.arrayBuffer()));
            signal?.throwIfAborted();
          }
          if (!files.length&&!binding.analysisAmbiguous) result.warnings.push(`${track.title}: 解析ファイルが未選択のため、既存波形とビートグリッドを引き継いでいません。`);
          if (files.length) {
            const enriched=await reader.read('analysis',{track,files,preserveCues:parsed.sourceFormat==='master'},files.map(file=>file.buffer));
            signal?.throwIfAborted();
            const priorHash=source.preparationHashes[track.id],currentPreparation=preparation(track);
            const unchanged=priorHash?await sourceDigest(new TextEncoder().encode(currentPreparation))===priorHash:currentPreparation===preparation(baseline.get(track.id));
            const next=unchanged?{...enriched,title:track.title,artist:track.artist}:{...track,peaks:enriched.peaks};
            track=await persist(next,undefined,track);
            if(!track)continue;
            source.analysisExtensions[track.id]=availableAnalysis.map(({extension})=>extension);
            if(unchanged)source.preparationHashes[track.id]=await sourceDigest(new TextEncoder().encode(preparation(enriched)));
            if(!source.analysisExtensions[track.id].includes('EXT'))result.warnings.push(`${track.title}: EXT解析ファイルがないため、DATに含まれる波形・CUEだけを引き継ぎました。`);
          }
        } catch (error) { if(signal?.aborted||error.cause?.name==='QuotaExceededError'||/保存容量/.test(error.message)) throw error;result.warnings.push(`${track.title}: 既存波形を読めませんでした（${error.message}）。`); }
      }
      const item=binding.audio;
      if (!item) { if(track.audioMissing) result.missing++;else result.reused++;continue; }
      try {
        const file=await item.getFile();signal?.throwIfAborted();
        const stamp=sourceFileStamp(file,item.path);
        if (!track.audioMissing) {
          result.reused++;
          if (source.audioStamps[track.id] && source.audioStamps[track.id]!==stamp) result.warnings.push(`${track.title}: 元の音源に変更があります。保存済み音源を保持しました。元音源の変更は自動反映しません。`);
          continue;
        }
        if (!isAudioFile(file) || !Number.isSafeInteger(file.size) || file.size <= 0) throw new Error('空でない音源ファイルを選んでください。');
        if (track.rekordbox?.size && track.rekordbox.size!==file.size) throw new Error('データベースと音源のサイズが異なります。元の音源を確認してください。');
        track=await persist({...track,audioMissing:false,fingerprint:`${file.name}|${file.size}|${file.lastModified||0}`},file,track);
        if(!track)continue;
        source.audioStamps[track.id]=stamp;result.copied++;
      } catch(error) {
        if (signal?.aborted || error.cause?.name==='QuotaExceededError' || /保存容量/.test(error.message)) throw error;
        result.missing++;result.warnings.push(`${track.title}: ${error.message}`);
      }
      if (count%10===0) await pause();
    }
    return result;
  } finally {
    source.cachedAudio=source.trackIds.filter(id=>existing.get(id)?.audioMissing===false).length;
    source.updatedAt=Date.now();await library.putSource(source);
  }
}
