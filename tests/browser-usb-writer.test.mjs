import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile, writeFile, mkdtemp, mkdir, rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {createHash} from 'node:crypto';
import {initWriter, planLibrary, createAnalysisMeter, patchAnalysis} from '../dist/vendor/browser-usb/writer.js';
import {inspectPdb, inspectAnalysis, readExport} from '../tools/usb-inspect.mjs';
import {parseDeviceDatabase, parseDeviceAnalysis} from '../dist/rekordbox-device.js';

const wasm = await readFile(new URL('../dist/vendor/browser-usb/writer.wasm', import.meta.url));
await initWriter({wasmBytes:wasm});
const sampleRate = 44100, duration = 2;
const source = (overrides = {}) => ({id:'original/日本語', title:'曲「赤」', artist:'DJ 日本語',
  filename:'曲「赤」.wav', bpm:128, duration, beatOffset:.125, cue:.25,
  hotcues:[.5,null,null,null,null,null,null,1.5],
  addedAt:'2026-11-07T00:00:00Z', size:44 + sampleRate * duration * 4,
  sampleRate, bitRate:1411, bitDepth:16,
  positionMarks:[{name:'Memory loop',type:4,start:.25,end:.75,num:-1,color:null},
    {name:'Red A',type:0,start:.5,end:null,num:0,color:[230,40,40]},
    {name:'Last H',type:0,start:1.5,end:null,num:7,color:[48,90,255]}], ...overrides});

function samples() {
  const pcm = new Float32Array(sampleRate * duration * 2);
  for (let i = 0; i < pcm.length / 2; i++) {
    const time = i / sampleRate;
    const value = Math.round((Math.sin(time * 2 * Math.PI * 90) * .3 + Math.sin(time * 2 * Math.PI * 3200) * .05) * 32767) / 32768;
    pcm[i * 2] = pcm[i * 2 + 1] = value;
  }
  return pcm;
}
async function generated(track = source(), chunk = 1554) {
  const plan = await planLibrary({tracks:[track]});
  const meter = await createAnalysisMeter({sampleRate,channels:2});
  meter.push(new Float32Array());
  const pcm = samples();
  for (let at = 0; at < pcm.length; at += chunk) meter.push(pcm.subarray(at, at + chunk));
  return {plan, files:meter.finish(track,plan.tracks[0]),pcm};
}
function sections(bytes) {
  const result = [], view = new DataView(bytes.buffer,bytes.byteOffset,bytes.byteLength);
  for (let at = view.getUint32(4); at < bytes.length;) {
    const length = view.getUint32(at+8), tag = new TextDecoder().decode(bytes.subarray(at,at+4));
    const data = bytes.slice(at,at+length);
    result.push({tag,list:['PCOB','PCO2'].includes(tag) ? view.getUint32(at+12) : null,bytes:data}); at += length;
  }
  return result;
}
function rebuild(bytes, parts, extraHeader = new Uint8Array()) {
  const oldHeader = new DataView(bytes.buffer,bytes.byteOffset).getUint32(4);
  const size = oldHeader + extraHeader.length + parts.reduce((size,part) => size+part.bytes.length,0);
  const result = new Uint8Array(size), view = new DataView(result.buffer);
  result.set(bytes.subarray(0,oldHeader)); result.set(extraHeader,oldHeader);
  view.setUint32(4,oldHeader+extraHeader.length); view.setUint32(8,size);
  let at = oldHeader+extraHeader.length;
  for (const part of parts) {result.set(part.bytes,at);at+=part.bytes.length;}
  return result;
}

test('the bundled writer has verified provenance and no host imports', async () => {
  const provenance = JSON.parse(await readFile(new URL('../dist/vendor/browser-usb/provenance.json', import.meta.url)));
  assert.equal(createHash('sha256').update(wasm).digest('hex'),provenance.wasmSha256);
  assert.equal(provenance.upstream.revision,'50d2ba07fdad49d3a95e02d2951ac7a67197e85a');
  assert.deepEqual(WebAssembly.Module.imports(await WebAssembly.compile(wasm)),[]);
});

