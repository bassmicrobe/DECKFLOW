/** Lossless, local OneLibrary mutations. Existing SQLite rows are never
 * serialized through JS or rebuilt from the application's partial snapshot. */
import initSqlJs from './vendor/sqlite-writer/sql-wasm.js?v=88e0687b343dbe25';
import {EMPTY_SQLITE_BASE64, SCHEMA, DEFAULT_ROWS} from './vendor/sqlite-writer/template.js?v=88e0687b343dbe25';
import {decrypt, encrypt, DEFAULT_KEY} from './vendor/onelibrary/sqlcipher.js?v=88e0687b343dbe25';

const MAX_BYTES = 128 * 1024 * 1024;
const fail = message => { throw new Error(`OneLibrary: ${message}`); };
const abort = signal => signal?.throwIfAborted();
const tick = () => new Promise(resolve => setTimeout(resolve, 0));
const quote = name => '"' + name.replaceAll('"', '""') + '"';
let runtimePromise;
/** wasmBytes permits deterministic, offline Node tests without network I/O. */
export function initOneLibraryWriter({wasmBytes} = {}) {
  if (!runtimePromise) runtimePromise = (async () => {
    const binary = wasmBytes ?? await (async () => {
      const response = await fetch(new URL('./vendor/sqlite-writer/sql-wasm.wasm?v=38c14f6e379210bc', import.meta.url));
      if (!response.ok) fail('SQLiteエンジンを読み込めません。');
      return new Uint8Array(await response.arrayBuffer());
    })();
    return initSqlJs({wasmBinary: binary});
  })().catch(error => { runtimePromise = undefined; throw error; });
  return runtimePromise;
}
function integer(value, label, min = 0, max = 0xffffffff) {
  if (typeof value === 'bigint') {
    if (value < BigInt(min) || value > BigInt(max)) fail(`${label}が範囲外です。`);
    return Number(value);
  }
  if (!Number.isSafeInteger(value) || value < min || value > max) fail(`${label}が範囲外です。`);
  return value;
}
function string(value, label, max = 8192) {
  if (typeof value !== 'string' || value.length > max || /[\u0000-\u001f\u007f]/u.test(value)) fail(`${label}を確認してください。`);
  return value;
}
function path(value) {
  const result = string(value, 'ファイルパス').replaceAll('\\', '/').normalize('NFC');
  if (!result.startsWith('/') || result.slice(1).split('/').some(part => !part || part === '.' || part === '..' || part.includes(':'))) fail('USB相対のファイルパスが不正です。');
  return result;
}
function rows(db, sql, parameters = [], limit = 100001) {
  const statement = db.prepare(sql);
  try {
    statement.bind(parameters);
    const result = [];
    while (statement.step()) {
      if (result.length >= limit) fail('データ件数の上限を超えています。');
      // Only known columns are selected. Unknown 64-bit values stay in SQLite.
      result.push(statement.getAsObject(null, {useBigInt: true}));
    }
    return result;
  } finally { statement.free(); }
}
const scalar = (db, sql, parameters = []) => Object.values(rows(db, sql, parameters, 1)[0] ?? {})[0];
const safeValue = value => typeof value === 'bigint' ? integer(value, '数値', -Number.MAX_SAFE_INTEGER, Number.MAX_SAFE_INTEGER) : value;
function schema(db) {
  const tables = new Map();
  for (const row of rows(db, "SELECT name FROM sqlite_schema WHERE type='table' AND name NOT LIKE 'sqlite_%'")) {
    tables.set(row.name, new Map(rows(db, `PRAGMA table_xinfo(${quote(row.name)})`).map(column => [column.name, column])));
  }
  return tables;
}
function requireColumns(tables, table, columns) {
  if (!tables.has(table) || columns.some(column => !tables.get(table).has(column))) fail(`未対応の${table}テーブル構造です。元のUSBは変更していません。`);
}
function checkSchema(tables) {
  requireColumns(tables, 'content', ['content_id', 'path', 'title', 'length', 'bpmx100', 'analysisDataFilePath']);
  requireColumns(tables, 'playlist', ['playlist_id', 'name', 'attribute', 'playlist_id_parent', 'sequenceNo']);
  requireColumns(tables, 'playlist_content', ['playlist_id', 'content_id', 'sequenceNo']);
}
function noTriggers(db, table) {
  if (rows(db, "SELECT name FROM sqlite_schema WHERE type='trigger' AND lower(tbl_name)=lower(?)", [table]).length) fail(`${table}に未対応の更新トリガーがあります。`);
}
function insert(db, tables, table, data) {
  noTriggers(db, table);
  const columns = tables.get(table);
  if (!columns) fail(`${table}テーブルがありません。`);
  const entries = Object.entries(data).filter(([name]) => columns.has(name));
  for (const [name, column] of columns) {
    if (column.notnull && column.dflt_value == null && !column.pk && !column.hidden && !entries.some(([key]) => key === name)) fail(`${table}.${name}の値が必要な未対応スキーマです。`);
  }
  db.run(`INSERT INTO ${quote(table)} (${entries.map(([name]) => quote(name)).join(',')}) VALUES (${entries.map(() => '?').join(',')})`, entries.map(([, value]) => value));
}
function maximum(db, tables, table, column) {
  if (!tables.has(table)) return 0;
  requireColumns(tables, table, [column]);
  return integer(scalar(db, `SELECT COALESCE(MAX(${quote(column)}),0) FROM ${quote(table)}`), `${table} ID`);
}
function nextId(db, tables, table, column) { return integer(maximum(db, tables, table, column) + 1, `${table} ID`, 1); }
function verifyImage(bytes) {
  if (bytes.length > MAX_BYTES || bytes.length < 4096 || bytes.length % 4096 || bytes[20] !== 80 || new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength).getUint16(16) !== 4096) fail('SQLiteのページサイズまたは予約領域を保持できません。');
}
async function open(bytes, options) {
  abort(options.signal);
  const SQL = await initOneLibraryWriter(options);
  let plain;
  if (bytes == null) plain = Uint8Array.from(atob(EMPTY_SQLITE_BASE64), character => character.charCodeAt(0));
  else {
    if (!(bytes instanceof Uint8Array) || bytes.length > MAX_BYTES) fail('128 MiB以内の完全なデータベースを指定してください。');
    plain = new TextDecoder().decode(bytes.subarray(0, 16)) === 'SQLite format 3\0' ? bytes :
      await decrypt(bytes, DEFAULT_KEY, (done, total) => options.onProgress?.({phase: 'decrypt', done, total}), {signal: options.signal});
  }
  verifyImage(plain); abort(options.signal);
  const db = new SQL.Database(plain);
  try {
    // SQLCipher's checkpointed source may carry WAL header flags. No external
    // WAL is accepted by the caller; use an internal rollback journal here.
    db.run('PRAGMA journal_mode=DELETE; PRAGMA trusted_schema=OFF; PRAGMA foreign_keys=ON;');
    if (bytes == null) {
      db.run(SCHEMA);
      const tables = schema(db);
      for (const [table, records] of Object.entries(DEFAULT_ROWS)) {
        const names = [...tables.get(table).keys()];
        for (const record of records) insert(db, tables, table, Object.fromEntries(names.map((name, index) => [name, record[index]])));
      }
      insert(db, tables, 'property', {deviceName: string(options.deviceName ?? 'DECKFLOW', 'デバイス名', 128), dbVersion: '1000', numberOfContents: 0,
        createdDate: new Date().toISOString().slice(0, 10), backGroundColorType: 0, myTagMasterDBID: 0});
      for (const [index, name] of ['Genre', 'Components', 'Situation', 'Untitled Column'].entries()) insert(db, tables, 'myTag', {myTag_id: index + 1, sequenceNo: index, name, attribute: 1, myTag_id_parent: 0});
    }
    if (scalar(db, 'PRAGMA quick_check') !== 'ok') fail('データベースが破損しています。');
    const tables = schema(db); checkSchema(tables);
    return {db, tables};
  } catch (error) { db.close(); throw error; }
}
const CONTENT_FIELDS = ['content_id','title','subtitle','bpmx100','length','path','analysisDataFilePath','fileName','fileSize','fileType','bitrate','bitDepth','samplingRate',
  'artist_id_artist','artist_id_remixer','artist_id_originalArtist','artist_id_composer','album_id','genre_id','key_id','label_id','djComment','dateAdded','dateCreated','releaseDate','releaseYear','trackNo','discNo','rating','djPlayCount','color_id'];
