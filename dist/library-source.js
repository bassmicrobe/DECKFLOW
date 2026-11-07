/** Read-only access to user-selected library folders. No filesystem URLs are fetched. */
const MAX_FILES = 100_000;
const MAX_FALLBACK_CHILDREN = 4096;
const RELEVANT = /(?:\.(?:xml|pdb|db|DAT|EXT|2EX|mp3|wav|aif|aiff|m4a|aac|flac|ogg)|\.db-wal)$/i;
const fail = message => { throw new Error(message); };
export function normalizeSourcePath(value) {
  if (typeof value !== 'string' || value.length > 8192 || /[\u0000-\u001f\u007f\\]/.test(value)) fail('ライブラリ内のパスを確認してください。');
  const path = value.replace(/^\/+/, '').normalize('NFC');
  if (!path || path.split('/').length > 34 || path.split('/').some(part => !part || part === '.' || part === '..')) fail('安全に読み取れないライブラリ内のパスです。');
  return path;
}
export function createSourceIndex(items, label = 'ライブラリ') {
  const entries = new Map();
  for (const item of items) {
    const path = normalizeSourcePath(item.path);
    if (entries.has(path)) fail('同じパスのファイルが重複しています。フォルダを選び直してください。');
    if (entries.size >= MAX_FILES) fail('1回に選べるファイルは100,000件までです。');
    entries.set(path, {...item, path});
  }
  // A suffix index permits relocated desktop libraries without basename-only guessing.
  const suffixes = new Map();
  for (const item of entries.values()) {
    const parts = item.path.split('/');
    for (let start = 0; start < parts.length - 1; start++) {
      const suffix = parts.slice(start).join('/');
      suffixes.set(suffix, suffixes.has(suffix) ? null : item);
    }
  }
  return {label, entries, find(path, {suffix = false} = {}) {
    if (!path) return null;
    const normalized = normalizeSourcePath(path);
    if (entries.has(normalized)) return entries.get(normalized);
    if (!suffix) return null;
    const parts = normalized.split('/');
    for (let start = 0; start < parts.length - 1; start++) {
      const candidate = suffixes.get(parts.slice(start).join('/'));
      if (candidate) return candidate;
      // An ambiguous longest match must never fall back to a shorter guess.
      if (candidate === null) return null;
    }
    return null;
  }};
}
export function indexFileList(files) {
  files = Array.from(files);
  if(files.length>MAX_FILES) fail('1回に選べるファイルは100,000件までです。');
  const label = files[0]?.webkitRelativePath?.split('/')[0] || '選択したファイル';
  return createSourceIndex(files.filter(file => RELEVANT.test(file.name)).map(file => ({path:file.webkitRelativePath || file.name, getFile:async()=>file})), label);
}

function childName(handle) {
  const name=handle?.name;
  if(typeof name!=='string'||name.includes('/'))fail('安全に読み取れないフォルダ名・ファイル名です。');
  normalizeSourcePath(name);
  return name;
}

const browserRejectsName = error => error?.name === 'TypeError' && /(?:^|:\s*)Name is not allowed\.?$/.test(error.message);
class UnavailableSourceName extends Error {
  constructor(reason='blocked'){super('ブラウザでこのファイル名を読み取れません。');this.reason=reason;}
}

