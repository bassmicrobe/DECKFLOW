/** Read-only rekordbox 6/7 master.db and OneLibrary importer, usable in a Worker. */
import {decrypt, DEFAULT_KEY, MASTER_KEY} from './vendor/onelibrary/sqlcipher.js';
import {SQLiteDatabase} from './vendor/onelibrary/sqlite.js';
import {validateLibrarySnapshot} from './library-store.js';

const fail = message => { throw new Error(message); };
const MAX_DATABASE = 128 * 1024 * 1024;
function text(value, label, max = 8192) {
  if (typeof value !== 'string' || value.length > max || /[\u0000-\u001f\u007f]/.test(value)) fail(`${label}を読み取れません。`);
  return value;
}
function sourceKey(value) {
  const id = String(value ?? '');
  if (!id || id.length > 128 || /[\u0000-\u001f\u007f]/.test(id)) fail('ライブラリ内のIDが正しくありません。');
  return id;
}
function hash(value) {
  let hash = 0xcbf29ce484222325n;
  for (const byte of new TextEncoder().encode(value)) hash = BigInt.asUintN(64,(hash ^ BigInt(byte)) * 0x100000001b3n);
  return hash.toString(16).padStart(16,'0');
}
function path(value, label, empty = false) {
  if (empty && !value) return null;
  let p = text(value,label).replaceAll('\\','/');
  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(p) || p.startsWith('//')) fail(`${label}はローカルパスにしてください。`);
  if (!p.startsWith('/')) p = '/' + p;
  const parts = p.slice(1).split('/');
  if (parts.some(v => !v || v === '.' || v === '..')) fail(`${label}に不正な区切りがあります。`);
  return p.normalize('NFC');
}
function number(value,label,min,max) {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < min || value > max) fail(`${label}の値が範囲外です。`);
  return value;
}
function lookup(rows,idKey) {
  const result = new Map();
  for (const row of rows) {
    const id = sourceKey(row[idKey]);
    if (result.has(id)) fail('ライブラリ内のIDが重複しています。');
    result.set(id,row);
  }
  return result;
}
const alive = row => row.rb_local_deleted == null || row.rb_local_deleted === 0;
function optionalTable(db,name,maxRows=100000) { return db.tables.has(name) ? db.select(name,{maxRows}) : []; }
function schema(db) {
  if (db.tables.has('djmdContent')) return {
    format:'master',tracks:'djmdContent',artists:'djmdArtist',lists:'djmdPlaylist',songs:'djmdSongPlaylist',cues:'djmdCue',
    id:'ID',title:'Title',artist:'ArtistID',artistName:'Name',artistId:'ID',bpm:'BPM',duration:'Length',path:'FolderPath',size:'FileSize',analysis:'AnalysisDataPath',
    listId:'ID',listName:'Name',parent:'ParentID',attribute:'Attribute',sequence:'Seq',songList:'PlaylistID',songId:'ContentID',songOrder:'TrackNo',
  };
  if (db.tables.has('content')) return {
    format:'onelibrary',tracks:'content',artists:'artist',lists:'playlist',songs:'playlist_content',cues:'cue',
    id:'content_id',title:'title',artist:'artist_id_artist',artistName:'name',artistId:'artist_id',bpm:'bpmx100',duration:'length',path:'path',size:'fileSize',analysis:'analysisDataFilePath',
    listId:'playlist_id',listName:'name',parent:'playlist_id_parent',attribute:'attribute',sequence:'sequenceNo',songList:'playlist_id',songId:'content_id',songOrder:'sequenceNo',
  };
  fail('rekordboxのmaster.dbまたはexportLibrary.dbを選んでください。');
}
/** Master cue encoding is separate from XML Type: Kind4 is an active memory
 * loop and is skipped by the hotcue slot sequence (1,2,3,5,6,7,8,9 = A..H).
 * References: CueGen Generator.CreateCues; rbxport PlayerCue/add_cue.
 * Only structural facts are used; no code is copied from those projects.
 */
