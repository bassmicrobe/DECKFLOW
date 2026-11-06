import test from 'node:test';
import assert from 'node:assert/strict';
import {createTrackQueue} from '../dist/track-updates.js';

test('rapid hot-cue saves merge against the last persisted track instead of overwriting pads',async()=>{
  const queue=createTrackQueue();let track={hotcues:[null,null,null,null]};let release;
  const gate=new Promise(resolve=>release=resolve);
  const first=queue.run('song',async()=>{const updated={hotcues:[...track.hotcues]};updated.hotcues[0]=1.25;await gate;track=updated;});
  const second=queue.run('song',async()=>{const updated={hotcues:[...track.hotcues]};updated.hotcues[1]=2.5;track=updated;});
  release();await Promise.all([first,second]);assert.deepEqual(track.hotcues,[1.25,2.5,null,null]);
});
test('a rejected write does not block the next save or an unrelated track',async()=>{
  const queue=createTrackQueue();const failed=queue.run('a',()=>{throw new Error('quota');});
  const next=queue.run('a',()=>42);const other=queue.run('b',()=>17);
  await assert.rejects(failed,/quota/);assert.equal(await other,17);assert.equal(await next,42);
});
test('deletion follows pending saves and cannot be undone by an older delayed write',async()=>{
  const queue=createTrackQueue();let saved={id:'a'};let release;const gate=new Promise(resolve=>release=resolve);
  const write=queue.run('a',async()=>{await gate;saved={id:'a',cue:2};});
  const remove=queue.run('a',()=>{saved=null;});release();await Promise.all([write,remove]);assert.equal(saved,null);
});
