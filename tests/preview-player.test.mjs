import test from 'node:test';
import assert from 'node:assert/strict';
import {PreviewPlayer} from '../dist/preview-player.js';
import {AudioBufferCache} from '../dist/audio-buffer-cache.js';

const deferred = () => { let resolve, reject; const promise = new Promise((yes,no) => {resolve=yes;reject=no;}); return {promise,resolve,reject}; };
const flush = () => new Promise(resolve => setImmediate(resolve));
const blob = id => ({size:12,arrayBuffer:async()=>id});
class Node {
  constructor() { for(const key of ['gain','frequency','Q','playbackRate','threshold','knee','ratio','attack','release'])this[key]={value:1}; this.connections=[]; }
  connect(node) { this.connections.push(node); return node; }
  disconnect() { this.connections=[]; }
  start(_at,offset) { this.offset=offset; this.started=true; }
  stop() { this.stopped=true; }
}
class Context {
  constructor() { this.currentTime=0; this.state='suspended'; this.destination=new Node(); this.sources=[]; this.resumeCalls=0; this.decoded=[]; }
  createGain() { return new Node(); }
  createBiquadFilter() { return new Node(); }
  createDynamicsCompressor() { return new Node(); }
  createBufferSource() { const source=new Node(); this.sources.push(source); return source; }
  async resume() { this.resumeCalls++; this.state='running'; }
  async close() { this.state='closed'; }
  async decodeAudioData(id) { this.decoded.push(id); return {id,duration:60}; }
}
function setup(getAudio=async id=>blob(id)) {
  const context=new Context(), states=[];
  const player=new PreviewPlayer({getAudio,createContext:()=>context,onChange:state=>states.push(state)});
  return {context,states,player};
}

test('the user gesture resumes audio before awaiting storage and only one source plays', async () => {
  let fetched=false;
  const {player,context}=setup(async id=>{fetched=true;return blob(id);});
  const pending=player.toggle('A');
  assert.equal(context.resumeCalls,1);
  assert.equal(fetched,false);
  await pending;
  assert.equal(player.getState().playing,true);
  assert.equal(player.gain.gain.value,.65);
  assert.deepEqual(player.gain.connections,[player.limiter]);
  assert.deepEqual(player.limiter.connections,[context.destination]);
  assert.equal(player.limiter.threshold.value,-1);
  assert.equal(player.limiter.ratio.value,20);
  const first=context.sources[0];
  await player.toggle('B');
  assert.equal(first.stopped,true);
  assert.equal(first.connections.length,0);
  assert.equal(player.getState().trackId,'B');
  assert.equal(context.sources.filter(source=>!source.stopped).length,1);
});

test('pause preserves time, seeking clamps, resume reuses PCM and stop releases it', async () => {
  const {player,context}=setup();
  await player.toggle('A');
  context.currentTime=12;
  await player.toggle('A');
  assert.equal(player.getState().position,12);
  assert.equal(player.getState().playing,false);
  context.currentTime=40;
  player.seek(30);
  await player.toggle('A');
  assert.equal(context.sources.at(-1).offset,30);
  assert.deepEqual(context.decoded,['A']);
  context.currentTime=43;
  assert.equal(player.getState().position,33);
  player.seek(-5);
  assert.equal(player.getState().position,0);
  player.seek(999);
  assert.equal(player.getState().position,60);
  assert.equal(player.getState().playing,false);
  await player.toggle('A');
  assert.equal(context.sources.at(-1).offset,0);
  player.stop();
  assert.deepEqual(player.getState(),{trackId:'A',loading:false,playing:false,position:0,duration:60,error:null,rate:1,eq:{low:0,mid:0,high:0}});
  assert.equal(player.buffer,null);
  await player.toggle('A');
  assert.deepEqual(context.decoded,['A','A']);
});

test('switching during storage ignores a stale success or failure', async () => {
  for (const fail of [false,true]) {
    const pending=deferred();
    const {player,context}=setup(id=>id==='A'?pending.promise:Promise.resolve(blob(id)));
    const old=player.toggle('A');
    await flush();
    await player.toggle('B');
    if(fail)pending.reject(new Error('stale missing file'));else pending.resolve(blob('A'));
    await old;
    assert.deepEqual(context.decoded,['B']);
    assert.equal(player.getState().trackId,'B');
    assert.equal(player.getState().playing,true);
    assert.equal(player.getState().error,null);
  }
});

