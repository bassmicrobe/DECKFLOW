import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp, mkdir, writeFile, readFile, rm, lstat, symlink, open} from 'node:fs/promises';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {createHash} from 'node:crypto';
import {validateUsbLibrary, buildRekordboxXml, encodeRekordboxLocation} from '../dist/usb-export.js';
import {exportUsb, resolveAudioFiles, verifyCueMetadata} from '../tools/export-usb.mjs';
import {inspectPdb, inspectAnalysis, safeExportPath, readExport} from '../tools/usb-inspect.mjs';
import {parseRekordboxDatabase} from '../dist/rekordbox-sqlite.js';

const track = (id='t1', overrides={}) => ({id, title:'曲 & <test> "A"', artist:'DJ 日本語', bpm:128,
  duration:5, beatOffset:.125, cue:.5, hotcues:[.125,1.2,2.4,3.6], filename:'日本語 & 128.wav', ...overrides});
const library = tracks => ({format:'deckflow.library',version:1,tracks:tracks || [track()],
  playlists:[{id:'p1',name:'夕方 & "mix"',trackIds:(tracks || [track()]).map(item => item.id).reverse()}]});
function wav(bpm, duration=5) {
  const rate=44100, frames=rate*duration, data=Buffer.alloc(44+frames*4);
  data.write('RIFF'); data.writeUInt32LE(data.length-8,4); data.write('WAVEfmt ',8);
  data.writeUInt32LE(16,16); data.writeUInt16LE(1,20); data.writeUInt16LE(2,22);
  data.writeUInt32LE(rate,24); data.writeUInt32LE(rate*4,28); data.writeUInt16LE(4,32);
  data.writeUInt16LE(16,34); data.write('data',36); data.writeUInt32LE(frames*4,40);
  for(let i=0;i<frames;i++) {
    const time=i/rate, phase=time%(60/bpm), amplitude=phase<.04 ? Math.exp(-phase*90)*.3*Math.sin(2*Math.PI*110*time):0;
    const sample=Math.round(amplitude*32767);
    data.writeInt16LE(sample,44+i*4); data.writeInt16LE(sample,46+i*4);
  }
  return data;
}
const hash = value => createHash('sha256').update(value).digest('hex');

test('rekordbox XML preserves titles, cues, BPM/grid and playlist order with escaped attributes', () => {
  const a=track('t1',{addedAt:'2026-11-06T12:00:00.000Z'}), b=track('t2',{title:'Second',filename:'Second.wav',bpm:174});
  const result=buildRekordboxXml(library([a,b]),new Map([['t1','/Music/日本語 & 128.wav'],['t2','/Music/Second.wav']]));
  assert.match(result.xml,/Name="曲 &amp; &lt;test&gt; &quot;A&quot;"/);
  assert.match(result.xml,/Bpm="128.000000"/);
  assert.match(result.xml,/Inizio="0.125000"/);
  assert.match(result.xml,/Start="3.600000" Num="3"/);
  assert.match(result.xml,/夕方 &amp; &quot;mix&quot;/);
  assert.ok(result.xml.includes('<TRACK Key="2"/>\n        <TRACK Key="1"/>'));
  assert.match(result.xml,/DECKFLOW ALL/);
  assert.match(result.xml,/DateAdded="2026-11-06"/);
  assert.ok(!result.xml.includes('file://localhost/Music/日本語'));
});

test('XML passes measured source size, sample rate and bitrate to the device writer', () => {
  const metadata = new Map([['t1', {size:1073741864, sampleRate:96000, bitRate:4608}]]);
  const result = buildRekordboxXml(library(), new Map([['t1','/Music/source.wav']]), metadata);
  assert.match(result.xml, /Size="1073741864"/);
  assert.match(result.xml, /SampleRate="96000"/);
  assert.match(result.xml, /BitRate="4608"/);
  for (const invalid of [{size:-1}, {size:2 ** 32}, {sampleRate:NaN}, {bitRate:-1}]) {
    assert.throws(() => buildRekordboxXml(library(), new Map([['t1','/Music/source.wav']]),
      new Map([['t1', {...metadata.get('t1'), ...invalid}]])), /音源/);
  }
});

