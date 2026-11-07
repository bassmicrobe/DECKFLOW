import {installMotion} from './ui-motion.js?v=7c8bf604d2c9c1e4';
import {createAnalysisInput} from './analysis-input.js?v=7c8bf604d2c9c1e4';
import {isPcmFileResource} from './audio-resource.js?v=7c8bf604d2c9c1e4';
import {analyzeAudioResource,audioResourcePeaks} from './audio-resource-analysis.js?v=7c8bf604d2c9c1e4';
import {bindTouchSlider} from './touch-slider.js?v=7c8bf604d2c9c1e4';
import {bindPlatterGesture} from './platter-gesture.js?v=7c8bf604d2c9c1e4';
import {AudioEngine} from './audio-engine.js?v=7c8bf604d2c9c1e4';
import {MappingManager} from './mappings.js?v=7c8bf604d2c9c1e4';
import {installDeckMidiLearn} from './deck-midi-learn.js?v=7c8bf604d2c9c1e4';
import {openLibrary} from './library-store.js?v=7c8bf604d2c9c1e4';
import {nativeUSBAvailable,openNativeUSB,importNativeUSB,writeNativeHotCues,exportNativeUSB} from './native-usb-library.js?v=7c8bf604d2c9c1e4';
import {USBDeviceMonitor,sourcePlaylistIds,isDeviceLibrarySource} from './usb-devices.js?v=7c8bf604d2c9c1e4';
import {createTrackQueue} from './track-updates.js?v=7c8bf604d2c9c1e4';
import {editTrackHotCue} from './track-hotcues.js?v=7c8bf604d2c9c1e4';
import {installFileDrop,isAudioFile} from './file-drop.js?v=7c8bf604d2c9c1e4';
import {PreviewPlayer} from './preview-player.js?v=7c8bf604d2c9c1e4';
import {sortLibraryTracks} from './library-sort.js?v=7c8bf604d2c9c1e4';
import {LIBRARY_COLUMNS,normalizeLibraryColumns,libraryColumnText} from './library-columns.js?v=7c8bf604d2c9c1e4';
import {AudioBufferCache} from './audio-buffer-cache.js?v=7c8bf604d2c9c1e4';
import {WaveformCache} from './waveform-cache.js?v=7c8bf604d2c9c1e4';
import {SelectedWaveformLoader} from './waveform-selection.js?v=7c8bf604d2c9c1e4';
import {drawWaveform,getWaveformWindow,timeAtWaveformX,waveformBeats,waveformBeatPosition} from './waveform-view.js?v=7c8bf604d2c9c1e4';
import {indexFileList,indexDirectory,createSourceIndex,databaseCandidates,createLibraryReader} from './library-source.js?v=7c8bf604d2c9c1e4';
import {cacheSourceLibrary} from './source-import.js?v=7c8bf604d2c9c1e4';
import {parseRekordboxXml} from './rekordbox-import.js?v=7c8bf604d2c9c1e4';
import {findImportedAudio,audioPeaks,tempoAt,advanceBeats,relinkMetadata} from './import-audio.js?v=7c8bf604d2c9c1e4';

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
  for (const [name,label] of [['play','再生 / 一時停止'],['cue','CUEへ戻る'],['loop','ループ ON / OFF'],['sync','BEAT SYNC'],['quantize','QUANTIZE'],...Array.from({length:8},(_,i)=>[`hotcue${i+1}`,`HOT CUE ${i+1}`])]) actions.push({id:`${deck}.${name}`,label,kind:'trigger'});
  for (const [name,label] of [['volume','チャンネル音量'],['tempo','テンポ'],['eq.low','EQ LOW'],['eq.mid','EQ MID'],['eq.high','EQ HIGH']]) actions.push({id:`${deck}.${name}`,label,kind:'continuous'});
}
actions.push({id:'mixer.crossfader',label:'クロスフェーダー',kind:'continuous'},{id:'mixer.master',label:'マスター音量',kind:'continuous'},{id:'mixer.center',label:'クロスフェーダーを中央へ',kind:'trigger'});
let library;
let tracks = [];
let playlists = [];
let activePlaylist = 'all';
let sources=[],activeSource=null,libraryPage=0,librarySortDirection='ascending';
const COLUMN_STORAGE_KEY='deckflow.library.columns.v1';
let visibleColumns=normalizeLibraryColumns(null),columnHeaderKey='';
try{visibleColumns=normalizeLibraryColumns(JSON.parse(localStorage.getItem(COLUMN_STORAGE_KEY)));}catch{}
const PAGE_SIZE=75;
let selectedSourceIndex=null,selectedCandidates=[],refreshSourceId=null,sourceController=null,sourceReader=null;
let nativeUSBSession=null,usbOperation=null,usbController=null;
let usbDeviceMonitor=null,usbDevices=[],usbDevicesLoaded=false,usbDevicesError=null;
const bufferCache=new AudioBufferCache();
let waveformCache=new WaveformCache();
const detailedWaves=new Map(),waveformJobs=new Map(),waveformKeys=new Map();
let previewWaveRange=null,previewDetailRange=null,previewWaveSpan=8,pageActive=true;
let previewCueErase=false,previewCueTrackId=null;
const previewCuePending=new Set();
let mappingGroup = 'all',mappingArmNonce=0,mappingArming=null,mappingTableKey='';
const deckElements={};
const setText=(element,text)=>{if(element.textContent!==text)element.textContent=text;};
let importing = false;
let editingTrack = null;
let relinkTrack = null;
let view = 'library';
const trackQueue=createTrackQueue();
const decks = {a:{trackId:null,pendingTrackId:null,loopBeats:4,loadNonce:0,angle:0,waveSpan:8,waveRange:null},b:{trackId:null,pendingTrackId:null,loopBeats:4,loadNonce:0,angle:0,waveSpan:8,waveRange:null}};
const engine = new AudioEngine({onEnded:()=>updateDecks(),onStatus:status=>{if(status.message)toast(status.message);updateDecks();}});
const platterGestures=new Map();
const touchSliders=[];
let pendingDeckPlayback=0;
const preview = new PreviewPlayer({getAudio:id=>library?.getAudio(id),getBuffer:async(id,decode)=>{const buffer=await bufferCache.get(id,decode);prepareWaveform(id,buffer);return buffer;},onChange:()=>updatePreview()});
let selectionWaveState={key:null,status:'idle'};
const selectedWaveform=new SelectedWaveformLoader({load:prepareSelectedWaveform,onState:state=>{selectionWaveState=state;updatePreviewWaveInfo();}});
const mapping = new MappingManager({actions,onAction:(id,value,phase)=>{if(view!=='mapping'&&phase !== 'release') dispatch(id,value).catch(report);},onChange:()=>renderMappings(),onStatus:status=>{renderMIDIStatus(status);}});

function renderDecks() {
  $('#decks').innerHTML = ['a','b'].map(id=>`<article class="deck" data-deck="${id}" aria-label="デッキ ${id.toUpperCase()}">
    <div class="deck-top"><span class="deck-letter">${id.toUpperCase()}</span><div class="deck-meta"><div class="deck-title" id="${id}-title">曲を読み込んでください</div><div class="deck-artist" id="${id}-artist">ライブラリから曲を選択</div></div><div class="deck-bpm"><span id="${id}-bpm">—.—</span><small>BPM</small></div></div>
    <div class="wave-toolbar"><span>波形</span><div class="wave-zoom"><button type="button" data-wave-zoom="${id}:out" aria-label="デッキ ${id.toUpperCase()} 波形を縮小">−</button><output id="${id}-wave-span">8s</output><button type="button" data-wave-zoom="${id}:in" aria-label="デッキ ${id.toUpperCase()} 波形を拡大">＋</button></div></div>
    <div class="deck-wave"><canvas id="${id}-wave" aria-label="デッキ ${id.toUpperCase()} 詳細波形" role="slider" tabindex="0" aria-valuemin="0" aria-valuemax="0" aria-valuenow="0"></canvas><span class="wave-empty" id="${id}-wave-empty">曲を読み込んでください</span></div>
    <div class="deck-overview"><canvas id="${id}-overview" aria-label="デッキ ${id.toUpperCase()} 全体波形" role="slider" tabindex="0" aria-valuemin="0" aria-valuemax="0" aria-valuenow="0"></canvas></div>
    <div class="deck-timeline"><span class="current-time" id="${id}-time">0:00</span><span id="${id}-remaining">− 0:00</span></div>
    <div class="platter-section"><button class="platter" id="${id}-platter" aria-label="デッキ ${id.toUpperCase()} プラッター。ドラッグでスクラッチ、矢印キーで前後へ移動"><span class="record"><span class="record-grooves"></span><span class="record-label"><b>${id.toUpperCase()}</b><small>DECKFLOW</small><i></i></span><span class="record-marker"></span></span><span class="platter-rim"></span></button><div class="platter-info"><button class="quantize-button" id="${id}-quantize" data-action="${id}.quantize" aria-label="デッキ ${id.toUpperCase()} クオンタイズ" aria-pressed="false">QUANTIZE</button><span class="platter-status sr-only" id="${id}-scratch-state"></span><button class="keylock-button" id="${id}-keylock" aria-pressed="false">KEY LOCK</button></div></div>
    <div class="deck-main-controls"><button class="transport" data-action="${id}.cue" aria-label="デッキ ${id.toUpperCase()} CUEへ戻る">CUE</button><button class="transport play" data-action="${id}.play" id="${id}-play" aria-label="デッキ ${id.toUpperCase()} 再生" aria-pressed="false">▶</button><button class="transport" data-action="${id}.sync" id="${id}-sync" aria-label="デッキ ${id.toUpperCase()} ビート同期" aria-pressed="false">SYNC</button><button class="transport" data-action="${id}.loop" id="${id}-loop" aria-label="デッキ ${id.toUpperCase()} ループ" aria-pressed="false">LOOP</button></div>
    <div class="hotcues">${Array.from({length:8},(_,i)=>i).map(i=>`<button class="hotcue" data-hotcue="${id}:${i}" id="${id}-hotcue-${i}" aria-label="デッキ ${id.toUpperCase()} HOT CUE ${i+1}" title="未設定なら現在位置を保存。設定後はジャンプ。Shift＋クリックで解除">${i+1}<small>HOT CUE</small></button>`).join('')}</div>
    <div class="deck-bottom"><div class="eq-controls">${['low','mid','high'].map(band=>`<div class="eq-control"><label for="${id}-eq-${band}">${band.toUpperCase()}</label><input id="${id}-eq-${band}" data-control="${id}.eq.${band}" type="range" min="-24" max="12" step="0.1" value="0" aria-label="デッキ ${id.toUpperCase()} EQ ${band}"><output id="${id}-eq-${band}-value">0.0</output></div>`).join('')}</div><div class="tempo-volume"><div class="tempo-control"><label for="${id}-tempo">TEMPO <output id="${id}-tempo-value">+0.0%</output></label><input id="${id}-tempo" data-control="${id}.tempo" type="range" min="-50" max="50" step="0.1" value="0" aria-label="デッキ ${id.toUpperCase()} テンポ"></div><div class="volume-control"><label for="${id}-volume">LEVEL <output id="${id}-volume-value">85%</output></label><input id="${id}-volume" data-control="${id}.volume" type="range" min="0" max="1" step="0.01" value="0.85" aria-label="デッキ ${id.toUpperCase()} 音量"></div><div class="loop-controls"><span>BEATS</span>${[1,2,4,8].map(n=>`<button class="loop-size${n===4?' active':''}" data-loop-size="${id}:${n}" aria-label="デッキ ${id.toUpperCase()} ${n}拍ループ">${n}</button>`).join('')}</div></div></div></article>`).join('');
  for (const id of ['a','b']) {
    bindPlatter(id);
    deckElements[id]={record:$(`#${id}-platter .record`),bpm:$(`#${id}-bpm`),time:$(`#${id}-time`),remaining:$(`#${id}-remaining`)};
  }
  for(const target of $$('#play-view [data-action],#play-view [data-control],#play-view [data-hotcue]')){
    const [deck,index]=(target.dataset.hotcue||'').split(':');
    const action=target.dataset.action||target.dataset.control||(deck?`${deck}.hotcue${Number(index)+1}`:null);
    if(actions.some(item=>item.id===action))target.dataset.midiAction=action;
  }
  for(const label of $$('#play-view label[for]')){const target=document.getElementById(label.htmlFor);if(target?.dataset.midiAction)label.dataset.midiAction=target.dataset.midiAction;}

}

