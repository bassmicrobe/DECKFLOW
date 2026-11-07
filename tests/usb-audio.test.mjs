import test from 'node:test';
import assert from 'node:assert/strict';
import {readUsbAudioInfo,feedUsbAudio} from '../dist/usb-audio.js';

function wav({rate=44100,channels=2,bits=16,frames=100,format=1}={}) {
  const align=channels*bits/8,bytes=new Uint8Array(44+frames*align),view=new DataView(bytes.buffer);
  const tag=(at,text)=>bytes.set(new TextEncoder().encode(text),at);
  tag(0,'RIFF');view.setUint32(4,bytes.length-8,true);tag(8,'WAVEfmt ');view.setUint32(16,16,true);
  view.setUint16(20,format,true);view.setUint16(22,channels,true);view.setUint32(24,rate,true);
  view.setUint32(28,rate*align,true);view.setUint16(32,align,true);view.setUint16(34,bits,true);
  tag(36,'data');view.setUint32(40,frames*align,true);return bytes;
}
function mp3Frame({bitrate=128,rate=44100,mono=false}={}) {
  const rates=[44100,48000,32000],bitrates=[0,32,40,48,56,64,80,96,112,128,160,192,224,256,320];
  const bytes=new Uint8Array(Math.floor(144000*bitrate/rate));
  bytes.set([255,251,(bitrates.indexOf(bitrate)<<4)|(rates.indexOf(rate)<<2),mono?192:0]);return bytes;
}
function vbrFrame(kind,frames) {
  const bytes=mp3Frame(),view=new DataView(bytes.buffer);
  bytes.set(new TextEncoder().encode(kind),36);
  if(kind==='VBRI'){view.setUint16(40,1);view.setUint32(50,frames);}
  else {view.setUint32(40,1);view.setUint32(44,frames);}
  return bytes;
}
const bytesBlob=parts=>new Blob(parts,{type:'audio/mpeg'});

test('CDJ WAV metadata uses integer kbps and accepts only supported PCM formats',async()=>{
  const info=await readUsbAudioInfo(new Blob([wav()]),'track.wav');
  assert.equal(info.bitRate,1411);assert.equal(info.sampleRate,44100);assert.equal(info.bitDepth,16);
  assert.equal(info.duration,100/44100);
  for(const options of [{bits:8},{bits:32},{rate:22050},{channels:3},{bits:32,format:3}])
    await assert.rejects(readUsbAudioInfo(new Blob([wav(options)]),'track.wav'),/CDJ用WAV/);
  await assert.rejects(readUsbAudioInfo(new Blob([wav().subarray(0,100)]),'cut.wav'),/範囲外|途中/);
  await assert.rejects(readUsbAudioInfo(new Blob([wav()]),'track.flac'),/WAV・MP3/);
});

test('CBR and VBR MP3 frame walks measure actual audio and exclude Xing/Info metadata frames',async()=>{
  for(const kind of ['Xing','Info']) {
    const info=await readUsbAudioInfo(bytesBlob([vbrFrame(kind,3),mp3Frame(),mp3Frame(),mp3Frame()]),'track.mp3');
    assert.equal(info.mp3AudioFrames,3);assert.equal(info.duration,3*1152/44100);assert.equal(info.bitRate,128);
  }
  const mixed=[mp3Frame({bitrate:64}),mp3Frame({bitrate:192}),mp3Frame({bitrate:320})];
  const info=await readUsbAudioInfo(bytesBlob(mixed),'vbr.mp3');
  assert.equal(info.mp3AudioFrames,3);
  assert.equal(info.bitRate,Math.round(mixed.reduce((sum,frame)=>sum+frame.length,0)*8/(3*1152/44100)/1000));
  for(const count of [3,4]) {
    const vbri=await readUsbAudioInfo(bytesBlob([vbrFrame('VBRI',count),...mixed]),'vbri.mp3');
    assert.equal(vbri.mp3AudioFrames,3);
  }
  const mono=await readUsbAudioInfo(bytesBlob([mp3Frame({mono:true,rate:32000})]),'mono.mp3');
  assert.equal(mono.channels,1);assert.equal(mono.sampleRate,32000);
});

