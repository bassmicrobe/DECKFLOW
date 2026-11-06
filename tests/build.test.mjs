import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,mkdir,readFile,writeFile,copyFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {createHash} from 'node:crypto';
import {spawnSync} from 'node:child_process';
const digest=bytes=>createHash('sha256').update(bytes).digest('hex').slice(0,16);
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
      'app.js':'export const ready = true;', 'icon.svg':'<svg xmlns="http://www.w3.org/2000/svg"/>',
    };
    for(const [name,content] of Object.entries(files))await writeFile(join(root,'dist',name),content);
    await run(root);
  }finally{await rm(root,{recursive:true,force:true});}
}
const build=root=>spawnSync(process.execPath,[join(root,'scripts/build.mjs')],{encoding:'utf8'});
async function output(root){
  const html=await readFile(join(root,'dist/index.html'),'utf8');
  const manifest=await readFile(join(root,'dist/manifest.webmanifest'),'utf8');
  const sw=await readFile(join(root,'dist/sw.js'),'utf8');
  return {html,manifest,sw};
}
async function verifyReferences(root,result){
  const urls=[...result.html.matchAll(/(?:href|src)="([^"]+)"/g)].map(match=>match[1]);
  urls.push(...JSON.parse(result.manifest).icons.map(icon=>icon.src));
  const assets=JSON.parse(/const ASSETS=(\[[^\n]+\]);/.exec(result.sw)[1]);
  assert.equal(urls.length,6);
  for(const reference of urls){
    const url=new URL(reference,'https://deckflow.test/');
    const bytes=await readFile(join(root,'dist',url.pathname));
    assert.equal(url.searchParams.getAll('v').length,1,reference);
    assert.equal(url.searchParams.get('v'),digest(bytes),reference);
    assert.ok(assets.includes(reference),`Not precached: ${reference}`);
  }
  for(const reference of assets){
    const url=new URL(reference,'https://deckflow.test/');
    const bytes=await readFile(join(root,'dist',url.pathname));
    if(url.searchParams.has('v'))assert.equal(url.searchParams.get('v'),digest(bytes),reference);
  }
}

test('build versions all entry references, precaches matching URLs and is idempotent',async()=>{
  await fixture(async root=>{
    const first=build(root);assert.equal(first.status,0,first.stderr);
    const a=await output(root);await verifyReferences(root,a);
    const second=build(root);assert.equal(second.status,0,second.stderr);
    const b=await output(root);await verifyReferences(root,b);
    assert.deepEqual(b,a);
    assert.equal(second.stdout,first.stdout);
  });
});

test('CSS and icon changes invalidate their entry URLs and the manifest dependency',async()=>{
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
    assert.notEqual(before.sw,after.sw);
    assert.equal(build(root).status,0);
    assert.deepEqual(await output(root),after);
  });
});

test('a missing entry asset fails before writing a mismatched manifest or HTML',async()=>{
  await fixture(async root=>{
    const index=join(root,'dist/index.html'),manifest=join(root,'dist/manifest.webmanifest');
    const html=(await readFile(index,'utf8')).replace('./styles.css?v=stale','./missing.css');
    await writeFile(index,html);
    const previousManifest=await readFile(manifest,'utf8');
    const failed=build(root);
    assert.notEqual(failed.status,0);assert.match(failed.stderr,/Missing runtime asset: \.\/missing\.css/);
    assert.equal(await readFile(index,'utf8'),html);
    assert.equal(await readFile(manifest,'utf8'),previousManifest);
  });
});
