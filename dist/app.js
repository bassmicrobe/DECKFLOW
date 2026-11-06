import {AudioEngine} from './audio-engine.js?v=401613a8eaa5242c';
import {MappingManager} from './mappings.js?v=401613a8eaa5242c';
import {openLibrary} from './library-store.js?v=401613a8eaa5242c';
import {validateUsbLibrary} from './usb-export.js?v=401613a8eaa5242c';
import {createTrackQueue} from './track-updates.js?v=401613a8eaa5242c';
import {installFileDrop,isAudioFile} from './file-drop.js?v=401613a8eaa5242c';
import {PreviewPlayer} from './preview-player.js?v=401613a8eaa5242c';
import {AudioBufferCache} from './audio-buffer-cache.js?v=401613a8eaa5242c';
import {WaveformCache} from './waveform-cache.js?v=401613a8eaa5242c';
import {drawWaveform,getWaveformWindow,timeAtWaveformX,waveformBeats} from './waveform-view.js?v=401613a8eaa5242c';
import {indexFileList,indexDirectory,createSourceIndex,databaseCandidates,createLibraryReader} from './library-source.js?v=401613a8eaa5242c';
import {cacheSourceLibrary} from './source-import.js?v=401613a8eaa5242c';
import {parseRekordboxXml} from './rekordbox-import.js?v=401613a8eaa5242c';
import {findImportedAudio,audioPeaks,tempoAt,advanceBeats,relinkMetadata} from './import-audio.js?v=401613a8eaa5242c';

const $ = selector => document.querySelector(selector);
const $$ = selector => [...document.querySelectorAll(selector)];
const escapeHTML = value => String(value ?? '').replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const clamp = (n, min, max) => Math.max(min, Math.min(max, n));
const uid = () => crypto.randomUUID();
const time = seconds => {const s = Math.max(0, Math.floor(seconds || 0)); return `${Math.floor(s/60)}:${String(s%60).padStart(2,'0')}`;};
let toastTimer;
function toast(message) { $('#toast').textContent = message; $('#toast').classList.add('visible'); clearTimeout(toastTimer); toastTimer = setTimeout(() => $('#toast').classList.remove('visible'), 4200); }
function report(error) { console.error(error); toast(error?.message || '操作を完了できませんでした。'); }
function download(name, content, type = 'application/json') {const url = URL.createObjectURL(new Blob([content], {type}));const a = document.createElement('a');a.href=url;a.download=name;a.click();setTimeout(()=>URL.revokeObjectURL(url),10000);}
function askConfirm(message){return new Promise(resolve=>{const dialog=$('#confirm-dialog');$('#confirm-dialog-message').textContent=message;dialog.returnValue='cancel';$('#confirm-dialog-cancel').onclick=()=>dialog.close('cancel');$('#confirm-dialog-accept').onclick=()=>dialog.close('yes');dialog.addEventListener('close',()=>resolve(dialog.returnValue==='yes'),{once:true});dialog.showModal();});}
function askPlaylistName(){return new Promise(resolve=>{const dialog=$('#text-dialog');const input=$('#text-dialog-input');input.value='';dialog.returnValue='cancel';$('#text-dialog-form').onsubmit=event=>{event.preventDefault();if(input.value.trim())dialog.close('save');};$('#text-dialog-cancel').onclick=()=>dialog.close('cancel');dialog.addEventListener('close',()=>resolve(dialog.returnValue==='save'?input.value.trim():null),{once:true});dialog.showModal();input.focus();});}

const actions = [];
for (const deck of ['a','b']) {
  for (const [name,label] of [['play','再生 / 一時停止'],['cue','CUEへ戻る'],['loop','ループ ON / OFF'],['sync','BPM SYNC'],...Array.from({length:8},(_,i)=>[`hotcue${i+1}`,`HOT CUE ${i+1}`])]) actions.push({id:`${deck}.${name}`,label,kind:'trigger'});
  for (const [name,label] of [['volume','チャンネル音量'],['tempo','テンポ'],['eq.low','EQ LOW'],['eq.mid','EQ MID'],['eq.high','EQ HIGH']]) actions.push({id:`${deck}.${name}`,label,kind:'continuous'});
}
actions.push({id:'mixer.crossfader',label:'クロスフェーダー',kind:'continuous'},{id:'mixer.master',label:'マスター音量',kind:'continuous'},{id:'mixer.center',label:'クロスフェーダーを中央へ',kind:'trigger'});
let library;
let tracks = [];
let playlists = [];
let activePlaylist = 'all';
let sources=[],activeSource=null,libraryPage=0;
const PAGE_SIZE=75;
let selectedSourceIndex=null,selectedCandidates=[],refreshSourceId=null,sourceController=null,sourceReader=null;
const bufferCache=new AudioBufferCache();
let waveformCache=new WaveformCache();
const detailedWaves=new Map(),waveformJobs=new Map(),waveformKeys=new Map();
let previewWaveRange=null,pageActive=true;
let mappingGroup = 'all';
let importing = false;
let editingTrack = null;
let relinkTrack = null;
let view = 'library';
const trackQueue=createTrackQueue();
const decks = {a:{trackId:null,pendingTrackId:null,loopBeats:4,loadNonce:0,angle:0,waveSpan:8,waveRange:null},b:{trackId:null,pendingTrackId:null,loopBeats:4,loadNonce:0,angle:0,waveSpan:8,waveRange:null}};
const engine = new AudioEngine({onEnded:()=>updateDecks(),onStatus:status=>{if(status.message)toast(status.message);updateDecks();}});
let pendingDeckPlayback=0;
const preview = new PreviewPlayer({getAudio:id=>library?.getAudio(id),getBuffer:async(id,decode)=>{const buffer=await bufferCache.get(id,decode);prepareWaveform(id,buffer);return buffer;},onChange:()=>updatePreview()});
const mapping = new MappingManager({actions,onAction:(id,value,phase)=>{if(phase !== 'release') dispatch(id,value).catch(report);},onChange:()=>renderMappings(),onStatus:status=>{renderMIDIStatus(status);}});

function renderDecks() {
  $('#decks').innerHTML = ['a','b'].map(id=>`<article class="deck" data-deck="${id}" aria-label="デッキ ${id.toUpperCase()}">
    <div class="deck-top"><span class="deck-letter">${id.toUpperCase()}</span><div class="deck-meta"><div class="deck-title" id="${id}-title">曲を読み込んでください</div><div class="deck-artist" id="${id}-artist">ライブラリから曲を選択</div></div><div class="deck-bpm"><span id="${id}-bpm">—.—</span><small>BPM</small></div></div>
    <div class="wave-toolbar"><span>波形</span><div class="wave-zoom"><button type="button" data-wave-zoom="${id}:out" aria-label="デッキ ${id.toUpperCase()} 波形を縮小">−</button><output id="${id}-wave-span">8s</output><button type="button" data-wave-zoom="${id}:in" aria-label="デッキ ${id.toUpperCase()} 波形を拡大">＋</button></div></div>
    <div class="deck-wave"><canvas id="${id}-wave" aria-label="デッキ ${id.toUpperCase()} 詳細波形" role="slider" tabindex="0" aria-valuemin="0" aria-valuemax="0" aria-valuenow="0"></canvas><span class="wave-empty" id="${id}-wave-empty">曲を読み込んでください</span></div>
    <div class="deck-overview"><canvas id="${id}-overview" aria-label="デッキ ${id.toUpperCase()} 全体波形" role="slider" tabindex="0" aria-valuemin="0" aria-valuemax="0" aria-valuenow="0"></canvas></div>
    <div class="deck-timeline"><span class="current-time" id="${id}-time">0:00</span><span id="${id}-remaining">− 0:00</span></div>
    <div class="platter-section"><button class="platter" id="${id}-platter" aria-label="デッキ ${id.toUpperCase()} プラッター。ドラッグでスクラッチ、矢印キーで前後へ移動"><span class="record"><span class="record-grooves"></span><span class="record-label"><b>${id.toUpperCase()}</b><small>DECKFLOW</small><i></i></span><span class="record-marker"></span></span><span class="platter-rim"></span></button><div class="platter-info"><span class="platter-status sr-only" id="${id}-scratch-state"></span><button class="keylock-button" id="${id}-keylock" aria-pressed="false">KEY LOCK</button></div></div>
    <div class="deck-main-controls"><button class="transport" data-action="${id}.cue" aria-label="デッキ ${id.toUpperCase()} CUEへ戻る">CUE</button><button class="transport play" data-action="${id}.play" id="${id}-play" aria-label="デッキ ${id.toUpperCase()} 再生" aria-pressed="false">▶</button><button class="transport" data-action="${id}.sync" aria-label="デッキ ${id.toUpperCase()} BPMを同期">SYNC</button><button class="transport" data-action="${id}.loop" id="${id}-loop" aria-label="デッキ ${id.toUpperCase()} ループ" aria-pressed="false">LOOP</button></div>
    <div class="hotcues">${Array.from({length:8},(_,i)=>i).map(i=>`<button class="hotcue" data-hotcue="${id}:${i}" id="${id}-hotcue-${i}" aria-label="デッキ ${id.toUpperCase()} HOT CUE ${i+1}" title="未設定なら現在位置を保存。設定後はジャンプ。Shift＋クリックで解除">${i+1}<small>HOT CUE</small></button>`).join('')}</div>
    <div class="deck-bottom"><div class="eq-controls">${['low','mid','high'].map(band=>`<div class="eq-control"><label for="${id}-eq-${band}">${band.toUpperCase()}</label><input id="${id}-eq-${band}" data-control="${id}.eq.${band}" type="range" min="-24" max="12" step="0.1" value="0" aria-label="デッキ ${id.toUpperCase()} EQ ${band}"><output id="${id}-eq-${band}-value">0.0</output></div>`).join('')}</div><div class="tempo-volume"><div class="tempo-control"><label for="${id}-tempo">TEMPO <output id="${id}-tempo-value">+0.0%</output></label><input id="${id}-tempo" data-control="${id}.tempo" type="range" min="-50" max="50" step="0.1" value="0" aria-label="デッキ ${id.toUpperCase()} テンポ"></div><div class="volume-control"><label for="${id}-volume">LEVEL <output id="${id}-volume-value">85%</output></label><input id="${id}-volume" data-control="${id}.volume" type="range" min="0" max="1" step="0.01" value="0.85" aria-label="デッキ ${id.toUpperCase()} 音量"></div><div class="loop-controls"><span>BEATS</span>${[1,2,4,8].map(n=>`<button class="loop-size${n===4?' active':''}" data-loop-size="${id}:${n}" aria-label="デッキ ${id.toUpperCase()} ${n}拍ループ">${n}</button>`).join('')}</div></div></div></article>`).join('');
  for (const id of ['a','b']) bindPlatter(id);
}

