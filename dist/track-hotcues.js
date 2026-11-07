/** Edit a single HOT CUE without changing imported memory cues, loops or grids. */
export function editTrackHotCue(track,index,position,{clear=false,now=Date.now()}={}) {
  if(!track||!Number.isInteger(index)||index<0||index>7)throw new TypeError('HOT CUE A〜Hを選択してください。');
  if(!clear&&(!Number.isFinite(position)||position<0||!Number.isFinite(track.duration)||track.duration<=0||position>track.duration))throw new RangeError('曲の範囲内にCUEを設定してください。');
  const original=track.positionMarks?.find(mark=>mark.num===index);
  const previous=track.hotcues?.[index]??null;
  if(clear?previous===null&&!original:previous===position&&(!original||original.type===0&&original.start===position))return track;
  if(!Number.isSafeInteger(now)||now<0)throw new TypeError('更新日時を確認してください。');
  const hotcues=Array.from({length:8},(_,i)=>track.hotcues?.[i]??null);
  hotcues[index]=clear?null:position;
  const updated={...track,hotcues,updatedAt:now};
  // Leave unimported tracks' marks absent: their export adapter synthesizes
  // both the main cue and all eight hot cues from the legacy fields.
  if(track.positionMarks!==undefined){
    updated.positionMarks=track.positionMarks.filter(mark=>mark.num!==index);
    if(!clear)updated.positionMarks.push({name:original?.name||`HOT CUE ${String.fromCharCode(65+index)}`,type:0,start:position,end:null,num:index,color:original?.color??null});
  }
  return updated;
}