function inspect(db, tables) {
  const lookups = {};
  for (const table of ['artist', 'album', 'genre', 'key', 'label']) {
    requireColumns(tables, table, [`${table}_id`, 'name']);
    lookups[table] = new Map(rows(db, `SELECT ${quote(table + '_id')} AS id,name FROM ${quote(table)}`).map(row => [String(row.id), row.name]));
  }
  const selected = CONTENT_FIELDS.map(name => tables.get('content').has(name) ? quote(name) : `NULL AS ${quote(name)}`).join(',');
  const tracks = rows(db, `SELECT ${selected} FROM content ORDER BY content_id`).map(row => {
    const get = name => safeValue(row[name]);
    return {contentId: integer(row.content_id, '曲ID', 1), path: path(row.path), analysisPath: row.analysisDataFilePath ? path(row.analysisDataFilePath) : null,
      title: row.title ?? '', artist: lookups.artist.get(String(row.artist_id_artist)) ?? '', album: lookups.album.get(String(row.album_id)) ?? '',
      genre: lookups.genre.get(String(row.genre_id)) ?? '', key: lookups.key.get(String(row.key_id)) ?? '', label: lookups.label.get(String(row.label_id)) ?? '',
      remixer: lookups.artist.get(String(row.artist_id_remixer)) ?? '', composer: lookups.artist.get(String(row.artist_id_composer)) ?? '',
      originalArtist: lookups.artist.get(String(row.artist_id_originalArtist)) ?? '',
      bpm: row.bpmx100 == null || row.bpmx100 === 0n ? null : get('bpmx100') / 100, duration: get('length'),
      filename: row.fileName || row.path.split('/').at(-1), size: get('fileSize'), fileType: get('fileType'), sampleRate: get('samplingRate'),
      bitRate: get('bitrate'), bitDepth: get('bitDepth'), comments: row.djComment ?? '', mixName: row.subtitle ?? '',
      codec: ({1:'mp3',4:'m4a',5:'flac',6:'alac',11:'wav',12:'aiff'})[get('fileType')] ?? '',
      dateAdded: row.dateAdded, addedDate: row.dateAdded, dateCreated: row.dateCreated, dateModified: null, releaseDate: row.releaseDate, year: get('releaseYear'),
      trackNumber: get('trackNo'), discNumber: get('discNo'), rating: get('rating'), playCount: get('djPlayCount'), colorId:get('color_id')};
  });
  const members = new Map();
  for (const row of rows(db, 'SELECT playlist_id,content_id,sequenceNo FROM playlist_content ORDER BY playlist_id,sequenceNo', [], 1000000)) {
    const id = integer(row.playlist_id, 'プレイリストID', 1), ids = members.get(id) ?? [];
    ids.push(integer(row.content_id, '曲ID', 1)); members.set(id, ids);
  }
  const playlists = rows(db, 'SELECT playlist_id,name,playlist_id_parent,attribute,sequenceNo FROM playlist ORDER BY sequenceNo,playlist_id').map(row => ({
    playlistId: integer(row.playlist_id, 'プレイリストID', 1), name: row.name, parentId: integer(row.playlist_id_parent ?? 0n, '親ID'),
    attribute: safeValue(row.attribute), sequenceNo: safeValue(row.sequenceNo), trackIds: members.get(Number(row.playlist_id)) ?? []}));
  const maxIds = {};
  for (const [key, table, column] of [['track','content','content_id'],['artist','artist','artist_id'],['album','album','album_id'],['genre','genre','genre_id'],['key','key','key_id'],['playlist','playlist','playlist_id']]) maxIds[key] = maximum(db, tables, table, column);
  let cues = [];
  if (tables.has('cue')) {
    requireColumns(tables, 'cue', ['cue_id','content_id','kind','inUsec','outUsec','cueComment','colorTableIndex','isActiveLoop']);
    cues = rows(db, 'SELECT cue_id,content_id,kind,inUsec,outUsec,cueComment,colorTableIndex,isActiveLoop FROM cue WHERE kind BETWEEN 0 AND 8', [], 1000000).map(row => ({
      cueId: String(row.cue_id), contentId: safeValue(row.content_id), kind: safeValue(row.kind), start: row.inUsec == null ? null : safeValue(row.inUsec) / 1e6,
      end: row.outUsec != null && row.outUsec > row.inUsec ? safeValue(row.outUsec) / 1e6 : null, name: row.cueComment ?? '',
      colorTableIndex: safeValue(row.colorTableIndex), isActiveLoop: safeValue(row.isActiveLoop)}));
  }
  return {tracks, playlists, maxIds, cues};
}
export async function inspectOneLibrary(bytes, options = {}) {
  const {db, tables} = await open(bytes, options);
  try { return inspect(db, tables); } finally { db.close(); }
}