async function dispatch(id,value=1) {
  if (id === 'mixer.center') return setControl('mixer.crossfader',.5);
  const action = actions.find(a=>a.id===id);
  if(!action)return;
  if(action.kind==='continuous')return setControl(id,value);
  const [deck,name]=id.split('.');
  const track=trackFor(deck);
  if(!track){toast('先にライブラリの曲をデッキへ読み込んでください。');return;}
  if(name==='play')await startDeckPlayback(()=>engine.toggle(deck));
  if(name==='cue')engine.jumpCue(deck);
  if(name.startsWith('hotcue'))await hotCue(deck,Number(name.slice(6))-1);
  if(name==='loop')toggleLoop(deck);
  if(name==='sync')syncDeck(deck);
  updateDecks();
}

function setControl(id,value) {
  value=clamp(Number(value),0,1);
  if(!Number.isFinite(value))return;
  mapping.setActionValue(id,value);
  if(id==='mixer.crossfader'){engine.setCrossfader(value);$('#crossfader').value=value;return;}
  if(id==='mixer.master'){engine.setMaster(value);$('#master').value=value;$('#master-value').textContent=`${Math.round(value*100)}%`;return;}
  const [deck,name,band]=id.split('.');
  if(name==='tempo') {const percent=(value-.5)*100;engine.setRate(deck,1+percent/100);$(`#${deck}-tempo`).value=percent;$(`#${deck}-tempo-value`).textContent=`${percent>=0?'+':''}${percent.toFixed(1)}%`;}
  if(name==='volume'){engine.setVolume(deck,value);$(`#${deck}-volume`).value=value;$(`#${deck}-volume-value`).textContent=`${Math.round(value*100)}%`;}
  if(name==='eq'){const db=-24+value*36;engine.setEQ(deck,band,db);$(`#${deck}-eq-${band}`).value=db;$(`#${deck}-eq-${band}-value`).textContent=`${db>0?'+':''}${db.toFixed(1)}`;}
  updateDecks();
}

const trackFor = deck => tracks.find(t=>t.id===decks[deck]?.trackId);
async function loadDeck(deck,trackId) {
  const track=tracks.find(t=>t.id===trackId);if(!track)return;
  if(track.audioMissing){relinkTrack=trackId;$('#link-audio-file').click();return;}
  if(engine.getState(deck).playing && !await askConfirm(`デッキ ${deck.toUpperCase()} は再生中です。曲を入れ替えますか？`))return;
  const nonce=++decks[deck].loadNonce;
  decks[deck].pendingTrackId=trackId;
  $(`#${deck}-title`).textContent='読み込み中…';
  try {const buffer=await bufferCache.get(trackId,async()=>{const blob=await library.getAudio(trackId);if(!blob)throw new Error('元の音源を読み込めません。曲を追加し直してください。');return engine.decode(await blob.arrayBuffer());});if(nonce!==decks[deck].loadNonce||!tracks.some(t=>t.id===trackId))return;
    engine.load(deck,buffer);prepareWaveform(trackId,buffer);engine.setCue(deck,track.cue||0);decks[deck].trackId=trackId;decks[deck].angle=0;
    setControl(`${deck}.tempo`,.5);updateDecks();renderLibrary();toast(`デッキ ${deck.toUpperCase()} に ${track.title} を読み込みました。`);
  } catch(error){if(nonce===decks[deck].loadNonce)updateDecks();report(error);}finally{if(nonce===decks[deck].loadNonce)decks[deck].pendingTrackId=null;}
}

async function hotCue(deck,index,clear=false){
  const track=trackFor(deck);if(!track)return;
  const state=engine.getState(deck);const pos=Math.min(state.position,Math.max(0,state.duration-.001));
  await trackQueue.run(track.id,async()=>{
    const current=tracks.find(t=>t.id===track.id);if(!current)throw new Error('この曲はライブラリから削除されています。');
    const updated={...current,hotcues:[...(current.hotcues||Array(8).fill(null))]};
    if(clear||current.hotcues?.[index]==null){updated.hotcues[index]=clear?null:pos;if(current.positionMarks){updated.positionMarks=current.positionMarks.filter(mark=>mark.num!==index);if(!clear)updated.positionMarks.push({name:`HOT CUE ${index+1}`,type:0,start:pos,end:null,num:index,color:null});}await library.putTrack(updated);tracks=tracks.map(t=>t.id===updated.id?updated:t);toast(clear?`HOT CUE ${index+1} を解除しました。`:`HOT CUE ${index+1} を ${time(pos)} に保存しました。`);}
    else if(decks[deck].trackId===track.id){engine.clearLoop(deck);engine.seek(deck,current.hotcues[index]);const mark=current.positionMarks?.find(mark=>mark.num===index);if(mark?.type===4)engine.setLoop(deck,mark.start,mark.end);await startDeckPlayback(()=>engine.play(deck));}
  });
  updateDecks();
}
function toggleLoop(deck){
  const track=trackFor(deck);if(!track)return;
  const state=engine.getState(deck);if(state.loop){engine.clearLoop(deck);return;}
  if(!track.bpm){toast('ループにはBPMが必要です。曲の情報から設定できます。');return;}
  const tempo=tempoAt(track,state.position);const beat=60/tempo.bpm;const offset=tempo.start;
  let start=offset+Math.floor((state.position-offset)/beat)*beat;start=Math.max(0,start);
  const end=Math.min(state.duration,advanceBeats(track,start,decks[deck].loopBeats));
  if(end-start<.05){toast('曲の終端ではループを作成できません。');return;}
  engine.setLoop(deck,start,end);
}
function syncDeck(deck){
  const other=deck==='a'?'b':'a';const own=trackFor(deck),target=trackFor(other);
  if(!own?.bpm||!target?.bpm){toast('両方のデッキへBPMのある曲を読み込んでください。');return;}
  const ownBpm=tempoAt(own,engine.getState(deck).position).bpm;const targetBpm=tempoAt(target,engine.getState(other).position).bpm;const rate=targetBpm*engine.getState(other).rate/ownBpm;
  if(rate<.5||rate>1.5){toast('BPM差がテンポの調整範囲（±50%）を超えています。');return;}
  setControl(`${deck}.tempo`,rate-.5);toast(`BPMを ${(ownBpm*rate).toFixed(2)} に合わせました。`);
}

