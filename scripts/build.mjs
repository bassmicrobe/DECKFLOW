import {readdir,readFile,writeFile} from 'node:fs/promises';
import {join,relative,resolve} from 'node:path';
import {fileURLToPath} from 'node:url';
import {createHash} from 'node:crypto';
import {spawnSync} from 'node:child_process';
const root=fileURLToPath(new URL('../dist/',import.meta.url));
async function walk(dir){const paths=[];for(const entry of await readdir(dir,{withFileTypes:true})){const path=join(dir,entry.name);if(entry.isDirectory())paths.push(...await walk(path));else if(/\.(?:js|wasm|html|css|svg|webmanifest)$/.test(entry.name)&&entry.name!=='sw.js'&&!path.includes('/source/'))paths.push(path);}return paths.sort();}
const files=await walk(root),contents=new Map();
for(const file of files){contents.set(file,await readFile(file));if(file.endsWith('.js')){const result=spawnSync(process.execPath,['--check',file],{encoding:'utf8'});if(result.status!==0)throw new Error(result.stderr);}}
const digest=data=>createHash('sha256').update(data).digest('hex').slice(0,16);
const versionedAssets=new Set();
const runtimePath=file=>'./'+relative(root,file).split('\\').join('/');
function localReference(reference,owner=join(root,'index.html')){
  const url=new URL(reference,'https://deckflow.build/'+relative(root,owner).split('\\').join('/'));
  const file=resolve(root,'.'+decodeURIComponent(url.pathname));
  return {url,file};
}
// The module graph is one version: imports, workers and worklets must never
// combine an entry from one release with a dependency from an older release.
// Match only simple local JS URL literals. External/bare imports, templates,
// comments without quoted URLs and service-worker registration are untouched.
const localJsLiteral=/(['"])(\.{1,2}\/[^'"\\\r\n]*?\.(?:js|wasm)(?:\?[^'"\\\r\n#]*)?(?:#[^'"\\\r\n]*)?)\1/g;
function rewriteModules(source,owner,version){
  return source.replace(localJsLiteral,(literal,quote,reference)=>{
    const {url,file}=localReference(reference,owner);
    if(file===join(root,'sw.js'))return literal;
    if(!contents.has(file))throw new Error(`Missing runtime asset: ${reference} (from ${runtimePath(owner)})`);
    url.searchParams.delete('v');
    if(file.endsWith('.wasm'))url.searchParams.set('v',digest(contents.get(file)));
    else if(version)url.searchParams.set('v',version);
    if(version)versionedAssets.add(runtimePath(file)+url.search);
    return quote+reference.split(/[?#]/)[0]+url.search+url.hash+quote;
  });
}
const modules=files.filter(file=>file.endsWith('.js'));
const normalizedModules=new Map();
const moduleHash=createHash('sha256');
for(const file of modules){
  const source=rewriteModules(contents.get(file).toString(),file,null);
  normalizedModules.set(file,source);
  moduleHash.update(runtimePath(file)+'\0');moduleHash.update(source);moduleHash.update('\0');
}
const moduleVersion=moduleHash.digest('hex').slice(0,16);
for(const file of modules){
  contents.set(file,Buffer.from(rewriteModules(normalizedModules.get(file),file,moduleVersion)));
  versionedAssets.add(runtimePath(file)+'?v='+moduleVersion);
}
function versioned(reference,owner=join(root,'index.html')){
  if(/^(?:[a-z][a-z0-9+.-]*:|\/\/)/i.test(reference))return reference;
  const {url,file}=localReference(reference,owner);
  if(!contents.has(file))throw new Error(`Missing runtime asset: ${reference}`);
  url.searchParams.set('v',file.endsWith('.js')?moduleVersion:digest(contents.get(file)));
  versionedAssets.add(runtimePath(file)+url.search);
  return reference.split(/[?#]/)[0]+url.search+url.hash;
}
// Update leaf references first. The manifest hash must describe its final bytes.
const manifestPath=join(root,'manifest.webmanifest');
const manifest=JSON.parse(contents.get(manifestPath).toString());
for(const icon of manifest.icons??[])if(typeof icon.src==='string')icon.src=versioned(icon.src);
contents.set(manifestPath,Buffer.from(JSON.stringify(manifest)+'\n'));
const indexPath=join(root,'index.html');
const attr=(tag,name)=>new RegExp(`\\b${name}\\s*=\\s*(["'])(.*?)\\1`,'i').exec(tag)?.[2];
const index=contents.get(indexPath).toString().replace(/<(?:link|script)\b[^>]*>/gi,tag=>{
  const script=/^<script\b/i.test(tag),rel=(attr(tag,'rel')??'').toLowerCase().split(/\s+/);
  if(!script&&!rel.some(value=>['stylesheet','manifest','icon'].includes(value)))return tag;
  const name=script?'src':'href';
  return tag.replace(new RegExp(`(\\b${name}\\s*=\\s*)(["'])(.*?)\\2`,'i'),(_match,prefix,quote,value)=>
    prefix+quote+versioned(value.replaceAll('&amp;','&')).replaceAll('&','&amp;')+quote);
});
contents.set(indexPath,Buffer.from(index));
// Commit generated references only after every local reference has validated.
for(const path of [...modules,manifestPath,indexPath])if(!(await readFile(path)).equals(contents.get(path)))await writeFile(path,contents.get(path));
let bytes=0;const hash=createHash('sha256');
for(const file of files){const data=contents.get(file);hash.update(relative(root,file));hash.update(data);bytes+=data.length;}
const version=hash.digest('hex').slice(0,16);
// Precache the exact graph-versioned URLs, including workers and worklets.
// Plain URLs remain available for old bookmarks and non-module assets.
const assets=[...new Set([...files.map(path=>'./'+relative(root,path).split('\\').join('/')),...versionedAssets])].sort();
await writeFile(join(root,'sw.js'),`// Generated by npm run build. Do not edit.\nconst CACHE='deckflow-${version}';\nconst DEV=['localhost','127.0.0.1','[::1]'].includes(self.location.hostname);\nconst ASSETS=${JSON.stringify(assets)};\nself.addEventListener('install',event=>event.waitUntil(caches.open(CACHE).then(cache=>cache.addAll(ASSETS)).then(()=>DEV?self.skipWaiting():undefined)));\nself.addEventListener('activate',event=>event.waitUntil(caches.keys().then(keys=>Promise.all(keys.filter(key=>key.startsWith('deckflow-')&&key!==CACHE).map(key=>caches.delete(key)))).then(()=>DEV?self.clients.claim():undefined)));\nself.addEventListener('fetch',event=>{if(event.request.method!=='GET'||new URL(event.request.url).origin!==self.location.origin)return;if(DEV){event.respondWith(fetch(event.request).catch(()=>caches.match(event.request).then(cached=>cached||(event.request.mode==='navigate'?caches.match('./index.html'):Response.error()))));return;}event.respondWith(caches.match(event.request).then(cached=>cached||fetch(event.request).catch(error=>{if(event.request.mode==='navigate')return caches.match('./index.html');throw error;})));});\n`);
console.log(`DECKFLOW: ${files.length} runtime assets, ${(bytes/1024).toFixed(0)} KiB, offline cache ${version}`);