test('WASM PDB crosses page boundaries and preserves metadata, Unicode, nested playlists and ordering', async () => {
  const tracks = Array.from({length:220},(_,i) => source({id:`track-${i}`,title:`Track ${i} 曲`,artist:`Artist ${i % 11}`,
    album:`Album ${i % 7}`,genre:'House',key:'Am',filename:i % 2 ? 'same.wav' : '同名曲.wav'}));
  const playlists = [{id:'p1',name:'夕方',folderPath:['Sets','2026'],trackIds:tracks.map(t => t.id).reverse()},
    {id:'p2',name:'空',folderPath:['Sets'],trackIds:[]}];
  const plan = await planLibrary({tracks,playlists,deviceName:'DECKFLOW iPad'});
  const inspected = inspectPdb(plan.pdb), imported = parseDeviceDatabase(plan.pdb);
  assert.equal(inspected.tracks.length,tracks.length); assert.equal(imported.tracks.length,tracks.length);
  assert.equal(new Set(plan.tracks.map(track => track.usbPath.toLowerCase())).size,tracks.length);
  assert.equal(imported.tracks[219].artist,tracks[219].artist);
  assert.equal(inspected.tracks[0].size,tracks[0].size);
  assert.equal(inspected.tracks[0].sampleRate,sampleRate);
  assert.equal(inspected.tracks[0].bitRate,1411);
  assert.equal(inspected.tracks[0].bpm,128);
  for (const [index,track] of inspected.tracks.entries()) {
    assert.equal(track.path,plan.tracks[index].usbPath);
    assert.equal(track.analysisPath,plan.tracks[index].anlzPaths.dat);
  }
  assert.deepEqual(inspected.playlists.find(p => p.name==='夕方').trackIds,tracks.map((_,i) => i+1).reverse());
  assert.deepEqual(imported.playlists.find(p => p.name==='夕方').folderPath,['Sets','2026']);
  const repeat = await planLibrary({tracks,playlists,deviceName:'DECKFLOW iPad'});
  assert.deepEqual(repeat.pdb,plan.pdb,'deterministic plan');
});

test('streamed PCM produces readable full-detail waveform/grid/eight HOT CUE files independently of chunk size', async () => {
  const {files,plan} = await generated();
  const whole = await generated(source(),sampleRate*duration*2);
  for (const key of ['dat','ext','ex2']) {
    assert.deepEqual(files[key],whole.files[key]);
    assert.equal(inspectAnalysis(files[key]).path,plan.tracks[0].usbPath);
    assert.ok(parseDeviceAnalysis(files[key]));
  }
  const dat = inspectAnalysis(files.dat), ext = inspectAnalysis(files.ext), ex2 = inspectAnalysis(files.ex2);
  assert.equal(dat.beats[0].time,.125); assert.equal(dat.beats[0].bpm,128);
  assert.ok(dat.cues.some(cue => cue.number===1 && cue.time===.5));
  assert.ok(ext.cues.some(cue => cue.number===8 && cue.time===1.5));
  assert.ok(ext.detailedCues.some(cue => cue.number===1 && cue.colorCode===0x2a && cue.name==='Red A'));
  assert.ok(ext.tags.includes('PWV5')); assert.ok(ex2.tags.includes('PWV7'));
  const detail = sections(files.ext).find(section => section.tag==='PWV3').bytes;
  assert.equal(new DataView(detail.buffer,detail.byteOffset).getUint32(16),duration*150);
});