test('unsupported library data is rejected before a writer can run', () => {
  for (const bad of [
    {}, {...library(),format:'other'}, library([]), library([track(),track()]),
    library([track('a',{filename:'../outside.wav'})]), library([track('a',{filename:'/absolute.wav'})]),
    library([track('a',{bpm:null})]), library([track('a',{bpm:Infinity})]),
    library([track('a',{cue:6})]), library([track('a',{hotcues:[-1]})]),
    {...library(),playlists:[{id:'p',name:'Unknown',trackIds:['missing']}]},
  ]) assert.throws(()=>validateUsbLibrary(bad));
  assert.throws(()=>encodeRekordboxLocation('../outside.wav'));
  assert.throws(()=>buildRekordboxXml(library(),new Map()));
});

test('audio file resolution rejects ambiguous names, symlinks and source-folder escapes', async () => {
  const dir=await mkdtemp(join(tmpdir(),'deckflow-audio-test-'));
  try {
    await writeFile(join(dir,'日本語 & 128.wav'),wav(128));
    const checked=validateUsbLibrary(library());
    assert.equal((await resolveAudioFiles(checked,dir)).size,1);
    await mkdir(join(dir,'another'));
    await writeFile(join(dir,'another','日本語 & 128.wav'),wav(128));
    await assert.rejects(resolveAudioFiles(checked,dir),/同名ファイル/);
    await rm(join(dir,'another'),{recursive:true});
    await rm(join(dir,'日本語 & 128.wav'));
    await symlink('/etc/hosts',join(dir,'日本語 & 128.wav'));
    await assert.rejects(resolveAudioFiles(checked,dir),/音源がありません/);
  } finally {await rm(dir,{recursive:true,force:true});}
});

test('binary inspectors reject truncated data and unsafe paths', async () => {
  assert.throws(()=>inspectPdb(new Uint8Array(12)));
  assert.throws(()=>inspectPdb(new Uint8Array(4096)));
  assert.throws(()=>inspectAnalysis(new Uint8Array(28)));
  await assert.rejects(safeExportPath(tmpdir(),'/../etc/hosts'));
  await assert.rejects(safeExportPath(tmpdir(),'relative.wav'));
});

const baken=process.env.DECKFLOW_BAKEN_BIN;
test('real baken CDJ-3000 export: PDB/ANLZ/cues/playlist order and audio hashes round-trip',
  {skip:!baken,timeout:120000}, async () => {
  const dir=await mkdtemp(join(tmpdir(),'deckflow-baken-test-'));
  try {
    const audio=join(dir,'audio'); await mkdir(audio);
    const a=track(), b=track('t2',{title:'Second 174',filename:'Second 174.wav',bpm:174,beatOffset:.25});
    const aAudio=wav(128), bAudio=wav(174);
    await writeFile(join(audio,a.filename),aAudio); await writeFile(join(audio,b.filename),bAudio);
    const json=join(dir,'library.json');
    const sourceLibrary=library([a,b]);
    sourceLibrary.playlists.push({id:'p2',name:sourceLibrary.playlists[0].name,trackIds:[a.id]});
    sourceLibrary.playlists.push({id:'empty',name:'空のプレイリスト',trackIds:[]});
    await writeFile(json,JSON.stringify(sourceLibrary));
    const out=join(dir,'NEW_USB_EXPORT');
    const report=await exportUsb({libraryPath:json,audioDir:audio,out,bakenPath:baken,quiet:true});
    assert.equal(report.tracks.length,2);
    assert.equal(report.hardwareVerified,false);
    assert.equal(report.tracks[0].bpm,128); assert.equal(report.tracks[1].bpm,174);
    assert.equal(report.tracks[0].sha256,hash(aAudio)); assert.equal(report.tracks[1].sha256,hash(bAudio));
    assert.equal(hash(await readFile(join(audio,a.filename))),hash(aAudio),'source audio stays unchanged');
    const device=await readExport(out);
    const oneLibrary = await parseRekordboxDatabase(new Uint8Array(await readFile(join(out, 'PIONEER/rekordbox/exportLibrary.db'))), {kind:'device'});
    assert.deepEqual(report.deviceFormats, ['Device Library','OneLibrary']);
    assert.equal(oneLibrary.tracks.length, 2);
    assert.deepEqual(oneLibrary.tracks.map(track => track.title), [a.title,b.title]);
    assert.deepEqual(oneLibrary.tracks.map(track => track.rekordbox.size), [aAudio.length,bAudio.length]);
    assert.ok(oneLibrary.playlists.some(list => list.name === '空のプレイリスト' && list.trackIds.length === 0));
    assert.equal(device.tracks[0].size, aAudio.length);
    assert.equal(device.tracks[0].sampleRate, 44100);
    assert.equal(device.tracks[0].bitRate, 1411);
    assert.equal(device.tracks[0].duration, 5);
    assert.equal(device.tracks[0].dat.beats[0].time,.125);
    assert.ok(device.tracks[0].ext.cues.some(cue=>cue.number===4&&cue.time===3.6));
    const playlist=device.playlists.find(item=>item.name==='夕方 & "mix"');
    assert.deepEqual(playlist.trackIds,[device.tracks[1].id,device.tracks[0].id]);
    const before=await readFile(join(out,'DECKFLOW-REPORT.json'));
    await assert.rejects(exportUsb({libraryPath:json,audioDir:audio,out,bakenPath:baken,quiet:true}),/新規フォルダ/);
    assert.deepEqual(await readFile(join(out,'DECKFLOW-REPORT.json')),before);
    const dryOut=join(dir,'DRY_RUN');
    const dry=await exportUsb({libraryPath:json,audioDir:audio,out:dryOut,bakenPath:baken,dryRun:true,quiet:true});
    assert.equal(dry.dryRun,true);
    await assert.rejects(lstat(dryOut),{code:'ENOENT'});
  } finally {await rm(dir,{recursive:true,force:true});}
});