test('stop, clear and a second toggle cancel pending decode without later autoplay', async () => {
  for (const action of ['stop','clear','toggle']) {
    const pending=deferred();
    const {player,context}=setup();
    context.decodeAudioData=()=>pending.promise;
    const old=player.toggle('A');
    await flush();
    if(action==='toggle')await player.toggle('A');else player[action]();
    pending.resolve({duration:60});
    await old;
    assert.equal(context.sources.length,0);
    assert.equal(player.getState().loading,false);
    assert.equal(player.getState().playing,false);
    assert.equal(player.buffer,null);
    assert.equal(player.getState().trackId,action==='clear'?null:'A');
  }
});

test('a stopped delayed resume cannot fetch or start audio', async () => {
  const pending=deferred();let reads=0;
  const {player,context}=setup(async id=>{reads++;return blob(id);});
  context.resume=()=>pending.promise;
  const play=player.toggle('A');
  player.stop();
  context.state='running';pending.resolve();
  await play;
  assert.equal(reads,0);
  assert.equal(context.sources.length,0);
});

test('missing audio and decode failures report errors and allow a later retry', async () => {
  let missing=true;
  const {player,context,states}=setup(async id=>missing?null:blob(id));
  await assert.rejects(player.toggle('A'),/元の音源/);
  assert.equal(states.at(-1).loading,false);
  assert.match(states.at(-1).error,/元の音源/);
  missing=false;
  context.decodeAudioData=async()=>{throw new Error('bad audio');};
  await assert.rejects(player.toggle('A'),/bad audio/);
  assert.equal(player.getState().playing,false);
  context.decodeAudioData=async()=>({duration:60});
  await player.toggle('A');
  assert.equal(player.getState().playing,true);
  assert.equal(player.getState().error,null);
});

test('resume failures can be retried and a stale rejection leaves the current audition alone', async () => {
  const {player,context}=setup();
  context.resume=async()=>{throw new Error('audio unavailable');};
  await assert.rejects(player.toggle('A'),/audio unavailable/);
  assert.equal(player.getState().loading,false);
  const pending=deferred();
  context.resume=()=>pending.promise;
  const old=player.toggle('A');
  context.resume=async()=>{context.state='running';};
  await player.toggle('B');
  pending.reject(new Error('stale audio unavailable'));
  await old;
  assert.equal(player.getState().trackId,'B');
  assert.equal(player.getState().playing,true);
  assert.equal(player.getState().error,null);
});

test('only the current source can report natural completion', async () => {
  const {player,context}=setup();
  await player.toggle('A');
  const oldEnded=context.sources[0].onended;
  player.seek(20);
  oldEnded();
  assert.equal(player.getState().playing,true);
  assert.equal(player.getState().position,20);
  context.sources.at(-1).onended();
  assert.equal(player.getState().playing,false);
  assert.equal(player.getState().position,0);
  assert.equal(player.buffer,null);
  assert.equal(player.getState().trackId,'A');
});

test('disposal closes the context and invalidates a pending read', async () => {
  const pending=deferred();
  const {player,context}=setup(()=>pending.promise);
  const play=player.toggle('A');await flush();
  player.dispose();
  pending.resolve(blob('A'));await play;
  assert.equal(context.state,'closed');
  assert.equal(context.sources.length,0);
  assert.equal(player.getState().trackId,null);
  await assert.rejects(player.toggle('B'),/終了しています/);
});

test('tempo changes preserve position through pause, resume and seeking', async () => {
  const {player,context}=setup();
  await player.toggle('A');
  context.currentTime=10;
  player.setRate(1.25);
  assert.equal(player.getState().position,10);
  assert.equal(context.sources.at(-1).playbackRate.value,1.25);
  context.currentTime=14;
  assert.equal(player.getState().position,15);
  await player.toggle('A');
  context.currentTime=20;
  assert.equal(player.getState().position,15);
  await player.toggle('A');
  context.currentTime=24;
  assert.equal(player.getState().position,20);
  player.seek(30);
  context.currentTime=28;
  assert.equal(player.getState().position,35);
  player.setRate(100);
  assert.equal(player.getState().position,35);
  assert.equal(player.getState().rate,1.5);
  player.setRate(-1);
  assert.equal(player.getState().rate,.5);
  player.setRate(NaN);
  assert.equal(player.getState().rate,.5);
  context.currentTime=30;
  assert.equal(player.getState().position,36);
});

