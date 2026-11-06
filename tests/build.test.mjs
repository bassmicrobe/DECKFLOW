import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,mkdir,readFile,writeFile,copyFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join,dirname} from 'node:path';
import {createHash} from 'node:crypto';
import {spawnSync} from 'node:child_process';
const digest=bytes=>createHash('sha256').update(bytes).digest('hex').slice(0,16);
const moduleNames=['app.js','dep.js','shared.js','worker.js','processor.js','vendor/node.js'];
async function fixture(run){
  const root=await mkdtemp(join(tmpdir(),'deckflow-build-'));
  try{
    await mkdir(join(root,'scripts'));await mkdir(join(root,'dist'));
    await writeFile(join(root,'package.json'),'{"type":"module"}\n');
    await copyFile(new URL('../scripts/build.mjs',import.meta.url),join(root,'scripts/build.mjs'));
    const files={
      'index.html':'<!doctype html><link rel="manifest" href="./manifest.webmanifest?v=old"><link rel="icon" href="./icon.svg"><link rel="stylesheet" href="./styles.css?v=stale"><link rel="stylesheet" href="./library-ui.css"><script type="module" src="./app.js"></script>',
      'manifest.webmanifest':JSON.stringify({name:'Test',icons:[{src:'./icon.svg?v=old',type:'image/svg+xml'}]}),
      'styles.css':':root{color:red}', 'library-ui.css':'body{background:black}',
      'app.js':`import {value} from './dep.js?v=stale';
export {shared} from './shared.js';
import './shared.js';
export const later=()=>import('./vendor/node.js');
export const worker=()=>new Worker(new URL('./worker.js',import.meta.url),{type:'module'});
export const worklet=context=>context.audioWorklet.addModule(new URL('./processor.js',import.meta.url));
export const register=()=>navigator.serviceWorker.register('./sw.js');
export const external=()=>import('https://example.com/module.js?v=keep');
export const ready=value;`,
      'dep.js':"import {shared} from './shared.js'; export const value=shared;",
      'shared.js':'export const shared = 1;',
      'worker.js':"import {value} from './dep.js'; self.onmessage=()=>self.postMessage(value);",
      'processor.js':"import {shared} from './shared.js'; export const processor=shared;",
      'vendor/node.js':"export {value} from '../dep.js?mode=test&v=old#fragment';",
      'icon.svg':'<svg xmlns="http://www.w3.org/2000/svg"/>',
    };
    for(const [name,content] of Object.entries(files)){
      await mkdir(dirname(join(root,'dist',name)),{recursive:true});await writeFile(join(root,'dist',name),content);
    }
    await run(root);
  }finally{await rm(root,{recursive:true,force:true});}
}
const build=root=>spawnSync(process.execPath,[join(root,'scripts/build.mjs')],{encoding:'utf8'});
async function output(root){
  const html=await readFile(join(root,'dist/index.html'),'utf8');
  const manifest=await readFile(join(root,'dist/manifest.webmanifest'),'utf8');
  const sw=await readFile(join(root,'dist/sw.js'),'utf8');
  const modules=Object.fromEntries(await Promise.all(moduleNames.map(async name=>[name,await readFile(join(root,'dist',name),'utf8')])));
  return {html,manifest,sw,modules};
}
const moduleVersion=result=>new URL(/src="([^"]*app\.js[^"]*)"/.exec(result.html)[1],'https://deckflow.test/').searchParams.get('v');
async function verifyReferences(root,result){
  const urls=[...result.html.matchAll(/(?:href|src)="([^"]+)"/g)].map(match=>match[1].replaceAll('&amp;','&'));
  urls.push(...JSON.parse(result.manifest).icons.map(icon=>icon.src));
  const assets=JSON.parse(/const ASSETS=(\[[^\n]+\]);/.exec(result.sw)[1]);
  const graphVersion=moduleVersion(result);
  assert.match(graphVersion,/^[a-f0-9]{16}$/);
  assert.equal(urls.length,6);
  for(const reference of urls){
    const url=new URL(reference,'https://deckflow.test/');
    const bytes=await readFile(join(root,'dist',url.pathname));
    assert.equal(url.searchParams.getAll('v').length,1,reference);
    assert.equal(url.searchParams.get('v'),url.pathname.endsWith('.js')?graphVersion:digest(bytes),reference);
    assert.ok(assets.includes(reference),`Not precached: ${reference}`);
  }
  for(const [name,source] of Object.entries(result.modules)){
    for(const match of source.matchAll(/(['"])(\.{1,2}\/[^'"\r\n]+\.js(?:\?[^'"\r\n#]*)?(?:#[^'"\r\n]*)?)\1/g)){
      const url=new URL(match[2],`https://deckflow.test/${name}`);
      if(url.pathname==='/sw.js'){assert.equal(url.search,'');continue;}
      assert.equal(url.searchParams.getAll('v').length,1,match[2]);
      assert.equal(url.searchParams.get('v'),graphVersion,match[2]);
      assert.ok(assets.includes('.'+url.pathname+url.search),`Not precached: ${match[2]}`);
    }
    assert.ok(assets.includes(`./${name}?v=${graphVersion}`),`Missing graph module: ${name}`);
  }
  for(const reference of assets){
    const url=new URL(reference,'https://deckflow.test/');
    const bytes=await readFile(join(root,'dist',url.pathname));
    if(url.searchParams.has('v'))assert.equal(url.searchParams.get('v'),url.pathname.endsWith('.js')?graphVersion:digest(bytes),reference);
  }
}

test('build versions the whole module graph, precaches exact URLs and is idempotent',async()=>{
  await fixture(async root=>{
    const first=build(root);assert.equal(first.status,0,first.stderr);
    const a=await output(root);await verifyReferences(root,a);
    assert.match(a.modules['app.js'],/https:\/\/example\.com\/module\.js\?v=keep/);
    assert.match(a.modules['vendor/node.js'],/\.\.\/dep\.js\?mode=test&v=[a-f0-9]{16}#fragment/);
    const second=build(root);assert.equal(second.status,0,second.stderr);
    const b=await output(root);await verifyReferences(root,b);
    assert.deepEqual(b,a);
    assert.equal(second.stdout,first.stdout);
  });
});

test('changing one dependency rotates entry, dynamic import, worker and worklet graph URLs together',async()=>{
  await fixture(async root=>{
    assert.equal(build(root).status,0);const before=await output(root);
    await writeFile(join(root,'dist/shared.js'),'export const shared = 2;');
    const changed=build(root);assert.equal(changed.status,0,changed.stderr);
    const after=await output(root);await verifyReferences(root,after);
    assert.notEqual(moduleVersion(before),moduleVersion(after));
    for(const name of ['app.js','dep.js','worker.js','processor.js','vendor/node.js'])assert.notEqual(before.modules[name],after.modules[name],name);
    const css=result=>/\.\/styles\.css\?v=[a-f0-9]+/.exec(result.html)[0];
    assert.equal(css(before),css(after));
    assert.equal(build(root).status,0);assert.deepEqual(await output(root),after);
  });
});

test('CSS and icon changes invalidate their entry URLs and manifest but retain the module graph',async()=>{
  await fixture(async root=>{
    assert.equal(build(root).status,0);const before=await output(root);
    await writeFile(join(root,'dist/styles.css'),':root{color:crimson}');
    await writeFile(join(root,'dist/icon.svg'),'<svg xmlns="http://www.w3.org/2000/svg"><title>Updated</title></svg>');
    const changed=build(root);assert.equal(changed.status,0,changed.stderr);
    const after=await output(root);await verifyReferences(root,after);
    for(const path of ['styles.css','icon.svg','manifest.webmanifest']){
      const url=result=>new RegExp(`\\./${path.replace('.','\\.')}\\?v=[a-f0-9]+`).exec(result.html)[0];
      assert.notEqual(url(before),url(after));
    }
    assert.equal(moduleVersion(before),moduleVersion(after));
    assert.notEqual(before.sw,after.sw);
    assert.equal(build(root).status,0);assert.deepEqual(await output(root),after);
  });
});

test('a missing entry asset fails before writing any generated references',async()=>{
  await fixture(async root=>{
    assert.equal(build(root).status,0);
    const index=join(root,'dist/index.html');
    await writeFile(index,(await readFile(index,'utf8')).replace(/\.\/styles\.css\?v=[a-f0-9]+/,'./missing.css'));
    const previous=await output(root);
    const failed=build(root);
    assert.notEqual(failed.status,0);assert.match(failed.stderr,/Missing runtime asset: \.\/missing\.css/);
    assert.deepEqual(await output(root),previous);
  });
});

test('a missing nested local module fails before writing any generated references',async()=>{
  await fixture(async root=>{
    assert.equal(build(root).status,0);
    await writeFile(join(root,'dist/vendor/node.js'),"export {missing} from '../missing.js';");
    const previous=await output(root);
    const failed=build(root);
    assert.notEqual(failed.status,0);assert.match(failed.stderr,/Missing runtime asset: \.\.\/missing\.js/);
    assert.deepEqual(await output(root),previous);
  });
});