function bindPlatter(id){
  const el=$(`#${id}-platter`);let gesture=null;
  const angle=event=>{const r=el.getBoundingClientRect();return Math.atan2(event.clientY-r.top-r.height/2,event.clientX-r.left-r.width/2);};
  const end=()=>{if(!gesture)return;gesture=null;startDeckPlayback(()=>engine.endScratch?.(id)).then(()=>updateDecks()).catch(report);updateDecks();};
  el.addEventListener('pointerdown',event=>{if(event.button!==0||gesture||!trackFor(id))return;event.preventDefault();el.setPointerCapture(event.pointerId);const state=engine.getState(id);const active={pointerId:event.pointerId,angle:angle(event),position:state.position,rotation:decks[id].angle,ready:false};gesture=active;
    startDeckPlayback(()=>engine.beginScratch?.(id)).then(()=>{if(gesture!==active)return;active.ready=true;engine.scratchTo?.(id,active.position);updateDecks();}).catch(error=>{if(gesture===active)gesture=null;report(error);});});
  el.addEventListener('pointermove',event=>{if(!gesture||gesture.pointerId!==event.pointerId)return;event.preventDefault();const next=angle(event);let delta=next-gesture.angle;if(delta>Math.PI)delta-=2*Math.PI;if(delta< -Math.PI)delta+=2*Math.PI;gesture.angle=next;gesture.position=clamp(gesture.position+delta/(2*Math.PI)*1.8,0,engine.getState(id).duration);gesture.rotation+=delta*180/Math.PI;decks[id].angle=gesture.rotation;el.querySelector('.record').style.transform=`rotate(${gesture.rotation}deg)`;if(gesture.ready)engine.scratchTo?.(id,gesture.position);});
  for(const name of ['pointerup','pointercancel','lostpointercapture'])el.addEventListener(name,end);
  el.addEventListener('keydown',event=>{if(!['ArrowLeft','ArrowRight'].includes(event.code)||!trackFor(id))return;event.preventDefault();engine.clearLoop(id);engine.seek(id,engine.getState(id).position+(event.code==='ArrowLeft'?-.1:.1));});
  $(`#${id}-keylock`).addEventListener('click',()=>{if(typeof engine.setKeyLock!=='function'){toast('音程を保つテンポ変更は準備中です。');return;}const enabled=!engine.getState(id).keyLockRequested;Promise.resolve(engine.setKeyLock(id,enabled)).then(()=>updateDecks()).catch(report);});
  for(const kind of ['wave','overview']){
    const canvas=$(`#${id}-${kind}`);let range=null;
    const currentRange=()=>kind==='overview'?{start:0,end:engine.getState(id).duration}:decks[id].waveRange||getWaveformWindow(engine.getState(id).duration,engine.getState(id).position,decks[id].waveSpan);
    const seek=event=>{const state=engine.getState(id);if(!state.loaded)return;const r=canvas.getBoundingClientRect();engine.clearLoop(id);engine.seek(id,timeAtWaveformX(event.clientX-r.left,r.width,range||currentRange()));updateDecks();};
    canvas.addEventListener('pointerdown',event=>{if(event.button!==0)return;event.preventDefault();range={...currentRange()};canvas.setPointerCapture(event.pointerId);seek(event);});
    canvas.addEventListener('pointermove',event=>{if(canvas.hasPointerCapture(event.pointerId))seek(event);});
    for(const name of ['pointerup','pointercancel','lostpointercapture'])canvas.addEventListener(name,()=>{range=null;});
    canvas.addEventListener('keydown',event=>{if(!['ArrowLeft','ArrowRight','Home','End'].includes(event.code))return;event.preventDefault();const state=engine.getState(id),step=kind==='overview'?5:decks[id].waveSpan/20;engine.clearLoop(id);engine.seek(id,event.code==='Home'?0:event.code==='End'?state.duration:state.position+(event.code==='ArrowLeft'?-step:step));updateDecks();});
  }
  for(const button of $$(`[data-wave-zoom^="${id}:"]`))button.onclick=()=>{decks[id].waveSpan=clamp(decks[id].waveSpan*(button.dataset.waveZoom.endsWith(':in')?.5:2),2,32);updateDecks();};
}

function updateDecks(){
  for(const id of ['a','b']){
    const track=trackFor(id),state=engine.getState(id);
    $(`#${id}-title`).textContent=track?.title||'曲を読み込んでください';
    $(`#${id}-artist`).textContent=track?.artist||'ライブラリから曲を選択';
    $(`#${id}-bpm`).textContent=track?.bpm?(tempoAt(track,state.position).bpm*state.rate).toFixed(2):'—.—';
    const play=$(`#${id}-play`);play.classList.toggle('is-playing',state.playing);play.textContent=state.playing?'Ⅱ':'▶';play.setAttribute('aria-pressed',String(state.playing));play.setAttribute('aria-label',`デッキ ${id.toUpperCase()} ${state.playing?'一時停止':'再生'}`);
    const loop=$(`#${id}-loop`);loop.classList.toggle('active',!!state.loop);loop.setAttribute('aria-pressed',String(!!state.loop));
    $(`#${id}-wave-empty`).hidden=!!track;
    $(`#${id}-scratch-state`).textContent=state.scratching?'SCRATCHING':state.playing?'PLAYING':'';
    $(`#${id}-platter`).classList.toggle('scratching',!!state.scratching);
    const keylock=$(`#${id}-keylock`);const locked=!!state.keyLock;keylock.setAttribute('aria-pressed',String(locked));keylock.classList.toggle('active',locked);keylock.textContent=locked?'KEY LOCK':state.keyLockRequested&&!state.keyLockError?'KEY LOCK · 待機':'PITCH LINK';keylock.title=state.keyLockError||(locked?'テンポを変えても音程を保っています':'クリックして音程固定の設定を切り替えます');
    for(let i=0;i<8;i++){const cue=track?.hotcues?.[i];const button=$(`#${id}-hotcue-${i}`);button.classList.toggle('set',cue!=null);const mark=track?.positionMarks?.find(m=>m.num===i);button.title=mark?`${mark.name||`HOT CUE ${i+1}`}${mark.type===4?' · LOOP':''} · Shift＋クリックで解除`:'未設定なら現在位置を保存。設定後はジャンプ。Shift＋クリックで解除';button.innerHTML=`${i+1}<small>${cue!=null?time(cue):'HOT CUE'}</small>`;}
    drawWave(id,state);
  }
}

function prepareWaveform(trackId,buffer){
  if(!pageActive)return;
  const track=tracks.find(item=>item.id===trackId);if(!track)return;
  const key=JSON.stringify([track.id,track.fingerprint||'']);
  if(waveformKeys.get(trackId)===key&&(detailedWaves.has(trackId)||waveformJobs.has(trackId)))return;
  const old=waveformKeys.get(trackId);if(old&&old!==key)waveformCache.delete(old);
  waveformKeys.set(trackId,key);const token={};waveformJobs.set(trackId,token);
  waveformCache.get(key,buffer).then(waveform=>{
    if(waveformJobs.get(trackId)!==token||waveformKeys.get(trackId)!==key||!tracks.some(item=>item.id===trackId))return;
    detailedWaves.delete(trackId);detailedWaves.set(trackId,waveform);
    while(detailedWaves.size>8){const removable=[...detailedWaves.keys()].find(id=>id!==decks.a.trackId&&id!==decks.b.trackId&&id!==preview.getState().trackId);if(!removable)break;detailedWaves.delete(removable);}
    for(const id of ['a','b'])if(decks[id].trackId===trackId)drawWave(id);
    drawLibraryWaves();drawPreviewWave();
  }).catch(()=>{/* Display data is optional; keep the existing overview and audio. */}).finally(()=>{if(waveformJobs.get(trackId)===token)waveformJobs.delete(trackId);});
}
function invalidateWaveform(trackId){const track=tracks.find(item=>item.id===trackId);const key=waveformKeys.get(trackId)||(track?JSON.stringify([track.id,track.fingerprint||'']):null);if(key)waveformCache.delete(key);waveformKeys.delete(trackId);waveformJobs.delete(trackId);detailedWaves.delete(trackId);}
function waveOptions(track,state){return {waveform:detailedWaves.get(track?.id),peaks:track?.peaks,duration:state.duration||track?.duration||0,position:state.position,markers:(track?.hotcues||[]).flatMap((time,i)=>time==null?[]:[{time,label:String.fromCharCode(65+i)}]),loop:state.loop};}
function setWavePosition(canvas,state){canvas.setAttribute('aria-valuemax',String(state.duration||0));canvas.setAttribute('aria-valuenow',String(state.position||0));canvas.setAttribute('aria-valuetext',`${time(state.position)} / ${time(state.duration)}`);}
function drawWave(id,state=engine.getState(id)){
  const track=trackFor(id),options=waveOptions(track,state),range=getWaveformWindow(options.duration,state.position,decks[id].waveSpan);
  decks[id].waveRange=range;
  const canvas=$(`#${id}-wave`),overview=$(`#${id}-overview`);
  canvas.dataset.resolution=options.waveform?'detailed':'overview';
  drawWaveform(canvas,{...options,...range,beats:track?waveformBeats(track,range.start,range.end):[]});
  drawWaveform(overview,{...options,overview:true});
  for(const target of [canvas,overview])setWavePosition(target,state);
  $(`#${id}-wave-span`).textContent=`${decks[id].waveSpan}s`;
  for(const button of $$(`[data-wave-zoom^="${id}:"]`))button.disabled=button.dataset.waveZoom.endsWith(':in')?decks[id].waveSpan<=2:decks[id].waveSpan>=32;
}
function drawLibraryWaves(){const byId=new Map(tracks.map(track=>[track.id,track]));for(const canvas of $$('canvas[data-wave-track]')){const track=byId.get(canvas.dataset.waveTrack);if(track)drawWaveform(canvas,{waveform:detailedWaves.get(track.id),peaks:track.peaks,duration:detailedWaves.get(track.id)?.duration||track.duration,position:null,overview:true});}}
function drawPreviewWave(){
  if(view!=='library')return;const state=preview.getState(),track=tracks.find(item=>item.id===state.trackId);if(!track)return;
  const options=waveOptions(track,state),range={start:0,end:options.duration},canvas=$('#preview-wave');previewWaveRange=range;
  canvas.dataset.resolution=options.waveform?'detailed':'overview';drawWaveform(canvas,{...options,...range,overview:true});setWavePosition(canvas,state);
}