function masterCues(db,tracks,sourceTracks,warnings) {
  if (!db.tables.has('djmdCue')) return;
  const byId = new Map(tracks.map(track => [track.rekordbox.trackId,track]));
  let unsupported = 0, colors = 0, unresolved = 0;
  for (const row of db.select('djmdCue',{maxRows:250000})) {
    if (!alive(row)) continue;
    const owner = sourceKey(row.ContentID);
    if (!sourceTracks.has(owner)) fail('CUEに存在しない曲への参照があります。');
    const track = byId.get(owner); if (!track) continue;
    const kind = row.Kind;
    if (!Number.isInteger(kind) || kind < 0) fail('CUE種別の値が正しくありません。');
    if (kind > 9) { unsupported++; continue; }
    const num = kind === 0 || kind === 4 ? -1 : kind <= 3 ? kind - 1 : kind - 2;
    const start = number(row.InMsec,'CUEの開始位置',0,86400000) / 1000;
    const out = row.OutMsec;
    const end = out == null || out === -1 || out === 4294967295 ? null : number(out,'LOOPの終了位置',0,86400000) / 1000;
    if (end != null && end <= start) fail('LOOPの終了位置は開始位置より後にしてください。');
    if (end == null && (kind === 4 || row.ActiveLoop === 1 || row.BeatLoopSize > 0)) {
      // A beat fraction plus average BPM can be wrong on a variable grid. Do
      // not turn an unresolved loop into a cue or invent its end.
      unresolved++; continue;
    }
    const maximum = Math.max(start,end ?? 0);
    if (maximum > track.duration) {
      const originalDuration = sourceTracks.get(owner).Length;
      if (!Number.isInteger(originalDuration) || maximum >= originalDuration + 1) fail('CUEの位置が曲の長さを超えています。');
      track.duration = maximum + 0.001;
    }
    if (num >= 0 && track.hotcues[num] != null) fail('同じHOT CUEスロットが重複しています。');
    if (row.Color != null && ![-1,255].includes(row.Color) || num >= 0 && row.ColorTableIndex > 0) colors++;
    let name = text(row.Comment ?? '', 'CUE名',1024);
    if (end != null && num < 0 && (kind === 4 || row.ActiveLoop === 1) && !name.startsWith('[active]')) name = '[active] ' + name;
    track.positionMarks.push({name,type:end == null ? 0 : 4,start,end,num,color:null});
    if (num >= 0) track.hotcues[num] = start;
    if (track.positionMarks.length > 1000) fail('1曲のCUEは1,000件以内で指定してください。');
  }
  for (const track of tracks) {
    const memory = track.positionMarks.filter(mark => mark.num < 0);
    if (memory.length) track.cue = Math.min(...memory.map(mark => mark.start));
  }
  if (unsupported) warnings.push(`未対応のHOT CUE I以降・CUE種別${unsupported}件は取り込みませんでした。HOT CUE A〜Hに対応しています。`);
  if (unresolved) warnings.push(`終了位置が保存されていないループ${unresolved}件は、長さを推測せず取り込みませんでした。XMLに書き出して取り込むと引き継げます。`);
  if (colors) warnings.push(`データベース固有のCUE色${colors}件は未変換です。位置・名前・ループは保持しました。`);
}
/**
 * kind can be 'master' or 'device' to avoid a second key derivation. Omit to
 * auto-detect. Caller must reject a selected nonempty sibling -wal file:
 * a database with uncheckpointed changes is not a complete snapshot.
 */