async function dispatch(id,value=1) {
  if (id === 'mixer.center') return setControl('mixer.crossfader',.5);
  const action = actions.find(a=>a.id===id);
  if(!action)return;
  if(action.kind==='continuous')return setControl(id,value);
  const [deck,name]=id.split('.');
  const track=trackFor(deck);
  if(!track){toast('先にライブラリの曲をデッキへ読み込んでください。');return;}
  if(name==='play'||name==='cue'||name==='loop')platterGestures.get(deck)?.cancel();
  if(name==='play')await startDeckPlayback(()=>engine.toggle(deck));
  if(name==='cue')engine.jumpCue(deck);
  if(name.startsWith('hotcue'))await hotCue(deck,Number(name.slice(6))-1);
  if(name==='loop')toggleLoop(deck);
  if(name==='sync')syncDeck(deck);
  if(name==='quantize')engine.setQuantize?.(deck,!engine.getState(deck).quantize);
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
  // Continuous MIDI values must not rebuild cue buttons or redraw both waveforms.
  if(name==='tempo'){const track=trackFor(deck),state=engine.getState(deck);setText(deckElements[deck].bpm,track?.bpm?(tempoAt(track,state.position).bpm*state.rate).toFixed(2):'—.—');const sync=$(`#${deck}-sync`);sync.classList.toggle('active',!!state.sync);sync.setAttribute('aria-pressed',String(!!state.sync));}
}

const trackFor = deck => tracks.find(t=>t.id===decks[deck]?.trackId);
async function loadDeck(deck,trackId) {
  const track=tracks.find(t=>t.id===trackId);if(!track)return;
  if(track.audioMissing){relinkTrack=trackId;$('#link-audio-file').click();return;}
  if(engine.getState(deck).playing && !await askConfirm(`デッキ ${deck.toUpperCase()} は再生中です。曲を入れ替えますか？`))return;
  const nonce=++decks[deck].loadNonce;
  decks[deck].pendingTrackId=trackId;
  $(`#${deck}-title`).textContent='読み込み中…';
  try {const buffer=await bufferCache.get(trackId,async()=>{const blob=await library.getAudio(trackId);if(!blob)throw new Error('元の音源を読み込めません。曲を追加し直してください。');return engine.decodeFile(blob);});if(nonce!==decks[deck].loadNonce||!tracks.some(t=>t.id===trackId))return;
    platterGestures.get(deck)?.cancel();engine.load(deck,buffer);prepareWaveform(trackId,buffer);engine.setCue(deck,track.cue||0);engine.setBeatGrid?.(deck,track);decks[deck].gridTrack=track;decks[deck].trackId=trackId;decks[deck].angle=0;
    setControl(`${deck}.tempo`,.5);updateDecks();renderLibrary();toast(`デッキ ${deck.toUpperCase()} に ${track.title} を読み込みました。`);
  } catch(error){if(nonce===decks[deck].loadNonce)updateDecks();report(error);}finally{if(nonce===decks[deck].loadNonce)decks[deck].pendingTrackId=null;}
}

async function hotCue(deck,index,clear=false){
  const track=trackFor(deck);if(!track)return;
  if(importing&&(clear||track.hotcues?.[index]==null)){toast('ライブラリの処理が完了してからHOT CUEを保存してください。');return;}
  const state=engine.getState(deck);const pos=Math.min(state.position,Math.max(0,state.duration-.001));
  await trackQueue.run(track.id,async()=>{
    const current=tracks.find(t=>t.id===track.id);if(!current)throw new Error('この曲はライブラリから削除されています。');
    if(importing&&(clear||current.hotcues?.[index]==null))return;
    if(clear&&current.hotcues?.[index]==null)return;
    if(clear||current.hotcues?.[index]==null){const updated=editTrackHotCue(current,index,pos,{clear});if(updated===current)return;await library.putTrack(updated);tracks=tracks.map(t=>t.id===updated.id?updated:t);refreshCueMetadata(updated);toast(clear?`HOT CUE ${index+1} を解除しました。`:`HOT CUE ${index+1} を ${time(pos)} に保存しました。`);}
    else if(decks[deck].trackId===track.id){platterGestures.get(deck)?.cancel();const mark=current.positionMarks?.find(mark=>mark.num===index),loop=mark?.type===4?{start:mark.start,end:mark.end}:null;await startDeckPlayback(()=>engine.triggerCue(deck,current.hotcues[index],{loop}));}
  });
  updateDecks();if(view==='library')updatePreview();
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
  const other=deck==='a'?'b':'a',state=engine.getState(deck);
  if(state.sync){engine.setSync(deck,false,other);return;}
  const own=trackFor(deck),target=trackFor(other);
  if(!own?.bpm||!target?.bpm){toast('両方のデッキへBPMのある曲を読み込んでください。');return;}
  if(!engine.setSync(deck,true,other)){toast('BPM差がテンポの調整範囲（±50%）を超えています。');return;}
  const synced=engine.getState(deck),percent=(synced.rate-1)*100;
  mapping.setActionValue(`${deck}.tempo`,synced.rate-.5);
  $(`#${deck}-tempo`).value=percent;$(`#${deck}-tempo-value`).textContent=`${percent>=0?'+':''}${percent.toFixed(1)}%`;
}

function bindPlatter(id){
  const el=$(`#${id}-platter`),record=el.querySelector('.record');
  platterGestures.get(id)?.dispose();
  platterGestures.set(id,bindPlatterGesture(el,{
    getState:()=>({...engine.getState(id),loaded:!!trackFor(id),rotation:decks[id].angle}),
    onBegin:()=>startDeckPlayback(()=>engine.beginScratch(id)),
    onMove:(position,timeStamp)=>engine.scratchTo(id,position,timeStamp),
    onEnd:()=>startDeckPlayback(()=>engine.endScratch(id)).then(()=>updateDecks()),
    onRotate:rotation=>{decks[id].angle=rotation;record.style.transform=`rotate(${rotation}deg)`;},
    onChange:()=>updateDecks(),onError:report,
  }));
  el.addEventListener('keydown',event=>{if(!['ArrowLeft','ArrowRight'].includes(event.code)||!trackFor(id))return;event.preventDefault();platterGestures.get(id)?.cancel();engine.clearLoop(id);engine.seek(id,engine.getState(id).position+(event.code==='ArrowLeft'?-.1:.1));});
  $(`#${id}-keylock`).addEventListener('click',()=>{if(typeof engine.setKeyLock!=='function'){toast('音程を保つテンポ変更は準備中です。');return;}const enabled=!engine.getState(id).keyLockRequested;Promise.resolve(engine.setKeyLock(id,enabled)).then(()=>updateDecks()).catch(report);});
  for(const kind of ['wave','overview']){
    const canvas=$(`#${id}-${kind}`);let range=null;
    const currentRange=()=>kind==='overview'?{start:0,end:engine.getState(id).duration}:decks[id].waveRange||getWaveformWindow(engine.getState(id).duration,engine.getState(id).position,decks[id].waveSpan);
    const seek=event=>{const state=engine.getState(id);if(!state.loaded)return;const r=canvas.getBoundingClientRect();platterGestures.get(id)?.cancel();engine.clearLoop(id);engine.seek(id,timeAtWaveformX(event.clientX-r.left,r.width,range||currentRange()));updateDecks();};
    canvas.addEventListener('pointerdown',event=>{if(event.button!==0)return;event.preventDefault();range={...currentRange()};canvas.setPointerCapture(event.pointerId);seek(event);});
    canvas.addEventListener('pointermove',event=>{if(canvas.hasPointerCapture(event.pointerId))seek(event);});
    for(const name of ['pointerup','pointercancel','lostpointercapture'])canvas.addEventListener(name,()=>{range=null;});
    canvas.addEventListener('keydown',event=>{if(!['ArrowLeft','ArrowRight','Home','End'].includes(event.code)||!engine.getState(id).loaded)return;event.preventDefault();platterGestures.get(id)?.cancel();const state=engine.getState(id),step=kind==='overview'?5:decks[id].waveSpan/20;engine.clearLoop(id);engine.seek(id,event.code==='Home'?0:event.code==='End'?state.duration:state.position+(event.code==='ArrowLeft'?-step:step));updateDecks();});
  }
  for(const button of $$(`[data-wave-zoom^="${id}:"]`))button.onclick=()=>{decks[id].waveSpan=clamp(decks[id].waveSpan*(button.dataset.waveZoom.endsWith(':in')?.5:2),2,32);updateDecks();};
}

function updateDecks(){
  for(const id of ['a','b']){
    const track=trackFor(id);
    if(decks[id].gridTrack!==track){engine.setBeatGrid?.(id,track||{});decks[id].gridTrack=track;}
    const state=engine.getState(id);
    $(`#${id}-title`).textContent=track?.title||'曲を読み込んでください';
    $(`#${id}-artist`).textContent=track?.artist||'ライブラリから曲を選択';
    $(`#${id}-bpm`).textContent=track?.bpm?(tempoAt(track,state.position).bpm*state.rate).toFixed(2):'—.—';
    const play=$(`#${id}-play`);play.classList.toggle('is-playing',state.playing);play.textContent=state.playing?'Ⅱ':'▶';play.setAttribute('aria-pressed',String(state.playing));play.setAttribute('aria-label',`デッキ ${id.toUpperCase()} ${state.playing?'一時停止':'再生'}`);
    const loop=$(`#${id}-loop`);loop.classList.toggle('active',!!state.loop);loop.setAttribute('aria-pressed',String(!!state.loop));
    $(`#${id}-wave-empty`).hidden=!!track;
    $(`#${id}-scratch-state`).textContent=state.scratching?'SCRATCHING':state.playing?'PLAYING':'';
    $(`#${id}-platter`).classList.toggle('scratching',!!state.scratching);
    const keylock=$(`#${id}-keylock`);const locked=!!state.keyLock;keylock.setAttribute('aria-pressed',String(locked));keylock.classList.toggle('active',locked);keylock.textContent=locked?'KEY LOCK':state.keyLockBypassReason?'PITCH LINK':state.keyLockRequested&&!state.keyLockError?'KEY LOCK · 待機':'PITCH LINK';keylock.title=state.keyLockBypassReason?`${state.keyLockBypassReason}${state.keyLockRequested?'（KEY LOCK設定は保持）':''}`:state.keyLockError||(locked?'テンポを変えても音程を保っています':'クリックして音程固定の設定を切り替えます');
    for(let i=0;i<8;i++){const cue=track?.hotcues?.[i];const button=$(`#${id}-hotcue-${i}`);button.classList.toggle('set',cue!=null);const mark=track?.positionMarks?.find(m=>m.num===i);button.title=mark?`${mark.name||`HOT CUE ${i+1}`}${mark.type===4?' · LOOP':''} · Shift＋クリックで解除`:'未設定なら現在位置を保存。設定後はジャンプ。Shift＋クリックで解除';const content=`${i+1}<small>${cue!=null?time(cue):'HOT CUE'}</small>`;if(button.innerHTML!==content)button.innerHTML=content;}
    for(const mode of ['sync','quantize']){const button=$(`#${id}-${mode}`),enabled=!!state[mode];button.classList.toggle('active',enabled);button.setAttribute('aria-pressed',String(enabled));}
    if(view==='play'||view==='mapping')drawWave(id,state);
  }
}

