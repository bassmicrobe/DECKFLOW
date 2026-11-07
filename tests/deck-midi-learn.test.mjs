import test from 'node:test';
import assert from 'node:assert/strict';
import {installDeckMidiLearn} from '../dist/deck-midi-learn.js';

function fixture(){
  const handlers=new Map(),selected=[],state={active:true,unsupported:0};
  const root={addEventListener(name,handler,options){assert.equal(options.capture,true);handlers.set(name,handler);},removeEventListener(name){handlers.delete(name);}};
  const binding=installDeckMidiLearn({root,isActive:()=>state.active,onSelect:id=>selected.push(id),onUnsupported:()=>state.unsupported++});
  const target=(action,{ignore=false,range=false}={})=>({dataset:action?{midiAction:action}:{},value:'.5',focus(){},matches:()=>range,
    closest(selector){return selector==='[data-midi-ignore]'?(ignore?this:null):this;}});
  const emit=(type,target,extra={})=>{const event={target,detail:1,prevented:false,stopped:false,preventDefault(){this.prevented=true;},stopImmediatePropagation(){this.stopped=true;},...extra};handlers.get(type)?.(event);return event;};
  return {handlers,selected,state,binding,target,emit};
}
test('clicking a deck target arms one MIDI assignment and blocks the underlying play gesture',()=>{
  const f=fixture(),play=f.target('a.play');
  for(const type of ['pointerdown','pointerup','click']){const event=f.emit(type,play);assert.equal(event.prevented,true);assert.equal(event.stopped,true);}
  assert.deepEqual(f.selected,['a.play']);f.binding.dispose();assert.equal(f.handlers.size,0);
});
test('range gestures and keyboard changes cannot move the mixer while assigning',()=>{
  const f=fixture(),range=f.target('mixer.crossfader',{range:true});
  f.emit('pointerdown',range);range.value='.9';f.emit('input',range);
  assert.equal(range.value,'.5');assert.deepEqual(f.selected,['mixer.crossfader']);
  assert.equal(f.emit('keydown',range,{code:'ArrowRight'}).prevented,true);
  assert.equal(f.emit('keydown',range,{code:'Tab'}).prevented,false);
});
test('keyboard activation can choose a target and control-toolbar clicks remain interactive',()=>{
  const f=fixture(),cue=f.target('b.cue');
  f.emit('keydown',cue,{code:'Enter'});assert.deepEqual(f.selected,['b.cue']);
  const ignored=f.emit('click',f.target(null,{ignore:true}));assert.equal(ignored.stopped,false);
});
test('inactive assignment mode passes transport through, unsupported platter gestures stay blocked',()=>{
  const f=fixture(),platter=f.target(null);f.emit('pointerdown',platter);assert.equal(f.state.unsupported,1);
  f.state.active=false;const event=f.emit('pointerdown',f.target('a.play'));assert.equal(event.stopped,false);assert.deepEqual(f.selected,[]);
});