test('HOT CUE patch preserves header extensions, every unrelated section and memory cues byte-for-byte', async () => {
  const {files} = await generated();
  const edited = source({hotcues:[null,1.1,null,null,null,null,null,1.75],positionMarks:[
    {name:'Ignored changed memory',type:0,start:.1,end:null,num:-1,color:[9,10,11]},
    {name:'New B loop',type:4,start:1.1,end:1.4,num:1,color:[230,40,40]},
    {name:'Moved H',type:0,start:1.75,end:null,num:7,color:[180,50,255]}]});
  for (const [key,kind] of [['dat','DAT'],['ext','EXT'],['ex2','2EX']]) {
    const parts = sections(files[key]);
    const unknown = new Uint8Array(20); unknown.set(new TextEncoder().encode('ZZZZ'));
    const unknownView = new DataView(unknown.buffer); unknownView.setUint32(4,12);unknownView.setUint32(8,20);
    unknown.set([5,9,17,23,31,43,59,71],12); parts.splice(1,0,{tag:'ZZZZ',bytes:unknown});
    const original = rebuild(files[key],parts,Uint8Array.of(101,102,103,104));
    const before = original.slice();
    const patched = await patchAnalysis(original,edited,{kind});
    assert.deepEqual(original,before,'source bytes are never mutated');
    assert.deepEqual(patched.subarray(12,32),before.subarray(12,32),'header extension preserved');
    const kept = parts.filter(p => !(['PCOB','PCO2'].includes(p.tag) && p.list===1));
    const afterKept = sections(patched).filter(p => !(['PCOB','PCO2'].includes(p.tag) && p.list===1));
    assert.deepEqual(afterKept.map(p=>p.bytes),kept.map(p=>p.bytes));
    if (kind==='2EX') assert.deepEqual(patched,original);
    if (kind==='EXT') {
      const cues = inspectAnalysis(patched).detailedCues;
      assert.ok(cues.some(cue => cue.number===2 && cue.time===1.1 && cue.end===1.4 && cue.name==='New B loop'));
      assert.ok(cues.some(cue => cue.number===8 && cue.time===1.75));
      assert.ok(!cues.some(cue => cue.number===1));
      assert.ok(cues.some(cue => cue.number===0 && cue.name==='Memory loop' && cue.time===.25));
    }
  }
});

test('missing HOT CUE sections can be added, malformed ANLZ and invalid PCM are rejected', async () => {
  const {files} = await generated();
  const removed = rebuild(files.ext,sections(files.ext).filter(p=>!(['PCOB','PCO2'].includes(p.tag) && p.list===1)));
  const patched = await patchAnalysis(removed,source(),{kind:'EXT'});
  assert.ok(inspectAnalysis(patched).detailedCues.some(cue=>cue.number===8));
  assert.deepEqual(sections(patched).map(p=>[p.tag,p.list]),sections(files.ext).map(p=>[p.tag,p.list]),'missing containers return to canonical section order');
  const broken = files.dat.slice(); new DataView(broken.buffer).setUint32(8,broken.length-1);
  await assert.rejects(patchAnalysis(broken,source(),{kind:'DAT'}),/length/);
  const parts = sections(files.ext), duplicate = parts.find(p=>p.tag==='PCO2' && p.list===1);
  await assert.rejects(patchAnalysis(rebuild(files.ext,[...parts,duplicate]),source(),{kind:'EXT'}),/Duplicate/);
  await assert.rejects(planLibrary({tracks:[source({size:0})]}),/サイズ/);
  await assert.rejects(planLibrary({tracks:[source({filename:'../audio.wav'})]}),/ファイル名/);
  const meter = await createAnalysisMeter({sampleRate,channels:2});
  assert.throws(()=>meter.push(new Float32Array(3)),/PCM/);
  assert.throws(()=>meter.push(new Float32Array([NaN,0])),/PCM/);
  meter.dispose(); assert.throws(()=>meter.push(new Float32Array(2)),/終了/);
});