test('real 1 GiB WAV USB export preserves long-track audio, metadata and final cues',
  {skip:!baken || process.env.DECKFLOW_LARGE_AUDIO_TEST !== '1',timeout:300000}, async () => {
  const dir = await mkdtemp(join(tmpdir(), 'deckflow-large-usb-'));
  try {
    const audio = join(dir, 'audio'); await mkdir(audio);
    const sampleRate = 96000, blockAlign = 6, frames = Math.floor(1024 ** 3 / blockAlign);
    const dataBytes = frames * blockAlign, duration = frames / sampleRate;
    const filename = 'Synthetic 1GiB 24-bit 96kHz.wav', path = join(audio, filename);
    const header = Buffer.alloc(44);
    header.write('RIFF'); header.writeUInt32LE(36 + dataBytes, 4); header.write('WAVEfmt ', 8);
    header.writeUInt32LE(16, 16); header.writeUInt16LE(1, 20); header.writeUInt16LE(2, 22);
    header.writeUInt32LE(sampleRate, 24); header.writeUInt32LE(sampleRate * blockAlign, 28);
    header.writeUInt16LE(blockAlign, 32); header.writeUInt16LE(24, 34);
    header.write('data', 36); header.writeUInt32LE(dataBytes, 40);
    const file = await open(path, 'wx');
    try {
      await file.write(header, 0, header.length, 0);
      await file.truncate(44 + dataBytes);
      // Distinct beginning/end samples catch a truncated or zero-filled copy.
      await file.write(Buffer.from([0,0,64,0,0,64]), 0, blockAlign, 44);
      await file.write(Buffer.from([0,0,192,0,0,192]), 0, blockAlign, 44 + dataBytes - blockAlign);
    } finally { await file.close(); }
    const source = track('large', {filename, duration, bpm:120, cue:duration - 2,
      hotcues:[null,null,null,null,null,null,null,duration - 1], beatOffset:0});
    const json = join(dir, 'library.json'); await writeFile(json, JSON.stringify(library([source])));
    const out = join(dir, 'USB');
    const report = await exportUsb({libraryPath:json,audioDir:audio,out,bakenPath:baken,quiet:true});
    assert.equal(report.tracks.length, 1); assert.equal(report.hardwareVerified, false);
    const device = (await readExport(out)).tracks[0];
    const oneLibrary = await parseRekordboxDatabase(new Uint8Array(await readFile(join(out, 'PIONEER/rekordbox/exportLibrary.db'))), {kind:'device'});
    assert.equal(oneLibrary.tracks[0].rekordbox.size, 44 + dataBytes);
    assert.equal(oneLibrary.tracks[0].duration, Math.ceil(duration));
    assert.equal(device.size, 44 + dataBytes);
    assert.equal(device.sampleRate, sampleRate); assert.equal(device.bitRate, 4608);
    assert.equal(device.duration, Math.ceil(duration));
    assert.ok(device.ext.detailedCues.some(cue => cue.number === 8 && Math.abs(cue.time - (duration - 1)) < .003));
    assert.equal((await lstat(device.audio)).size, 44 + dataBytes);
    assert.equal(report.tracks[0].sha256.length, 64);
  } finally { await rm(dir, {recursive:true,force:true}); }
});

