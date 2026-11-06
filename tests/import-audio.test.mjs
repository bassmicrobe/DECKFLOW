import test from 'node:test';
import assert from 'node:assert/strict';
import {findImportedAudio, audioPeaks, tempoAt, barPositions, advanceBeats, relinkMetadata} from '../dist/import-audio.js';
const track = {id:'xml1', filename:'曲.wav', duration:60, audioMissing:true, rekordbox:{size:100}};
const file = {name:'曲.wav', size:100};
test('XML audio relink tolerates integer TotalTime and rejects ambiguous or wrong audio', () => {
  assert.equal(findImportedAudio([track], file, 60.8), track);
  assert.equal(findImportedAudio([track], {...file,name:'other.wav'}, 60), null);
  assert.throws(() => findImportedAudio([track], file, 62), /長さ/);
  assert.throws(() => findImportedAudio([track], {...file,size:101}, 60), /サイズ/);
  assert.throws(() => findImportedAudio([track,{...track,id:'xml2'}], file, 60), /複数/);
  assert.equal(findImportedAudio([track,{...track,id:'xml2'}], file, 60, 'xml1'), track);
  assert.throws(() => findImportedAudio([], file, 60, 'gone'), /見つかりません/);
  assert.equal(findImportedAudio([{...track,audioMissing:false}], file, 60), null);
});
test('display peaks retain both channels without changing imported metadata', () => {
  const buffer = {length:4,numberOfChannels:2,getChannelData:i=>i?new Float32Array([0,.8,0,.2]):new Float32Array([.1,0,.5,0])};
  const before=JSON.stringify(track);
  const peaks=audioPeaks(buffer,2);
  assert.ok(Math.abs(peaks[0]-.8)<1e-6);assert.equal(peaks[1],.5);
  assert.equal(JSON.stringify(track),before);
});
test('variable tempo display follows segment boundaries and bar beat numbers', () => {
  const t={bpm:120,tempos:[{start:0,bpm:120,meter:'4/4',beat:1},{start:2,bpm:60,meter:'3/4',beat:2}]};
  assert.equal(tempoAt(t,1.9).bpm,120);assert.equal(tempoAt(t,2).bpm,60);
  assert.deepEqual(barPositions(t,8),[0,4,7]);
  assert.equal(advanceBeats(t,1.5,4),5);
  assert.equal(advanceBeats(t,0,4),2);
  assert.ok(barPositions(t,10000,10).length<=10);
});
test('relink uses actual duration and preserves preparation; rejects marks outside actual audio', () => {
  const original={...track,bpm:127.1,cue:1,beatOffset:.12,hotcues:[60.5],tempos:[{start:.12,bpm:127.1,meter:'4/4',beat:1}],positionMarks:[{start:59,end:60.5,type:4,num:0}]};
  const linked=relinkMetadata(original,file,60.8,[.5]);
  assert.equal(linked.duration,60.8);assert.equal(linked.bpm,127.1);assert.equal(linked.audioMissing,false);
  assert.deepEqual(linked.tempos,original.tempos);assert.deepEqual(linked.positionMarks,original.positionMarks);
  assert.equal(original.audioMissing,true);
  assert.throws(()=>relinkMetadata(original,file,60,[.5]),/終端/);
});
