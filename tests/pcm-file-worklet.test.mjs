import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import vm from 'node:vm';
import {createPcmResampler, createPcmResamplerFromKernel} from '../dist/pcm-resampler.js';

const source = await readFile(new URL('../dist/pcm-file-worklet.js', import.meta.url), 'utf8');
function fixture({length = 80, rate = 1000, sourceRate = rate, pageFrames = 8, sample = frame => frame / 1000} = {}) {
  let Processor;
  const messages = [];
  class Base { constructor() {this.port = {postMessage: message => messages.push(message)};} }
  const clock = {currentTime: 0};
  vm.runInNewContext(source.replace(/^import .*?;\n/m, ''), {AudioWorkletProcessor: Base, sampleRate: rate, Float32Array, createPcmResamplerFromKernel, get currentTime() {return clock.currentTime;},
    registerProcessor: (_name, type) => {Processor = type;}});
  const processor = new Processor({processorOptions: {length, sampleRate: sourceRate, channels: 1, pageFrames,
    kernel: createPcmResampler(sourceRate / rate).kernel}});
  const send = message => processor.port.onmessage({data: ['start', 'rate'].includes(message.type)
    ? {...message, kernel: createPcmResampler(sourceRate / rate * (message.rate ?? message.value ?? 1)).kernel} : message});
  const supply = () => {
    const requests = messages.splice(0).filter(message => message.type === 'request');
    for (const request of requests) {
      const start = request.index * pageFrames;
      send({type: 'page', index: request.index, generation: request.generation,
        channels: [Float32Array.from({length: Math.min(pageFrames, length - start)}, (_, i) => sample(start + i))]});
    }
  };
  const render = frames => {const output = new Float32Array(frames); processor.process([], [[output]]); clock.currentTime += frames / rate; return output;};
  return {processor, send, supply, render, messages};
}

test('streamed PCM crosses page boundaries without dropping or duplicating source frames', () => {
  const f = fixture(); f.send({type: 'start', position: 0, rate: 1});
  f.supply(); const first = f.render(12); f.supply(); const second = f.render(4);
  const actual = [...first, ...second];
  assert.ok(actual.every((value, index) => Math.abs(value - index / 1000) < 1e-7));
});

test('underruns hold position, stale pages are ignored, and resuming never skips unread audio', () => {
  const f = fixture(); f.send({type: 'start', position: .020, rate: 1});
  assert.ok(f.render(4).every(value => value === 0));
  assert.equal(f.processor.position, 20);
  f.send({type: 'page', generation: -1, index: 2, channels: [new Float32Array(8).fill(.9)]});
  assert.equal(f.processor.pages.size, 0);
  f.supply(); assert.ok(Math.abs(f.render(1)[0] - .020) < 1e-7);
});

test('rate, loop boundaries, natural completion and stopping preserve transport semantics', () => {
  const f = fixture({length: 32, pageFrames: 128});
  f.send({type: 'start', position: .004, rate: 2, loop: {start: .004, end: .008}});
  f.supply();
  const positions = Array.from({length: 4}, () => {f.render(1); return f.processor.position;});
  assert.deepEqual(positions, [6, 8, 6, 8]);
  f.send({type: 'loop', loop: null});
  f.send({type: 'rate', value: 1}); f.supply();
  for (let i = 0; i < 8; i++) {f.render(4); f.supply();}
  assert.equal(f.processor.active, false);
  assert.equal(f.processor.position, 32);
  f.send({type: 'start', position: 0, rate: 1}); f.supply();
  f.send({type: 'stop'}); assert.ok(f.render(4).every(value => value === 0));
  assert.equal(f.processor.pages.size, 0);
});

test('large logical files keep at most six PCM pages and never request whole-file data', () => {
  const f = fixture({length: 1_000_000_000});
  f.send({type: 'start', position: 999000, rate: 1});
  for (let i = 0; i < 80; i++) {
    f.supply(); f.render(4);
    assert.ok(f.processor.pages.size <= 6);
    assert.ok(f.messages.filter(message => message.type === 'request').length <= 6);
  }
});