test('XML export keeps variable TEMPO, eight cues, named colored loops and nested playlist paths', () => {
  const a=track('t1',{hotcues:[.1,null,null,null,null,null,null,4],tempos:[{start:.1,bpm:128,meter:'4/4',beat:3},{start:2,bpm:150,meter:'4/4',beat:1}],
    positionMarks:[{name:'Memory & loop',type:4,start:1,end:1.5,num:-1,color:null},{name:'Final H',type:0,start:4,end:null,num:7,color:[230,40,40]}]});
  const source=library([a]);source.playlists[0].folderPath=['Sets','2026'];
  const {xml}=buildRekordboxXml(source,new Map([['t1','/Music/a.wav']]));
  assert.match(xml,/Inizio="2.000000" Bpm="150.000000"/);
  assert.match(xml,/Name="Final H" Type="0" Start="4.000000" Num="7" Red="230" Green="40" Blue="40"/);
  assert.match(xml,/Name="Memory &amp; loop" Type="4" Start="1.000000" Num="-1" End="1.500000"/);
  assert.match(xml,/Type="0" Name="Sets"/);assert.match(xml,/Type="0" Name="2026"/);
  assert.throws(()=>validateUsbLibrary(library([track('bad',{tempos:[{start:0,bpm:128,meter:'3/4',beat:1}]} )])),/4\/4/);
});

test('real ANLZ carry-over keeps waveform/grid bytes, updates cues, handles old caches, and never guesses basenames',
  {skip:!baken,timeout:120000},async()=>{
  const {rewriteAnalysisPath}=await import('../tools/analysis-source.mjs');
  const dir=await mkdtemp(join(tmpdir(),'deckflow-carry-test-'));
  try {
    const audio=join(dir,'audio');await mkdir(audio);
    const a=track('t1',{hotcues:[.125,null,null,null,null,null,null,4],
      tempos:[{start:.125,bpm:128,meter:'4/4',beat:1},{start:2,bpm:150,meter:'4/4',beat:1}],
      positionMarks:[{name:'Memory loop',type:4,start:1,end:1.5,num:-1,color:null},{name:'Hot H',type:0,start:4,end:null,num:7,color:[230,40,40]}]});
    await writeFile(join(audio,a.filename),wav(128));
    const json=join(dir,'library.json'), initial=library([a]);initial.playlists[0].folderPath=['Sets','Evening'];
    await writeFile(json,JSON.stringify(initial));
    const sourceExport=join(dir,'source-device');
    await exportUsb({libraryPath:json,audioDir:audio,out:sourceExport,bakenPath:baken,quiet:true});
    const first=(await readExport(sourceExport)).tracks[0];
    const cache=join(dir,'cache'), relative='P001/track/ANLZ0000.DAT', dat=join(cache,relative);
    await mkdir(join(cache,'P001/track'),{recursive:true});
    const origin='/Original Music/'+a.filename;
    const originals=new Map();
    for(const extension of ['DAT','EXT','2EX']) {
      const bytes=rewriteAnalysisPath(await readFile(first.analysis.replace(/\.DAT$/,'.'+extension)),origin);
      // Distinct source waveform proves that the exporter did not reanalyse it.
      if(extension==='DAT'){
        let offset=bytes.readUInt32BE(4);
        while(offset<bytes.length){const len=bytes.readUInt32BE(offset+8);if(bytes.toString('ascii',offset,offset+4)==='PWAV'){bytes[offset+len-1]^=7;break;}offset+=len;}
      }
      const file=dat.replace(/\.DAT$/,'.'+extension);await writeFile(file,bytes);originals.set(file,hash(bytes));
    }
    a.rekordbox={trackId:'42',location:encodeRekordboxLocation(origin)};
    a.positionMarks[1]={...a.positionMarks[1],name:'Updated H',start:4.25};a.hotcues[7]=4.25;
    await writeFile(json,JSON.stringify(initial));
    const out=join(dir,'reused-device'), report=await exportUsb({libraryPath:json,audioDir:audio,out,bakenPath:baken,analysisDir:cache,quiet:true});
    assert.equal(report.tracks[0].analysis.status,'reused');
    const copied=(await readExport(out)).tracks[0];assert.deepEqual(copied.two.sectionHashes.PWV7,first.two.sectionHashes.PWV7);
    assert.deepEqual(copied.dat.sectionHashes.PWAV,inspectAnalysis(await readFile(dat)).sectionHashes.PWAV);
    assert.deepEqual(copied.dat.sectionHashes.PQTZ,first.dat.sectionHashes.PQTZ);
    assert.ok(copied.ext.detailedCues.some(cue=>cue.number===8&&cue.time===4.25&&cue.name==='Updated H'&&cue.colorCode===0x2a));
    assert.ok(copied.dat.cues.some(cue=>cue.number===0&&cue.type===4&&cue.time===1&&cue.end===1.5));
    for(const [file,before]of originals)assert.equal(hash(await readFile(file)),before,'original ANLZ stays unchanged');
    // No 2EX: older rekordbox analyses retain their available waveforms.
    await rm(dat.replace(/\.DAT$/,'.2EX'));originals.delete(dat.replace(/\.DAT$/,'.2EX'));
    const oldOut=join(dir,'older-device');await exportUsb({libraryPath:json,audioDir:audio,out:oldOut,bakenPath:baken,analysisDir:cache,quiet:true});
    assert.equal((await readExport(oldOut)).tracks[0].two,null);
    // A stale second tempo must not slip through baken's first-tempo-only matcher.
    a.tempos[1].bpm=151;await writeFile(json,JSON.stringify(initial));
    const rejectedOut=join(dir,'stale-device');
    await assert.rejects(exportUsb({libraryPath:json,audioDir:audio,out:rejectedOut,bakenPath:baken,analysisDir:cache,quiet:true}),/ビートグリッド/);
    await assert.rejects(lstat(rejectedOut),{code:'ENOENT'});a.tempos[1].bpm=150;
    // Same name at another full path is not enough evidence of identity.
    a.rekordbox.location=encodeRekordboxLocation('/Different/'+a.filename);await writeFile(json,JSON.stringify(initial));
    const fallback=await exportUsb({libraryPath:json,audioDir:audio,out:join(dir,'generated-device'),bakenPath:baken,analysisDir:cache,quiet:true});
    assert.equal(fallback.tracks[0].analysis.status,'generated');
    // Modern caches with ?/name require an explicit mapping, still grid checked.
    for(const file of originals.keys())await writeFile(file,rewriteAnalysisPath(await readFile(file),'?/'+a.filename));
    const map=join(dir,'analysis-map.json');await writeFile(map,JSON.stringify({format:'deckflow.analysis-map',version:1,tracks:{t1:relative}}));
    const mapped=await exportUsb({libraryPath:json,audioDir:audio,out:join(dir,'mapped-device'),bakenPath:baken,analysisDir:cache,analysisMapPath:map,quiet:true});
    assert.equal(mapped.tracks[0].analysis.reason,'explicit-analysis-map');
    await writeFile(map,JSON.stringify({format:'deckflow.analysis-map',version:1,tracks:{t1:'../ANLZ0000.DAT'}}));
    await assert.rejects(exportUsb({libraryPath:json,audioDir:audio,out:join(dir,'escape-device'),bakenPath:baken,analysisDir:cache,analysisMapPath:map,quiet:true}),/相対ANLZ/);
  }finally{await rm(dir,{recursive:true,force:true});}
});


