import test from 'node:test';
import assert from 'node:assert/strict';
import {createAudioReadSource,isAudioReadSource,ownAudioReadSource} from '../dist/audio-read-source.js';

test('native audio reads are limited to 1 MiB and become independent owned Blob bytes',async()=>{
  const data=new Uint8Array(2*1024*1024+37);for(let i=0;i<data.length;i++)data[i]=i%251;
  const calls=[],source=createAudioReadSource({name:'track.wav',size:data.length,type:'audio/wav',read:async(offset,length)=>{
    calls.push({offset,length});return data.subarray(offset,offset+length);
  }});
  assert.equal(isAudioReadSource(source),true);assert.equal(isAudioReadSource({...source}),false);
  assert.equal(Object.isFrozen(source),true);
  const blob=await ownAudioReadSource(source);
  assert.equal(blob.type,'audio/wav');assert.equal(blob.size,data.length);
  assert.ok(calls.every(call=>call.length<=1024*1024));
  const owned=new Uint8Array(await blob.arrayBuffer());assert.deepEqual(owned,data);
  data.fill(0);assert.notDeepEqual(new Uint8Array(await blob.arrayBuffer()),data,'USB change cannot mutate cached bytes');
});

test('native file slices clamp negative offsets and reject truncated reads or invalid sources',async()=>{
  const data=Uint8Array.of(0,1,2,3,4,5,6,7,8,9);
  const source=createAudioReadSource({name:'a',size:data.length,read:async(start,length)=>data.slice(start,start+length)});
  assert.deepEqual([...new Uint8Array(await source.slice(-4,-1).arrayBuffer())],[6,7,8]);
  assert.equal((await source.slice(8,3).arrayBuffer()).byteLength,0);
  assert.deepEqual([...new Uint8Array(await source.slice(-100,100).arrayBuffer())],[...data]);
  assert.throws(()=>source.slice(NaN,5),/範囲/);
  const short=createAudioReadSource({name:'cut',size:10,read:async()=>new Uint8Array(9)});
  await assert.rejects(short.arrayBuffer(),/最後まで/);
  assert.throws(()=>createAudioReadSource({name:'a',size:-1,read(){}}),TypeError);
  assert.throws(()=>createAudioReadSource({name:'a',size:1,type:'audio/\n',read(){}}),TypeError);
});