function entity(db, tables, table, name, artistId = null) {
  if (!name) return null;
  string(name, table, 1024); requireColumns(tables, table, [`${table}_id`, 'name']);
  const album = table === 'album';
  const parameters = album ? [name, artistId] : [name];
  const found = scalar(db, `SELECT ${quote(table + '_id')} FROM ${quote(table)} WHERE name=?${album ? ' AND artist_id IS ?' : ''} ORDER BY ${quote(table + '_id')} LIMIT 1`, parameters);
  if (found != null) return integer(found, table + ' ID', 1);
  const id = nextId(db, tables, table, table + '_id');
  insert(db, tables, table, {[table + '_id']: id, name, nameForSearch: null, ...(album ? {artist_id: artistId, image_id: null, isComplation: 0} : {})});
  return id;
}
function content(db, tables, entry) {
  const id = integer(entry.contentId, '曲ID', 1), track = entry.track ?? {};
  const usbPath = path(entry.usbPath), analysisPath = path(entry.analysisPath);
  if (scalar(db, 'SELECT content_id FROM content WHERE content_id=?', [id]) != null) fail(`曲ID ${id}は既に使用されています。`);
  const duration = track.duration;
  if (!Number.isFinite(duration) || duration <= 0 || duration > 86400) fail('曲の長さを確認してください。');
  const bpm = track.bpm == null ? 0 : Math.round(track.bpm * 100);
  integer(bpm, 'BPM', 0, 99999);
  const size = integer(track.size ?? track.rekordbox?.size, '音源サイズ', 1, 0xffffffff);
  const artist = entity(db, tables, 'artist', track.artist ?? '');
  const album = entity(db, tables, 'album', track.album ?? track.rekordbox?.album ?? '', artist);
  const fileType = track.fileType ?? ({mp3:1,m4a:4,aac:4,flac:5,alac:6,wav:11,aif:12,aiff:12}[usbPath.split('.').at(-1).toLowerCase()]);
  integer(fileType, 'ファイル形式', 1, 255);
  const today = new Date().toISOString().slice(0,10);
  const data = {content_id:id,title:string(track.title,'曲名',1024),titleForSearch:null,subtitle:track.mixName ?? '',bpmx100:bpm,length:Math.ceil(duration),
    trackNo:track.trackNumber ?? 0,discNo:track.discNumber ?? 0,artist_id_artist:artist,artist_id_remixer:entity(db,tables,'artist',track.remixer??''),artist_id_originalArtist:entity(db,tables,'artist',track.originalArtist??''),
    artist_id_composer:entity(db,tables,'artist',track.composer??''),artist_id_lyricist:0,album_id:album,genre_id:entity(db,tables,'genre',track.genre ?? ''),
    label_id:entity(db,tables,'label',track.label ?? ''),key_id:entity(db,tables,'key',track.key ?? ''),color_id:track.colorId??0,image_id:null,
    djComment:track.comments ?? '',rating:track.rating ?? 0,releaseYear:track.year ?? 0,releaseDate:track.releaseDate ?? '',
    dateCreated:track.dateCreated ?? today,dateAdded:track.dateAdded ?? track.addedDate ?? today,path:usbPath,fileName:usbPath.split('/').at(-1),fileSize:size,fileType,
    bitrate:track.bitRate ?? 0,bitDepth:track.bitDepth ?? 16,samplingRate:track.sampleRate ?? 44100,isrc:'',djPlayCount:track.playCount ?? 0,
    isHotCueAutoLoadOn:1,isKuvoDeliverStatusOn:1,kuvoDeliveryComment:'',masterDbId:3933607398,masterContentId:id,analysisDataFilePath:analysisPath,
    analysedBits:41,contentLink:0xC0700,hasModified:0,cueUpdateCount:0,analysisDataUpdateCount:0,informationUpdateCount:0};
  requireColumns(tables,'content',['fileName','fileSize','fileType','samplingRate','cueUpdateCount']);
  insert(db,tables,'content',data);
  const marks = entry.marks ?? track.positionMarks ?? [];
  if (!Array.isArray(marks) || marks.length > 1000) fail('CUEの件数が不正です。');
  const seen = new Set();
  for (const mark of marks) {
    const prepared = cueValues(mark, duration);
    if (prepared.kind && seen.has(prepared.kind)) fail('HOT CUEスロットが重複しています。');
    seen.add(prepared.kind);
    addCue(db,tables,id,prepared);
  }
}
function cueValues(mark, duration) {
  const num = integer(mark.num, 'CUEスロット', -1, 7);
  if (!Number.isFinite(mark.start) || mark.start < 0 || mark.start > duration + 1) fail('CUEの開始位置が範囲外です。');
  if(mark.type===4 && mark.end==null) fail('LOOPの終了位置がありません。');
  const end = mark.end == null ? mark.start : mark.end;
  if (!Number.isFinite(end) || end < mark.start || end > duration + 1 || mark.end != null && end === mark.start) fail('LOOPの終了位置が範囲外です。');
  const values = {kind:num+1,inUsec:Math.round(mark.start*1e6),outUsec:Math.round(end*1e6),cueComment:string(mark.name ?? '', 'CUE名', 1024),
    in150FramePerSec:Math.round(mark.start*150),out150FramePerSec:Math.round(end*150)};
  // RGB/XML palette values are not SQL colorTableIndex. Never guess a mapping.
  if (Object.hasOwn(mark,'colorTableIndex')) values.colorTableIndex = integer(mark.colorTableIndex,'CUE色',0,255);
  if (Object.hasOwn(mark,'isActiveLoop')) values.isActiveLoop = mark.isActiveLoop ? 1 : 0;
  else if(num<0) {
    values.isActiveLoop=end>mark.start && /^\s*\[active\]\s*/i.test(values.cueComment)?1:0;
    if(values.isActiveLoop) values.cueComment=values.cueComment.replace(/^\s*\[active\]\s*/i,'');
  }
  return values;
}
function addCue(db,tables,id,values) {
  requireColumns(tables,'cue',['cue_id','content_id','kind','inUsec','outUsec','cueComment','colorTableIndex','isActiveLoop']);
  // Let SQLite allocate its 64-bit INTEGER PRIMARY KEY; do not round-trip it.
  insert(db,tables,'cue',{content_id:id,colorTableIndex:0,isActiveLoop:values.outUsec>values.inUsec?1:0,beatLoopNumerator:null,beatLoopDenominator:null,...values});
}
function noCueReferences(db,tables,cueId) {
  if (tables.has('hotCueBankList_cue') && scalar(db,'SELECT COUNT(*) FROM hotCueBankList_cue WHERE cue_id=?',[cueId]) !== 0n) fail('HOT CUE BANKが参照するCUEは削除できません。');
  for (const table of tables.keys()) {
    for (const key of rows(db,`PRAGMA foreign_key_list(${quote(table)})`)) {
      if (key.table === 'cue' && scalar(db,`SELECT COUNT(*) FROM ${quote(table)} WHERE ${quote(key.from)}=?`,[cueId]) !== 0n) fail('別のデータが参照するCUEは削除できません。');
    }
  }
}
function hotCues(db,tables,update) {
  const id=integer(update.contentId,'曲ID',1);
  requireColumns(tables,'content',['cueUpdateCount']);
  requireColumns(tables,'cue',['cue_id','content_id','kind','inUsec','outUsec','cueComment','colorTableIndex','isActiveLoop']);
  noTriggers(db,'cue'); noTriggers(db,'content');
  const duration=scalar(db,'SELECT length FROM content WHERE content_id=?',[id]);
  if (duration==null) fail('CUEの対象曲が見つかりません。');
  if (!Array.isArray(update.marks) || update.marks.length>8) fail('HOT CUEはA〜Hを指定してください。');
  const desired=new Map();
  for(const mark of update.marks) {
    const values=cueValues(mark,safeValue(duration));
    if(values.kind===0 || desired.has(values.kind)) fail('HOT CUEスロットが不正です。');
    desired.set(values.kind,values);
  }
  const existing=rows(db,'SELECT CAST(cue_id AS TEXT) AS id,kind,inUsec,outUsec,cueComment,colorTableIndex,isActiveLoop FROM cue WHERE content_id=? AND kind BETWEEN 1 AND 8',[id]);
  if(new Set(existing.map(row=>String(row.kind))).size!==existing.length) fail('同じHOT CUEスロットが重複しています。');
  let changed=false;
  for(const row of existing) {
    const kind=Number(row.kind), next=desired.get(kind); desired.delete(kind);
    if(!next) {noCueReferences(db,tables,row.id);db.run('DELETE FROM cue WHERE cue_id=?',[row.id]);changed=true;continue;}
    const updates={};
    const previousEnd=row.outUsec!=null&&row.outUsec>row.inUsec?row.outUsec:row.inUsec;
    const moved=row.inUsec!==BigInt(next.inUsec) || previousEnd!==BigInt(next.outUsec);
    if(moved) {
      Object.assign(updates,{inUsec:next.inUsec,outUsec:next.outUsec,in150FramePerSec:next.in150FramePerSec,out150FramePerSec:next.out150FramePerSec,
        beatLoopNumerator:null,beatLoopDenominator:null});
      const seekColumns=new Set(['inMpegFrameNumber','outMpegFrameNumber','inMpegAbs','outMpegAbs','inDecodingStartFramePosition','outDecodingStartFramePosition','inFileOffsetInBlock','outFileOffsetInBlock','inNumberOfSampleInBlock','outNumberOfSampleInBlock'].map(name=>name.toLowerCase()));
      for(const column of tables.get('cue').keys()) if(seekColumns.has(column.toLowerCase())) updates[column]=null;
      if(next.inUsec===next.outUsec) updates.isActiveLoop=0;
      else if(row.inUsec===row.outUsec) updates.isActiveLoop=1;
    }
    if((row.cueComment??'')!==next.cueComment) updates.cueComment=next.cueComment;
    if(Object.hasOwn(next,'colorTableIndex') && row.colorTableIndex!==BigInt(next.colorTableIndex)) updates.colorTableIndex=next.colorTableIndex;
    if(Object.hasOwn(next,'isActiveLoop') && row.isActiveLoop!==BigInt(next.isActiveLoop)) updates.isActiveLoop=next.isActiveLoop;
    const entries=Object.entries(updates).filter(([column])=>tables.get('cue').has(column));
    if(entries.length) {db.run(`UPDATE cue SET ${entries.map(([column])=>quote(column)+'=?').join(',')} WHERE cue_id=?`,[...entries.map(([,value])=>value),row.id]);changed=true;}
  }
  for(const values of desired.values()) {addCue(db,tables,id,values);changed=true;}
  if(changed) {
    db.run('UPDATE content SET cueUpdateCount=COALESCE(cueUpdateCount,0)+1 WHERE content_id=? AND (cueUpdateCount IS NULL OR (typeof(cueUpdateCount)=\'integer\' AND cueUpdateCount>=0 AND cueUpdateCount<9223372036854775807))',[id]);
    if(db.getRowsModified()!==1) fail('CUE更新カウンターが範囲外です。');
  }
}
function appendMembers(db,tables,playlistId,trackIds,{preserveDuplicates=false}={}) {
  integer(playlistId,'プレイリストID',1);
  if(scalar(db,'SELECT attribute FROM playlist WHERE playlist_id=?',[playlistId])!==0n) fail('曲を追加できるプレイリストが見つかりません。');
  if(!Array.isArray(trackIds)||trackIds.length>100000) fail('プレイリストの曲数が不正です。');
  const existing=new Set(rows(db,'SELECT content_id FROM playlist_content WHERE playlist_id=?',[playlistId]).map(row=>String(row.content_id)));
  let sequence=integer(scalar(db,'SELECT COALESCE(MAX(sequenceNo),0) FROM playlist_content WHERE playlist_id=?',[playlistId]),'曲順',0,Number.MAX_SAFE_INTEGER);
  for(const value of trackIds) {
    const id=integer(value,'曲ID',1);
    if(scalar(db,'SELECT content_id FROM content WHERE content_id=?',[id])==null) fail('プレイリストに存在しない曲が含まれています。');
    if(!preserveDuplicates&&existing.has(String(id))) continue;
    insert(db,tables,'playlist_content',{playlist_id:playlistId,content_id:id,sequenceNo:++sequence});existing.add(String(id));
  }
}