test('bounded scratch reads forward and reverse, stops at its target and disposes its pages', () => {
  const f = fixture({length: 1000, pageFrames: 128});
  f.send({type: 'begin', position: .050, session: 7}); f.supply();
  f.send({type: 'target', position: .090, timeStamp: 0});
  f.render(32); f.supply(); f.render(64);
  assert.equal(f.processor.position, 90);
  f.send({type: 'target', position: .030, timeStamp: 30});
  f.supply(); f.render(96);
  assert.equal(f.processor.position, 30);
  assert.ok(f.render(128).every(value => Math.abs(value) < .001));
  f.send({type: 'dispose'});
  assert.equal(f.processor.pages.size, 0);
  assert.equal(f.processor.active, false);
  assert.equal(f.processor.process([], [[new Float32Array(128)]]), false, 'disposed processors must release their active-source lifetime');
});

test('96 kHz files reject ultrasonic aliasing at 48 kHz while preserving audible tones across pages', () => {
  const rms = frequency => {
    const f = fixture({length: 24000, rate: 48000, sourceRate: 96000, pageFrames: 4096,
      sample: frame => Math.sin(2 * Math.PI * frequency * frame / 96000)});
    f.send({type: 'start', position: 0, rate: 1});
    const blocks = [];
    for (let i = 0; i < 64; i++) {f.supply(); blocks.push(...f.render(128));}
    const interior = blocks.slice(128, -128);
    assert.equal(f.processor.buffering, false);
    assert.equal(f.processor.position, 16384);
    return Math.sqrt(interior.reduce((sum, value) => sum + value * value, 0) / interior.length);
  };
  assert.ok(rms(30000) < .02, '30 kHz must not fold into a full-volume 18 kHz tone');
  assert.ok(Math.abs(rms(1000) - Math.SQRT1_2) < .03, 'audible frequencies retain their level');
});


test('primed file sources begin at the scheduled audio sample without clearing cached pages', () => {
  const f = fixture({length: 4096, rate: 48000, pageFrames: 1024, sample: () => .5});
  f.send({type:'prepare', id:17, position:0}); f.supply();
  assert.ok(f.messages.some(message=>message.type==='prepared'&&message.id===17));
  const pages = [...f.processor.pages.values()];
  f.send({type:'start', position:0, rate:1, when:64/48000});
  assert.equal(f.processor.pages.get(0), pages[0]);
  const out=f.render(128);
  assert.ok(out.slice(0,64).every(value=>value===0));
  assert.ok(out.slice(64).every(value=>value===.5));
  assert.equal(f.processor.position,64);
});

test('fractional PCM rendering caches page lookup across sinc taps', () => {
  const f = fixture({length:32768, pageFrames:32768, rate:48000});
  f.send({type:'start',position:.01,rate:1.1}); f.supply();
  let lookups=0; const original=f.processor.pages.get.bind(f.processor.pages);
  f.processor.pages.get=index=>{lookups++; return original(index);};
  f.render(128);
  assert.ok(lookups<8, `page map lookups: ${lookups}`);
});

for(const cadence of [60,120]) test(`streamed reverse scratch stays constant at ${cadence} Hz`,()=>{
  const f=fixture({length:192000,rate:48000,pageFrames:32768,sample:frame=>Math.sin(2*Math.PI*110*frame/48000)*.5});
  f.send({type:'begin',position:2,session:1}); f.supply(); let next=0;
  for(let frame=0;frame<24000;frame+=128){
    while(next<=frame){f.send({type:'target',position:2-next/48000,timeStamp:next/48}); next+=48000/cadence;}
    f.supply(); const before=f.processor.position; const output=f.render(128);
    assert.ok(output.every(Number.isFinite));
    if(frame>4800) assert.ok(Math.abs((f.processor.position-before)/128+1)<1e-5);
  }
});

test('file-backed fast backspin uses the same anti-alias aperture as in-memory scratch',()=>{
  const level=(frequency,movement)=>{
    const f=fixture({length:16384,rate:48000,pageFrames:16384,sample:i=>Math.sin(2*Math.PI*frequency*i/48000)});
    f.send({type:'begin',position:.2});f.supply();
    const samples=Array.from({length:1024},(_,i)=>f.processor.read(10000-i*4,0,movement));
    assert.ok(samples.every(Number.isFinite));
    return Math.sqrt(samples.reduce((sum,value)=>sum+value*value,0)/samples.length);
  };
  assert.ok(level(14000,-4)<level(14000,0)*.25);
  assert.ok(Math.abs(level(1000,-4)-Math.SQRT1_2)<.04);
});