const waveformKey=track=>JSON.stringify([track.id,track.fingerprint||'']);
function acceptWaveform(trackId,key,waveform){
  const track=tracks.find(item=>item.id===trackId);
  if(!pageActive||!track||waveformKey(track)!==key)return;
  waveformKeys.set(trackId,key);detailedWaves.delete(trackId);detailedWaves.set(trackId,waveform);
  while(detailedWaves.size>8){const removable=[...detailedWaves.keys()].find(id=>id!==decks.a.trackId&&id!==decks.b.trackId&&id!==preview.getState().trackId);if(!removable)break;detailedWaves.delete(removable);}
  for(const id of ['a','b'])if(decks[id].trackId===trackId)drawWave(id);
  drawLibraryWaves();drawPreviewWave();updatePreviewWaveInfo();
}
async function prepareSelectedWaveform(track,current){
  const key=waveformKey(track);
  if(waveformKeys.get(track.id)===key&&detailedWaves.has(track.id))return;
  // Persistent display data is usable without loading the original audio.
  const cached=await waveformCache.find(key);
  if(!current()||!pageActive)return;
  if(cached){acceptWaveform(track.id,key,cached);return;}
  if(track.audioMissing)return false;
  const buffer=await bufferCache.get(track.id,async()=>{
    const audio=await library.getAudio(track.id);
    if(!audio)throw new Error('元の音源を読み込めませんでした。');
    // An audition/deck may share this cache job after selection changes.
    // Finish the single in-flight decode; the coordinator skips obsolete work.
    // decodeFile opens PCM resources without resume(), start() or playback.
    // Large WAV files remain file-backed and are read in bounded chunks.
    return engine.decodeFile(audio);
  });
  if(!current()||!pageActive)return;
  if(!await prepareWaveform(track.id,buffer))throw new Error('詳細波形を生成できませんでした。');
}
function prepareWaveform(trackId,buffer){
  if(!pageActive)return Promise.resolve(null);
  const track=tracks.find(item=>item.id===trackId);if(!track)return Promise.resolve(null);
  const key=waveformKey(track);
  if(waveformKeys.get(trackId)===key){
    if(detailedWaves.has(trackId))return Promise.resolve(detailedWaves.get(trackId));
    if(waveformJobs.has(trackId))return waveformJobs.get(trackId).promise;
  }
  const old=waveformKeys.get(trackId);if(old&&old!==key)waveformCache.delete(old);
  waveformKeys.set(trackId,key);const token={};waveformJobs.set(trackId,token);
  token.promise=waveformCache.get(key,buffer).then(waveform=>{
    if(waveformJobs.get(trackId)!==token||waveformKeys.get(trackId)!==key)return null;
    acceptWaveform(trackId,key,waveform);return waveform;
  }).catch(error=>{if(pageActive&&waveformJobs.get(trackId)===token)console.warn('Detailed waveform unavailable:',error);return null;}).finally(()=>{if(waveformJobs.get(trackId)===token)waveformJobs.delete(trackId);});
  return token.promise;
}
function invalidateWaveform(trackId){const track=tracks.find(item=>item.id===trackId);const key=waveformKeys.get(trackId)||(track?JSON.stringify([track.id,track.fingerprint||'']):null);if(key)waveformCache.delete(key);waveformKeys.delete(trackId);waveformJobs.delete(trackId);detailedWaves.delete(trackId);}
function waveOptions(track,state){return {waveform:detailedWaves.get(track?.id),peaks:track?.peaks,duration:state.duration||track?.duration||0,position:state.position,markers:(track?.hotcues||[]).flatMap((time,i)=>time==null?[]:[{time,label:String.fromCharCode(65+i)}]),loop:state.loop};}
function setWavePosition(canvas,state){canvas.setAttribute('aria-valuemax',String(state.duration||0));canvas.setAttribute('aria-valuenow',String(state.position||0));canvas.setAttribute('aria-valuetext',`${time(state.position)} / ${time(state.duration)}`);}
function drawWave(id,state=engine.getState(id)){
  const track=trackFor(id),options=waveOptions(track,state),range=getWaveformWindow(options.duration,state.position,decks[id].waveSpan);
  decks[id].waveRange=range;
  const canvas=$(`#${id}-wave`),overview=$(`#${id}-overview`);
  canvas.dataset.resolution=options.waveform?'detailed':'overview';
  drawWaveform(canvas,{...options,...range,beats:track?waveformBeats(track,range.start,range.end,{labels:true}):[]});
  drawWaveform(overview,{...options,overview:true});
  for(const target of [canvas,overview])setWavePosition(target,state);
  $(`#${id}-wave-span`).textContent=`${decks[id].waveSpan}s`;
  for(const button of $$(`[data-wave-zoom^="${id}:"]`))button.disabled=button.dataset.waveZoom.endsWith(':in')?decks[id].waveSpan<=2:decks[id].waveSpan>=32;
}
function drawLibraryWaves(){const byId=new Map(tracks.map(track=>[track.id,track]));for(const canvas of $$('canvas[data-wave-track]')){const track=byId.get(canvas.dataset.waveTrack);if(track)drawWaveform(canvas,{waveform:detailedWaves.get(track.id),peaks:track.peaks,duration:detailedWaves.get(track.id)?.duration||track.duration,position:null,overview:true});}}
function drawPreviewWave(){
  if(view!=='library')return;
  const state=preview.getState(),track=tracks.find(item=>item.id===state.trackId),options=waveOptions(track,state);
  const canvas=$('#preview-wave'),detail=$('#preview-detail-wave');
  previewWaveRange={start:0,end:options.duration};
  previewDetailRange=getWaveformWindow(options.duration,state.position,previewWaveSpan);
  canvas.dataset.resolution=options.waveform?'detailed':'overview';
  drawWaveform(canvas,{...options,...previewWaveRange,overview:true});setWavePosition(canvas,state);
  detail.dataset.resolution=options.waveform?'detailed':'overview';
  detail.dataset.framesPerSecond=String(options.waveform?.framesPerSecond||0);
  drawWaveform(detail,{...options,...previewDetailRange,beats:track?waveformBeats(track,previewDetailRange.start,previewDetailRange.end,{labels:true}):[]});setWavePosition(detail,state);
  for(const target of [canvas,detail]){target.setAttribute('aria-disabled',String(!track||!options.duration||state.loading));target.tabIndex=track&&options.duration?0:-1;}
  $('#preview-zoom').textContent=`${previewWaveSpan}s`;
  $('#preview-zoom-in').disabled=!track||previewWaveSpan<=2;
  $('#preview-zoom-out').disabled=!track||previewWaveSpan>=32;
}
function updatePreviewWaveInfo(){
  const state=preview.getState(),track=tracks.find(item=>item.id===state.trackId),waveform=detailedWaves.get(track?.id);
  const status=$('#preview-wave-status'),position=$('#preview-beat-position'),source=$('#preview-bpm-source');
  if(status){
    const loading=track&&selectionWaveState.key===waveformKey(track)&&selectionWaveState.status==='loading';
    status.textContent=!track?'':waveform?'詳細波形':loading?'詳細波形を準備中…':track.audioMissing?'概要波形 · 音源未リンク':selectionWaveState.status==='error'?'概要波形 · 詳細波形を取得できませんでした':'概要波形';
    status.title=waveform?`${Math.round(waveform.framesPerSecond)}点/秒${waveform.reducedResolution?'（長尺音源の表示容量を調整）':''}`:selectionWaveState.error?.message||'';
    status.setAttribute('aria-busy',String(!!loading));
  }
  const musical=track?waveformBeatPosition(track,state.position):null;
  if(position){position.textContent=musical?`${musical.bar}.${musical.beat}`:'—';position.title=musical?`${musical.bar}小節 ${musical.beat}拍目`:'ビートグリッド未設定';}
  if(source)source.textContent=!track?'':!track.bpm&&!track.tempos?.length?'BPM未設定':track.rekordbox?(track.tempos?.length?'rekordboxのビートグリッド':'rekordboxのBPM'):track.confidence<.35?'BPM解析済み · 要確認':'BPM解析済み';
  const bpm=musical?.bpm||track?.bpm;
  $('#preview-bpm-display').textContent=bpm?(bpm*(state.rate??1)).toFixed(2):'—';
}

let lastFrame=0,lastUI=0,lastPreviewUI=0,lastWaveUI=0;
function animate(now){
  const dt=lastFrame?Math.min((now-lastFrame)/1000,.1):0;lastFrame=now;
  if((view==='play'||view==='mapping')&&!document.hidden){for(const id of ['a','b']){const state=engine.getState(id);if(state.playing&&!state.scratching){decks[id].angle=(decks[id].angle+dt*200*state.rate)%360;deckElements[id].record.style.transform=`rotate(${decks[id].angle}deg)`;}
    if(now-lastWaveUI>=32&&(state.playing||state.scratching))drawWave(id,state);
    if(now-lastUI>100){const track=trackFor(id);setText(deckElements[id].bpm,track?.bpm?(tempoAt(track,state.position).bpm*state.rate).toFixed(2):'—.—');setText(deckElements[id].time,time(state.position));setText(deckElements[id].remaining,`− ${time(state.duration-state.position)}`);}}
    if(now-lastWaveUI>=32)lastWaveUI=now;
    if(now-lastUI>100){lastUI=now;const level=engine.getLevels?.();$('#master-meter').style.height=`${Math.min(1,(level?.master||0)*2)*100}%`;$('#audio-status').textContent=engine.context?`${engine.context.sampleRate/1000} kHz / ${engine.context.state==='running'?'AUDIO ON':'待機中'}`:'音声待機中';}}
  if(view==='library'&&!document.hidden&&now-lastPreviewUI>=32){lastPreviewUI=now;updatePreviewProgress();}
  requestAnimationFrame(animate);
}

function setView(next){
  if(next!==view){for(const slider of touchSliders)slider.cancel();if(view==='mapping')cancelMappingLearn();}
  if(next!=='play')for(const gesture of platterGestures.values())gesture.cancel();
  if(next!=='library'){previewCueErase=false;preview.stop();}view=next;
  const assigning=next==='mapping';
  $('#play-view').classList.toggle('active',next==='play'||assigning);
  $('#play-view').classList.toggle('midi-assign-mode',assigning);
  $('#deck-mapping-toolbar').hidden=!assigning;
  $('#mapping-view').classList.toggle('active',assigning);
  $('#library-section').hidden=assigning;$('#library-intro').hidden=next!=='library';
  $$('.workspace-tabs .tab').forEach(button=>{const active=button.dataset.view===next;button.classList.toggle('active',active);if(active)button.setAttribute('aria-current','page');else button.removeAttribute('aria-current');});
  if(next==='play'||assigning)updateDecks();
  if(assigning)renderMappings();updatePreview();
}

function setLibrarySort(field,toggle=false){
  const select=$('#sort');
  librarySortDirection=toggle&&field===select.value&&librarySortDirection==='ascending'?'descending':'ascending';
  select.value=field;libraryPage=0;renderLibrary();
}

function visibleLibraryTracks(){
  const query=$('#search').value.trim().toLocaleLowerCase();
  let filtered=tracks.filter(track=>(`${track.title} ${track.artist}`).toLocaleLowerCase().includes(query));
  const source=sources.find(item=>item.id===activeSource);
  if(source){const ids=new Set(source.trackIds);filtered=filtered.filter(track=>ids.has(track.id));}
  const playlist=playlists.find(item=>item.id===activePlaylist),positions=new Map(playlist?.trackIds.map((id,index)=>[id,index])||[]);
  if(playlist)filtered=filtered.filter(track=>positions.has(track.id));
  return sortLibraryTracks(filtered,{field:$('#sort').value,direction:librarySortDirection,playlistOrder:playlist?positions:null});
}
function scopedPlaylists(){
  const source=sources.find(item=>item.id===activeSource);
  if(!source)return playlists;
  const ids=sourcePlaylistIds(source);
  return playlists.filter(playlist=>ids.has(playlist.id));
}
function setupColumnMenu(){
  $('#library-column-options').innerHTML=LIBRARY_COLUMNS.filter(column=>!column.required).map(column=>`<label><input type="checkbox" data-library-column-toggle="${column.id}" ${visibleColumns.includes(column.id)?'checked':''}><span>${column.label}</span></label>`).join('');
  $('#sort').innerHTML=LIBRARY_COLUMNS.filter(column=>column.sort).map(column=>`<option value="${column.sort}">${column.id==='number'?'追加順':`${column.label}順`}</option>`).join('');
}
function saveColumnSelection(){
  try{localStorage.setItem(COLUMN_STORAGE_KEY,JSON.stringify(visibleColumns));}catch{}
  for(const input of $$('[data-library-column-toggle]'))input.checked=visibleColumns.includes(input.dataset.libraryColumnToggle);
  renderLibrary();
}
function renderColumnHeaders(){
  const columns=LIBRARY_COLUMNS.filter(column=>visibleColumns.includes(column.id)),key=columns.map(column=>column.id).join('|');
  if(columnHeaderKey!==key){
    const heading=document.activeElement?.closest('.library-table th')?document.activeElement.dataset.librarySort:null;
    const table=$('.library-table');
    table.querySelector('colgroup').innerHTML=columns.map(column=>`<col style="width:${column.width}px">`).join('');
    table.querySelector('thead tr').innerHTML=columns.map(column=>`<th data-library-column="${column.id}" ${column.sort?'aria-sort="none"':''}>${column.sort?`<button ${column.id==='bpm'?'id="sort-bpm"':''} data-library-sort="${column.sort}"${column.id==='number'?' aria-label="追加順で並べ替え"':''}>${column.label}</button>`:column.id==='actions'?'<span class="sr-only">曲の操作</span>':column.label}</th>`).join('');
    table.style.minWidth=`${columns.reduce((sum,column)=>sum+column.width,0)}px`;columnHeaderKey=key;
    if(heading)table.querySelector(`[data-library-sort="${heading}"]`)?.focus({preventScroll:true});
  }
  return columns;
}
function trackCells(track,index,columns){
  return columns.map(column=>{
    const id=column.id,attr=`data-library-column="${id}"`;
    if(id==='number')return `<td ${attr} class="track-number">${String(libraryPage*PAGE_SIZE+index+1).padStart(2,'0')}</td>`;
    if(id==='title')return `<td ${attr}><div class="track-identity"><button class="preview-track-button" data-preview="${escapeHTML(track.id)}" aria-label="${escapeHTML(track.title)} を試聴" aria-pressed="false" ${track.audioMissing?'disabled':''}>▶</button><div class="track-copy"><button class="track-title track-select-button" data-track-select="${escapeHTML(track.id)}" title="${escapeHTML(track.filename)}" aria-label="${escapeHTML(track.title)} を選択">${escapeHTML(track.title)}</button></div></div></td>`;
    if(id==='waveform')return `<td ${attr} class="wave-cell"><canvas class="mini-wave" data-wave-track="${escapeHTML(track.id)}" aria-hidden="true"></canvas></td>`;
    if(id==='decks')return `<td ${attr}><div class="track-actions">${track.audioMissing?`<button class="link-audio-button" data-link-audio="${escapeHTML(track.id)}">音源を選択</button>`:`<button class="load-button ${decks.a.trackId===track.id?'is-loaded':''}" data-load="a:${escapeHTML(track.id)}" aria-label="${escapeHTML(track.title)} をデッキ A へ">A</button><button class="load-button b ${decks.b.trackId===track.id?'is-loaded':''}" data-load="b:${escapeHTML(track.id)}" aria-label="${escapeHTML(track.title)} をデッキ B へ">B</button>`}</div></td>`;
    if(id==='actions')return `<td ${attr}><button class="icon-button more-button" data-edit="${escapeHTML(track.id)}" aria-label="${escapeHTML(track.title)} の情報を編集">⋯</button></td>`;
    const text=libraryColumnText(track,id),className=id==='artist'?'track-artist-cell':['bpm','duration'].includes(id)?`track-${id}`:['dateAdded','dateModified','key','bitRate','sampleRate'].includes(id)?'track-data-cell':id==='rating'?'track-rating':'';
    const title=id==='bpm'?(track.rekordbox?'rekordboxの平均BPM':track.confidence<.35?'解析結果は推定です。曲の情報で修正できます。':'BPM'):id==='rating'&&text?`${track.rating} / 5`:text;
    return `<td ${attr} class="${className}" title="${escapeHTML(title)}">${escapeHTML(text)}</td>`;
  }).join('');
}

