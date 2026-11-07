/** Intercept deck gestures before transport, range and platter handlers while
 * learning. The same rendered DJ controls remain the assignment targets. */
export function installDeckMidiLearn({root,isActive,onSelect,onUnsupported=()=>{}}){
  const listeners=[];let pointerAction=null;
  const block=event=>{event.preventDefault();event.stopImmediatePropagation();};
  const control=event=>{
    if(!isActive()||event.target.closest?.('[data-midi-ignore]'))return null;
    return event.target.closest?.('[data-midi-action],button,input,canvas,[role="slider"]');
  };
  const listen=(name,handler)=>{root.addEventListener(name,handler,{capture:true});listeners.push([name,handler]);};
  listen('pointerdown',event=>{
    const target=control(event);if(!target)return;
    block(event);pointerAction=target.dataset?.midiAction||null;
    if(target.matches?.('input[type=range]'))target.dataset.midiValue=target.value;
    if(pointerAction){target.focus?.({preventScroll:true});onSelect(pointerAction);}else onUnsupported();
  });
  listen('click',event=>{
    const target=control(event);if(!target)return;
    block(event);const action=target.dataset?.midiAction;
    if(action&&(event.detail===0||action!==pointerAction))onSelect(action);
    else if(!action)onUnsupported();
    pointerAction=null;
  });
  for(const name of ['pointermove','pointerup','pointercancel'])listen(name,event=>{if(control(event))block(event);if(name==='pointercancel')pointerAction=null;});
  listen('keydown',event=>{
    const target=control(event);if(!target||!['Enter','Space','ArrowLeft','ArrowRight','ArrowUp','ArrowDown','Home','End'].includes(event.code))return;
    block(event);
    if(!event.repeat&&['Enter','Space'].includes(event.code)){const action=target.dataset?.midiAction;action?onSelect(action):onUnsupported();}
  });
  for(const name of ['input','change'])listen(name,event=>{
    const target=control(event);if(!target)return;block(event);
    if(target.matches?.('input[type=range]')&&target.dataset.midiValue!==undefined)target.value=target.dataset.midiValue;
  });
  return {dispose(){for(const[name,handler]of listeners)root.removeEventListener(name,handler,{capture:true});}};
}
