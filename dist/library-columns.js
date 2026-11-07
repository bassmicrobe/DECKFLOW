import {metadataDate,trackFileType} from './track-metadata.js?v=b48f446ea6c7f1bb';
export const LIBRARY_COLUMNS = Object.freeze([
  {id:'number',label:'#',width:45,sort:'added',required:true},
  {id:'title',label:'曲名',width:235,sort:'title',required:true},
  {id:'artist',label:'アーティスト',width:155,sort:'artist',default:true},
  {id:'album',label:'アルバム',width:165,sort:'album',default:true},
  {id:'genre',label:'ジャンル',width:105,sort:'genre',default:true},
  {id:'bpm',label:'BPM',width:72,sort:'bpm',default:true},
  {id:'key',label:'キー',width:65,sort:'key',default:true},
  {id:'duration',label:'時間',width:70,sort:'duration',default:true},
  {id:'rating',label:'評価',width:90,sort:'rating',default:true},
  {id:'dateAdded',label:'追加日',width:145,sort:'dateAdded',default:true},
  {id:'dateModified',label:'最終変更日',width:145,sort:'dateModified',default:true},
  {id:'waveform',label:'波形',width:125,default:true},
  {id:'fileType',label:'形式',width:88,sort:'fileType'},
  {id:'bitRate',label:'ビットレート',width:105,sort:'bitRate'},
  {id:'sampleRate',label:'サンプルレート',width:115,sort:'sampleRate'},
  {id:'comments',label:'コメント',width:200,sort:'comments'},
  {id:'fileName',label:'ファイル名',width:220,sort:'fileName'},
  {id:'decks',label:'デッキへ',width:100,required:true},
  {id:'actions',label:'曲の操作',width:56,required:true},
]);

export function normalizeLibraryColumns(value) {
  const selected=Array.isArray(value)?new Set(value):null;
  return LIBRARY_COLUMNS.filter(column=>column.required||(selected?selected.has(column.id):column.default)).map(column=>column.id);
}

const dateFormatter=new Intl.DateTimeFormat('ja-JP',{year:'numeric',month:'2-digit',day:'2-digit',hour:'2-digit',minute:'2-digit',hour12:false});
const stamp=value=>{const normalized=metadataDate(value);return normalized?Date.parse(normalized):null;};
export function libraryTrackDate(track,field){
  if(field==='dateAdded')return stamp(track.dateAdded)!==null?track.dateAdded:(stamp(track.addedAt)!==null?track.addedAt:null);
  const original=stamp(track.dateModified),edited=stamp(track.updatedAt);
  return edited!==null&&(original===null||edited>original)?track.updatedAt:original!==null?track.dateModified:null;
}
export function formatLibraryDate(value){
  if(stamp(value)===null)return '';
  if(typeof value==='string'&&/^\d{4}-\d{2}-\d{2}$/.test(value))return value.replaceAll('-','/');
  return dateFormatter.format(new Date(value));
}
export function libraryColumnText(track,id){
  const value=track[id];
  if(id==='dateAdded'||id==='dateModified')return formatLibraryDate(libraryTrackDate(track,id));
  if(id==='fileType')return trackFileType(track);
  if(id==='fileName')return String(track.fileName||track.filename||'');
  if(id==='duration'){const seconds=Math.max(0,Math.floor(Number(value)||0));return `${Math.floor(seconds/60)}:${String(seconds%60).padStart(2,'0')}`;}
  if(id==='bpm')return Number.isFinite(value)&&value>0?value.toFixed(2):'—';
  if(id==='rating'){if(!Number.isFinite(value))return '';const stars=Math.max(0,Math.min(5,Math.round(value)));return '★'.repeat(stars)+'☆'.repeat(5-stars);}
  if(id==='bitRate')return Number.isFinite(value)&&value>0?`${value.toLocaleString('ja-JP')} kbps`:'';
  if(id==='sampleRate')return Number.isFinite(value)&&value>0?`${(value/1000).toLocaleString('ja-JP',{maximumFractionDigits:3})} kHz`:'';
  return value==null?'':String(value);
}
