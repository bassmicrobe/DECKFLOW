// Optional real-browser integration: run with a local dev server and Playwright.
// DECKFLOW_PLAYWRIGHT_MODULE can point to an external Playwright installation.
import assert from 'node:assert/strict';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {writeLargeWav} from './helpers/large-wav-file.mjs';

const {chromium} = await import(process.env.DECKFLOW_PLAYWRIGHT_MODULE || 'playwright');
const origin = process.env.DECKFLOW_BROWSER_URL || 'http://127.0.0.1:4187';
assert.ok(['localhost','127.0.0.1'].includes(new URL(origin).hostname), 'Test only an isolated localhost origin');
const temporary = await mkdtemp(join(tmpdir(),'deckflow-large-browser-'));
let browser;
try {
  const path = join(temporary,'DECKFLOW - Long synthetic 120.wav');
  const fixture = await writeLargeWav(path);
  browser = await chromium.launch({channel:'chrome',headless:true,args:['--autoplay-policy=no-user-gesture-required','--mute-audio']});
  const context = await browser.newContext();
  const page = await context.newPage(), errors = [];
  page.on('pageerror',error=>errors.push(error.message));
  page.on('console',message=>{if(['error','warning'].includes(message.type()))console.error('Browser:',message.text());else if(message.text().startsWith('Direct transport:'))console.log(message.text());});
  await page.addInitScript(() => {
    window.decodeSizes = [];
    const original = BaseAudioContext.prototype.decodeAudioData;
    BaseAudioContext.prototype.decodeAudioData = function(bytes,...rest) {
      window.decodeSizes.push(bytes.byteLength); return original.call(this,bytes,...rest);
    };
  });
  await page.goto(origin);
  await page.waitForFunction(()=>document.querySelector('#storage-status')?.textContent.includes('端末内'));
  const started = performance.now();
  await page.locator('#audio-files').setInputFiles(path);
  await page.waitForFunction(()=>document.querySelector('#library-status')?.textContent.includes('1曲を追加'),null,{timeout:180000});
  const importMs = performance.now() - started;
  console.log('Imported 1 GiB audio', {importMs});
  const saved = await page.evaluate(async()=>{
    const {openLibrary}=await import('/library-store.js');const library=await openLibrary();
    const [track]=await library.getTracks();const blob=await library.getAudio(track.id);
    return {track,bytes:blob.size,decodeSizes:window.decodeSizes};
  });
  assert.equal(saved.bytes,fixture.bytes);assert.ok(Math.abs(saved.track.duration-fixture.duration)<.001);
  assert.ok(saved.track.duration>1200);assert.ok(saved.track.bpm>118&&saved.track.bpm<122);
  assert.ok(saved.track.peaks.some(value=>value>0));assert.deepEqual(saved.decodeSizes,[]);
  // Persisted audio must survive loss of the originally selected file.
  await rm(path);
  console.log('Removed original file; checking persisted playback');
  await page.reload();
  await page.locator('[data-preview]').waitFor();
  await page.locator('[data-preview]').click();
  try {
    await page.waitForFunction(()=>document.querySelector('#preview-status')?.textContent==='試聴中');
    await page.waitForFunction(()=>Number(document.querySelector('#preview-time')?.textContent.split(' / ')[0].split(':').reduce((n,part)=>n*60+Number(part),0))>=1);
  } catch(error) {
    console.error(await page.evaluate(async()=>{
      const {openLibrary}=await import('/library-store.js');const library=await openLibrary(),[track]=await library.getTracks();
      const blob=await library.getAudio(track.id);
      let header;
      try{header=Array.from(new Uint8Array(await blob.slice(0,44).arrayBuffer()));}catch(failure){header=failure.message;}
      return {preview:document.querySelector('#preview-status')?.textContent,time:document.querySelector('#preview-time')?.textContent,
        toast:document.querySelector('#toast')?.textContent,header};
    }));
    throw error;
  }
  await page.locator('#preview-stop').click();
  console.log('Persisted preview played after reload');
  await page.locator('[data-load^="a:"]').click();
  await page.waitForFunction(()=>document.querySelector('#a-title')?.textContent==='Long synthetic 120');
  await page.locator('[data-view="play"]').click();
  await page.locator('#a-play').click();
  console.log('Deck playing; waiting for full detail waveform');
  const readWaveform=()=>page.evaluate(async()=>{
    if(!(await indexedDB.databases()).some(item=>item.name==='deckflow-waveform-cache'))return false;
    return new Promise((resolve,reject)=>{
      const opening=indexedDB.open('deckflow-waveform-cache');
      opening.onerror=()=>reject(opening.error);
      opening.onsuccess=()=>{
        const database=opening.result;
        try {
          if(!database.objectStoreNames.contains('data')){database.close();resolve(false);return;}
          const transaction=database.transaction('data'),request=transaction.objectStore('data').getAll();
          request.onsuccess=()=>{
            try {
              const wave=request.result[0];
              resolve(wave ? {sourceLength:wave.sourceLength,frameCount:wave.frameCount,duration:wave.duration} : false);
            } catch(error){reject(error);}
          };
          request.onerror=()=>reject(request.error);
          transaction.oncomplete=()=>database.close();
          transaction.onabort=()=>{database.close();reject(transaction.error);};
        } catch(error){database.close();reject(error);}
      };
    });
  });
  // Poll the resolved value: waitForFunction treats an async predicate's
  // Promise as truthy before its IndexedDB result becomes available.
  const waveformDeadline=performance.now()+30000;
  let waveform;
  do {
    waveform=await readWaveform();
    if(!waveform)await new Promise(resolve=>setTimeout(resolve,250));
  } while(!waveform&&performance.now()<waveformDeadline);
  assert.ok(waveform,'Full detail waveform should be persisted within 30 seconds');
  assert.equal(waveform.sourceLength,(fixture.bytes-44)/4);assert.equal(waveform.frameCount,300000);
  console.log('Full detail waveform persisted', waveform);
  await page.waitForFunction(()=>Number(document.querySelector('#a-time')?.textContent.split(':').reduce((n,part)=>n*60+Number(part),0))>=1);
  await page.locator('#a-play').click();
  // Use the persisted Blob and actual audio-thread output to verify long seeks,
  // loops and scratch without reading the entire file or trusting UI time alone.
  console.log('Checking transport output and controls');
  const transport = await page.evaluate(async()=>{
    const {openLibrary}=await import('/library-store.js');const {AudioEngine}=await import('/audio-engine.js');
    const library=await openLibrary(),[track]=await library.getTracks(),blob=await library.getAudio(track.id);
    const engine=new AudioEngine(),statuses=[];engine.onStatus=status=>statuses.push(status);
    const wait=ms=>new Promise(resolve=>setTimeout(resolve,ms));
    try {
      console.log('Direct transport: getting resource');
      const resource=await engine.decodeFile(blob);engine.load('a',resource);
      // The fixture has opposite-phase stereo. Inspect one channel: the
      // engine's mono level meter would legitimately cancel the two channels.
      const splitter=engine.context.createChannelSplitter(2),analyser=engine.context.createAnalyser();
      const silent=engine.context.createGain();silent.gain.value=0;
      engine.decks.a.nodes.low.connect(splitter);splitter.connect(analyser,0);
      analyser.connect(silent).connect(engine.context.destination);
      const at=Math.floor(resource.duration*.46)+2;engine.seek('a',at);
      await engine.play('a');await wait(1000);
      console.log('Direct transport: playing');
      const samples=new Float32Array(256),peaks=[];
      for(let i=0;i<12;i++){analyser.getFloatTimeDomainData(samples);peaks.push(Math.max(...samples.map(Math.abs)));await wait(50);}
      const peak=Math.max(...peaks);
      engine.setLoop('a',at,at+1);await wait(1600);const loop=engine.getState('a');
      engine.clearLoop('a');engine.setRate('a',1.1);await wait(300);
      const rate=engine.getState('a').rate;
      await engine.beginScratch('a');engine.scratchTo('a',at+.25,performance.now());await wait(200);
      console.log('Direct transport: scratch started');
      await engine.endScratch('a');await wait(300);const scratch=engine.getState('a');
      const tail=Math.floor(resource.duration)-40;
      engine.load('b',resource);engine.seek('b',tail);await engine.play('b');await wait(700);
      const dual={a:engine.getState('a'),b:engine.getState('b')};
      engine.pause('b');engine.unload('b');
      engine.pause('a');engine.unload('a');
      return {kind:resource.kind,peak,at,loop,rate,scratch,dual,tail,empty:engine.getState('a'),statuses};
    } finally {engine.dispose();}
  });
  console.log(JSON.stringify({fixture,importMs,savedBpm:saved.track.bpm,transport}));
  assert.equal(transport.kind,'pcm-file');assert.ok(transport.peak>.001,'Audio thread should output samples after long seek');
  assert.ok(transport.loop.position>=transport.at&&transport.loop.position<transport.at+1);
  assert.equal(transport.rate,1.1);assert.equal(transport.scratch.scratching,false);
  assert.ok(transport.dual.a.playing&&transport.dual.b.playing);
  assert.ok(transport.dual.b.position>transport.tail+.1);
  assert.equal(transport.dual.a.buffering,false);assert.equal(transport.dual.b.buffering,false);
  assert.equal(transport.empty.loaded,false);assert.equal(transport.empty.duration,0);
  await page.evaluate(()=>navigator.serviceWorker.ready);
  console.log('Checking cached offline reload');
  await context.setOffline(true);
  await page.reload();
  await page.locator('[data-preview]').click();
  await page.waitForFunction(()=>document.querySelector('#preview-status')?.textContent==='試聴中');
  await page.waitForFunction(()=>Number(document.querySelector('#preview-time')?.textContent.split(' / ')[0].split(':').reduce((n,part)=>n*60+Number(part),0))>=1);
  await page.locator('#preview-stop').click();
  assert.deepEqual(errors,[]);
  const cdp=await context.newCDPSession(page);await cdp.send('Performance.enable');
  const metrics=await cdp.send('Performance.getMetrics');
  const heap=metrics.metrics.find(item=>item.name==='JSHeapUsedSize')?.value;
  console.log(JSON.stringify({browser:await browser.version(),fixture,importMs,savedBpm:saved.track.bpm,
    directFullFileDecodes:saved.decodeSizes,waveform,transport,offlineReloadAndPlayback:true,jsHeapUsedBytes:heap,pageErrors:errors},null,2));
} catch(error) {
  console.error('Test failure before cleanup:',error);
  throw error;
} finally {
  await browser?.close();
  await rm(temporary,{recursive:true,force:true});
}
