import test from 'node:test';
import assert from 'node:assert/strict';
import {drawWaveform,getWaveformWindow,waveformBeats,WAVEFORM_COLORS} from '../dist/waveform-view.js';
import {instrumentedCanvas,measuredWaveform} from './helpers/waveform-canvas-fixture.mjs';

test('120 moving overview positions restore thin playhead strips without repainting bands or scanning samples',()=>{
  const f=instrumentedCanvas(),reads={count:0},wave=measuredWaveform(27000,180,{reads});
  const options={waveform:wave,overview:true,markers:[{time:60,label:'A'}],loop:{start:30,end:40}};
  drawWaveform(f.canvas,{...options,position:0});
  const rasterRects=f.stats.rasterRects,sourceReads=reads.count,copied=f.stats.copiedPixels;
  for(let frame=1;frame<=120;frame++)drawWaveform(f.canvas,{...options,position:frame/6});
  assert.equal(reads.count,sourceReads);assert.equal(f.stats.rasterRects,rasterRects);
  assert.ok(f.stats.screenRects<=121,'only the playhead is repainted on the screen');
  assert.ok(f.stats.copiedPixels-copied<=120*5*f.canvas.height,'restore area is bounded by the previous playhead width');
  const copies=f.canvas.calls.filter(call=>call.type==='image');
  assert.equal(copies[0].args[2],f.canvas.width);assert.ok(copies.slice(1).every(call=>call.args[2]<=5));
  const before=f.stats.screenRects;drawWaveform(f.canvas,{...options,position:null});assert.equal(f.stats.screenRects,before);
  assert.ok(f.canvas.calls.at(-1).type==='image','hiding the playhead restores the old strip');
});

test('detail playback and reverse motion reuse the audio tile while grid and cue coordinates remain exact',()=>{
  const f=instrumentedCanvas(),reads={count:0},wave=measuredWaveform(27000,180,{reads});
  const paint=position=>{
    const range=getWaveformWindow(180,position,8);
    drawWaveform(f.canvas,{waveform:wave,position,...range,markers:[{time:52,label:'A'}],beats:waveformBeats({bpm:120},range.start,range.end,{labels:true})});
    return range;
  };
  paint(50);const sourceReads=reads.count,rasterRects=f.stats.rasterRects;
  for(let frame=1;frame<=90;frame++)paint(50+frame/60);
  for(let frame=89;frame>=0;frame--)paint(50+frame/60);
  assert.equal(reads.count,sourceReads);assert.equal(f.stats.rasterRects,rasterRects);
  assert.ok(f.stats.screenRects<180*40,'screen painting consists of grid, cue and playhead only');
  const range=paint(50.75),marker=f.canvas.calls.filter(call=>call.type==='rect'&&call.color===WAVEFORM_COLORS.marker).at(-1);
  assert.equal(marker.x,Math.round((52-range.start)/8*f.canvas.width));
  assert.ok(f.canvas.calls.filter(call=>call.type==='image').every(call=>call.smoothing===false));
});

test('tile boundaries, seeking, zoom, resized canvas, revision and replaced bands invalidate correctly',()=>{
  const f=instrumentedCanvas(),reads={count:0},wave=measuredWaveform(27000,180,{reads});
  const paint=(position,span=8,revision=0,waveform=wave)=>drawWaveform(f.canvas,{waveform,position,...getWaveformWindow(180,position,span),revision});
  paint(50);let before=reads.count;paint(60);assert.ok(reads.count>before);
  before=reads.count;paint(100);assert.ok(reads.count>before);
  before=reads.count;paint(100,4);assert.ok(reads.count>before);
  before=reads.count;paint(100,4,1);assert.ok(reads.count>before);
  before=reads.count;paint(100,4,1,{...wave,low:new Uint8Array(27000).fill(255)});assert.ok(reads.count>before);
  f.rect.width=500;paint(100,4,1);assert.equal(f.canvas.width,1000);
  const copies=f.stats.imageCopies;f.canvas.width=20;paint(100,4,1);assert.equal(f.canvas.width,1000);assert.ok(f.stats.imageCopies>copies);
});