let lastFrame=0,lastUI=0,lastPreviewUI=0,lastWaveUI=0;
function animate(now){
  const dt=lastFrame?Math.min((now-lastFrame)/1000,.1):0;lastFrame=now;
  if(view==='play'&&!document.hidden){for(const id of ['a','b']){const state=engine.getState(id);if(state.playing&&!state.scratching){decks[id].angle=(decks[id].angle+dt*200*state.rate)%360;$(`#${id}-platter .record`).style.transform=`rotate(${decks[id].angle}deg)`;}
    if(now-lastWaveUI>=32&&(state.playing||state.scratching))drawWave(id,state);
    if(now-lastUI>100){const track=trackFor(id);$(`#${id}-bpm`).textContent=track?.bpm?(tempoAt(track,state.position).bpm*state.rate).toFixed(2):'—.—';$(`#${id}-time`).textContent=time(state.position);$(`#${id}-remaining`).textContent=`− ${time(state.duration-state.position)}`;}}
    if(now-lastWaveUI>=32)lastWaveUI=now;
    if(now-lastUI>100){lastUI=now;const level=engine.getLevels?.();$('#master-meter').style.height=`${Math.min(1,(level?.master||0)*2)*100}%`;$('#audio-status').textContent=engine.context?`${engine.context.sampleRate/1000} kHz / ${engine.context.state==='running'?'AUDIO ON':'待機中'}`:'音声待機中';}}
  if(view==='library'&&!document.hidden&&now-lastPreviewUI>=32){lastPreviewUI=now;updatePreviewProgress();}
  requestAnimationFrame(animate);
}

function setView(next){if(next!=='library')preview.stop();view=next;$('#play-view').classList.toggle('active',next==='play');$('#mapping-view').classList.toggle('active',next==='mapping');$('#library-section').hidden=next==='mapping';$('#library-intro').hidden=next!=='library';
  $$('.workspace-tabs .tab').forEach(button=>{const active=button.dataset.view===next;button.classList.toggle('active',active);if(active)button.setAttribute('aria-current','page');else button.removeAttribute('aria-current');});if(next==='play')updateDecks();if(next==='mapping')renderMappings();updatePreview();}

function renderLibrary(){
  const nav=$('#source-nav-list');if(nav)for(const button of nav.querySelectorAll('[data-source-view]')){const active=button.dataset.sourceView===activeSource;button.classList.toggle('active',active);button.setAttribute('aria-pressed',String(active));}
  $('#library-section').classList.toggle('is-empty',tracks.length===0);
  $('#track-count').textContent=`${tracks.length.toLocaleString('ja-JP')}曲`;
  $('#playlist-tabs').innerHTML=`<button class="pill ${activePlaylist==='all'&&!activeSource?'active':''}" data-playlist="all">すべての曲</button>`+playlists.map(p=>`<button class="pill ${activePlaylist===p.id?'active':''}" data-playlist="${escapeHTML(p.id)}">${escapeHTML([...(p.folderPath||[]),p.name].join(" / "))} <span>${p.trackIds.length}</span></button>`).join('');
  const query=$('#search').value.trim().toLocaleLowerCase();let filtered=tracks.filter(t=>(`${t.title} ${t.artist}`).toLocaleLowerCase().includes(query));
  const selectedSource=sources.find(source=>source.id===activeSource);if(selectedSource){const ids=new Set(selectedSource.trackIds);filtered=filtered.filter(track=>ids.has(track.id));}
  const playlist=playlists.find(p=>p.id===activePlaylist),positions=new Map(playlist?.trackIds.map((id,index)=>[id,index])||[]);if(playlist)filtered=filtered.filter(t=>positions.has(t.id));
  const sort=$('#sort').value;filtered.sort(sort==='bpm'?(a,b)=>(a.bpm||999)-(b.bpm||999):sort==='title'?(a,b)=>a.title.localeCompare(b.title,'ja'):playlist?(a,b)=>positions.get(a.id)-positions.get(b.id):(a,b)=>a.addedAt-b.addedAt);
  const pageCount=Math.max(1,Math.ceil(filtered.length/PAGE_SIZE));libraryPage=Math.min(libraryPage,pageCount-1);
  $('#library-pages').hidden=filtered.length<=PAGE_SIZE;$('#previous-page').disabled=libraryPage===0;$('#next-page').disabled=libraryPage===pageCount-1;$('#page-status').textContent=`${filtered.length?libraryPage*PAGE_SIZE+1:0}–${Math.min(filtered.length,(libraryPage+1)*PAGE_SIZE)} / ${filtered.length.toLocaleString('ja-JP')}曲`;
  $('#source-filter').hidden=!selectedSource;$('#source-filter').innerHTML=selectedSource?`<span>${escapeHTML(selectedSource.label)} · 保存済みライブラリ</span><button class="text-button" data-source-all>すべての曲へ</button>`:'';
  $('#track-list').innerHTML=filtered.slice(libraryPage*PAGE_SIZE,(libraryPage+1)*PAGE_SIZE).map((t,index)=>`<tr><td class="track-number">${String(libraryPage*PAGE_SIZE+index+1).padStart(2,'0')}</td><td><div class="track-identity"><button class="preview-track-button" data-preview="${escapeHTML(t.id)}" aria-label="${escapeHTML(t.title)} を試聴" aria-pressed="false" ${t.audioMissing?'disabled':''}>▶</button><div class="track-copy"><div class="track-title" title="${escapeHTML(t.filename)}">${escapeHTML(t.title)}</div><div class="track-artist">${escapeHTML(t.artist||'アーティスト未設定')}${t.rekordbox?' · rekordbox':''}</div></div></div></td><td class="wave-cell"><canvas class="mini-wave" data-wave-track="${escapeHTML(t.id)}" aria-hidden="true"></canvas></td><td class="track-bpm" title="${t.rekordbox?'rekordboxの平均BPM':t.confidence<.35?'解析結果は推定です。曲の情報で修正できます。':'BPM'}">${t.bpm?t.bpm.toFixed(2):'—'}</td><td class="track-duration">${time(t.duration)}</td><td><div class="track-actions">${t.audioMissing?`<button class="link-audio-button" data-link-audio="${escapeHTML(t.id)}">音源を選択</button>`:`<button class="load-button ${decks.a.trackId===t.id?'is-loaded':''}" data-load="a:${escapeHTML(t.id)}" aria-label="${escapeHTML(t.title)} をデッキ A へ">A</button><button class="load-button b ${decks.b.trackId===t.id?'is-loaded':''}" data-load="b:${escapeHTML(t.id)}" aria-label="${escapeHTML(t.title)} をデッキ B へ">B</button>`}</div></td><td><button class="icon-button more-button" data-edit="${escapeHTML(t.id)}" aria-label="${escapeHTML(t.title)} の情報を編集">⋯</button></td></tr>`).join('');
  $('#empty-library').hidden=tracks.length>0;
  if(!filtered.length&&tracks.length)$('#track-list').innerHTML='<tr><td colspan="7" style="text-align:center;color:#a0a0a0;padding:32px">条件に合う曲はありません。</td></tr>';
  updatePreview();drawLibraryWaves();
}


async function startDeckPlayback(operation){
  preview.stop();pendingDeckPlayback++;
  try{return await operation();}finally{pendingDeckPlayback--;}
}
async function togglePreview(trackId){
  const track=tracks.find(t=>t.id===trackId);if(!track)return;if(track.audioMissing){toast('先に「音源を選択」で元の音源を関連付けてください。');return;}
  if(pendingDeckPlayback||['a','b'].some(id=>{const state=engine.getState(id);return state.playing||state.scratching;})){
    toast('DJデッキが再生中です。試聴するにはデッキを停止してください。');return;
  }
  setView('library');
  await preview.toggle(trackId);
}
function updatePreviewProgress(){
  const state=preview.getState();
  if(!state.trackId)return;
  const seek=$('#preview-seek');
  seek.max=String(state.duration||0);seek.value=String(state.position);
  seek.disabled=state.loading||!state.duration||!!state.error;
  seek.setAttribute('aria-valuetext',`${time(state.position)} / ${time(state.duration)}`);
  $('#preview-time').textContent=`${time(state.position)} / ${time(state.duration)}`;
  drawPreviewWave();
}
function updatePreview(){
  const state=preview.getState(),track=tracks.find(t=>t.id===state.trackId);
  $('#library-preview').hidden=view!=='library'||!track;
  $('#preview-title').textContent=track?.title||'';
  $('#preview-artist').textContent=track?.artist||'アーティスト未設定';
  $('#preview-status').textContent=state.loading?'読み込み中…':state.error?'再生できませんでした':state.playing?'試聴中':state.position?'一時停止':'試聴';
  const play=$('#preview-toggle');
  play.textContent=state.loading?'×':state.playing?'Ⅱ':'▶';
  play.setAttribute('aria-label',state.loading?'試聴の読み込みをキャンセル':state.playing?'試聴を一時停止':'試聴を再生');
  play.setAttribute('aria-pressed',String(state.playing));
  $('#preview-stop').disabled=!state.loading&&!state.playing&&!state.position;
  const rate=state.rate??1,percent=(rate-1)*100;
  $('#preview-rate').value=String(percent);
  $('#preview-rate-value').textContent=`${percent>=0?'+':''}${percent.toFixed(1)}%`;
  $('#preview-bpm-label').textContent=track?.tempos?.length>1?'再生BPM（平均）':'再生BPM';
  const bpm=$('#preview-bpm');bpm.disabled=!track?.bpm;
  if(track?.bpm){bpm.min=String(track.bpm*.5);bpm.max=String(track.bpm*1.5);}
  if(document.activeElement!==bpm)bpm.value=track?.bpm?(track.bpm*rate).toFixed(2):'';
  $('#preview-edit-bpm').textContent=track?.bpm?`解析BPM ${track.bpm.toFixed(2)} を修正`:'解析BPMを設定';
  for(const band of ['low','mid','high']){
    const db=state.eq?.[band]??0;
    $(`#preview-eq-${band}`).value=String(db);
    $(`#preview-eq-${band}-value`).textContent=`${db>0?'+':''}${db.toFixed(1)} dB`;
  }

  const trackIndex=new Map(tracks.map(item=>[item.id,item]));
  for(const button of $$('[data-preview]')){
    const selected=button.dataset.preview===state.trackId;
    const item=trackIndex.get(button.dataset.preview);
    button.textContent=selected&&state.loading?'×':selected&&state.playing?'Ⅱ':'▶';
    button.setAttribute('aria-label',`${item?.title||'この曲'} ${selected&&state.loading?'の読み込みをキャンセル':selected&&state.playing?'の試聴を一時停止':'を試聴'}`);
    button.setAttribute('aria-pressed',String(selected&&state.playing));
    button.classList.toggle('active',selected);
    button.closest('tr').classList.toggle('is-previewing',selected);
  }
  updatePreviewProgress();
}