export async function parseRekordboxDatabase(bytes,{sourceId = 'rekordbox',kind,onProgress} = {}) {
  if (!(bytes instanceof Uint8Array) || bytes.length < 512 || bytes.length > MAX_DATABASE) fail('データベースは128 MB以内の完全なファイルを選んでください。');
  text(sourceId,'読み込み元ID',256);
  if (kind !== undefined && !['master','device','onelibrary'].includes(kind)) fail('データベース形式が正しくありません。');
  let plain = bytes;
  if (new TextDecoder().decode(bytes.subarray(0,16)) !== 'SQLite format 3\0') {
    const keys = kind === 'master' ? [MASTER_KEY] : kind ? [DEFAULT_KEY] : [MASTER_KEY,DEFAULT_KEY];
    let opened = false;
    for (const key of keys) {
      try { plain = await decrypt(bytes,key,onProgress); opened = true; break; }
      catch { /* Try only the documented keys, never read configuration or execute source files. */ }
    }
    if (!opened) fail('データベースを検証できません。破損、未対応の暗号形式、または鍵の変更が考えられます。rekordboxを終了して再選択するかXMLを取り込んでください。');
  }
  const db = new SQLiteDatabase(plain), s = schema(db);
  if (kind === 'master' && s.format !== 'master' || kind && kind !== 'master' && s.format !== 'onelibrary') fail('選択したデータベースの形式が一致しません。');
  const required = [s.id,s.title,s.duration,s.path];
  if (required.some(c => !db.tables.get(s.tracks).columns.includes(c))) fail('対応していないrekordboxデータベースの列構成です。');
  const source = `${s.format}:${sourceId}`, warnings = [], entries = [], tracks = [];
  const artists = lookup(optionalTable(db,s.artists).filter(alive),s.artistId);
  const sourceTracks = lookup(db.select(s.tracks,{maxRows:100000}),s.id);
  if ([...sourceTracks.values()].filter(alive).length > 10000) fail('曲は10,000件以内で指定してください。');
  const trackIds = new Map(); let skipped = 0;
  for (const [id,row] of sourceTracks) {
    if (!alive(row)) continue;
    // Streaming-only/offline service rows have no accessible local audio path.
    if (!row[s.path] || !row[s.duration]) { skipped++; continue; }
    const sourcePath = path(row[s.path],'音源パス'), filename = sourcePath.split('/').at(-1);
    const duration = number(row[s.duration],'曲の長さ',Number.MIN_VALUE,86400);
    const rawBpm = row[s.bpm];
    const bpm = rawBpm == null || rawBpm === 0 ? null : number(rawBpm / 100,'BPM',30,300);
    const artist = row[s.artist] == null ? null : artists.get(String(row[s.artist]));
    const trackId = `rdb-${hash(`${source}\0track\0${id}`)}`;
    const location = 'file://localhost' + sourcePath.split('/').map(encodeURIComponent).join('/');
    const title = text(row[s.title] || filename,'曲名',180);
    const size = row[s.size] == null || row[s.size] === 0 ? null : number(row[s.size],'音源サイズ',0,Number.MAX_SAFE_INTEGER);
    if (size != null && !Number.isSafeInteger(size)) fail('音源サイズは整数で指定してください。');
    const track = {id:trackId,title,artist:text(artist?.[s.artistName] ?? '','アーティスト名',180),bpm,duration,
      filename,beatOffset:0,cue:0,hotcues:Array(8).fill(null),peaks:[],confidence:0,audioMissing:true,addedAt:0,
      fingerprint:`${source}:${id}`,tempos:[],positionMarks:[],rekordbox:{trackId:id,location,size}};
    tracks.push(track);trackIds.set(id,trackId);
    entries.push({trackId,sourcePath,analysisPath:path(row[s.analysis],'解析データパス',true)});
  }
  if (skipped) warnings.push(`ローカル音源のパスまたは長さがない${skipped}曲（ストリーミング曲など）は取り込みませんでした。`);
  const lists = lookup(optionalTable(db,s.lists).filter(alive),s.listId);
  if (lists.size > 1000) fail('プレイリストは1,000件以内で指定してください。');
  const songs = optionalTable(db,s.songs).filter(alive);
  const memberships = new Map();
  for (const row of songs) {
    const listId = sourceKey(row[s.songList]), originalId = sourceKey(row[s.songId]);
    if (!lists.has(listId) || !sourceTracks.has(originalId)) fail('プレイリストに存在しない曲またはリストへの参照があります。');
    const order = number(row[s.songOrder] ?? 0,'プレイリストの順番',0,Number.MAX_SAFE_INTEGER);
    if (!Number.isInteger(order)) fail('プレイリストの順番が正しくありません。');
    if (!memberships.has(listId)) memberships.set(listId,[]);
    if (trackIds.has(originalId)) memberships.get(listId).push({id:trackIds.get(originalId),order});
  }
  const folderPath = (id,visited = new Set()) => {
    if (visited.has(id) || visited.size >= 32) fail('プレイリストフォルダーが循環しているか深すぎます。');
    visited.add(id);const row = lists.get(id);
    const parent = row[s.parent];
    if (parent == null || parent === '' || String(parent) === '0' || String(parent) === 'root') return [];
    const parentId = sourceKey(parent), ancestor = lists.get(parentId);
    if (!ancestor || ancestor[s.attribute] !== 1) fail('プレイリストフォルダーの参照が正しくありません。');
    return [...folderPath(parentId,visited),text(ancestor[s.listName],'フォルダー名',80)];
  };
  const playlists = [];let smart = 0, duplicate = 0;
  for (const [id,row] of lists) {
    const folders = folderPath(id); // Validate folders even when empty/unsupported.
    if (row[s.attribute] === 1) continue;
    if (row[s.attribute] === 4) { smart++; continue; }
    if (row[s.attribute] !== 0) fail('対応していないプレイリスト種別です。');
    const seen = new Set(), ids = [];
    for (const item of (memberships.get(id) ?? []).sort((a,b) => a.order - b.order)) {
      if (seen.has(item.id)) { duplicate++; continue; } seen.add(item.id);ids.push(item.id);
    }
    playlists.push({id:`rdbp-${hash(`${source}\0playlist\0${id}`)}`,name:text(row[s.listName],'プレイリスト名',80),folderPath:folders,trackIds:ids});
  }
  if (smart) warnings.push(`条件式から生成されるスマートプレイリスト${smart}件は取り込みませんでした。`);
  if (duplicate) warnings.push(`プレイリスト内の重複曲${duplicate}件をまとめました。`);
  if (s.format === 'master') masterCues(db,tracks,sourceTracks,warnings);
  else if (db.tables.has(s.cues)) warnings.push('OneLibraryのCUE・ループは、同時に選択したANLZ解析ファイルから引き継ぎます。');
  const result = validateLibrarySnapshot({format:'deckflow.library',version:1,tracks,playlists});
  return {tracks:result.tracks,playlists:result.playlists,entries,warnings,format:s.format};
}