test('cached raster aggregation keeps a one-frame transient at full amplitude and permits fractional scroll without smoothing',()=>{
  const f=instrumentedCanvas(100,100,1),wave=measuredWaveform(100000,100);
  for(const name of ['min','max','low','mid','high'])wave[name].fill(0);
  wave.min[49999]=wave.max[49999]=wave.low[49999]=255;
  drawWaveform(f.canvas,{waveform:wave,start:46,end:54,position:50});
  const low=f.surfaces[0].calls.filter(call=>call.type==='rect'&&call.color===WAVEFORM_COLORS.low);
  assert.ok(low.some(call=>Math.abs(call.height-86)<1e-6));
  const before=f.stats.rasterRects;
  drawWaveform(f.canvas,{waveform:wave,start:46.03,end:54.03,position:50.03});
  assert.equal(f.stats.rasterRects,before);
  const image=f.canvas.calls.filter(call=>call.type==='image').at(-1);
  assert.notEqual(image.args[0],Math.round(image.args[0]));assert.equal(image.smoothing,false);
});

test('overview static overlay changes rebuild once and switching modes cannot reuse an overview as an audio tile',()=>{
  const f=instrumentedCanvas(100,100,1),wave=measuredWaveform(100,1);
  drawWaveform(f.canvas,{waveform:wave,overview:false,position:.5});
  drawWaveform(f.canvas,{waveform:wave,overview:true,position:.5,markers:[{time:.4,label:'A'}]});
  let before=f.stats.rasterRects;
  drawWaveform(f.canvas,{waveform:wave,overview:true,position:.6,markers:[{time:.5,label:'A'}]});
  assert.ok(f.stats.rasterRects>before);before=f.stats.rasterRects;
  drawWaveform(f.canvas,{waveform:wave,overview:false,position:.6});assert.ok(f.stats.rasterRects>before);
});

test('raster storage is bounded and an evicted canvas repaints when its position changes',()=>{
  const fixtures=[],wave=measuredWaveform(100,100);
  for(let i=0;i<80;i++) {
    const f=instrumentedCanvas(1000,200,2);fixtures.push(f);drawWaveform(f.canvas,{waveform:wave,overview:true,position:0});
  }
  const live=fixtures.flatMap(f=>f.surfaces).filter(canvas=>canvas.width>1&&canvas.height>1);
  assert.ok(live.length<=64);assert.ok(live.reduce((sum,canvas)=>sum+canvas.width*canvas.height,0)<=8*1024*1024);
  const first=fixtures[0],before=first.stats.rasterRects;
  assert.ok(first.surfaces[0].width===1,'old backing store was released');
  drawWaveform(first.canvas,{waveform:wave,overview:true,position:10});assert.ok(first.stats.rasterRects>before);
});

test('a browser with OffscreenCanvas but without its 2D context uses a detached HTML canvas',()=>{
  const previous=globalThis.OffscreenCanvas;
  let attempts=0;
  globalThis.OffscreenCanvas=class {constructor(){attempts++;}getContext(){return null;}};
  try {
    const f=instrumentedCanvas(100,40,1),wave=measuredWaveform(100,10);
    drawWaveform(f.canvas,{waveform:wave,overview:true,position:0});
    assert.equal(f.surfaces.length,1);assert.equal(f.stats.imageCopies,1);
    f.rect.width=120;drawWaveform(f.canvas,{waveform:wave,overview:true,position:1});
    assert.equal(attempts,1,'unsupported Offscreen 2D is not allocated every frame');
    assert.equal(f.stats.imageCopies,2);
  }finally{if(previous===undefined)delete globalThis.OffscreenCanvas;else globalThis.OffscreenCanvas=previous;}
});
