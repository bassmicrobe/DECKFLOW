import test from 'node:test';
import assert from 'node:assert/strict';
import {editTrackHotCue} from '../dist/track-hotcues.js';
import {exportPositionMarks} from '../dist/usb-export.js';
import {validateLibrarySnapshot} from '../dist/library-store.js';
import {createTrackQueue} from '../dist/track-updates.js';

const track=()=>({id:'cue-test',title:'CUE test',artist:'QA',filename:'cue-test.wav',duration:60,bpm:120,beatOffset:.1,cue:1,hotcues:[2,null,null,null,null,null,null,null],peaks:[],addedAt:123});
test('new audio retains every hot cue and the main cue in USB export after editing',()=>{
  const input=track(),updated=editTrackHotCue(input,7,12.345,{now:456});
  assert.equal(input.hotcues[7],null);assert.equal(updated.updatedAt,456);
  assert.equal(updated.positionMarks,undefined);
  const validated=validateLibrarySnapshot({format:'deckflow.library',version:1,tracks:[updated],playlists:[]}).tracks[0];
  assert.deepEqual(exportPositionMarks(validated).map(mark=>[mark.num,mark.start]),[[-1,1],[0,2],[7,12.345]]);
});
test('editing one imported bank preserves memory cues, other loops, names, colors and grid',()=>{
  const memory={name:'memory',num:-1,type:0,start:3,end:null,color:null},loop={name:'loop',num:1,type:4,start:4,end:8,color:'#ff0000'};
  const input={...track(),hotcues:[2,4,null,null,null,null,null,null],tempos:[{start:.1,bpm:120,meter:'4/4',beat:1}],positionMarks:[memory,loop,{name:'intro',num:0,type:0,start:2,end:null,color:'#00ffff'}]};
  const updated=editTrackHotCue(input,0,6,{now:456});
  assert.equal(updated.positionMarks[0],memory);assert.equal(updated.positionMarks[1],loop);assert.equal(updated.tempos,input.tempos);
  assert.deepEqual(updated.positionMarks[2],{name:'intro',num:0,type:0,start:6,end:null,color:'#00ffff'});
  assert.equal(input.positionMarks[2].start,2);
  const cleared=editTrackHotCue(updated,0,NaN,{clear:true,now:457});
  assert.deepEqual(cleared.positionMarks,[memory,loop]);assert.equal(cleared.hotcues[0],null);assert.equal(cleared.hotcues[1],4);
});
test('no-op edits preserve dates and invalid positions cannot be saved',()=>{
  const input=track();assert.equal(editTrackHotCue(input,0,2),input);assert.equal(editTrackHotCue(input,7,NaN,{clear:true}),input);
  for(const value of [-1,61,NaN,Infinity])assert.throws(()=>editTrackHotCue(input,1,value));
  for(const index of [-1,8,1.5])assert.throws(()=>editTrackHotCue(input,index,2));
  assert.equal(editTrackHotCue(input,1,0).hotcues[1],0);
});
test('a failed queued save leaves displayed metadata unchanged and does not block the next bank',async()=>{
  const queue=createTrackQueue();let current=track();
  const save=(index,position,fail=false)=>queue.run(current.id,async()=>{const next=editTrackHotCue(current,index,position,{now:456});if(fail)throw new Error('quota');current=next;});
  const failed=save(1,10,true),next=save(2,20);await assert.rejects(failed,/quota/);await next;
  assert.equal(current.hotcues[1],null);assert.equal(current.hotcues[2],20);assert.equal(current.hotcues[0],2);
});