function renderLibrary(){
  const columns=renderColumnHeaders();
  const nav=$('#source-nav-list');if(nav)for(const button of nav.querySelectorAll('[data-source-view]')){const active=button.dataset.sourceView===activeSource;button.classList.toggle('active',active);button.setAttribute('aria-pressed',String(active));}
  $('#library-section').classList.toggle('is-empty',tracks.length===0);
  $('#track-count').textContent=`${tracks.length.toLocaleString('ja-JP')}曲`;
  const selectedSource=sources.find(source=>source.id===activeSource);
  const visiblePlaylists=scopedPlaylists();
  if(activePlaylist!=='all'&&!visiblePlaylists.some(playlist=>playlist.id===activePlaylist))activePlaylist='all';
  $('#playlist-tabs').innerHTML=`<button class="pill ${activePlaylist==='all'?'active':''}" data-playlist="all">${selectedSource?.nativeUSB?'このUSBのすべての曲':'すべての曲'}</button>`+visiblePlaylists.map(p=>`<button class="pill ${activePlaylist===p.id?'active':''}" data-playlist="${escapeHTML(p.id)}">${escapeHTML([...(p.folderPath||[]),p.name].join(" / "))} <span>${p.trackIds.length}</span></button>`).join('');
  const filtered=visibleLibraryTracks();
  $('#track-count').textContent=`${filtered.length.toLocaleString('ja-JP')}曲`;
  const sort=$('#sort').value;
  for(const button of $$('[data-library-sort]')){
    const active=button.dataset.librarySort===sort,heading=button.closest('th');
    heading.setAttribute('aria-sort',active?librarySortDirection:'none');
    if(active)heading.dataset.sortDirection=librarySortDirection;else delete heading.dataset.sortDirection;
    button.title=active&&librarySortDirection==='ascending'?'降順に並べ替え':'昇順に並べ替え';
  }
  const pageCount=Math.max(1,Math.ceil(filtered.length/PAGE_SIZE));libraryPage=Math.min(libraryPage,pageCount-1);
  $('#library-pages').hidden=filtered.length<=PAGE_SIZE;$('#previous-page').disabled=libraryPage===0;$('#next-page').disabled=libraryPage===pageCount-1;$('#page-status').textContent=`${filtered.length?libraryPage*PAGE_SIZE+1:0}–${Math.min(filtered.length,(libraryPage+1)*PAGE_SIZE)} / ${filtered.length.toLocaleString('ja-JP')}曲`;
  $('#source-filter').hidden=!selectedSource;$('#source-filter').innerHTML=selectedSource?`<span>${escapeHTML(selectedSource.label)} · 保存済みライブラリ</span><button class="text-button" data-source-all>すべての曲へ</button>`:'';
  $('#track-list').innerHTML=filtered.slice(libraryPage*PAGE_SIZE,(libraryPage+1)*PAGE_SIZE).map((track,index)=>`<tr data-select-track="${escapeHTML(track.id)}" tabindex="-1" aria-selected="false">${trackCells(track,index,columns)}</tr>`).join('');
  $('#empty-library').hidden=tracks.length>0;
  if(!filtered.length&&tracks.length)$('#track-list').innerHTML=`<tr><td colspan="${columns.length}" style="text-align:center;color:#a0a0a0;padding:32px">条件に合う曲はありません。</td></tr>`;
  updatePreview();drawLibraryWaves();renderNativeUSB();renderUSBDevices();
}


async function startDeckPlayback(operation){
  preview.stop();pendingDeckPlayback++;
  try{return await operation();}finally{pendingDeckPlayback--;}
}
function selectPreview(trackId){
  const track=tracks.find(t=>t.id===trackId);if(!track)return;
  setView('library');
  preview.select(track.id,track.duration);
}
async function togglePreview(trackId){
  const track=tracks.find(t=>t.id===trackId);if(!track)return;if(track.audioMissing){toast('先に「音源を選択」で元の音源を関連付けてください。');return;}
  if(pendingDeckPlayback||['a','b'].some(id=>{const state=engine.getState(id);return state.playing||state.scratching;})){
    toast('DJデッキが再生中です。試聴するにはデッキを停止してください。');return;
  }
  setView('library');
  await preview.toggle(trackId);
}
function refreshCueMetadata(track){
  if(view==='library'&&$('#sort').value==='dateModified'){renderLibrary();return;}
  const row=$$('[data-select-track]').find(item=>item.dataset.selectTrack===track.id),cell=row?.querySelector('[data-library-column="dateModified"]');
  if(cell)setText(cell,libraryColumnText(track,'dateModified'));
}
const cueTime=seconds=>{const milliseconds=Math.max(0,Math.round((seconds||0)*1000));return `${Math.floor(milliseconds/60000)}:${String(Math.floor(milliseconds/1000)%60).padStart(2,'0')}.${String(milliseconds%1000).padStart(3,'0')}`;};
function updatePreviewCues(){
  const state=preview.getState(),track=tracks.find(t=>t.id===state.trackId);
  if(previewCueTrackId!==state.trackId){previewCueTrackId=state.trackId;previewCueErase=false;}
  const pending=previewCuePending.has(state.trackId),available=!!track&&state.duration>0&&!state.loading&&!importing&&!pending;
  const hasCue=track?.hotcues?.some(cue=>cue!=null);
  if(!hasCue)previewCueErase=false;
  const erase=$('#preview-cue-erase');erase.disabled=!available||!hasCue;erase.setAttribute('aria-pressed',String(previewCueErase));erase.textContent=previewCueErase?'解除を中止':'解除';
  $('#preview-cues').classList.toggle('is-erasing',previewCueErase);
  setText($('#preview-cue-hint'),pending?'HOT CUEを保存中…':previewCueErase?'解除するCUEを選択':!track?'曲を選択してCUEを設定':'空き枠で現在位置を保存 · 設定済みで移動');
  for(const button of $$('[data-preview-cue]')){
    const index=Number(button.dataset.previewCue),label=String.fromCharCode(65+index),cue=track?.hotcues?.[index];
    const mark=track?.positionMarks?.find(item=>item.num===index),isLoop=mark?.type===4;
    const caption=cue==null?'＋ 設定':cueTime(cue);
    setText(button.querySelector('small'),caption);button.classList.toggle('is-set',cue!=null);
    button.disabled=!available||(previewCueErase&&cue==null);
    const action=previewCueErase?'解除':cue==null?'現在位置に設定':isLoop?'ループ開始位置へ移動':'へ移動';
    button.setAttribute('aria-label',`HOT CUE ${label} ${cue==null?'':cueTime(cue)+' '}${action}`);
    button.title=cue==null?'現在の再生位置を保存':`${mark?.name||`HOT CUE ${label}`}${isLoop?' · LOOP':''} · ${cueTime(cue)}`;
  }
}
async function previewHotCue(index){
  const state=preview.getState(),track=tracks.find(t=>t.id===state.trackId);
  if(!track||!Number.isInteger(index)||index<0||index>7||!state.duration||state.loading||importing||previewCuePending.has(track.id))return;
  const clear=previewCueErase,existing=track.hotcues?.[index];
  if(!clear&&existing!=null){preview.seek(existing);return;}
  if(clear&&existing==null)return;
  // Capture the intended track and position before storage can yield. Selection
  // may change while saving; it must never redirect the edit to another song.
  const position=Math.max(0,Math.min(state.position,Math.max(0,Math.min(state.duration,track.duration)-.001)));
  previewCueErase=false;previewCuePending.add(track.id);updatePreviewCues();
  try{
    await trackQueue.run(track.id,async()=>{
      const current=tracks.find(t=>t.id===track.id);
      if(!current)throw new Error('この曲はライブラリから削除されています。');
      if(importing)throw new Error('ライブラリの処理が完了してからHOT CUEを保存してください。');
      // A simultaneous deck edit may have filled the empty bank already.
      // Keep that edit rather than replacing it with an older click position.
      if(!clear&&current.hotcues?.[index]!=null)return;
      const updated=editTrackHotCue(current,index,position,{clear});if(updated===current)return;
      await library.putTrack(updated);tracks=tracks.map(item=>item.id===updated.id?updated:item);refreshCueMetadata(updated);
      const label=String.fromCharCode(65+index);
      toast(clear?`HOT CUE ${label} を解除しました。`:`HOT CUE ${label} を ${cueTime(position)} に保存しました。`);
    });
  }finally{
    previewCuePending.delete(track.id);if(view==='library')updatePreview();updateDecks();
  }
}
function updatePreviewProgress(){
  const state=preview.getState();
  const seek=$('#preview-seek');
  seek.max=String(state.duration||0);seek.value=String(state.position);
  seek.disabled=state.loading||!state.duration||!!state.error;
  seek.setAttribute('aria-valuetext',`${time(state.position)} / ${time(state.duration)}`);
  $('#preview-time').textContent=`${time(state.position)} / ${time(state.duration)}`;
  drawPreviewWave();updatePreviewWaveInfo();
}
function updatePreview(){
  const state=preview.getState(),track=tracks.find(t=>t.id===state.trackId);
  selectedWaveform.select(pageActive&&view==='library'&&track?waveformKey(track):null,track);
  const playable=!!track&&!track.audioMissing;
  $('#library-preview').hidden=view!=='library';
  $('#library-preview').classList.toggle('has-track',!!track);
  $('#preview-title').textContent=track?.title||'曲を選択してください';
  $('#preview-artist').textContent=track?(track.artist||'アーティスト未設定'):'曲一覧から選択';
  $('#preview-status').textContent=!track?'プレビュー':track.audioMissing?'音源未リンク':state.loading?'読み込み中…':state.error?'再生できませんでした':state.playing?'再生中':state.position?'一時停止':'選択中';
  const play=$('#preview-toggle');
  play.disabled=!playable;
  for(const id of ['preview-rate','preview-eq-low','preview-eq-mid','preview-eq-high','preview-reset'])$(`#${id}`).disabled=!playable;
  $('#preview-edit-bpm').disabled=!track;
  play.textContent=state.loading?'×':state.playing?'Ⅱ':'▶';
  play.setAttribute('aria-label',state.loading?'試聴の読み込みをキャンセル':state.playing?'試聴を一時停止':'試聴を再生');
  play.setAttribute('aria-pressed',String(state.playing));
  $('#preview-stop').disabled=!state.loading&&!state.playing&&!state.position;
  const rate=state.rate??1,percent=(rate-1)*100;
  $('#preview-bpm-display').textContent=track?.bpm?(track.bpm*rate).toFixed(2):'—';
  $('#preview-rate').value=String(percent);
  $('#preview-rate-value').textContent=`${percent>=0?'+':''}${percent.toFixed(1)}%`;
  $('#preview-bpm-label').textContent=track?.tempos?.length>1?'再生BPM（平均）':'再生BPM';
  const bpm=$('#preview-bpm');bpm.disabled=!track?.bpm||!playable;
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
    const row=button.closest('tr');row.classList.toggle('is-previewing',selected);row.setAttribute('aria-selected',String(selected));
  }
  updatePreviewCues();
  const rows=$$('[data-select-track]'),selectedRow=rows.find(row=>row.dataset.selectTrack===state.trackId);
  for(const row of rows)row.tabIndex=row===(selectedRow||rows[0])?0:-1;
  updatePreviewProgress();
}

