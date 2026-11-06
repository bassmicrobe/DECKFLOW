/** Read-only ANLZ selection and isolated staging for the pinned baken writer.
 * baken's native locator uses basenames. Never pass an unfiltered cache to it.
 * Beat expansion and PPTH layout adapted from baken 4.10.0 (MIT),
 * Copyright (c) 2025 Jesse Pinkman (JPHFA). See vendor/licenses/baken-MIT.txt.
 */
import {readFile,writeFile,readdir,realpath,lstat,mkdir} from 'node:fs/promises';
import {resolve,join,sep,dirname,basename} from 'node:path';
import {createHash} from 'node:crypto';
import {inspectAnalysis} from './usb-inspect.mjs';
import {parseRekordboxLocation} from '../dist/rekordbox-model.js';
import {exportTempos} from '../dist/usb-export.js';
const MAX_FILE = 64 * 1024 * 1024, MAX_SCAN = 512 * 1024 * 1024;
const hash = bytes => createHash('sha256').update(bytes).digest('hex');
const identity = path => path.replace(/\\/g,'/').replace(/^\/(?=[A-Za-z]:\/)/,'/').normalize('NFC');
const failure = message => { throw new Error(message); };
async function boundedRead(path) {
  const info = await lstat(path);
  if (!info.isFile() || info.isSymbolicLink() || info.size > MAX_FILE) failure(`ANLZは64 MiB以下の通常ファイルが必要です: ${path}`);
  return readFile(path);
}
/** Mirrors baken 4.10.0 grid.rs (MIT); all segments, not only the first BPM. */
export function expectedBeats(track) {
  const tempos = exportTempos(track), result = [];
  const barSteps = tempos.some(t => t.beat !== tempos[0].beat);
  for (let k=0;k<tempos.length;k++) {
    const t=tempos[k], next=tempos[k+1], period=60/t.bpm;
    let count;
    if (next) {
      const x=(next.start-t.start)/period, rounded=Math.max(1,Math.round(x));
      count=rounded;
      if (barSteps) {
        const step=(next.beat+4-t.beat)%4, fits=n=>Math.abs(x-n)<=n*.01;
        if (!fits(rounded) || rounded%4!==step) {
          const first=step||4, nearest=first+4*Math.max(0,Math.round((x-first)/4));
          count=fits(nearest)?nearest:first;
        }
      }
    } else count=Math.max(0,Math.ceil((Math.ceil(track.duration)-t.start)/period));
    if (result.length+count>1000000) failure('ビートグリッドが大きすぎます。');
    for(let i=0;i<count;i++) result.push({beat:(t.beat-1+i)%4+1,bpm:Math.round(t.bpm*100)/100,time:Math.round((t.start+i*period)*1000)/1000});
  }
  return result;
}
export function verifyBeatGrid(track, beats) {
  const expected=expectedBeats(track);
  // XML TotalTime truncates fractional seconds. Model that bounded extra tail
  // using the final TEMPO as well, so every carried beat is still validated.
  const extended=expectedBeats({...track,duration:Math.floor(track.duration)+1});
  if (!beats.length || !expected.length) failure(`${track.filename}: ビートグリッドがありません。`);
  for(let i=0;i<beats.length;i++) {
    const candidate=extended[i];
    if (!candidate || Math.abs(beats[i].time-candidate.time)>.003 || Math.abs(beats[i].bpm-candidate.bpm)>.011 || beats[i].beat!==candidate.beat) {
      failure(`${track.filename}: ANLZのビートグリッドとXML/TEMPOが一致しません。元のXMLと解析ファイルの組み合わせを確認してください。`);
    }
  }
  if(expected.slice(beats.length).some(beat=>beat.time<Math.floor(track.duration)-.003)) {
    failure(`${track.filename}: ANLZの長さとXMLの曲長が一致しません。`);
  }
}
export function rewriteAnalysisPath(bytes,path) {
  inspectAnalysis(bytes);
  const headerLength=new DataView(bytes.buffer,bytes.byteOffset,bytes.byteLength).getUint32(4);
  const parts=[Buffer.from(bytes.subarray(0,headerLength))];
  let at=parts[0].length, found=false;
  while(at<bytes.length) {
    const len=new DataView(bytes.buffer,bytes.byteOffset,bytes.byteLength).getUint32(at+8);
    const part=Buffer.from(bytes.subarray(at,at+len));
    if(part.toString('ascii',0,4)==='PPTH') {
      if(found) failure('ANLZに重複したPPTHがあります。');
      found=true;
      const body=Buffer.from(path+'\0','utf16le');body.swap16();
      const ppth=Buffer.alloc(16+body.length);ppth.write('PPTH');ppth.writeUInt32BE(16,4);ppth.writeUInt32BE(ppth.length,8);ppth.writeUInt32BE(body.length,12);body.copy(ppth,16);parts.push(ppth);
    } else parts.push(part);
    at+=len;
  }
  if(!found) failure('ANLZに音源のPPTHがありません。');
  const output=Buffer.concat(parts);output.writeUInt32BE(output.length,8);return output;
}
async function mappedPath(base,value) {
  if(typeof value!=='string'||!value||value.startsWith('/')||/[\\\0]/.test(value)||value.split('/').some(p=>!p||p==='.'||p==='..')||!/^ANLZ0000\.DAT$/i.test(basename(value))) failure('analysis-mapには解析フォルダ内の相対ANLZ0000.DATパスを指定してください。');
  let current=base;
  for(const part of value.split('/')) {current=join(current,part);if((await lstat(current)).isSymbolicLink())failure('analysis-mapにシンボリックリンクは指定できません。');}
  const path=await realpath(current);if(!path.startsWith(base+sep))failure('解析フォルダ外のファイルは使用できません。');return path;
}
export async function stageAnalysisSources({library,sources,analysisDir,analysisMapPath,stageDir}) {
  await mkdir(stageDir,{recursive:true});
  const result=new Map(library.tracks.map(t=>[t.id,{status:'generated',reason:analysisDir?'matching-full-path-not-found':'analysis-dir-not-specified'}]));
  if(!analysisDir) {if(analysisMapPath)failure('--analysis-mapには--analysis-dirも必要です。');return result;}
  const base=await realpath(analysisDir), byPath=new Map();
  let count=0, scanned=0;
  const walk=async (directory,depth=0)=> {
    if(depth>12) failure('ANLZフォルダの階層が深すぎます。USBANLZフォルダを指定してください。');
    for(const item of await readdir(directory,{withFileTypes:true})) {
      if(++count>100000)failure('解析フォルダの項目が多すぎます。USBANLZフォルダを絞ってください。');
      if(item.name.startsWith('.')||item.isSymbolicLink())continue;
      const path=join(directory,item.name);
      if(item.isDirectory())await walk(path,depth+1);
      else if(item.isFile()&&/^ANLZ0000\.DAT$/i.test(item.name)) {
        const bytes=await boundedRead(path);scanned+=bytes.length;if(scanned>MAX_SCAN)failure('解析キャッシュが512 MiBを超えています。対象フォルダを絞ってください。');
        const data=inspectAnalysis(bytes);if(!data.path)failure(`ANLZに音源パスがありません: ${path}`);
        const key=identity(data.path);if(!byPath.has(key))byPath.set(key,[]);byPath.get(key).push(path);
      }
    }
  };
  await walk(base);
  let map={};
  if(analysisMapPath) {
    const text=await boundedRead(analysisMapPath);if(text.length>1024*1024)failure('analysis-mapは1 MiB以下で指定してください。');
    const input=JSON.parse(text);
    if(input?.format!=='deckflow.analysis-map'||input.version!==1||!input.tracks||typeof input.tracks!=='object'||Array.isArray(input.tracks))failure('analysis-mapの形式が正しくありません。');
    map=input.tracks;
    if(Object.keys(map).some(id=>!result.has(id)))failure('analysis-mapにライブラリにない曲IDがあります。');
  }
  const used=new Set(), names=new Map();
  for(const t of library.tracks)names.set(t.filename,(names.get(t.filename)||0)+1);
  for(let index=0;index<library.tracks.length;index++) {
    const track=library.tracks[index], paths=new Set([identity(sources.get(track.id))]);
    if(track.rekordbox)paths.add(parseRekordboxLocation(track.rekordbox.location).identity);
    let matches=[...new Set([...paths].flatMap(path=>byPath.get(path)||[]))];
    const explicit=Object.hasOwn(map,track.id);
    if(explicit) matches=[await mappedPath(base,map[track.id])];
    if(!matches.length)continue;
    if(matches.length!==1)failure(`${track.filename}: 同じ音源パスのANLZが複数あります。--analysis-mapで指定してください。`);
    if(names.get(track.filename)>1)failure(`${track.filename}: 同名曲がライブラリ内に複数あるため、ANLZ引き継ぎの対象を分けて書き出してください。`);
    const datPath=matches[0];if(used.has(datPath))failure('同じANLZを複数の曲に割り当てることはできません。');used.add(datPath);
    if (track.rekordbox?.size != null && (await lstat(sources.get(track.id))).size !== track.rekordbox.size) failure(`${track.filename}: 音源サイズがXMLのSizeと一致しません。ANLZの引き継ぎを中止しました。`);
    const sourceFiles={}, files={}, sourceHash={};
    let originalPath;
    for(const extension of ['DAT','EXT','2EX']) {
      const path=datPath.replace(/\.DAT$/i,'.'+extension);
      let bytes;
      try {bytes=await boundedRead(path);}catch(error){if(extension==='2EX'&&error.code==='ENOENT')continue;throw error;}
      const data=inspectAnalysis(bytes);
      if(extension==='DAT') {verifyBeatGrid(track,data.beats);originalPath=data.path;}
      if(data.path!==originalPath)failure(`${track.filename}: ANLZファイル間の音源パスが一致しません。`);
      if(!data.path||(!explicit&&!paths.has(identity(data.path))))failure(`${track.filename}: ANLZファイル間の音源パスが一致しません。`);
      files[extension]=data;sourceFiles[extension]=path;sourceHash[extension]=hash(bytes);
      const destination=join(stageDir,'DECKFLOW',String(index+1));await mkdir(destination,{recursive:true});
      await writeFile(join(destination,`ANLZ0000.${extension}`),rewriteAnalysisPath(bytes,sources.get(track.id)),{flag:'wx'});
    }
    if(!files.DAT.tags.includes('PWAV')||!files.EXT.tags.includes('PWV3'))failure(`${track.filename}: 引き継ぐANLZに波形データが不足しています。`);
    result.set(track.id,{status:'reused',reason:explicit?'explicit-analysis-map':'exact-source-path',sourceFiles,sourceHash,files});
  }
  return result;
}
export function verifyAnalysisCarryover(track,selection,deviceTrack) {
  if(selection.status!=='reused')return;
  for(const [extension,source] of Object.entries(selection.files)) {
    const output=deviceTrack[{DAT:'dat',EXT:'ext','2EX':'two'}[extension]];
    if(!output)failure(`${track.filename}: .${extension}解析ファイルが引き継がれていません。`);
    for(const tag of Object.keys(source.sectionHashes).filter(tag=>/^PW(?:AV|V\d)$/.test(tag)||tag==='PQTZ'||tag==='PQT2')) {
      if(JSON.stringify(source.sectionHashes[tag])!==JSON.stringify(output.sectionHashes[tag]))failure(`${track.filename}: ${tag}の波形／ビートデータが元ファイルと一致しません。`);
    }
  }
}