// A fresh resolver per operation keeps absent paths and revoked permissions from
// leaking into later imports. Only a browser name rejection permits a bounded,
// one-level lookup in the already selected parent; names are never rewritten.
function directoryResolver(root,signal,{allowNameFallback=false,onUnavailable=()=>{}}={}) {
  const rootName=childName(root),folders=new Map([['',Promise.resolve({handle:root,names:[]})]]);
  const enumerations=new WeakMap();let enumerated=0;
  const exactChild=async(parent,name,kind)=>{
    if(typeof parent.values!=='function')throw new UnavailableSourceName();
    if(!enumerations.has(parent))enumerations.set(parent,(async()=>{
      const children=new Map();let scanned=0,truncated=false;
      try{
        for await(const child of parent.values()){
          signal?.throwIfAborted();
          if(enumerated>=MAX_FILES){truncated=true;break;}
          enumerated++;scanned++;
          children.set(child.name,children.has(child.name)?null:child);
          if(scanned>=MAX_FALLBACK_CHILDREN){truncated=true;break;}
          if(scanned%100===0){await new Promise(resolve=>setTimeout(resolve,0));signal?.throwIfAborted();}
        }
      }catch(error){signal?.throwIfAborted();if(browserRejectsName(error))throw new UnavailableSourceName();throw error;}
      return {children,truncated};
    })());
    const {children,truncated}=await enumerations.get(parent);signal?.throwIfAborted();
    const child=children.get(name);
    if(child?.kind===kind)return child;
    throw new UnavailableSourceName(truncated?'limit':'blocked');
  };
  const optional=async(parent,name,kind)=>{
    signal?.throwIfAborted();
    try{const value=await parent[kind==='directory'?'getDirectoryHandle':'getFileHandle'](name,{create:false});signal?.throwIfAborted();return value;}
    catch(error){
      signal?.throwIfAborted();
      if(['NotFoundError','TypeMismatchError'].includes(error.name))return null;
      if(allowNameFallback&&browserRejectsName(error))return exactChild(parent,name,kind);
      throw error;
    }
  };
  const directory=parts=>{
    const key=parts.join('/');
    if(!folders.has(key))folders.set(key,(async()=>{
      const parent=await directory(parts.slice(0,-1));signal?.throwIfAborted();
      if(!parent)return null;
      const handle=await optional(parent.handle,parts.at(-1),'directory');
      signal?.throwIfAborted();
      return handle?{handle,names:[...parent.names,childName(handle)]}:null;
    })());
    return folders.get(key);
  };
  return async raw=>{
    normalizeSourcePath(raw);
    try{
      const parts=raw.replace(/^\/+/,'').split('/');
      const parent=await directory(parts.slice(0,-1));signal?.throwIfAborted();
      if(!parent)return null;
      const handle=await optional(parent.handle,parts.at(-1),'file');
      signal?.throwIfAborted();
      if(!handle)return null;
      const relative=[...parent.names,childName(handle)].join('/');
      return {handle,relative,path:normalizeSourcePath(`${rootName}/${relative}`),getFile:()=>handle.getFile()};
    }catch(error){
      signal?.throwIfAborted();
      if(error instanceof UnavailableSourceName){onUnavailable(raw,error.reason);return null;}
      throw error;
    }
  };
}