let worker;
let analysisId=0;
const pendingAnalysis=new Map();
function analyze(buffer,onProgress=()=>{}){
  if(isPcmFileResource(buffer))return analyzeAudioResource(buffer,{analyze:analyzeInput,onProgress});
  const {samples,sampleRate}=createAnalysisInput(buffer);
  return analyzeInput(samples,sampleRate);
}
function analyzeInput(samples,sampleRate){
  return new Promise((resolve,reject)=>{
    if(!worker){worker=new Worker(new URL('./analysis-worker.js?v=7c8bf604d2c9c1e4',import.meta.url),{type:'module'});worker.onmessage=({data})=>{const entry=pendingAnalysis.get(data.id);if(!entry)return;pendingAnalysis.delete(data.id);clearTimeout(entry.timer);data.error?entry.reject(new Error(data.error)):entry.resolve(data.result);};worker.onerror=()=>{for(const entry of pendingAnalysis.values()){clearTimeout(entry.timer);entry.reject(new Error('解析処理を開始できませんでした。ページを再読み込みしてください。'));}pendingAnalysis.clear();worker.terminate();worker=null;};}
    const id=++analysisId;const timer=setTimeout(()=>{pendingAnalysis.delete(id);reject(new Error('解析処理が応答しません。もう一度お試しください。'));},90000);
    pendingAnalysis.set(id,{resolve,reject,timer});worker.postMessage({id,samples,sampleRate},[samples.buffer]);
  });
}