test('cue readback rejects a lost color and accepts nearest device palette color',()=>{
  const source=track('colored',{positionMarks:[{name:'H',type:0,start:1,end:null,num:7,color:[229,39,40]}]});
  const row={number:8,time:1,type:0,end:null,name:'H',colorCode:0x2a,color:[255,0,0]};
  const device={dat:{cues:[]},ext:{cues:[row],detailedCues:[row]}};
  verifyCueMetadata(source,device);
  assert.throws(()=>verifyCueMetadata({...source,positionMarks:[]},device),/CUEの数/);
  row.colorCode=0;row.color=[26,255,0];
  assert.throws(()=>verifyCueMetadata(source,device),/色/);
  assert.throws(()=>validateUsbLibrary(library([track('memory-color',{positionMarks:[{name:'Memory',type:0,start:1,end:null,num:-1,color:[230,40,40]}]})])),/色付きメモリーCUE/);
});

test('fractional-duration tail keeps BPM, beat number and ordering validation',async()=>{
  const {expectedBeats,verifyBeatGrid}=await import('../tools/analysis-source.mjs');
  const source=track('tail',{duration:5,bpm:120,beatOffset:0});
  const beats=expectedBeats({...source,duration:6});
  verifyBeatGrid(source,beats);
  for(const change of [{bpm:0},{beat:1},{time:5.2}]) {
    const damaged=beats.map(beat=>({...beat}));damaged[damaged.length-1]={...damaged.at(-1),...change};
    assert.throws(()=>verifyBeatGrid(source,damaged),/ビートグリッド/);
  }
});