let worker;
let analysisId=0;
const pendingAnalysis=new Map();
function analyze(buffer){
  return new Promise((resolve,reject)=>{
    if(!worker){worker=new Worker(new URL('./analysis-worker.js?v=401613a8eaa5242c',import.meta.url),{type:'module'});worker.onmessage=({data})=>{const entry=pendingAnalysis.get(data.id);if(!entry)return;pendingAnalysis.delete(data.id);clearTimeout(entry.timer);data.error?entry.reject(new Error(data.error)):entry.resolve(data.result);};worker.onerror=()=>{for(const entry of pendingAnalysis.values()){clearTimeout(entry.timer);entry.reject(new Error('解析処理を開始できませんでした。ページを再読み込みしてください。'));}pendingAnalysis.clear();worker.terminate();worker=null;};}
    const step=Math.max(1,Math.floor(buffer.sampleRate/22050));const samples=new Float32Array(Math.ceil(buffer.length/step));
    const channels=Array.from({length:buffer.numberOfChannels},(_,i)=>buffer.getChannelData(i));
    for(let i=0;i<samples.length;i++){let value=0,count=0;for(let j=i*step;j<Math.min((i+1)*step,buffer.length);j++){for(const channel of channels){value+=channel[j];count++;}}samples[i]=value/Math.max(1,count);}
    const id=++analysisId;const timer=setTimeout(()=>{pendingAnalysis.delete(id);reject(new Error('解析に時間がかかっています。短い音源でお試しください。'));},90000);
    pendingAnalysis.set(id,{resolve,reject,timer});worker.postMessage({id,samples,sampleRate:buffer.sampleRate/step},[samples.buffer]);
  });
}

function setImporting(value){
  importing=value;
  for(const id of ['import-top','import-empty','demo-button','demo-empty','import-xml','import-xml-empty','choose-xml','open-sources','open-sources-empty','choose-source-folder','choose-source-files','start-source-import']){
    const el=$(`#${id}`);if(!el)continue;el.disabled=value;el.classList.toggle('importing',value);
  }
}

async function importXml(file){
  if(!file)return;
  if(!library||importing){toast('読み込みの完了をお待ちください。');return;}
  setImporting(true);
  try{
    if(file.size>32*1024*1024)throw new Error('XMLは32 MB以内で選んでください。');
    const parsed=parseRekordboxXml(await file.text());
    const result=await library.importTracks(parsed.tracks,parsed.playlists);
    tracks=await library.getTracks();playlists=await library.getPlaylists();
    setView('library');renderLibrary();updateDecks();
    const summary=`${result.addedTracks}曲・${result.addedPlaylists}プレイリストを追加。既存${result.skippedTracks}曲・${result.skippedPlaylists}プレイリストは保持しました。`;
    $('#xml-result').textContent=summary+(parsed.warnings.length?' '+parsed.warnings.join(' '):'')+' 音源は「音源を追加」または曲ごとの「音源を選択」で関連付けてください。';
    $('#library-status').textContent=summary;
    toast('XMLを取り込みました。BPM・CUE・ビートグリッドを保持しています。');
    await storageInfo();
  }catch(error){$('#xml-result').textContent=error.message;report(error);}
  finally{setImporting(false);$('#xml-file').value='';}
}

async function importFiles(files,selectedId=null){
  files=Array.from(files);if(!files.length)return;
  if(!library){toast('ライブラリを起動しています。少しお待ちください。');return;}
  if(importing){toast('ファイルを読み込み中です。少しお待ちください。');return;}
  setImporting(true);
  let added=0,linked=0,skipped=0;const errors=[];
  try {for(let i=0;i<files.length;i++){
    const file=files[i];const fingerprint=`${file.name}|${file.size}|${file.lastModified||0}`;
    const hasMissing=tracks.some(t=>t.audioMissing&&(selectedId?t.id===selectedId:t.filename.normalize('NFC')===file.name.normalize('NFC')));
    if(!hasMissing&&tracks.some(t=>t.fingerprint===fingerprint)){skipped++;continue;}
    $('#library-status').textContent=`読み込み中 ${i+1} / ${files.length} — ${file.name}`;
    try {
      if(!isAudioFile(file))throw new Error('音源ファイルを選んでください（MP3・WAV・AACなど）。');
      if(file.size>80*1024*1024)throw new Error('1曲80 MB以内の音源を選んでください。');
      let buffer=await engine.decode(await file.arrayBuffer());
      const imported=findImportedAudio(tracks,file,buffer.duration,selectedId);
      if(imported){
        const peaks=audioPeaks(buffer),duration=buffer.duration;buffer=null;
        await trackQueue.run(imported.id,async()=>{
          const current=tracks.find(t=>t.id===imported.id);if(!current)throw new Error('この曲は削除されています。');
          const metadata=relinkMetadata(current,file,duration,peaks);
          bufferCache.delete(metadata.id);invalidateWaveform(metadata.id);await library.putTrack(metadata,file);tracks=tracks.map(t=>t.id===metadata.id?metadata:t);
        });linked++;
      }else{
        const result=await analyze(buffer);buffer=null;
        const stem=file.name.replace(/\.[^.]+$/,'');const split=stem.split(' - ');const title=split.length>1?split.slice(1).join(' - '):stem;const artist=split.length>1?split[0]:'';
        const metadata={id:uid(),title,artist,bpm:result.bpm,confidence:result.confidence,duration:result.duration,beatOffset:result.beatOffset||0,peaks:result.peaks,cue:0,hotcues:Array(8).fill(null),filename:file.name,fingerprint,addedAt:Date.now()};
        await library.putTrack(metadata,file);tracks.push(metadata);added++;
      }
      renderLibrary();
    } catch(error){errors.push(`${file.name}: ${error.message}`);}
  }
  const summary=`${added}曲を追加、${linked}曲の音源を関連付け${skipped?`、重複${skipped}曲をスキップ`:''}。`;
  $('#library-status').textContent=summary+(errors.length?`${errors.length}ファイルを読み込めませんでした。${errors[0]}`:linked?'XMLのBPM・CUE・ビートグリッドは再解析せず保持しました。':`音源と解析結果は${library.persistent?'この端末に保存しました':'このセッションだけで保持しています'}。`);
  if(errors.length)toast(errors[0]);else toast(summary);
  await storageInfo();
  } finally {setImporting(false);$('#audio-files').value='';$('#link-audio-file').value='';}
}