async function targetedDeviceIndex(root,{signal}) {
  const resolve=directoryResolver(root,signal),databases=[],initial=new Map();
  for(const folder of ['PIONEER','.PIONEER'])for(const filename of ['export.pdb','exportLibrary.db']){
    const relative=`${folder}/rekordbox/${filename}`,item=await resolve(relative);
    signal?.throwIfAborted();
    if(!item)continue;
    databases.push({relative,path:item.path});initial.set(item.path,item);
    const wal=await resolve(relative+'-wal');signal?.throwIfAborted();
    if(wal)initial.set(wal.path,wal);
  }
  if(!databases.length)return null;
  const entries=new Map(),aliases=new Map();
  const publish=(items,lookup)=>{
    entries.clear();aliases.clear();
    for(const [path,item] of items)entries.set(path,{path,getFile:item.getFile});
    for(const [alias,item] of lookup)aliases.set(alias,entries.get(item.path));
  };
  publish(initial,new Map(databases.map(database=>[normalizeSourcePath(database.relative),initial.get(database.path)])));
  const index={label:root.name,entries,targetedDevice:true,
    find(path){return path?aliases.get(normalizeSourcePath(path))||null:null;},
    async databaseWal(candidate,{signal:readSignal}={}){
      const database=databases.find(item=>item.path===candidate.path);
      if(!database)return null;
      // Re-probe with a fresh resolver, including when the same picker selection
      // is reused after a cancelled import or rekordbox has created a new WAL.
      const item=await directoryResolver(root,readSignal)(database.relative+'-wal');
      readSignal?.throwIfAborted();return item;
    },
    async prepareEntries(references,{signal:readSignal,onProgress=()=>{},candidate}={}){
      readSignal?.throwIfAborted();
      const paths=new Set();
      const add=path=>{normalizeSourcePath(path);paths.add(path.replace(/^\/+/,''));if(paths.size>MAX_FILES)fail('1回に選べるファイルは100,000件までです。');};
      for(const entry of references){
        add(entry.sourcePath);
        if(entry.analysisPath)for(const extension of ['DAT','EXT'])add(entry.analysisPath.replace(/\.(?:DAT|EXT|2EX)$/i,`.${extension}`));
      }
      if(candidate)await checkDatabaseWal(index,candidate,readSignal);
      readSignal?.throwIfAborted();
      const unavailable=new Map();
      const resolve=directoryResolver(root,readSignal,{allowNameFallback:true,onUnavailable:(path,reason)=>unavailable.set(path,reason)}),items=new Map(initial),lookup=new Map();
      for(const database of databases)lookup.set(normalizeSourcePath(database.relative),items.get(database.path));
      let cursor=0,completed=0,failure;const pending=[...paths];
      const report=()=>onProgress(completed,pending.length);
      report();
      const worker=async()=>{
        while(!failure&&cursor<pending.length){
          const raw=pending[cursor++];
          try{
            const resolved=await resolve(raw);readSignal?.throwIfAborted();if(failure)return;
            if(resolved){
              let item=items.get(resolved.path);
              if(item&&item.handle!==resolved.handle){
                const same=typeof item.handle.isSameEntry==='function'?await item.handle.isSameEntry(resolved.handle):item.relative===resolved.relative;
                readSignal?.throwIfAborted();if(failure)return;
                if(!same)fail('同じパスのファイルが重複しています。フォルダを選び直してください。');
              }
              if(!item){item=resolved;items.set(item.path,item);}
              for(const alias of [normalizeSourcePath(raw),normalizeSourcePath(resolved.relative)]){
                const previous=lookup.get(alias);
                if(previous&&previous.path!==item.path)fail('同じパスのファイルが重複しています。フォルダを選び直してください。');
                lookup.set(alias,item);
              }
            }
            completed++;report();
            if(completed%100===0){await new Promise(resolve=>setTimeout(resolve,0));readSignal?.throwIfAborted();}
          }catch(error){failure??=error;}
        }
      };
      await Promise.all(Array.from({length:Math.min(4,pending.length)},worker));
      readSignal?.throwIfAborted();if(failure)throw failure;
      // No partially prepared aliases become visible after an error or cancel.
      publish(items,lookup);
      const blocked=[...unavailable.values()].filter(reason=>reason==='blocked').length,limited=unavailable.size-blocked;
      return {warnings:[
        ...(blocked?[`${blocked} 件の音源・解析ファイルは、名前に含まれる文字などをブラウザが許可しないため読み取れませんでした。曲情報とプレイリストは保持しています。USB内の名前は変更していません。`]:[]),
        ...(limited?[`${limited} 件の音源・解析ファイルは、フォルダ内の確認上限に達したため読み取れませんでした。曲情報とプレイリストは保持しています。`]:[]),
      ]};
    },
  };
  return index;
}

