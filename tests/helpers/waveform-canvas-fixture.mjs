/** Instrumented Canvas2D surface: records actual renderer calls and areas.
 * No GPU timing is inferred from these deterministic CPU/paint-work counts. */
export function instrumentedCanvas(width=900,height=120,dpr=2) {
  const stats={screenRects:0,rasterRects:0,screenArea:0,rasterArea:0,imageCopies:0,copiedPixels:0,texts:0};
  const surfaces=[];
  const surface=screen=>{
    const calls=[],canvas={width:0,height:0,calls};
    const context={fillStyle:'',font:'',textBaseline:'',imageSmoothingEnabled:true,
      setTransform(){},clearRect(){},measureText(text){return {width:text.length*6};},
      fillText(text,x,y){stats.texts++;if(calls.length<20000)calls.push({type:'text',text,x,y,color:this.fillStyle});},
      fillRect(x,y,w,h){
        const key=screen?'screen':'raster';stats[key+'Rects']++;stats[key+'Area']+=Math.max(0,w)*Math.max(0,h);
        if(calls.length<20000)calls.push({type:'rect',x,y,width:w,height:h,color:this.fillStyle});
      },
      drawImage(source,...args){
        stats.imageCopies++;stats.copiedPixels+=args.length===8?args[6]*args[7]:source.width*source.height;
        if(calls.length<20000)calls.push({type:'image',source,args,smoothing:this.imageSmoothingEnabled});
      }};
    canvas.getContext=()=>context;canvas.context=context;
    if(!screen)surfaces.push(canvas);
    return canvas;
  };
  const canvas=surface(true),rect={width,height};
  canvas.ownerDocument={defaultView:{devicePixelRatio:dpr},createElement:()=>surface(false)};
  canvas.getBoundingClientRect=()=>rect;
  return {canvas,rect,stats,surfaces};
}

export function measuredWaveform(count=27000,duration=180,{reads}={}) {
  const wave={duration,frameCount:count};
  for(const [band,offset] of ['min','max','low','mid','high'].map((name,index)=>[name,index])) {
    const data=Uint8Array.from({length:count},(_,i)=>40+(i*13+offset*31)%216);
    wave[band]=reads?new Proxy(data,{get(target,key){if(/^\d+$/.test(String(key)))reads.count++;return Reflect.get(target,key,target);}}):data;
  }
  return wave;
}