function demoWav(bpm,index){
  const sr=44100,duration=24,length=sr*duration,beat=60/bpm;const samples=new Float32Array(length);let seed=7301+index;
  for(let i=0;i<length;i++){const t=i/sr;const b=t%beat;const kick=.55*Math.sin(2*Math.PI*(48*t+6*(1-Math.exp(-b*30))))*Math.exp(-b*23);
    seed=(Math.imul(seed,1664525)+1013904223)>>>0;const noise=(seed/4294967296*2-1);const hat=.10*noise*Math.exp(-(t%(beat/2))*140);
    const note=[55,65.406,73.416,49][Math.floor(t/(beat*4))%4]*(index?1.5:1);const bass=.12*Math.sin(2*Math.PI*note*t)*(1-Math.exp(-b*24))*Math.exp(-b*2);
    const fade=Math.min(1,t/.05,(duration-t)/.15);samples[i]=clamp((kick+hat+bass)*fade,-.95,.95);}
  const bytes=new ArrayBuffer(44+length*2),v=new DataView(bytes);const text=(p,s)=>{for(let i=0;i<s.length;i++)v.setUint8(p+i,s.charCodeAt(i));};text(0,'RIFF');v.setUint32(4,36+length*2,true);text(8,'WAVE');text(12,'fmt ');v.setUint32(16,16,true);v.setUint16(20,1,true);v.setUint16(22,1,true);v.setUint32(24,sr,true);v.setUint32(28,sr*2,true);v.setUint16(32,2,true);v.setUint16(34,16,true);text(36,'data');v.setUint32(40,length*2,true);for(let i=0;i<length;i++)v.setInt16(44+i*2,samples[i]*32767,true);
  return new File([bytes],`DECKFLOW - ${index?'Blue Hour 128':'Night Walk 124'}.wav`,{type:'audio/wav',lastModified:1});
}

function openTrack(id){
  if(importing){toast('読み込みが終わってから曲の情報を編集してください。');return;}
  const track=tracks.find(t=>t.id===id);if(!track)return;editingTrack=id;const form=$('#track-form');form.elements.title.value=track.title;form.elements.artist.value=track.artist;form.elements.bpm.value=track.bpm||'';$('#track-grid-note').hidden=!track.tempos?.length;const details=$('#track-import-details');details.hidden=!track.rekordbox;details.innerHTML=track.rekordbox?`<strong>rekordboxから取り込み</strong><br>${track.tempos?.length||0}個のテンポ区間 · ${(track.positionMarks||[]).filter(m=>m.num===-1).length}個のメモリーCUE／ループ<ul>${(track.positionMarks||[]).map(m=>`<li>${m.num<0?'MEMORY':`HOT CUE ${m.num+1}`} · ${time(m.start)}${m.type===4?`〜${time(m.end)} LOOP`:''} ${escapeHTML(m.name)}</li>`).join('')}</ul>`:'';
  form.elements.playlist.innerHTML='<option value="">追加しない</option>'+playlists.map(p=>`<option value="${escapeHTML(p.id)}">${escapeHTML([...(p.folderPath||[]),p.name].join(" / "))}</option>`).join('');$('#track-dialog').showModal();
}
function renderMIDIStatus(status=mapping.status){$('#midi-status').textContent=status.message+(status.inputs?.length?` 接続：${status.inputs.map(p=>p.name||p.id).join('、')}`:'');$('#connect-midi').textContent=status.state==='connected'?'MIDIを再確認':'MIDIを接続';}
function bindingLabel(item){const b=item.binding;if(item.source==='keyboard')return `${b.shift?'Shift + ':''}${b.alt?'Alt + ':''}${b.code.replace(/^Key/,'').replace(/^Digit/,'')}`;return `${b.type==='pitchbend'?'PITCH':`${b.type.toUpperCase()} ${b.number}`} / CH ${b.channel+1}${item.mode==='relative-twos'?' / REL 2C':item.mode==='relative-offset'?' / REL 64':''}`;}
function renderMappings(){
  $('#mapping-count').textContent=String(mapping.profile.mappings.length);if(document.activeElement!==$('#profile-name'))$('#profile-name').value=mapping.profile.name;
  const learning=mapping.learning;$('#learn-banner').hidden=!learning;if(learning){const a=actions.find(a=>a.id===learning.actionId);$('#learn-text').textContent=`${learning.actionId.split('.')[0].toUpperCase()} / ${a?.label}：${learning.source==='midi'?'割り当てる機材を操作':'割り当てるキーを押して'}ください。`;}
  $('#mapping-list').innerHTML=actions.filter(a=>mappingGroup==='all'||a.id.split('.')[0]===mappingGroup).map(a=>{const group=a.id.split('.')[0];const list=mapping.getMappings(a.id);return `<tr><td><span class="action-group ${group}">${group==='mixer'?'MIXER':`DECK ${group.toUpperCase()}`}</span>${a.label}</td><td><div class="mapping-chips">${list.length?list.map(m=>`<span class="binding">${escapeHTML(bindingLabel(m))}<button data-remove-mapping="${escapeHTML(m.id)}" aria-label="${escapeHTML(bindingLabel(m))} の割り当てを削除">×</button></span>`).join(''):'<span class="mapping-empty">未設定</span>'}</div></td><td><div class="mapping-learn-actions"><button class="learn-button ${learning?.actionId===a.id&&learning.source==='midi'?'active':''}" data-learn="${a.id}" data-source="midi">MIDI</button><button class="learn-button ${learning?.actionId===a.id&&learning.source==='keyboard'?'active':''}" data-learn="${a.id}" data-source="keyboard" ${a.kind==='continuous'?'disabled title="連続操作はMIDIで割り当てます"':''}>キー</button></div></td></tr>`;}).join('');
}

async function storageInfo(){try{const estimate=await navigator.storage?.estimate?.();$('#storage-status').textContent=library.persistent?`端末内に保存${estimate?.usage?` / ${(estimate.usage/1024/1024).toFixed(1)} MB`:''}`:'一時保存（このセッションのみ）';}catch{}}

function renderSources(){
  const trackIds=new Set(tracks.filter(track=>!track.audioMissing).map(track=>track.id));
  $('#saved-source-list').innerHTML=sources.length?sources.map(source=>`<div class="saved-source"><div><strong>${escapeHTML(source.label)}</strong><small>${source.trackIds.length}曲 · 音源保存 ${source.trackIds.filter(id=>trackIds.has(id)).length}曲</small></div><div class="saved-source-actions"><button class="button subtle compact" data-source-view="${escapeHTML(source.id)}">開く</button><button class="text-button" data-source-refresh="${escapeHTML(source.id)}">再読み込み</button><button class="text-button" data-source-forget="${escapeHTML(source.id)}" aria-label="${escapeHTML(source.label)}の参照だけ一覧から外す">一覧から外す</button></div></div>`).join(''):'<p class="source-note">まだ保存したライブラリはありません。</p>';
  const nav=$('#source-nav-list');if(nav)nav.innerHTML=sources.map(source=>`<button class="source-nav-button" data-source-view="${escapeHTML(source.id)}"><span>${escapeHTML(source.label)}</span><small>${source.trackIds.length}</small></button>`).join('')||'<p class="source-note">フォルダやUSBから追加できます。</p>';
}
function openSources(reset=true){
  if(!importing){if(reset)refreshSourceId=null;selectedSourceIndex=null;selectedCandidates=[];$('#source-selection').hidden=true;$('#source-database').innerHTML='';$('#source-progress').textContent='';}
  renderSources();if(!$('#source-dialog').open)$('#source-dialog').showModal();
}
async function chooseSourceFolder(){
  if(importing)return;
  // Directory file input also works in current iPad Safari; no retained permission is needed.
  $('#source-folder').click();
}

function selectSourceIndex(index){
  if(!index.entries.size){$('#source-progress').textContent='対応するファイルがありません。DBまたは音源を含むフォルダを選んでください。';return;}
  const candidates=databaseCandidates(index);
  if(!candidates.length&&selectedSourceIndex&&selectedCandidates.length){
    try{selectedSourceIndex=createSourceIndex([...selectedSourceIndex.entries.values(),...index.entries.values()],selectedSourceIndex.label);$('#source-progress').textContent=`音源フォルダ「${index.label}」を関連付けました。読み込みを開始できます。`;}catch(error){report(error);}
    return;
  }
  if(!candidates.length){$('#source-progress').textContent='master.db、export.pdb、exportLibrary.db、またはrekordbox XMLが見つかりません。先にライブラリのDBを選び、その後に音源フォルダを選んでください。';return;}
  selectedSourceIndex=index;selectedCandidates=candidates;
  $('#source-database').innerHTML=candidates.map((candidate,i)=>`<option value="${i}">${escapeHTML(candidate.path)}</option>`).join('');
  $('#source-selection').hidden=false;$('#source-selection-note').textContent=`${index.entries.size.toLocaleString('ja-JP')}ファイルを確認。音源が別フォルダなら、続けてそのフォルダを選択してください。`;
  $('#source-progress').textContent='データベースの内容と音源を端末内に保存します。保存済みの編集内容は保持します。';
  $('#source-folder').value='';$('#source-files').value='';
}
async function importSource(){
  if(importing||!library||!selectedSourceIndex)return;
  const candidate=selectedCandidates[Number($('#source-database').value)];if(!candidate)return;
  setImporting(true);sourceController=new AbortController();$('#cancel-source-import').hidden=false;
  let lastRender=0,sourcePositions=new Map();
  try{
    sourceReader=createLibraryReader();
    const result=await cacheSourceLibrary({library,index:selectedSourceIndex,candidate,sources,sourceId:refreshSourceId,reader:sourceReader,signal:sourceController.signal,
      saveTrack:(track,blob,base)=>trackQueue.run(track.id,async()=>{const current=tracks[sourcePositions.get(track.id)];if(!current)throw new Error('この曲は削除されています。');const next={...track};if(base)for(const field of ['title','artist','bpm','cue','hotcues','tempos','positionMarks','beatOffset'])if(JSON.stringify(current[field])!==JSON.stringify(base[field]))next[field]=current[field];await library.putTrack(next,blob);return next;}),
      onProgress:message=>{$('#source-progress').textContent=message;$('#library-status').textContent=message;},
      onMetadata:async()=>{[tracks,playlists]=await Promise.all([library.getTracks(),library.getPlaylists()]);sourcePositions=new Map(tracks.map((track,index)=>[track.id,index]));setView('library');renderLibrary();},
      onTrack:track=>{const i=sourcePositions.get(track.id);if(i!==undefined)tracks[i]=track;else{sourcePositions.set(track.id,tracks.length);tracks.push(track);}if(performance.now()-lastRender>250){renderLibrary();lastRender=performance.now();}}});
    const message=`${result.addedTracks}曲を追加。音源${result.copied}曲を保存、${result.reused}曲はキャッシュを利用。${result.missing?`音源未接続 ${result.missing}曲。`:''}${result.metadataCached?' DBの解析結果もキャッシュから読み込みました。':''}`;
    $('#source-progress').textContent=message+(result.warnings.length?`\n${result.warnings.slice(0,3).join('\n')}${result.warnings.length>3?`\nほか${result.warnings.length-3}件`:''}`:'');$('#library-status').textContent=message;toast(library.persistent?'ライブラリを保存しました。次回は端末内のキャッシュから開きます。':'この画面を開いている間だけ保持します。端末の保存領域を利用できません。');
    // Request persistence only after the user explicitly imported files. Denial leaves normal caching intact.
    navigator.storage?.persist?.().catch(()=>{});
  }catch(error){const message=sourceController.signal.aborted?'読み込みを中止しました。保存済みの曲はそのまま使えます。':error.message;$('#source-progress').textContent=message;$('#library-status').textContent=message;if(!sourceController.signal.aborted)report(error);}
  finally{sourceReader?.close();sourceReader=null;sourceController=null;setImporting(false);$('#cancel-source-import').hidden=true;[tracks,playlists,sources]=await Promise.all([library.getTracks(),library.getPlaylists(),library.getSources()]);renderSources();renderLibrary();await storageInfo();}
}