test('in-place HOT CUE edits preserve player-palette colors and untouched opaque cue fields',async()=>{
  const track=source({positionMarks:[
    {name:'Magenta A',type:0,start:.5,end:null,num:0,color:[222,68,207]},
    {name:'Keep H',type:0,start:1.5,end:null,num:7,color:[180,50,255]},
  ]});
  const {files}=await generated(track),parts=sections(files.ext);
  const hot=parts.find(p=>p.tag==='PCO2'&&p.list===1);
  const rows=bytes=>{
    const map=new Map(),view=new DataView(bytes.buffer,bytes.byteOffset,bytes.byteLength);
    for(let at=20;at<bytes.length;){const len=view.getUint32(at+8);map.set(view.getUint32(at+12),bytes.subarray(at,at+len));at+=len;}
    return map;
  };
  rows(hot.bytes).get(8)[rows(hot.bytes).get(8).length-1]=0xa5;
  rows(hot.bytes).get(1)[rows(hot.bytes).get(1).length-1]=0xb6;
  const original=rebuild(files.ext,parts),parsed=parseDeviceAnalysis(original);
  const edited=source({...track,positionMarks:parsed.positionMarks.map(mark=>mark.num===0?{...mark,start:.75}:mark),
    hotcues:[.75,null,null,null,null,null,null,1.5]});
  const patched=await patchAnalysis(original,edited,{kind:'EXT'});
  const after=sections(patched).find(p=>p.tag==='PCO2'&&p.list===1);
  assert.deepEqual(rows(after.bytes).get(8),rows(hot.bytes).get(8),'untouched cue keeps all opaque bytes');
  const beforeColor=inspectAnalysis(original).detailedCues.find(cue=>cue.number===1);
  const afterColor=inspectAnalysis(patched).detailedCues.find(cue=>cue.number===1);
  assert.equal(beforeColor.colorCode,0x31);assert.equal(afterColor.colorCode,0x31);
  assert.deepEqual(afterColor.color,beforeColor.color);assert.equal(afterColor.time,.75);
  assert.equal(rows(after.bytes).get(1).at(-1),0,'changed timing resets old opaque seek fields');
});

const baken = process.env.DECKFLOW_BAKEN_BIN;
test('WASM waveform and CUE section bytes equal the original native baken export for identical decoded audio',
  {skip:!baken,timeout:120000},async () => {
  const {exportUsb} = await import('../tools/export-usb.mjs');
  const {files,pcm} = await generated();
  const track = source(), dir = await mkdtemp(join(tmpdir(),'deckflow-wasm-oracle-'));
  try {
    const audio = join(dir,'audio'); await mkdir(audio);
    const wav = Buffer.alloc(44+pcm.length*2);
    wav.write('RIFF');wav.writeUInt32LE(wav.length-8,4);wav.write('WAVEfmt ',8);
    wav.writeUInt32LE(16,16);wav.writeUInt16LE(1,20);wav.writeUInt16LE(2,22);
    wav.writeUInt32LE(sampleRate,24);wav.writeUInt32LE(sampleRate*4,28);wav.writeUInt16LE(4,32);wav.writeUInt16LE(16,34);
    wav.write('data',36);wav.writeUInt32LE(pcm.length*2,40);
    for (let i=0;i<pcm.length;i++) wav.writeInt16LE(Math.round(pcm[i]*32768),44+i*2);
    await writeFile(join(audio,track.filename),wav);
    const libraryPath=join(dir,'library.json');
    await writeFile(libraryPath,JSON.stringify({format:'deckflow.library',version:1,tracks:[track],playlists:[]}));
    const out=join(dir,'USB'); await exportUsb({libraryPath,audioDir:audio,out,bakenPath:baken,quiet:true});
    const [native] = (await readExport(out)).tracks;
    for (const [key,extension] of [['dat','DAT'],['ext','EXT'],['ex2','2EX']]) {
      const bytes = await readFile(native.analysis.replace(/\.DAT$/,`.${extension}`));
      const hashes = data => sections(data).filter(p=>p.tag!=='PPTH').map(p=>({tag:p.tag,
        sha256:createHash('sha256').update(p.bytes).digest('hex')}));
      assert.deepEqual(hashes(files[key]),hashes(bytes),`${extension}: all non-path sections match native writer`);
    }
  } finally {await rm(dir,{recursive:true,force:true});}
});
