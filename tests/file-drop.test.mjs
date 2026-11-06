import test from 'node:test';
import assert from 'node:assert/strict';
import {installFileDrop,isAudioFile,isFileDrag} from '../dist/file-drop.js';

function harness() {
  const target = new EventTarget();
  const host = new EventTarget();
  const states = [], batches = [];
  const dispose = installFileDrop({target,host,onActive:value=>states.push(value),onFiles:files=>batches.push(files)});
  const emit = (type, transfer, extra = {}, receiver = target) => {
    const event = new Event(type, {cancelable:true});
    Object.assign(event, {dataTransfer:transfer,...extra});
    receiver.dispatchEvent(event);
    return event;
  };
  return {target,host,states,batches,emit,dispose};
}
const protectedFiles = () => ({types:['Files'],items:[],files:[],dropEffect:'none'});

test('file drag detection works during the protected drag phase, and ignores text/links', () => {
  assert.equal(isFileDrag(protectedFiles()),true);
  assert.equal(isFileDrag({types:[],items:[{kind:'file'}]}),true);
  assert.equal(isFileDrag({types:['text/plain','text/uri-list'],items:[{kind:'string'}]}),false);
  assert.equal(isFileDrag(null),false);
  assert.equal(isAudioFile({name:'TRACK.WAV',type:''}),true);
  assert.equal(isAudioFile({name:'no-extension',type:'audio/mp4'}),true);
  assert.equal(isAudioFile({name:'notes.txt',type:'text/plain'}),false);
  assert.equal(isAudioFile({name:'cover.jpg',type:'image/jpeg'}),false);
});

test('nested enters/leaves keep the overlay stable and a file drop is copied synchronously', () => {
  const h=harness(), transfer=protectedFiles();
  assert.equal(h.emit('dragenter',transfer).defaultPrevented,true);
  h.emit('dragenter',transfer);
  h.emit('dragleave',transfer);
  assert.deepEqual(h.states,[true]);
  assert.equal(h.emit('dragover',transfer).defaultPrevented,true);
  assert.equal(transfer.dropEffect,'copy');
  const first={name:'A.wav'}, second={name:'B.mp3'};
  transfer.files=[first,second];
  assert.equal(h.emit('drop',transfer).defaultPrevented,true);
  transfer.files.length=0;
  assert.deepEqual(h.batches,[[first,second]]);
  assert.deepEqual(h.states,[true,false]);
});

test('dropping item-backed files ignores directories and non-file items', () => {
  const h=harness(), track={name:'track.flac'};
  h.emit('drop',{types:['Files'],items:[
    {kind:'string',getAsFile:()=>null},
    {kind:'file',webkitGetAsEntry:()=>({isDirectory:true}),getAsFile:()=>({name:'folder'})},
    {kind:'file',getAsFile:()=>track},
    {kind:'file',getAsFile:()=>null},
  ]});
  assert.deepEqual(h.batches,[[track]]);
});

test('leaving, cancellation, losing focus and disposal clear the drag indicator', () => {
  const h=harness();
  h.emit('dragenter',protectedFiles());h.emit('dragleave',protectedFiles());
  h.emit('dragenter',protectedFiles());h.emit('keydown',null,{key:'Escape'});
  h.emit('dragenter',protectedFiles());h.emit('blur',null,{},h.host);
  h.emit('dragenter',protectedFiles());h.emit('dragend');
  h.emit('dragover',protectedFiles());h.emit('pagehide',null,{},h.host);
  h.emit('dragenter',protectedFiles());h.dispose();
  assert.deepEqual(h.states,[true,false,true,false,true,false,true,false,true,false,true,false]);
  h.emit('dragenter',protectedFiles());
  assert.equal(h.states.length,12);
});

test('ordinary drags are never prevented or imported', () => {
  const h=harness(), transfer={types:['text/plain'],items:[{kind:'string'}],files:[]};
  for(const type of ['dragenter','dragover','drop'])assert.equal(h.emit(type,transfer).defaultPrevented,false);
  assert.deepEqual(h.states,[]);
  assert.deepEqual(h.batches,[]);
});