test('three-band EQ uses the intended signal chain, clamps gain and returns a state copy', async () => {
  const {player,context}=setup();
  await player.toggle('A');
  const {low,mid,high}=player.eqNodes;
  assert.equal(low.type,'lowshelf'); assert.equal(low.frequency.value,250);
  assert.equal(mid.type,'peaking'); assert.equal(mid.frequency.value,1000); assert.equal(mid.Q.value,.8);
  assert.equal(high.type,'highshelf'); assert.equal(high.frequency.value,4000);
  assert.deepEqual(context.sources.at(-1).connections,[low]);
  assert.deepEqual(low.connections,[mid]); assert.deepEqual(mid.connections,[high]); assert.deepEqual(high.connections,[player.gain]);
  player.setEQ('low',-100); player.setEQ('mid',6); player.setEQ('high',100);
  assert.deepEqual(player.getState().eq,{low:-24,mid:6,high:12});
  assert.equal(low.gain.value,-24); assert.equal(mid.gain.value,6); assert.equal(high.gain.value,12);
  player.setEQ('invalid',10); player.setEQ('mid',NaN);
  const copied=player.getState().eq;copied.mid=-24;
  assert.equal(player.getState().eq.mid,6);
});

test('the same track keeps tempo and EQ after stop; a different track resets both', async () => {
  const {player,context}=setup();
  await player.toggle('A');
  player.setRate(.8);player.setEQ('low',-8);player.setEQ('high',4);
  player.stop();
  assert.equal(player.getState().rate,.8);
  assert.deepEqual(player.getState().eq,{low:-8,mid:0,high:4});
  await player.toggle('A');
  assert.equal(context.sources.at(-1).playbackRate.value,.8);
  assert.equal(player.eqNodes.low.gain.value,-8);
  await player.toggle('B');
  assert.equal(context.sources.at(-1).playbackRate.value,1);
  assert.equal(player.getState().rate,1);
  assert.deepEqual(player.getState().eq,{low:0,mid:0,high:0});
  for(const node of Object.values(player.eqNodes))assert.equal(node.gain.value,0);
});

test('shared buffer lookup happens after gesture resume and replay after stop reuses cached PCM', async () => {
  const context = new Context(), cache = new AudioBufferCache();
  let lookups = 0, reads = 0;
  context.decodeAudioData = async id => {context.decoded.push(id); return {id, duration:60, length:1024, numberOfChannels:2};};
  const player = new PreviewPlayer({createContext:()=>context, getAudio:async id=>{reads++; return blob(id);},
    getBuffer:(id, decode)=>{lookups++; assert.equal(context.state, 'running'); return cache.get(id, decode);}});
  const first = player.toggle('A');
  assert.equal(context.resumeCalls, 1);
  assert.equal(lookups, 0);
  await first;
  player.stop();
  assert.equal(player.buffer, null);
  await player.toggle('A');
  assert.equal(player.getState().playing, true);
  assert.equal(lookups, 2);
  assert.equal(reads, 1);
  assert.deepEqual(context.decoded, ['A']);
});

test('cancelling an audition does not cancel a shared decode or allow stale autoplay', async () => {
  for (const cancel of ['stop', 'clear', 'dispose']) {
    const context = new Context(), cache = new AudioBufferCache(), wait = deferred();
    context.decodeAudioData = async id => {context.decoded.push(id); return {id, duration:60, length:1024, numberOfChannels:2};};
    const player = new PreviewPlayer({createContext:()=>context, getAudio:()=>wait.promise,
      getBuffer:(id, decode)=>cache.get(id, decode)});
    const audition = player.toggle('A');
    await flush();
    const deck = cache.get('A', () => assert.fail('shared work was not reused'));
    player[cancel]();
    wait.resolve(blob('A'));
    await audition;
    assert.equal((await deck).id, 'A');
    assert.deepEqual(context.decoded, ['A']);
    assert.equal(context.sources.length, 0);
    assert.equal(player.getState().playing, false);
    assert.equal(player.buffer, null);
  }
});

test('a stale shared-cache rejection does not affect a later successful audition', async () => {
  const context = new Context(), first = deferred();
  const player = new PreviewPlayer({createContext:()=>context,
    getBuffer:id=>id === 'A' ? first.promise : Promise.resolve({duration:60})});
  const old = player.toggle('A'); await flush();
  await player.toggle('B');
  first.reject(new Error('stale cache error')); await old;
  assert.equal(player.getState().trackId, 'B');
  assert.equal(player.getState().playing, true);
  assert.equal(player.getState().error, null);
});