function events(){
  installFileDrop({target:document,host:window,onActive:active=>{$('#file-drop-overlay').hidden=!active;},onFiles:files=>{
    if(!files.length){toast('フォルダではなく、音源ファイルをドロップしてください。');return;}
    setView('library');const xml=files.filter(f=>/\.xml$/i.test(f.name));if(xml.length){if(xml.length!==1||files.length!==1){toast('XMLは1ファイルずつ取り込み、その後に音源を追加してください。');return;}$('#xml-dialog').showModal();importXml(xml[0]).catch(report);}else importFiles(files).catch(report);
  }});
  document.addEventListener('click',event=>{const menu=$('#library-tools');if(menu?.open&&(!event.target.closest('#library-tools')||event.target.closest('#library-tools button')))menu.open=false;const target=event.target.closest('button');if(!target)return;
    if(target.dataset.action)dispatch(target.dataset.action).catch(report);
    if(target.dataset.view)setView(target.dataset.view);
    if(target.dataset.load){const value=target.dataset.load;loadDeck(value.slice(0,1),value.slice(2));}
    if(target.dataset.linkAudio){relinkTrack=target.dataset.linkAudio;$('#link-audio-file').click();}
    if(target.dataset.edit)openTrack(target.dataset.edit);
    if(target.dataset.preview)togglePreview(target.dataset.preview).catch(report);
    if(target.dataset.hotcue){const [deck,index]=target.dataset.hotcue.split(':');hotCue(deck,Number(index),event.shiftKey).catch(report);}
    if(target.dataset.playlist){activePlaylist=target.dataset.playlist;activeSource=null;libraryPage=0;renderLibrary();}
    if(target.hasAttribute('data-open-sources'))openSources();
    if(target.dataset.sourceView){activeSource=target.dataset.sourceView;activePlaylist='all';libraryPage=0;setView('library');renderLibrary();$('#source-dialog').close();}
    if(target.hasAttribute('data-source-all')){activeSource=null;activePlaylist='all';libraryPage=0;renderLibrary();}
    if(target.dataset.sourceRefresh&&!importing){refreshSourceId=target.dataset.sourceRefresh;openSources(false);$('#source-progress').textContent='更新する元のライブラリフォルダ、またはUSBを選び直してください。保存済みの編集内容は保持します。';}
    if(target.dataset.sourceForget&&!importing){library.removeSource(target.dataset.sourceForget).then(async()=>{sources=await library.getSources();if(activeSource===target.dataset.sourceForget)activeSource=null;renderSources();renderLibrary();}).catch(report);}
    if(target.dataset.loopSize){const [deck,size]=target.dataset.loopSize.split(':');decks[deck].loopBeats=Number(size);$$(`[data-loop-size^="${deck}:"]`).forEach(b=>b.classList.toggle('active',b===target));if(engine.getState(deck).loop){engine.clearLoop(deck);toggleLoop(deck);updateDecks();}}
    if(target.hasAttribute('data-close-dialog'))target.closest('dialog').close();
    if(target.dataset.removeMapping)mapping.removeMapping(target.dataset.removeMapping);
    if(target.dataset.group){mappingGroup=target.dataset.group;$$('#mapping-filters .pill').forEach(b=>b.classList.toggle('active',b===target));renderMappings();}
    if(target.dataset.learn){const learn=async()=>{if(target.dataset.source==='midi'&&!await mapping.enableMIDI())return;const action=actions.find(a=>a.id===target.dataset.learn);const mode=target.dataset.source==='midi'&&action?.kind==='continuous'?$('#midi-mode').value:'absolute';mapping.learn(target.dataset.learn,target.dataset.source,{mode});renderMappings();};learn().catch(report);}
  });
  document.addEventListener('input',event=>{const el=event.target;if(!el.dataset.control)return;const id=el.dataset.control;const value=Number(el.value);setControl(id,id.includes('.eq.')?(value+24)/36:id.endsWith('.tempo')?value/100+.5:value);});
  $('#crossfader').addEventListener('input',e=>setControl('mixer.crossfader',Number(e.target.value)));$('#master').addEventListener('input',e=>setControl('mixer.master',Number(e.target.value)));$('#center-fader').onclick=()=>setControl('mixer.crossfader',.5);
  $('#preview-toggle').onclick=()=>togglePreview(preview.getState().trackId).catch(report);
  $('#preview-stop').onclick=()=>preview.stop();
  $('#preview-seek').addEventListener('input',event=>preview.seek(Number(event.target.value)));
  const previewCanvas=$('#preview-wave');let previewDragRange=null;
  const seekPreview=event=>{const state=preview.getState();if(!state.duration||state.loading)return;const rect=previewCanvas.getBoundingClientRect();preview.seek(timeAtWaveformX(event.clientX-rect.left,rect.width,previewDragRange||previewWaveRange||{start:0,end:state.duration}));};
  previewCanvas.addEventListener('pointerdown',event=>{if(event.button!==0)return;event.preventDefault();previewDragRange={...previewWaveRange};previewCanvas.setPointerCapture(event.pointerId);seekPreview(event);});
  previewCanvas.addEventListener('pointermove',event=>{if(previewCanvas.hasPointerCapture(event.pointerId))seekPreview(event);});
  for(const name of ['pointerup','pointercancel','lostpointercapture'])previewCanvas.addEventListener(name,()=>{previewDragRange=null;});
  previewCanvas.addEventListener('keydown',event=>{if(!['ArrowLeft','ArrowRight','Home','End'].includes(event.code))return;event.preventDefault();const state=preview.getState();preview.seek(event.code==='Home'?0:event.code==='End'?state.duration:state.position+(event.code==='ArrowLeft'?-.25:.25));});
  $('#preview-rate').addEventListener('input',event=>preview.setRate(1+Number(event.target.value)/100));
  $('#preview-bpm').addEventListener('input',event=>{
    const track=tracks.find(t=>t.id===preview.getState().trackId),value=Number(event.target.value);
    if(track?.bpm&&Number.isFinite(value)&&value>=track.bpm*.5&&value<=track.bpm*1.5)preview.setRate(value/track.bpm);
  });
  $('#preview-bpm').addEventListener('change',event=>{
    const track=tracks.find(t=>t.id===preview.getState().trackId),value=Number(event.target.value);
    if(!track?.bpm)return;
    if(!Number.isFinite(value)||value<track.bpm*.5||value>track.bpm*1.5){toast(`再生BPMは ${(track.bpm*.5).toFixed(2)}〜${(track.bpm*1.5).toFixed(2)} で指定してください。`);event.target.value=(track.bpm*preview.getState().rate).toFixed(2);return;}
    preview.setRate(value/track.bpm);
  });
  $('#preview-edit-bpm').onclick=()=>openTrack(preview.getState().trackId);
  for(const band of ['low','mid','high'])$(`#preview-eq-${band}`).addEventListener('input',event=>preview.setEQ(band,Number(event.target.value)));
  $('#preview-reset').onclick=()=>{preview.setRate(1);for(const band of ['low','mid','high'])preview.setEQ(band,0);};

  for(const id of ['import-top','import-empty'])$(`#${id}`).onclick=()=>$('#audio-files').click();
  for(const id of ['open-sources','open-sources-empty'])$(`#${id}`)?.addEventListener('click',()=>openSources());
  $('#choose-source-folder').onclick=()=>chooseSourceFolder().catch(report);
  $('#choose-source-files').onclick=()=>$('#source-files').click();
  for(const id of ['source-folder','source-files'])$(`#${id}`).onchange=event=>{try{selectSourceIndex(indexFileList(event.target.files));}catch(error){$('#source-progress').textContent=error.message;report(error);}};
  $('#start-source-import').onclick=()=>importSource().catch(report);
  $('#cancel-source-import').onclick=()=>{sourceController?.abort();sourceReader?.close();};
  $('#previous-page').onclick=()=>{libraryPage=Math.max(0,libraryPage-1);renderLibrary();};
  $('#next-page').onclick=()=>{libraryPage++;renderLibrary();};
  $('#audio-files').addEventListener('change',e=>importFiles([...e.target.files]).catch(report));
  $('#link-audio-file').addEventListener('change',e=>{const id=relinkTrack;relinkTrack=null;importFiles([...e.target.files],id).catch(report);});
  for(const id of ['import-xml','import-xml-empty'])$(`#${id}`).onclick=()=>$('#xml-dialog').showModal();
  $('#choose-xml').onclick=()=>$('#xml-file').click();
  $('#xml-file').addEventListener('change',e=>importXml(e.target.files[0]).catch(report));
  for(const id of ['demo-button','demo-empty'])$(`#${id}`).onclick=()=>importFiles([demoWav(124,0),demoWav(128,1)]).catch(report);
  $('#show-help').onclick=()=>$('#help-dialog').showModal();$('#usb-info').onclick=()=>$('#usb-dialog').showModal();
  $('#search').addEventListener('input',()=>{libraryPage=0;renderLibrary();});$('#sort').addEventListener('change',()=>{libraryPage=0;renderLibrary();});$('#sort-bpm').onclick=()=>{$('#sort').value=$('#sort').value==='bpm'?'added':'bpm';renderLibrary();};
  $('#new-playlist').onclick=async()=>{const name=await askPlaylistName();if(!name)return;const p={id:uid(),name:name.slice(0,80),trackIds:[]};const next=[...playlists,p];try{await library.putPlaylists(next);playlists=next;activePlaylist=p.id;renderLibrary();}catch(error){report(error);}};
  $('#track-form').onsubmit=async event=>{
    event.preventDefault();if(importing){toast('読み込み完了後に保存してください。');return;}const id=editingTrack;const form=event.target;
    const fields={title:form.elements.title.value.trim(),artist:form.elements.artist.value.trim(),bpm:form.elements.bpm.value?Number(form.elements.bpm.value):null};
    const playlistId=form.elements.playlist.value;
    if(!fields.title)return;
    if(fields.bpm!==null&&(!Number.isFinite(fields.bpm)||fields.bpm<30||fields.bpm>300)){toast('BPMは30〜300で指定してください。');return;}
    try{
      await trackQueue.run(id,async()=>{const current=tracks.find(t=>t.id===id);if(!current)throw new Error('この曲は削除されています。');const updated={...current,...fields};await library.putTrack(updated);tracks=tracks.map(t=>t.id===id?updated:t);});
      if(playlistId){const next=playlists.map(p=>p.id===playlistId?{...p,trackIds:[...new Set([...p.trackIds,id])]}:p);await library.putPlaylists(next);playlists=next;}
      $('#track-dialog').close();
    }catch(error){report(error);}finally{renderLibrary();updateDecks();}
  };
  for(const [id,multiplier]of[['half-bpm',.5],['double-bpm',2]])$(`#${id}`).onclick=()=>{const input=$('#track-form').elements.bpm;const value=Number(input.value)*multiplier;if(value>=30&&value<=300)input.value=value.toFixed(2);};
  $('#delete-track').onclick=async()=>{
    if(importing){toast('読み込み完了後に削除してください。');return;}
    const track=tracks.find(t=>t.id===editingTrack);if(!track||!await askConfirm(`「${track.title}」をDECKFLOWから削除しますか？元の音源ファイルは削除しません。`))return;
    try{
      await trackQueue.run(track.id,async()=>{
        for(const id of ['a','b'])if(decks[id].pendingTrackId===track.id){decks[id].loadNonce++;decks[id].pendingTrackId=null;}
        if(preview.getState().trackId===track.id)preview.clear();
        bufferCache.delete(track.id);invalidateWaveform(track.id);await library.removeTrack(track.id);
        for(const id of ['a','b'])if(decks[id].trackId===track.id){engine.pause(id);decks[id].trackId=null;decks[id].loadNonce++;}
        tracks=tracks.filter(t=>t.id!==track.id);playlists=await library.getPlaylists();
      });
      $('#track-dialog').close();renderLibrary();updateDecks();await storageInfo();
    }catch(error){updateDecks();report(error);}
  };
  const saveLibrary=usb=>{if(!tracks.length){toast('先に曲を追加してください。');return;}const snapshot={format:'deckflow.library',version:1,exportedAt:new Date().toISOString(),tracks,playlists};try{if(usb)validateUsbLibrary(snapshot);download('deckflow-library.json',JSON.stringify(snapshot,null,2));toast(usb?'MacのUSB書き出しツールへ渡すJSONを保存しました。':'BPM・CUE・プレイリストをJSONに保存しました。音源は含まれません。');}catch(error){report(error);}};
  $('#export-library').onclick=()=>saveLibrary(false);$('#usb-download').onclick=()=>saveLibrary(true);
  $('#connect-midi').onclick=()=>mapping.enableMIDI().catch(report);$('#cancel-learn').onclick=()=>{mapping.cancelLearn();renderMappings();};
  $('#profile-name').addEventListener('change',e=>{try{const profile=mapping.profile;profile.name=e.target.value.trim()||'DECKFLOW マイコントローラー';mapping.importProfile(JSON.stringify(profile));}catch(error){report(error);}});
  $('#export-profile').onclick=()=>download('deckflow-mappings.json',mapping.exportProfile());$('#import-profile').onclick=()=>$('#profile-file').click();
  $('#profile-file').addEventListener('change',async e=>{const file=e.target.files[0];if(!file)return;try{if(file.size>1024*1024)throw new Error('設定ファイルが大きすぎます。');mapping.importProfile(await file.text());toast('割り当て設定を読み込みました。');}catch(error){report(error);}e.target.value='';});
  $('#reset-profile').onclick=async()=>{if(await askConfirm('MIDI・キーの割り当てを初期状態へ戻しますか？'))mapping.reset();};
  document.addEventListener('keydown',e=>{if(e.code==='Escape'&&$('#library-tools')?.open){$('#library-tools').open=false;$('#library-tools summary').focus();return;}if(e.code==='Escape'&&mapping.learning){mapping.cancelLearn();renderMappings();return;}mapping.handleKeyDown(e);});document.addEventListener('keyup',e=>mapping.handleKeyUp(e));
  window.addEventListener('resize',()=>{updateDecks();drawLibraryWaves();drawPreviewWave();});
  window.addEventListener('pageshow',event=>{pageActive=true;if(event.persisted){waveformCache=new WaveformCache();for(const id of ['a','b']){const buffer=engine.decks[id]?.buffer;if(buffer&&decks[id].trackId)prepareWaveform(decks[id].trackId,buffer);}}});
  window.addEventListener('pagehide',()=>{pageActive=false;for(const id of ['a','b']){decks[id].loadNonce++;decks[id].pendingTrackId=null;}waveformCache.dispose();waveformJobs.clear();sourceController?.abort();sourceReader?.close();bufferCache.clear();preview.clear();for(const id of ['a','b'])engine.pause(id);});
}