test('ID3/APEv2 metadata stays outside audio counts and damaged frame/header lengths fail',async()=>{
  const id3=Uint8Array.of(73,68,51,4,0,0,0,0,0,4,0,0,0,0);
  const id3v1=new Uint8Array(128);id3v1.set(new TextEncoder().encode('TAG'));
  const ape=new Uint8Array(32),apeView=new DataView(ape.buffer);ape.set(new TextEncoder().encode('APETAGEX'));
  apeView.setUint32(8,2000,true);apeView.setUint32(12,32,true);
  const tagged=await readUsbAudioInfo(bytesBlob([id3,mp3Frame(),ape,id3v1]),'tagged.mp3');
  assert.equal(tagged.mp3AudioFrames,1);
  await assert.rejects(readUsbAudioInfo(bytesBlob([mp3Frame().subarray(0,100)]),'cut.mp3'),/途中/);
  await assert.rejects(readUsbAudioInfo(bytesBlob([mp3Frame(),Uint8Array.of(255,251)]),'cut-tail.mp3'),/途中/);
  await assert.rejects(readUsbAudioInfo(bytesBlob([vbrFrame('Xing',2),mp3Frame()]),'wrong-count.mp3'),/フレーム数/);
  await assert.rejects(readUsbAudioInfo(bytesBlob([vbrFrame('Info',0)]),'empty.mp3'));
  const wrongId3=id3.slice();wrongId3[6]=128;
  await assert.rejects(readUsbAudioInfo(bytesBlob([wrongId3,mp3Frame()]),'wrong-id3.mp3'),/ID3/);
  await assert.rejects(readUsbAudioInfo(bytesBlob([mp3Frame(),mp3Frame({rate:48000})]),'changed.mp3'),/曲中/);
  const wrongApe=ape.slice();new DataView(wrongApe.buffer).setUint32(12,999999,true);
  await assert.rejects(readUsbAudioInfo(bytesBlob([mp3Frame(),wrongApe]),'wrong-ape.mp3'),/APE/);
});

test('decoded PCM is interleaved at its original rate; abort and mismatched channels stop metering',async()=>{
  const frames=40000,channels=[new Float32Array(frames).fill(.25),new Float32Array(frames).fill(-.5)];
  const decoded={length:frames,duration:frames/44100,sampleRate:44100,numberOfChannels:2,getChannelData:i=>channels[i]};
  const received=[];
  await feedUsbAudio(new Blob([wav()]),{sampleRate:44100,channels:2},{push:pcm=>received.push(pcm)}, {decode:async()=>decoded});
  assert.equal(received.length,2);assert.equal(received[0].length,32768*2);
  assert.deepEqual([...received[1].subarray(0,4)],[.25,-.5,.25,-.5]);
  await assert.rejects(feedUsbAudio(new Blob([wav()]),{sampleRate:48000,channels:2},{push(){throw Error('must not push');}},
    {decode:async()=>decoded}),/一致/);
  const controller=new AbortController();let pushes=0;
  await assert.rejects(feedUsbAudio(new Blob([wav()]),{sampleRate:44100,channels:2},{push(){pushes++;controller.abort();}},
    {decode:async()=>decoded,signal:controller.signal}),{name:'AbortError'});
  assert.equal(pushes,1);
});

test('large WAV transfer reads bounded frames without decoding or holding the complete PCM',async()=>{
  const bytes=wav({frames:5_000_000}),header=bytes.subarray(0,44),calls=[];
  const source={size:bytes.length,slice(start,end){calls.push(end-start);return {async arrayBuffer(){
    const chunk=new Uint8Array(end-start);if(start<44)chunk.set(header.subarray(start,Math.min(44,end)));return chunk.buffer;
  }};},arrayBuffer(){throw Error('whole-file read forbidden');}};
  const controller=new AbortController();let pushes=0;
  await assert.rejects(feedUsbAudio(source,{sampleRate:44100,channels:2},{push(chunk){
    assert.ok(chunk.length<=32768*2);if(++pushes===2)controller.abort();
  }},{signal:controller.signal,decode:async()=>{throw Error('whole-file decode forbidden');}}),{name:'AbortError'});
  assert.equal(pushes,2);assert.ok(Math.max(...calls)<=32768*4);
});

test('oversized compressed audio fails before whole-file allocation or decoding',async()=>{
  for (const [size,duration] of [[33*1024*1024,120],[1024,3600]]) {
    await assert.rejects(feedUsbAudio({size,arrayBuffer(){throw Error('must not read');}},
      {codec:'mp3',duration,sampleRate:44100,channels:2},{push(){throw Error('must not push');}}),/PCM WAV/);
  }
});