/** addTracks IDs and playlist IDs are explicit: the caller aligns new IDs
 * with the Device Library plan. Existing IDs may differ between formats.
 * hotCueUpdates[].marks is the COMPLETE desired A..H set for that track;
 * absent slots are removed, memory/unknown kinds and unrelated tracks stay.
 * Native USB CAS/journaling belongs to the caller; this function returns bytes.
 */
export async function updateOneLibrary(bytes, changes = {}) {
  const {addTracks=[],addPlaylists=[],appendPlaylistTracks=[],hotCueUpdates=[],signal,onProgress}=changes;
  for(const list of [addTracks,addPlaylists,appendPlaylistTracks,hotCueUpdates]) if(!Array.isArray(list)||list.length>10000) fail('更新件数が不正です。');
  const {db,tables}=await open(bytes,changes);
  try {
    db.run('BEGIN IMMEDIATE');
    const paths=new Set(rows(db,'SELECT path FROM content').map(row=>path(row.path).toLocaleLowerCase('en-US')));
    for(const [index,entry] of addTracks.entries()) {
      abort(signal);const key=path(entry.usbPath).toLocaleLowerCase('en-US');if(paths.has(key)) fail('同じ音源パスが既に登録されています。');
      content(db,tables,entry);paths.add(key);onProgress?.({phase:'tracks',done:index+1,total:addTracks.length});
      if(index%32===0) await tick();
    }
    const pending=[...addPlaylists];
    while(pending.length) {
      let advanced=false;
      for(let index=pending.length-1;index>=0;index--) {
        const list=pending[index],id=integer(list.playlistId,'プレイリストID',1),parent=integer(list.parentId??0,'親ID');
        if(scalar(db,'SELECT playlist_id FROM playlist WHERE playlist_id=?',[id])!=null) fail('プレイリストIDが重複しています。');
        const parentKind=parent?scalar(db,'SELECT attribute FROM playlist WHERE playlist_id=?',[parent]):1n;
        if(parentKind==null) continue;if(parentKind!==1n) fail('プレイリストの親はフォルダーにしてください。');
        const attribute=integer(list.attribute??0,'プレイリスト種別',0,1);
        const sequence=list.sequenceNo??integer(scalar(db,'SELECT COALESCE(MAX(sequenceNo),0)+1 FROM playlist WHERE COALESCE(playlist_id_parent,0)=?',[parent]),'並び順');
        insert(db,tables,'playlist',{playlist_id:id,name:string(list.name,'プレイリスト名',1024),sequenceNo:integer(sequence,'並び順'),image_id:null,attribute,playlist_id_parent:parent});
        if(attribute===0) appendMembers(db,tables,id,list.trackIds??[],{preserveDuplicates:true});
        else if(list.trackIds?.length) fail('フォルダーに曲を直接追加できません。');
        pending.splice(index,1);advanced=true;
      }
      if(!advanced) fail('プレイリストの親が存在しないか循環しています。');
      abort(signal);await tick();
    }
    for(const list of appendPlaylistTracks) {abort(signal);appendMembers(db,tables,list.playlistId,list.trackIds);}
    const touched=new Set();
    for(const update of hotCueUpdates) {abort(signal);if(touched.has(update.contentId)) fail('同じ曲のCUE更新が重複しています。');hotCues(db,tables,update);touched.add(update.contentId);await tick();}
    if(addTracks.length) {requireColumns(tables,'property',['numberOfContents']);noTriggers(db,'property');db.run('UPDATE property SET numberOfContents=(SELECT COUNT(*) FROM content)');}
    if(scalar(db,'PRAGMA integrity_check')!=='ok') fail('更新後のSQLite検証に失敗しました。');
    if(rows(db,'PRAGMA foreign_key_check').length) fail('更新後の関連データの整合性を確認できません。');
    abort(signal);db.run('COMMIT');
    const plain=db.export();verifyImage(plain);
    return await encrypt(plain,DEFAULT_KEY,(done,total)=>onProgress?.({phase:'encrypt',done,total}),{signal});
  } catch(error) {try{db.run('ROLLBACK');}catch{}throw error;}
  finally {db.close();}
}