async function start(){
  renderDecks();events();setView('library');renderMappings();renderMIDIStatus();
  for(const id of ['a','b']){mapping.setActionValue(`${id}.tempo`,.5);mapping.setActionValue(`${id}.volume`,.85);for(const band of ['low','mid','high'])mapping.setActionValue(`${id}.eq.${band}`,24/36);}
  mapping.setActionValue('mixer.crossfader',.5);mapping.setActionValue('mixer.master',.8);
  library=await openLibrary();[tracks,playlists,sources]=await Promise.all([library.getTracks(),library.getPlaylists(),library.getSources()]);renderSources();renderLibrary();updateDecks();await storageInfo();if(library.warning)toast(library.warning);
  if(window.DECKFLOW_NATIVE){$('.mapping-note').textContent='iPadアプリではCoreMIDIで接続した機材を学習できます。音量・EQなどの連続操作はMIDI、キーはボタン操作に対応します。物理機材の互換性とヘッドホンCUEの独立出力は実機確認が必要です。';}
  if('serviceWorker'in navigator&&!window.DECKFLOW_NATIVE)navigator.serviceWorker.register('./sw.js').catch(error=>console.warn('Offline cache unavailable',error));
  requestAnimationFrame(animate);
}
start().catch(error=>{report(error);$('#library-status').textContent='起動できませんでした。ページを再読み込みしてください。';});
