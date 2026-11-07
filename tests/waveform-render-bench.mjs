/** Usage: node tests/waveform-render-bench.mjs [--baseline=/absolute/old-module.mjs]
 * Executes the actual renderer over two decks at 60 Hz for ten seconds.
 * Counts paint calls/areas and detached-surface memory. CPU time is the JS
 * renderer with instrumented Canvas2D, not GPU time or iPad end-to-end latency.
 */
import {performance} from 'node:perf_hooks';
import {pathToFileURL} from 'node:url';
import * as current from '../dist/waveform-view.js';
import {instrumentedCanvas,measuredWaveform} from './helpers/waveform-canvas-fixture.mjs';

function measure(renderer) {
  const wave=measuredWaveform(),decks=Array.from({length:2},()=>({detail:instrumentedCanvas(900,120,2),overview:instrumentedCanvas(900,35,2)}));
  const begin=performance.now();let rendered=0;
  for(let frame=0;frame<600;frame++)for(const [id,deck] of decks.entries()) {
    const position=50+id*20+frame/60,range=renderer.getWaveformWindow(180,position,8);
    rendered+=renderer.drawWaveform(deck.detail.canvas,{waveform:wave,position,...range,
      beats:renderer.waveformBeats({bpm:120},range.start,range.end,{labels:true}),markers:[{time:52+id*20,label:'A'}]})?1:0;
    rendered+=renderer.drawWaveform(deck.overview.canvas,{waveform:wave,position,overview:true})?1:0;
  }
  const elapsed=performance.now()-begin,fixtures=decks.flatMap(deck=>[deck.detail,deck.overview]);
  const sum=key=>fixtures.reduce((total,f)=>total+f.stats[key],0);
  return {requestedFrames:2400,renderedFrames:rendered,rendererCpuMs:Math.round(elapsed*10)/10,
    screenFillRects:sum('screenRects'),rasterFillRects:sum('rasterRects'),totalFillRects:sum('screenRects')+sum('rasterRects'),
    imageCopies:sum('imageCopies'),copiedPixels:sum('copiedPixels'),
    retainedRasterBytes:fixtures.flatMap(f=>f.surfaces).filter(c=>c.width>1&&c.height>1).reduce((total,c)=>total+c.width*c.height*4,0)};
}
const baselineArgument=process.argv.find(value=>value.startsWith('--baseline='));
const baseline=baselineArgument?measure(await import(pathToFileURL(baselineArgument.slice(11)).href)):null;
const result=measure(current);
console.log(JSON.stringify({baseline,current:result,...(baseline?{fillRectReductionPercent:Math.round((1-result.totalFillRects/baseline.totalFillRects)*10000)/100}:{})},null,2));
