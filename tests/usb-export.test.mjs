import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp, mkdir, writeFile, readFile, rm, lstat, symlink} from 'node:fs/promises';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {createHash} from 'node:crypto';
import {validateUsbLibrary, buildRekordboxXml, encodeRekordboxLocation} from '../dist/usb-export.js';
import {exportUsb, resolveAudioFiles} from '../tools/export-usb.mjs';
import {inspectPdb, inspectAnalysis, safeExportPath, readExport} from '../tools/usb-inspect.mjs';

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