function setImporting(value){
  importing=value;
  if(value)usbDeviceMonitor?.stop();else if(pageActive&&!document.hidden)usbDeviceMonitor?.start();
  for(const id of ['import-top','import-empty','import-xml','import-xml-empty','choose-xml','open-sources','open-sources-empty','choose-source-folder','choose-source-files','start-source-import']){
    const el=$(`#${id}`);if(!el)continue;el.disabled=value;el.classList.toggle('importing',value);
  }
  for(const button of $$('[data-source-refresh],[data-source-forget]'))button.disabled=value;
  renderNativeUSB();renderUSBDevices();updatePreviewCues();
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
      let buffer=await engine.decodeFile(file);
      const imported=findImportedAudio(tracks,file,buffer.duration,selectedId);
      if(imported){
        const peaks=isPcmFileResource(buffer)?await audioResourcePeaks(buffer):audioPeaks(buffer),duration=buffer.duration;buffer=null;
        await trackQueue.run(imported.id,async()=>{
          const current=tracks.find(t=>t.id===imported.id);if(!current)throw new Error('この曲は削除されています。');
          const metadata=relinkMetadata(current,file,duration,peaks);
          $('#library-status').textContent=`音源を保存中 ${i+1} / ${files.length} — ${file.name}`;
          bufferCache.delete(metadata.id);invalidateWaveform(metadata.id);await library.putTrack(metadata,file);tracks=tracks.map(t=>t.id===metadata.id?metadata:t);
        });linked++;
      }else{
        const result=await analyze(buffer,message=>{$('#library-status').textContent=`${message} — ${file.name}`;});buffer=null;
        const stem=file.name.replace(/\.[^.]+$/,'');const split=stem.split(' - ');const title=split.length>1?split.slice(1).join(' - '):stem;const artist=split.length>1?split[0]:'';
        const metadata={id:uid(),title,artist,bpm:result.bpm,confidence:result.confidence,duration:result.duration,beatOffset:result.beatOffset||0,peaks:result.peaks,cue:0,hotcues:Array(8).fill(null),filename:file.name,fingerprint,addedAt:Date.now()};
        $('#library-status').textContent=`音源を保存中 ${i+1} / ${files.length} — ${file.name}`;
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

function openTrack(id){
  if(importing){toast('読み込みが終わってから曲の情報を編集してください。');return;}
  const track=tracks.find(t=>t.id===id);if(!track)return;editingTrack=id;const form=$('#track-form');form.elements.title.value=track.title;form.elements.artist.value=track.artist;form.elements.bpm.value=track.bpm||'';$('#track-grid-note').hidden=!track.tempos?.length;const details=$('#track-import-details');details.hidden=!track.rekordbox;details.innerHTML=track.rekordbox?`<strong>rekordboxから取り込み</strong><br>${track.tempos?.length||0}個のテンポ区間 · ${(track.positionMarks||[]).filter(m=>m.num===-1).length}個のメモリーCUE／ループ<ul>${(track.positionMarks||[]).map(m=>`<li>${m.num<0?'MEMORY':`HOT CUE ${m.num+1}`} · ${time(m.start)}${m.type===4?`〜${time(m.end)} LOOP`:''} ${escapeHTML(m.name)}</li>`).join('')}</ul>`:'';
  form.elements.playlist.innerHTML='<option value="">追加しない</option>'+playlists.map(p=>`<option value="${escapeHTML(p.id)}">${escapeHTML([...(p.folderPath||[]),p.name].join(" / "))}</option>`).join('');$('#track-dialog').showModal();
}
function renderMIDIStatus(status=mapping.status){
  const message=status.message+(status.inputs?.length?` 接続：${status.inputs.map(p=>p.name||p.id).join('、')}`:'');
  $('#midi-status').textContent=message;$('#deck-midi-status').textContent=message;
  for(const id of ['connect-midi','deck-connect-midi'])$(`#${id}`).textContent=status.state==='connected'?'MIDIを再確認':'MIDIを接続';
}
function cancelMappingLearn(){mappingArmNonce++;mappingArming=null;mapping.cancelLearn();renderMappings();}
async function armMapping(actionId,source='midi'){
  const action=actions.find(item=>item.id===actionId);if(!action||view!=='mapping')return;
  const nonce=++mappingArmNonce;mappingArming=actionId;mapping.cancelLearn();renderMappings();
  try{
    if(source==='midi'&&!await mapping.enableMIDI())return;
    if(nonce!==mappingArmNonce||view!=='mapping')return;
    mappingArming=null;
    const mode=source==='midi'&&action.kind==='continuous'?$('#midi-mode').value:'absolute';
    mapping.learn(actionId,source,{mode});
  }finally{if(nonce===mappingArmNonce){mappingArming=null;renderMappings();}}
}
function bindingLabel(item){const b=item.binding;if(item.source==='keyboard')return `${b.shift?'Shift + ':''}${b.alt?'Alt + ':''}${b.code.replace(/^Key/,'').replace(/^Digit/,'')}`;return `${b.type==='pitchbend'?'PITCH':`${b.type.toUpperCase()} ${b.number}`} / CH ${b.channel+1}${item.mode==='relative-twos'?' / REL 2C':item.mode==='relative-offset'?' / REL 64':''}`;}
function renderMappings(){
  const profile=mapping.profile;
  setText($('#mapping-count'),String(profile.mappings.length));if(document.activeElement!==$('#profile-name'))$('#profile-name').value=profile.name;
  const learning=mapping.learning,targetId=learning?.actionId||mappingArming,action=actions.find(item=>item.id===targetId);
  const instruction=targetId?`${targetId.split('.')[0].toUpperCase()} / ${action?.label}：${mappingArming?'MIDI接続を確認中…':learning.source==='midi'?'機材のボタン・ノブを操作してください':'割り当てるキーを押してください'}`:'割り当てる操作を画面で選び、MIDI機材を操作してください。';
  $('#learn-banner').hidden=!learning;if(learning)setText($('#learn-text'),instruction);
  setText($('#deck-learn-text'),instruction);$('#deck-cancel-learn').disabled=!targetId;
  for(const target of $$('#play-view [data-midi-action]')){const selected=!!targetId&&target.dataset.midiAction===targetId;target.classList.toggle('midi-learn-target',selected);}
  // MIDI performance values never require replacing the assignment table.
  if(view!=='mapping'||!$('#mapping-advanced').open)return;
  const key=JSON.stringify([profile.mappings,mappingGroup,learning]);if(key===mappingTableKey)return;mappingTableKey=key;
  $('#mapping-list').innerHTML=actions.filter(a=>mappingGroup==='all'||a.id.split('.')[0]===mappingGroup).map(a=>{const group=a.id.split('.')[0];const list=mapping.getMappings(a.id);return `<tr><td><span class="action-group ${group}">${group==='mixer'?'MIXER':`DECK ${group.toUpperCase()}`}</span>${a.label}</td><td><div class="mapping-chips">${list.length?list.map(m=>`<span class="binding">${escapeHTML(bindingLabel(m))}<button data-remove-mapping="${escapeHTML(m.id)}" aria-label="${escapeHTML(bindingLabel(m))} の割り当てを削除">×</button></span>`).join(''):'<span class="mapping-empty">未設定</span>'}</div></td><td><div class="mapping-learn-actions"><button class="learn-button ${learning?.actionId===a.id&&learning.source==='midi'?'active':''}" data-learn="${a.id}" data-source="midi">MIDI</button><button class="learn-button ${learning?.actionId===a.id&&learning.source==='keyboard'?'active':''}" data-learn="${a.id}" data-source="keyboard" ${a.kind==='continuous'?'disabled title="連続操作はMIDIで割り当てます"':''}>キー</button></div></td></tr>`;}).join('');
}

async function storageInfo(){try{const estimate=await navigator.storage?.estimate?.();$('#storage-status').textContent=library.persistent?`端末内に保存${estimate?.usage?` / ${(estimate.usage/1024/1024).toFixed(1)} MB`:''}`:'一時保存（このセッションのみ）';}catch{}}

function renderSources(){
  const existingIds=new Set(tracks.map(track=>track.id));
  const trackIds=new Set(tracks.filter(track=>!track.audioMissing).map(track=>track.id));
  const savedCount=source=>source.trackIds.filter(id=>existingIds.has(id)).length;
  $('#saved-source-list').innerHTML=sources.length?sources.map(source=>`<div class="saved-source"><div><strong>${escapeHTML(source.label)}</strong><small>${savedCount(source)}曲 · 音源保存 ${source.trackIds.filter(id=>trackIds.has(id)).length}曲</small></div><div class="saved-source-actions"><button class="button subtle compact" data-source-view="${escapeHTML(source.id)}">開く</button><button class="text-button" data-source-refresh="${escapeHTML(source.id)}">再読み込み</button><button class="text-button" data-source-forget="${escapeHTML(source.id)}" aria-label="${escapeHTML(source.label)}の参照だけ一覧から外す">一覧から外す</button></div></div>`).join(''):'<p class="source-note">まだ保存したライブラリはありません。</p>';
  const nav=$('#source-nav-list');if(nav)nav.innerHTML=sources.filter(source=>!isDeviceLibrarySource(source)).map(source=>`<button class="source-nav-button" data-source-view="${escapeHTML(source.id)}"><span>${escapeHTML(source.label)}</span><small>${savedCount(source)}</small></button>`).join('')||'<p class="source-note">未追加</p>';
  renderUSBDevices();
}
function cachedUSBSource(rootId){
  const matching=sources.filter(source=>source.nativeUSB?.rootId===rootId);
  return matching.find(source=>source.id===activeSource)||matching.sort((a,b)=>(b.updatedAt||0)-(a.updatedAt||0))[0];
}
function openCachedSource(sourceId){
  activeSource=sourceId;activePlaylist='all';libraryPage=0;$('#search').value='';
  setView('library');renderLibrary();if($('#source-dialog').open)$('#source-dialog').close();
}
function usbSessionConnected(){
  if(!nativeUSBSession)return false;
  const device=usbDevices.find(item=>item.id===nativeUSBSession.root.id);
  return !usbDevicesError&&(device?device.connected:!usbDevicesLoaded);
}
function noteConnectedUSB(session){
  const paths=[...session.index.entries.keys()];
  const device={id:session.root.id,name:session.root.name,connected:true,pendingTransactions:session.root.pendingTransactions||0,
    libraryFormats:[...(paths.some(path=>/(?:^|\/)export\.pdb$/i.test(path))?['pdb']:[]),...(paths.some(path=>/(?:^|\/)exportLibrary\.db$/i.test(path))?['onelibrary']:[])]};
  usbDevices=[...usbDevices.filter(item=>item.id!==device.id),device];usbDevicesError=null;renderUSBDevices();
}
let usbDeviceMarkup='';
function renderUSBDevices(){
  const group=$('#usb-devices-group'),nav=$('#usb-device-list');if(!group||!nav)return;
  const available=nativeUSBAvailable(),devices=new Map(usbDevices.map(device=>[device.id,device]));
  for(const source of sources)if(source.nativeUSB&&!devices.has(source.nativeUSB.rootId))devices.set(source.nativeUSB.rootId,
    {id:source.nativeUSB.rootId,name:source.nativeUSB.rootName||source.label,connected:false,unconfirmed:!usbDevicesLoaded,pendingTransactions:0,libraryFormats:[]});
  group.hidden=false;
  $('#usb-add').disabled=!library||importing;
  $('#usb-add').textContent=available?'＋ USBを追加':'USBを開く';
  const browserSources=sources.filter(source=>!source.nativeUSB&&isDeviceLibrarySource(source));
  const activeRoot=sources.find(source=>source.id===activeSource)?.nativeUSB?.rootId;
  const markup=[...devices.values()].sort((a,b)=>Number(b.connected)-Number(a.connected)||a.name.localeCompare(b.name,'ja'))
    .map(device=>{
      const cached=cachedUSBSource(device.id),selected=activeRoot===device.id;
      const status=!available?'保存済み · 接続状態未確認':device.pendingTransactions?'復旧が必要':device.unconfirmed?'確認中':device.connected?'接続中':cached?'未接続 · 保存済み':'未接続';
      const title=device.error||(device.connected?'選択してUSBのライブラリを読み込む':cached?'保存済みの曲とプレイリストを開く':'USBを接続してください。');
      return `<button class="usb-device-button" data-usb-device="${escapeHTML(device.id)}" data-connected="${device.connected}" aria-pressed="${selected}" title="${escapeHTML(title)}" ${importing||(!available&&!cached)||(!device.connected&&!device.unconfirmed&&!cached)?'disabled':''}><strong>${escapeHTML(device.name)}</strong><small>${status}</small></button>`;
    }).join('')+browserSources.map(source=>`<button class="usb-device-button" data-source-view="${escapeHTML(source.id)}" data-connected="false" aria-pressed="${activeSource===source.id}" title="保存済みの曲とプレイリストを開く。接続状態はブラウザでは確認できません。" ${importing?'disabled':''}><strong>${escapeHTML(source.label)}</strong><small>保存済み · 接続状態未確認</small></button>`).join('');
  if(markup!==usbDeviceMarkup){
    const focused=nav.contains(document.activeElement)?document.activeElement.dataset.usbDevice:null;
    usbDeviceMarkup=markup;nav.innerHTML=markup;
    if(focused){const button=[...nav.querySelectorAll('[data-usb-device]')].find(item=>item.dataset.usbDevice===focused);if(button&&!button.disabled)button.focus({preventScroll:true});}
  }
  $('#usb-devices-status').textContent=!available?'USB名のフォルダを選んで読み込みます。ブラウザでは接続を自動検出できません。':usbDevicesError?'USBの接続状態を確認できません。USBを選び直してください。':!devices.size?'初回は「USBを追加」からUSB名のフォルダを選択':'';
}
function startUSBDeviceMonitor(){
  if(!nativeUSBAvailable()||typeof globalThis.nativeUSB?.listDevices!=='function')return;
  usbDeviceMonitor??=new USBDeviceMonitor({listDevices:()=>globalThis.nativeUSB.listDevices(),
    isVisible:()=>pageActive&&!document.hidden,isBusy:()=>importing,
    onChange:devices=>{usbDevices=devices;usbDevicesLoaded=true;usbDevicesError=null;
      const connected=devices.find(device=>device.id===nativeUSBSession?.root.id);
      if(connected?.connected)nativeUSBSession.root.pendingTransactions=connected.pendingTransactions;
      renderUSBDevices();renderNativeUSB();},
    onError:error=>{usbDevicesError=error;renderUSBDevices();renderNativeUSB();}});
  if(pageActive&&!document.hidden&&!importing)usbDeviceMonitor.start();
}
async function selectUSBDevice(rootId){
  if(importing||!library)return;
  const device=usbDevices.find(item=>item.id===rootId),cached=cachedUSBSource(rootId);
  if(device?.connected===false||!nativeUSBAvailable()){
    if(cached){openCachedSource(cached.id);toast(nativeUSBAvailable()?'USBは未接続です。保存済みのライブラリを開きました。':'保存済みのライブラリを開きました。ブラウザではUSBの接続状態を確認できません。');}
    return;
  }
  const session=await connectNativeUSB({rootId});
  if(!session){if(cached)openCachedSource(cached.id);return;}
  if(session.root.pendingTransactions||!session.candidate){renderNativeUSB();if(!$('#usb-dialog').open)$('#usb-dialog').showModal();return;}
  await runSourceImport({index:session.index,candidate:session.candidate,sourceId:cached?.id,session,fromUSB:true});
}
async function addUSBDevice(){
  if(!nativeUSBAvailable()){openSources();return;}
  const session=await connectNativeUSB();if(!session)return;
  if(session.root.pendingTransactions||!session.candidate){renderNativeUSB();if(!$('#usb-dialog').open)$('#usb-dialog').showModal();return;}
  await runSourceImport({index:session.index,candidate:session.candidate,sourceId:cachedUSBSource(session.root.id)?.id,session,fromUSB:true});
}
function openSources(reset=true){
  if(!importing){if(reset)refreshSourceId=null;selectedSourceIndex=null;selectedCandidates=[];$('#source-selection').hidden=true;$('#source-database').innerHTML='';$('#source-progress').textContent='';}
  renderSources();if(!$('#source-dialog').open)$('#source-dialog').showModal();
}
async function chooseSourceFolder(){
  if(importing)return;
  if(nativeUSBAvailable()){
    const session=await connectNativeUSB();
    if(session?.root.pendingTransactions){$('#source-dialog').close();if(!$('#usb-dialog').open)$('#usb-dialog').showModal();renderNativeUSB();return;}
    if(session){selectSourceIndex(session.index);refreshSourceId=connectedUSBSource()?.id||refreshSourceId;}
    return;
  }
  // A read-only directory picker avoids the generic file-input confirmation
  // in supporting browsers. Handles stay in this selection; never request writes.
  if(typeof globalThis.showDirectoryPicker==='function'){
    const controller=new AbortController();sourceController=controller;setImporting(true);
    $('#source-progress').textContent='読み込むフォルダを選んでください。';
    try{
      const handle=await globalThis.showDirectoryPicker({id:'deckflow-library',mode:'read'});
      controller.signal.throwIfAborted();
      $('#cancel-source-import').hidden=false;
      $('#source-progress').textContent='フォルダ内のファイルを確認しています…';
      const index=await indexDirectory(handle,{signal:controller.signal,onProgress:count=>{
        $('#source-progress').textContent=`フォルダ内のファイルを確認しています… ${count.toLocaleString('ja-JP')}件`;
      }});
      controller.signal.throwIfAborted();selectSourceIndex(index);
    }catch(error){
      if(error.name==='AbortError')$('#source-progress').textContent='フォルダの読み込みを中止しました。';
      else{const message=['NotAllowedError','SecurityError'].includes(error.name)?'フォルダを開けませんでした。読み取りを許可して、もう一度選択してください。':error.message;$('#source-progress').textContent=message;throw new Error(message);}
    }finally{sourceController=null;$('#cancel-source-import').hidden=true;setImporting(false);}
    return;
  }
  // Safari uses its standard folder selector; its system labels are browser-owned.
  $('#source-folder').click();
}

function selectSourceIndex(index){
  if(!index.entries.size){$('#source-progress').textContent='対応するファイルがありません。DBまたは音源を含むフォルダを選んでください。';return;}
  const candidates=databaseCandidates(index);
  if(!candidates.length&&selectedSourceIndex&&selectedCandidates.length){
    if(selectedSourceIndex.nativeSession){$('#source-progress').textContent='USBライブラリには選択したUSB内の音源を使用します。別フォルダの音源は曲ごとの「音源を選択」から関連付けてください。';return;}
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
  return runSourceImport({index:selectedSourceIndex,candidate,sourceId:refreshSourceId,session:selectedSourceIndex.nativeSession});
}
async function runSourceImport({index,candidate,sourceId,session,fromUSB=false}){
  if(importing||!library)return;
  const progress=message=>{const target=$(fromUSB?'#usb-progress':'#source-progress');if(target)target.textContent=message;$('#library-status').textContent=message;};
  if(session){nativeUSBSession=session;usbOperation='read';}
  setImporting(true);sourceController=new AbortController();$('#cancel-source-import').hidden=false;
  let lastRender=0,sourcePositions=new Map();
  try{
    if(session){
      progress('USBの最新の状態を確認しています…');
      session=await openNativeUSB({rootId:session.root.id,bridge:session.bridge,signal:sourceController.signal});
      index=session.index;
      candidate=databaseCandidates(index).find(item=>item.path===candidate.path);
      if(!candidate)throw new Error('選択したUSBのライブラリが見つかりません。USBを選び直してください。');
      nativeUSBSession=session;noteConnectedUSB(session);
    }
    sourceReader=createLibraryReader();
    const options={library,index,candidate,sources,sourceId,session:session?{...session,candidate}:undefined,reader:sourceReader,signal:sourceController.signal,
      saveTrack:(track,blob,base,{signal})=>trackQueue.run(track.id,async()=>{signal?.throwIfAborted();const current=tracks[sourcePositions.get(track.id)];if(!current)throw new Error('この曲は削除されています。');const next={...track};if(base)for(const field of ['title','artist','bpm','cue','hotcues','tempos','positionMarks','beatOffset'])if(JSON.stringify(current[field])!==JSON.stringify(base[field]))next[field]=current[field];await library.putTrack(next,blob,{signal});return next;}),
      onProgress:progress,
      onMetadata:async()=>{[tracks,playlists]=await Promise.all([library.getTracks(),library.getPlaylists()]);sourcePositions=new Map(tracks.map((track,index)=>[track.id,index]));setView('library');renderLibrary();},
      onTrack:track=>{const i=sourcePositions.get(track.id);if(i!==undefined)tracks[i]=track;else{sourcePositions.set(track.id,tracks.length);tracks.push(track);}if(performance.now()-lastRender>250){renderLibrary();lastRender=performance.now();}}};
    const result=await(session?importNativeUSB(options):cacheSourceLibrary(options));
    if((session||isDeviceLibrarySource(result.source))&&result.source?.id){activeSource=result.source.id;activePlaylist='all';libraryPage=0;$('#search').value='';}
    const message=`${result.addedTracks}曲を追加。音源${result.copied}曲を保存、${result.reused}曲はキャッシュを利用。${result.missing?`音源未接続 ${result.missing}曲。`:''}${result.metadataCached?' DBの解析結果もキャッシュから読み込みました。':''}`;
    progress(message+(result.warnings.length?`\n${result.warnings.slice(0,3).join('\n')}${result.warnings.length>3?`\nほか${result.warnings.length-3}件`:''}`:''));toast(library.persistent?'ライブラリを保存しました。次回は端末内のキャッシュから開きます。':'この画面を開いている間だけ保持します。端末の保存領域を利用できません。');
    // Request persistence only after the user explicitly imported files. Denial leaves normal caching intact.
    navigator.storage?.persist?.().catch(()=>{});
    return result;
  }catch(error){const message=sourceController.signal.aborted?'読み込みを中止しました。保存済みの曲はそのまま使えます。':error.message;progress(message);if(!sourceController.signal.aborted)report(error);}
  finally{sourceReader?.close();sourceReader=null;sourceController=null;usbOperation=null;$('#cancel-source-import').hidden=true;try{[tracks,playlists,sources]=await Promise.all([library.getTracks(),library.getPlaylists(),library.getSources()]);renderSources();renderLibrary();await storageInfo();}finally{setImporting(false);}}
}

function connectedUSBSource(){
  if(!nativeUSBSession?.root?.id)return null;
  const matching=sources.filter(source=>source.nativeUSB?.rootId===nativeUSBSession?.root.id);
  return matching.find(source=>source.id===activeSource)||matching.find(source=>source.databasePath===nativeUSBSession?.candidate?.path)||matching[0];
}
function nativeUSBSelection(){
  const selected=visibleLibraryTracks(),ids=new Set(selected.map(track=>track.id));
  // The writer needs the full membership of each relevant list when appending
  // to an existing USB. Search limits audio selection, never playlist contents.
  const related=(activePlaylist==='all'?scopedPlaylists():playlists.filter(playlist=>playlist.id===activePlaylist))
    .filter(playlist=>activePlaylist!=='all'||!$('#search').value.trim()||playlist.trackIds.some(id=>ids.has(id)))
    .map(playlist=>({...playlist,trackIds:[...playlist.trackIds]}));
  return {tracks:selected,playlists:related};
}
function renderNativeUSB(){
  if(!$('#usb-connect'))return;
  const available=nativeUSBAvailable(),online=usbSessionConnected(),source=connectedUSBSource(),count=visibleLibraryTracks().length,pending=!!nativeUSBSession?.root.pendingTransactions;
  $('#usb-device-label').textContent=nativeUSBSession?`${nativeUSBSession.root.name}${online?'':' · 未接続'}`:'USB未接続';
  $('#usb-native-note').hidden=available;
  $('#usb-connect').disabled=!available||importing||!library;
  $('#usb-read').disabled=!available||!online||importing||!library||!nativeUSBSession?.candidate||pending;
  $('#usb-save').disabled=!available||!online||importing||!library||!source||pending;
  $('#usb-save').title=source?'読み込み後に編集したHOT CUEだけを書き戻します':'このUSBのライブラリを先に読み込んでください。';
  $('#usb-export').disabled=!available||!online||importing||!library||!nativeUSBSession||!count||pending;
  $('#usb-export').textContent=`${count.toLocaleString('ja-JP')}曲を転送`;
  $('#usb-export').title='現在のコレクション・プレイリスト・検索結果の全ページが対象です。USBの既存曲は保持されます。';
  $('#usb-cancel').hidden=!usbOperation;
  $('#usb-cancel').disabled=['connect','recover'].includes(usbOperation)||!!usbController?.signal.aborted||!!sourceController?.signal.aborted;
  const recover=$('#usb-recover');if(recover){recover.hidden=!pending;recover.disabled=!available||!online||importing||!nativeUSBSession;}
  for(const dialog of ['usb-dialog','source-dialog'])for(const button of $$(`#${dialog} [data-close-dialog]`))button.disabled=dialog==='usb-dialog'?!!usbOperation:!!sourceController;
}
async function connectNativeUSB({rootId}={}){
  if(importing||!nativeUSBAvailable())return null;
  usbOperation='connect';setImporting(true);$('#usb-progress').textContent='USBのフォルダを選択してください。';
  try{
    const session=await openNativeUSB(rootId?{rootId}:{});
    if(!session){$('#usb-progress').textContent='USBの選択を中止しました。';return null;}
    session.index.nativeSession=session;nativeUSBSession=session;noteConnectedUSB(session);
    sources=await library.getSources();renderSources();
    $('#usb-progress').textContent=session.root.pendingTransactions?'中断されたUSBへの保存があります。「USBを復旧」から元の状態へ戻してから操作してください。':session.candidate?'USBを接続しました。「ライブラリを読み込む」から曲を開けます。':'USBを接続しました。曲とプレイリストを転送できます。';
    return session;
  }catch(error){$('#usb-progress').textContent=error.name==='AbortError'?'USBの選択を中止しました。':error.message;if(error.name!=='AbortError')report(error);return null;}
  finally{usbOperation=null;setImporting(false);}
}
async function readNativeUSB(){
  if(importing||!nativeUSBSession?.candidate||!usbSessionConnected())return;
  const session=nativeUSBSession;
  return runSourceImport({index:session.index,candidate:session.candidate,sourceId:connectedUSBSource()?.id,session,fromUSB:true});
}
async function recoverNativeUSB(){
  if(importing||!nativeUSBSession?.root.pendingTransactions||!nativeUSBAvailable())return;
  const session=nativeUSBSession;usbOperation='recover';setImporting(true);
  $('#usb-progress').textContent='中断されたUSBの保存を復旧しています。USBを取り外さないでください。';
  try{
    await session.bridge.recover(session.root.id);
    nativeUSBSession=await openNativeUSB({rootId:session.root.id,bridge:session.bridge});
    noteConnectedUSB(nativeUSBSession);
    sources=await library.getSources();renderSources();
    $('#usb-progress').textContent='USBを復旧しました。ライブラリを読み込み直してから編集を続けてください。';
    toast('USBを復旧しました。');
  }catch(error){$('#usb-progress').textContent=error.message;report(error);}
  finally{usbOperation=null;setImporting(false);}
}
async function writeUSB(kind){
  if(importing||!library||!nativeUSBSession||!nativeUSBAvailable()||!usbSessionConnected())return;
  usbOperation=kind;usbController=new AbortController();setImporting(true);
  const signal=usbController.signal,onProgress=message=>{$('#usb-progress').textContent=message;$('#library-status').textContent=message;};
  try{
    onProgress('保存済みの曲情報を確認しています…');
    await Promise.all(tracks.map(track=>trackQueue.run(track.id,async()=>{})));
    signal.throwIfAborted();sources=await library.getSources();
    if(kind==='save'){
      const source=connectedUSBSource();if(!source)throw new Error('このUSBのライブラリを先に読み込んでください。');
      const result=await writeNativeHotCues({library,source,tracks,signal,onProgress});
      onProgress(result.updatedFiles?`Device Library・OneLibraryを保存しました。HOT CUE更新 ${result.updatedTracks}曲。`:'両ライブラリに保存する変更はありません。');
    }else{
      const selection=nativeUSBSelection();if(!selection.tracks.length)throw new Error('書き出す曲を選んでください。');
      const result=await exportNativeUSB({library,session:nativeUSBSession,...selection,signal,onProgress});
      const completed=result.writtenFiles?`Device Library・OneLibraryを保存しました。追加 ${result.exportedTracks}曲、HOT CUE更新 ${result.updatedTracks}曲。`:'選択した曲は両ライブラリに保存済みです。';
      onProgress(completed);
      // A subsequent export must treat this drive as an existing library.
      const rootId=nativeUSBSession.root.id;nativeUSBSession=null;
      try{nativeUSBSession=await openNativeUSB({rootId});if(nativeUSBSession){nativeUSBSession.index.nativeSession=nativeUSBSession;noteConnectedUSB(nativeUSBSession);}}
      catch(error){onProgress(`${completed} 続けて操作する場合はUSBを再接続してください（${error.message}）。`);}
    }
    toast($('#usb-progress').textContent);
  }catch(error){if(error.recoveryRequired&&nativeUSBSession)nativeUSBSession.root.pendingTransactions=Math.max(1,nativeUSBSession.root.pendingTransactions||0);onProgress(error.name==='AbortError'&&!error.recoveryRequired?'USBの処理を中止しました。確定前の変更は取り消しました。':error.message);if(error.name!=='AbortError'||error.recoveryRequired)report(error);}
  finally{
    try{[tracks,playlists,sources]=await Promise.all([library.getTracks(),library.getPlaylists(),library.getSources()]);renderSources();renderLibrary();await storageInfo();}
    finally{usbController=null;usbOperation=null;setImporting(false);}
  }
}

function events(){
  setupColumnMenu();
  installFileDrop({target:document,host:window,onActive:active=>{$('#file-drop-overlay').hidden=!active;},onFiles:files=>{
    if(!files.length){toast('フォルダではなく、音源ファイルをドロップしてください。');return;}
    setView('library');const xml=files.filter(f=>/\.xml$/i.test(f.name));if(xml.length){if(xml.length!==1||files.length!==1){toast('XMLは1ファイルずつ取り込み、その後に音源を追加してください。');return;}$('#xml-dialog').showModal();importXml(xml[0]).catch(report);}else importFiles(files).catch(report);
  }});
  document.addEventListener('click',event=>{const menu=$('#library-tools');if(menu?.open&&(!event.target.closest('#library-tools')||event.target.closest('#library-tools button')))menu.open=false;const columnsMenu=$('#library-columns');if(columnsMenu?.open&&!event.target.closest('#library-columns'))columnsMenu.open=false;const target=event.target.closest('button');if(!target)return;
    if(target.dataset.action)dispatch(target.dataset.action).catch(report);
    if(target.dataset.view)setView(target.dataset.view);
    if(target.dataset.load){const value=target.dataset.load;loadDeck(value.slice(0,1),value.slice(2));}
    if(target.dataset.linkAudio){relinkTrack=target.dataset.linkAudio;$('#link-audio-file').click();}
    if(target.dataset.edit)openTrack(target.dataset.edit);
    if(target.dataset.preview)togglePreview(target.dataset.preview).catch(report);
    if(target.dataset.trackSelect)selectPreview(target.dataset.trackSelect);
    if(target.hasAttribute('data-preview-cue'))previewHotCue(Number(target.dataset.previewCue)).catch(report);
    if(target.dataset.librarySort)setLibrarySort(target.dataset.librarySort,true);
    if(target.dataset.hotcue){const [deck,index]=target.dataset.hotcue.split(':');hotCue(deck,Number(index),event.shiftKey).catch(report);}
    if(target.dataset.playlist){const source=sources.find(item=>item.id===activeSource);activePlaylist=target.dataset.playlist;if(source&&activePlaylist!=='all'&&!sourcePlaylistIds(source).has(activePlaylist))activeSource=null;libraryPage=0;renderLibrary();}
    if(target.dataset.usbDevice)selectUSBDevice(target.dataset.usbDevice).catch(report);
    if(target.hasAttribute('data-open-sources'))openSources();
    if(target.dataset.sourceView&&!sourceController)openCachedSource(target.dataset.sourceView);
    if(target.hasAttribute('data-source-all')){activeSource=null;activePlaylist='all';libraryPage=0;renderLibrary();}
    if(target.dataset.sourceRefresh&&!importing){refreshSourceId=target.dataset.sourceRefresh;openSources(false);$('#source-progress').textContent='更新する元のライブラリフォルダ、またはUSBを選び直してください。保存済みの編集内容は保持します。';}
    if(target.dataset.sourceForget&&!importing){library.removeSource(target.dataset.sourceForget).then(async()=>{sources=await library.getSources();if(activeSource===target.dataset.sourceForget)activeSource=null;renderSources();renderLibrary();}).catch(report);}
    if(target.dataset.loopSize){const [deck,size]=target.dataset.loopSize.split(':');decks[deck].loopBeats=Number(size);$$(`[data-loop-size^="${deck}:"]`).forEach(b=>b.classList.toggle('active',b===target));if(engine.getState(deck).loop){engine.clearLoop(deck);toggleLoop(deck);updateDecks();}}
    if(target.hasAttribute('data-close-dialog')){const dialog=target.closest('dialog');if((dialog.id==='usb-dialog'&&usbOperation)||(dialog.id==='source-dialog'&&sourceController))toast('処理が完了するまでお待ちください。中止する場合は「中止」を押してください。');else dialog.close();}
    if(target.dataset.removeMapping)mapping.removeMapping(target.dataset.removeMapping);
    if(target.dataset.group){mappingGroup=target.dataset.group;$$('#mapping-filters .pill').forEach(b=>b.classList.toggle('active',b===target));renderMappings();}
    if(target.dataset.learn)armMapping(target.dataset.learn,target.dataset.source).catch(report);
  });
  document.addEventListener('input',event=>{const el=event.target;if(!el.dataset.control)return;const id=el.dataset.control;const value=Number(el.value);setControl(id,id.includes('.eq.')?(value+24)/36:id.endsWith('.tempo')?value/100+.5:value);});
  $('#crossfader').addEventListener('input',e=>setControl('mixer.crossfader',Number(e.target.value)));$('#master').addEventListener('input',e=>setControl('mixer.master',Number(e.target.value)));$('#center-fader').onclick=()=>setControl('mixer.crossfader',.5);
  for(const input of $$('input[type=range]:not([hidden])'))touchSliders.push(bindTouchSlider(input));
  $('#preview-toggle').onclick=()=>togglePreview(preview.getState().trackId).catch(report);
  $('#preview-stop').onclick=()=>preview.stop();
  $('#preview-cue-erase').onclick=()=>{previewCueErase=!previewCueErase;updatePreviewCues();};
  $('#preview-seek').addEventListener('input',event=>preview.seek(Number(event.target.value)));
  const trackList=$('#track-list');
  trackList.addEventListener('click',event=>{
    if(event.target.closest('button,a,input,select,summary'))return;
    const row=event.target.closest('[data-select-track]');if(row)selectPreview(row.dataset.selectTrack);
  });
  trackList.addEventListener('keydown',event=>{
    const row=event.target.closest('[data-select-track]'),title=event.target.closest('.track-select-button');
    if(!row||(event.target!==row&&!title)||!['Enter','Space','ArrowUp','ArrowDown'].includes(event.code))return;
    // Consume selection keys before configurable DJ shortcuts. Other row actions
    // retain their own native button activation and never select another track.
    event.preventDefault();
    const rows=$$('[data-select-track]'),index=rows.indexOf(row);
    const next=rows[clamp(index+(event.code==='ArrowUp'?-1:event.code==='ArrowDown'?1:0),0,rows.length-1)];
    selectPreview(next.dataset.selectTrack);next.focus({preventScroll:true});next.scrollIntoView({block:'nearest'});
  });
  for(const [selector,kind] of [['#preview-wave','overview'],['#preview-detail-wave','detail']]){
    const canvas=$(selector);let dragRange=null,dragPointer=null;
    const seek=event=>{const state=preview.getState();if(!state.duration||state.loading)return;const rect=canvas.getBoundingClientRect();const range=dragRange||(kind==='overview'?previewWaveRange:previewDetailRange)||{start:0,end:state.duration};preview.seek(timeAtWaveformX(event.clientX-rect.left,rect.width,range));};
    canvas.addEventListener('pointerdown',event=>{if(event.button!==0||dragPointer!==null||!preview.getState().duration||preview.getState().loading)return;event.preventDefault();dragRange={...(kind==='overview'?previewWaveRange:previewDetailRange)};dragPointer=event.pointerId;canvas.setPointerCapture(event.pointerId);seek(event);});
    canvas.addEventListener('pointermove',event=>{if(event.pointerId===dragPointer&&canvas.hasPointerCapture(event.pointerId))seek(event);});
    for(const name of ['pointerup','pointercancel','lostpointercapture'])canvas.addEventListener(name,event=>{if(event.pointerId===dragPointer){dragRange=null;dragPointer=null;}});
    canvas.addEventListener('keydown',event=>{if(!['ArrowLeft','ArrowRight','Home','End'].includes(event.code)||!preview.getState().duration)return;event.preventDefault();const state=preview.getState(),step=kind==='overview'?5:previewWaveSpan/20;preview.seek(event.code==='Home'?0:event.code==='End'?state.duration:state.position+(event.code==='ArrowLeft'?-step:step));});
  }
  $('#preview-zoom-in').onclick=()=>{previewWaveSpan=clamp(previewWaveSpan/2,2,32);drawPreviewWave();};
  $('#preview-zoom-out').onclick=()=>{previewWaveSpan=clamp(previewWaveSpan*2,2,32);drawPreviewWave();};
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
  $('#show-help').onclick=()=>$('#help-dialog').showModal();$('#usb-info').onclick=()=>{renderNativeUSB();$('#usb-dialog').showModal();};
  $('#usb-connect').onclick=()=>connectNativeUSB().catch(report);
  $('#usb-add').onclick=()=>addUSBDevice().catch(report);
  $('#usb-read').onclick=()=>readNativeUSB().catch(report);
  $('#usb-save').onclick=()=>writeUSB('save').catch(report);
  $('#usb-export').onclick=()=>writeUSB('export').catch(report);
  $('#usb-recover')?.addEventListener('click',()=>recoverNativeUSB().catch(report));
  $('#usb-cancel').onclick=()=>{if(usbOperation==='read'){sourceController?.abort();sourceReader?.close();}else usbController?.abort();renderNativeUSB();};
  for(const id of ['usb-dialog','source-dialog'])$(`#${id}`).addEventListener('cancel',event=>{if(id==='usb-dialog'?!!usbOperation:!!sourceController)event.preventDefault();});
  $('#search').addEventListener('input',()=>{libraryPage=0;renderLibrary();});$('#sort').addEventListener('change',event=>setLibrarySort(event.target.value));
  $('#library-column-options').addEventListener('change',event=>{const id=event.target.dataset.libraryColumnToggle;if(!id)return;const selected=new Set(visibleColumns);if(event.target.checked)selected.add(id);else selected.delete(id);visibleColumns=normalizeLibraryColumns([...selected]);saveColumnSelection();});
  $('#reset-library-columns').onclick=()=>{visibleColumns=normalizeLibraryColumns(null);saveColumnSelection();};
  $('#new-playlist').onclick=async()=>{
    if(!library||importing){toast('ライブラリの読み込み完了後に作成してください。');return;}
    const name=await askPlaylistName();if(!name||importing)return;
    const playlist={id:uid(),name:name.slice(0,80),trackIds:[]};
    try{playlists=await library.createPlaylist(playlist);activePlaylist=playlist.id;activeSource=null;libraryPage=0;renderLibrary();toast('プレイリストを作成しました。');}catch(error){report(error);}
  };
  $('#track-form').onsubmit=async event=>{
    event.preventDefault();if(importing){toast('読み込み完了後に保存してください。');return;}const id=editingTrack;const form=event.target;
    const fields={title:form.elements.title.value.trim(),artist:form.elements.artist.value.trim(),bpm:form.elements.bpm.value?Number(form.elements.bpm.value):null};
    const playlistId=form.elements.playlist.value;
    if(!fields.title)return;
    if(fields.bpm!==null&&(!Number.isFinite(fields.bpm)||fields.bpm<30||fields.bpm>300)){toast('BPMは30〜300で指定してください。');return;}
    try{
      await trackQueue.run(id,async()=>{
        if(importing)throw new Error('ライブラリの処理が完了してから保存してください。');
        const result=await library.updateTrackDetails(id,fields,playlistId||null);
        tracks=tracks.map(track=>track.id===id?result.track:track);playlists=result.playlists;
      });
      $('#track-dialog').close();toast('曲情報を保存しました。');
    }catch(error){report(error);}finally{renderLibrary();updateDecks();}
  };
  for(const [id,multiplier]of[['half-bpm',.5],['double-bpm',2]])$(`#${id}`).onclick=()=>{const input=$('#track-form').elements.bpm;const value=Number(input.value)*multiplier;if(value>=30&&value<=300)input.value=value.toFixed(2);};
  $('#delete-track').onclick=async()=>{
    if(importing){toast('読み込み完了後に削除してください。');return;}
    const track=tracks.find(t=>t.id===editingTrack);if(!track||!await askConfirm(`「${track.title}」をDECKFLOWから削除しますか？元の音源ファイルは削除しません。`)||importing)return;
    try{
      await trackQueue.run(track.id,async()=>{
        if(importing)throw new Error('ライブラリの処理が完了してから削除してください。');
        for(const id of ['a','b'])if(decks[id].pendingTrackId===track.id){decks[id].loadNonce++;decks[id].pendingTrackId=null;}
        if(preview.getState().trackId===track.id)preview.clear();
        bufferCache.delete(track.id);invalidateWaveform(track.id);await library.removeTrack(track.id);
        for(const id of ['a','b'])if(decks[id].trackId===track.id){platterGestures.get(id)?.cancel();engine.unload(id);decks[id].trackId=null;decks[id].loadNonce++;}
        tracks=tracks.filter(t=>t.id!==track.id);[playlists,sources]=await Promise.all([library.getPlaylists(),library.getSources()]);
      });
      $('#track-dialog').close();renderSources();renderLibrary();updateDecks();await storageInfo();
    }catch(error){updateDecks();report(error);}
  };
  $('#export-library').onclick=()=>{if(!tracks.length){toast('先に曲を追加してください。');return;}const snapshot={format:'deckflow.library',version:1,exportedAt:new Date().toISOString(),tracks,playlists};download('deckflow-library.json',JSON.stringify(snapshot,null,2));toast('BPM・CUE・プレイリストをJSONに保存しました。音源は含まれません。');};
  for(const id of ['connect-midi','deck-connect-midi'])$(`#${id}`).onclick=()=>mapping.enableMIDI().catch(report);
  for(const id of ['cancel-learn','deck-cancel-learn'])$(`#${id}`).onclick=cancelMappingLearn;
  $('#mapping-advanced').addEventListener('toggle',renderMappings);
  for(const id of ['midi-mode','deck-midi-mode'])$(`#${id}`).addEventListener('change',event=>{const value=event.target.value;$('#midi-mode').value=value;$('#deck-midi-mode').value=value;if(mapping.learning?.source==='midi'||mappingArming)armMapping(mapping.learning?.actionId||mappingArming).catch(report);});
  installDeckMidiLearn({root:$('#play-view'),isActive:()=>view==='mapping',onSelect:id=>armMapping(id).catch(report),onUnsupported:()=>{setText($('#deck-learn-text'),'再生・CUE・SYNC・EQ・音量・テンポなど、枠で示した操作を選択してください。');}});
  $('#deck-export-profile').onclick=()=>$('#export-profile').click();$('#deck-import-profile').onclick=()=>$('#import-profile').click();
  $('#profile-name').addEventListener('change',e=>{try{const profile=mapping.profile;profile.name=e.target.value.trim()||'DECKFLOW マイコントローラー';mapping.importProfile(JSON.stringify(profile));}catch(error){report(error);}});
  $('#export-profile').onclick=()=>download('deckflow-mappings.json',mapping.exportProfile());$('#import-profile').onclick=()=>$('#profile-file').click();
  $('#profile-file').addEventListener('change',async e=>{const file=e.target.files[0];if(!file)return;try{if(file.size>1024*1024)throw new Error('設定ファイルが大きすぎます。');mapping.importProfile(await file.text());toast('割り当て設定を読み込みました。');}catch(error){report(error);}e.target.value='';});
  $('#reset-profile').onclick=async()=>{if(await askConfirm('MIDI・キーの割り当てを初期状態へ戻しますか？'))mapping.reset();};
  document.addEventListener('keydown',e=>{if(e.code==='Escape'&&$('#library-columns')?.open){$('#library-columns').open=false;$('#library-columns summary').focus();return;}if(e.code==='Escape'&&$('#library-tools')?.open){$('#library-tools').open=false;$('#library-tools summary').focus();return;}if(e.code==='Escape'&&(mapping.learning||mappingArming)){cancelMappingLearn();return;}mapping.handleKeyDown(e);});document.addEventListener('keyup',e=>mapping.handleKeyUp(e));
  window.addEventListener('resize',()=>{updateDecks();drawLibraryWaves();drawPreviewWave();});
  document.addEventListener('visibilitychange',()=>{if(document.hidden)usbDeviceMonitor?.stop();else startUSBDeviceMonitor();});
  window.addEventListener('pageshow',event=>{pageActive=true;startUSBDeviceMonitor();if(event.persisted){waveformCache=new WaveformCache();for(const id of ['a','b']){const buffer=engine.decks[id]?.buffer;if(buffer&&decks[id].trackId)prepareWaveform(decks[id].trackId,buffer);}}});
  window.addEventListener('pagehide',()=>{pageActive=false;usbDeviceMonitor?.stop();for(const slider of touchSliders)slider.cancel();for(const gesture of platterGestures.values())gesture.cancel();for(const id of ['a','b']){decks[id].loadNonce++;decks[id].pendingTrackId=null;}waveformCache.dispose();waveformJobs.clear();sourceController?.abort();sourceReader?.close();usbController?.abort();bufferCache.clear();preview.clear();for(const id of ['a','b'])engine.pause(id);});
}

async function start(){
  renderDecks();events();setView('library');renderMappings();renderMIDIStatus();installMotion(document);
  for(const id of ['a','b']){mapping.setActionValue(`${id}.tempo`,.5);mapping.setActionValue(`${id}.volume`,.85);for(const band of ['low','mid','high'])mapping.setActionValue(`${id}.eq.${band}`,24/36);}
  mapping.setActionValue('mixer.crossfader',.5);mapping.setActionValue('mixer.master',.8);
  library=await openLibrary();[tracks,playlists,sources]=await Promise.all([library.getTracks(),library.getPlaylists(),library.getSources()]);renderSources();renderLibrary();updateDecks();startUSBDeviceMonitor();await storageInfo();if(library.warning)toast(library.warning);
  if(window.DECKFLOW_NATIVE){$('.mapping-note').textContent='CoreMIDI対応。連続操作はMIDI、ボタン操作はMIDI・キーに対応。';}
  if('serviceWorker'in navigator&&!window.DECKFLOW_NATIVE)navigator.serviceWorker.register('./sw.js').catch(error=>console.warn('Offline cache unavailable',error));
  requestAnimationFrame(animate);
}
start().catch(error=>{report(error);$('#library-status').textContent='起動できませんでした。ページを再読み込みしてください。';});
