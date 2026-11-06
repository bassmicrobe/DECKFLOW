/** Read-only access to user-selected library folders. No filesystem URLs are fetched. */
const MAX_FILES = 100_000;
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
export async function indexDirectory(handle, {signal, onProgress = () => {}} = {}) {
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
export async function databaseBytes(index, candidate) {
  const wal = index.entries.get(candidate.path + '-wal');
  if (wal && (await wal.getFile()).size > 0) fail('未反映の変更（WAL）があるデータベースです。rekordboxを終了し、データベースを確定させてからフォルダを選び直してください。XMLでも取り込めます。');
  const file = await candidate.getFile();
  if(candidate.kind==='xml' && file.size>32*1024*1024) fail('XMLは32 MB以内で選んでください。');
  if (!file.size || file.size > 128 * 1024 * 1024) fail('ライブラリDBは128 MB以内で選んでください。大きい場合はXMLまたはUSBライブラリを使用してください。');
  return new Uint8Array(await file.arrayBuffer());
}
export async function sourceDigest(bytes) {
  const hash = await crypto.subtle.digest('SHA-256', bytes);
  return Array.from(new Uint8Array(hash),value=>value.toString(16).padStart(2,'0')).join('');
}

/** A worker per import keeps parsing off the playback/UI thread and makes cancellation immediate. */
export function createLibraryReader() {
  const worker = new Worker(new URL('./library-source-worker.js?v=15d483d12b5c45ed', import.meta.url), {type:'module'});
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