export async function indexDirectory(handle, {signal, onProgress = () => {}} = {}) {
  signal?.throwIfAborted();
  if(typeof handle.getDirectoryHandle==='function'){
    const device=await targetedDeviceIndex(handle,{signal});signal?.throwIfAborted();
    if(device)return device;
  }
  const items = []; let scanned = 0;
  async function walk(directory, prefix, depth) {
    if (depth > 32) fail('フォルダ階層は32段まで対応しています。');
    for await (const child of directory.values()) {
      signal?.throwIfAborted();
      if (++scanned > MAX_FILES) fail('1回に選べるファイルは100,000件までです。');
      const path = `${prefix}/${child.name}`;
      if (child.kind === 'directory') await walk(child, path, depth + 1);
      else if (child.kind === 'file' && RELEVANT.test(child.name)) items.push({path, getFile:()=>child.getFile()});
      if (scanned % 200 === 0) { onProgress(scanned); await new Promise(resolve=>setTimeout(resolve,0)); }
    }
  }
  await walk(handle, handle.name, 0);
  signal?.throwIfAborted();
  return createSourceIndex(items, handle.name);
}
export function databaseCandidates(index) {
  const result = [];
  for (const item of index.entries.values()) {
    const name = item.path.split('/').at(-1).toLowerCase();
    const kind = name === 'export.pdb' ? 'pdb' : ['master.db','exportlibrary.db'].includes(name) ? 'sqlite' : /\.xml$/.test(name) && !/^(?:masterplaylists|automixplaylist)/.test(name) ? 'xml' : null;
    if (kind) result.push({...item,kind});
  }
  return result.sort((a,b)=>({pdb:0,sqlite:1,xml:2}[a.kind]-{pdb:0,sqlite:1,xml:2}[b.kind]) || a.path.localeCompare(b.path));
}
export function sourceFileStamp(file, path) { return `${path}|${file.size}|${file.lastModified || 0}`; }
async function checkDatabaseWal(index,candidate,signal) {
  signal?.throwIfAborted();
  const wal=typeof index.databaseWal==='function'?await index.databaseWal(candidate,{signal}):index.entries.get(candidate.path+'-wal');
  signal?.throwIfAborted();
  if(wal){const file=await wal.getFile();signal?.throwIfAborted();if(file.size>0)fail('未反映の変更（WAL）があるデータベースです。rekordboxを終了し、データベースを確定させてからフォルダを選び直してください。XMLでも取り込めます。');}
}
export async function databaseBytes(index, candidate, {signal}={}) {
  await checkDatabaseWal(index,candidate,signal);
  const file = await candidate.getFile();
  signal?.throwIfAborted();
  if(candidate.kind==='xml' && file.size>32*1024*1024) fail('XMLは32 MB以内で選んでください。');
  if (!file.size || file.size > 128 * 1024 * 1024) fail('ライブラリDBは128 MB以内で選んでください。大きい場合はXMLまたはUSBライブラリを使用してください。');
  const bytes=new Uint8Array(await file.arrayBuffer());signal?.throwIfAborted();return bytes;
}
export async function sourceDigest(bytes) {
  const hash = await crypto.subtle.digest('SHA-256', bytes);
  return Array.from(new Uint8Array(hash),value=>value.toString(16).padStart(2,'0')).join('');
}

/** A worker per import keeps parsing off the playback/UI thread and makes cancellation immediate. */
export function createLibraryReader() {
  const worker = new Worker(new URL('./library-source-worker.js?v=b48f446ea6c7f1bb', import.meta.url), {type:'module'});
  let sequence = 0; const pending = new Map(); let closed = false;
  const close = (error = new Error('読み込みを中止しました。')) => {
    if (closed) return; closed = true; worker.terminate();
    for (const item of pending.values()) { clearTimeout(item.timer); item.reject(error); }
    pending.clear();
  };
  worker.onmessage = ({data}) => {
    const item = pending.get(data.id); if (!item) return;
    pending.delete(data.id); clearTimeout(item.timer);
    if (data.error) item.reject(new Error(data.error)); else item.resolve(data.result);
  };
  worker.onerror = () => close(new Error('ライブラリの読み取り処理を開始できませんでした。ページを再読み込みしてください。'));
  return {close, read(operation, data, transfer = []) {
    if (closed) return Promise.reject(new Error('読み込みは終了しました。'));
    return new Promise((resolve,reject)=>{
      const id=++sequence;const timer=setTimeout(()=>close(new Error('ライブラリの読み取りがタイムアウトしました。小さいライブラリで試してください。')),120_000);
      pending.set(id,{resolve,reject,timer});worker.postMessage({id,operation,...data},transfer);
    });
  }};
}
