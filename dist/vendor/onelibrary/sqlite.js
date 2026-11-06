// Adapted from v1vendi/onelibrary (MIT). See LICENSE and NOTICE.md.
// Read-only table b-tree reader. No SQL is executed, no database is mutated.
const TEXT = new TextDecoder('utf-8', {fatal:true});
const MAX_ROWS = 250_000, MAX_PAYLOAD = 16 * 1024 * 1024;
export class SQLiteError extends Error {}
function fail(message) { throw new SQLiteError(message); }
function range(bytes, offset, length) {
  if (!Number.isSafeInteger(offset) || !Number.isSafeInteger(length) || offset < 0 || length < 0 || offset + length > bytes.length) fail('truncated SQLite data');
}
function integer(value, min, max) { if (!Number.isSafeInteger(value) || value < min || value > max) fail('invalid SQLite integer'); return value; }
function readVarint(bytes, offset) {
  let value = 0n;
  for (let i = 0; i < 9; i++) {
    range(bytes, offset + i, 1);
    const b = bytes[offset + i];
    value = (value << BigInt(i === 8 ? 8 : 7)) | BigInt(i === 8 ? b : b & 0x7f);
    if (!(b & 0x80) || i === 8) {
      const n = Number(BigInt.asIntN(64, value));
      if (!Number.isSafeInteger(n)) fail('SQLite integer exceeds supported range');
      return [n, i + 1];
    }
  }
}
function decodeValues(bytes, offset, serialTypes) {
  const out = []; let p = offset;
  for (const t of serialTypes) {
    integer(t, 0, MAX_PAYLOAD * 2 + 13);
    if (t === 0) { out.push(null); continue; }
    if (t === 8 || t === 9) { out.push(t - 8); continue; }
    if (t === 10 || t === 11) fail('reserved SQLite serial type');
    const len = t <= 6 ? [0,1,2,3,4,6,8][t] : t === 7 ? 8 : Math.floor((t - 12) / 2);
    range(bytes, p, len);
    if (t <= 6) {
      let value = 0n;
      for (let i = 0; i < len; i++) value = (value << 8n) | BigInt(bytes[p + i]);
      const n = Number(BigInt.asIntN(len * 8, value));
      if (!Number.isSafeInteger(n)) fail('SQLite integer exceeds supported range');
      out.push(n);
    } else if (t === 7) {
      const n = new DataView(bytes.buffer, bytes.byteOffset + p, 8).getFloat64(0);
      if (!Number.isFinite(n)) fail('nonfinite SQLite number');
      out.push(n);
    } else if (t % 2) out.push(TEXT.decode(bytes.subarray(p, p + len)));
    else out.push(bytes.slice(p, p + len));
    p += len;
  }
  if (p !== bytes.length) fail('SQLite record length mismatch');
  return out;
}
export class SQLiteDatabase {
  constructor(image) {
    if (!(image instanceof Uint8Array) || image.length < 512 || image.length > 128 * 1024 * 1024) fail('unsupported SQLite size');
    if (TEXT.decode(image.subarray(0,16)) !== 'SQLite format 3\0') fail('not a SQLite database');
    const dv = new DataView(image.buffer, image.byteOffset, image.length);
    const encodedSize = dv.getUint16(16);
    this.pageSize = encodedSize === 1 ? 65536 : encodedSize;
    if (this.pageSize < 512 || this.pageSize > 65536 || (this.pageSize & (this.pageSize - 1)) || image.length % this.pageSize) fail('invalid SQLite page geometry');
    this.data = image; this.reserve = image[20]; this.usable = this.pageSize - this.reserve;
    this.pageCount = image.length / this.pageSize;
    if (this.usable < 480 || ![1,2].includes(image[18]) || ![1,2].includes(image[19]) || image[21] !== 64 || image[22] !== 32 || image[23] !== 32 || ![0,1].includes(dv.getUint32(56))) fail('unsupported SQLite header/encoding');
    if (dv.getUint32(28) > this.pageCount) fail('truncated SQLite database');
    this.tables = this._readMaster();
  }
  _page(n) {
    integer(n, 1, this.pageCount);
    return this.data.subarray((n - 1) * this.pageSize, n * this.pageSize);
  }
  _payload(page, offset, totalLen, seen) {
    integer(totalLen, 1, MAX_PAYLOAD);
    const maxLocal = this.usable - 35;
    let local = totalLen;
    if (totalLen > maxLocal) {
      const minLocal = Math.floor((this.usable - 12) * 32 / 255) - 23;
      local = minLocal + ((totalLen - minLocal) % (this.usable - 4));
      if (local > maxLocal) local = minLocal;
    }
    range(page.subarray(0,this.usable), offset, local + (local < totalLen ? 4 : 0));
    if (local === totalLen) return page.subarray(offset, offset + local);
    const out = new Uint8Array(totalLen); out.set(page.subarray(offset, offset + local));
    let got = local, next = new DataView(page.buffer,page.byteOffset,page.length).getUint32(offset + local);
    while (got < totalLen) {
      if (seen.has(next)) fail('cyclic/reused SQLite overflow page');
      seen.add(next);
      const ov = this._page(next), take = Math.min(this.usable - 4, totalLen - got);
      out.set(ov.subarray(4,4 + take),got); got += take;
      next = new DataView(ov.buffer,ov.byteOffset,ov.length).getUint32(0);
    }
    if (next !== 0) fail('SQLite overflow exceeds payload');
    return out;
  }
  *_walk(pageNo, state = {seen:new Set(),rows:0}, depth = 0) {
    if (depth > 64 || state.seen.has(pageNo)) fail('cyclic/overdeep SQLite b-tree');
    state.seen.add(pageNo);
    const page = this._page(pageNo), base = pageNo === 1 ? 100 : 0;
    const type = page[base], dv = new DataView(page.buffer,page.byteOffset,page.length);
    if (![5,13].includes(type)) fail('unsupported SQLite b-tree type');
    const count = dv.getUint16(base + 3), headerLen = type === 5 ? 12 : 8;
    range(page.subarray(0,this.usable), base + headerLen, count * 2);
    const pointers = new Set();
    for (let i = 0; i < count; i++) {
      const ptr = dv.getUint16(base + headerLen + i * 2);
      if (ptr < base + headerLen + count * 2 || ptr >= this.usable || pointers.has(ptr)) fail('invalid SQLite cell pointer');
      pointers.add(ptr);
      if (type === 5) {
        range(page.subarray(0,this.usable),ptr,4);
        yield* this._walk(dv.getUint32(ptr),state,depth + 1); continue;
      }
      let p = ptr;
      const usable = page.subarray(0,this.usable);
      const [payloadLen,n1] = readVarint(usable,p); p += n1;
      const [rowid,n2] = readVarint(usable,p); p += n2;
      const payload = this._payload(page,p,payloadLen,state.seen);
      const [headerSize,n3] = readVarint(payload,0);
      integer(headerSize,n3,payload.length);
      const types = []; let q = n3;
      while (q < headerSize) {
        const [t,n] = readVarint(payload.subarray(0,headerSize),q); types.push(t); q += n;
        if (types.length > 512) fail('SQLite record has too many columns');
      }
      if (q !== headerSize || ++state.rows > MAX_ROWS) fail('SQLite row limit exceeded');
      yield [rowid,decodeValues(payload,headerSize,types)];
    }
    if (type === 5) yield* this._walk(dv.getUint32(base + 8),state,depth + 1);
  }
  _readMaster() {
    const tables = new Map();
    for (const [,row] of this._walk(1)) {
      const [type,name,,rootpage,sql] = row;
      if (type !== 'table' || String(name).startsWith('sqlite_')) continue;
      if (typeof name !== 'string' || typeof sql !== 'string' || name.length > 255 || sql.length > 131072 || tables.has(name)) fail('invalid SQLite schema');
      if (tables.size >= 512) fail('too many SQLite tables');
      // Ignore virtual tables until selected; their data is not a table b-tree.
      tables.set(name,{name,rootpage,sql,columns:parseColumns(sql),rowidAlias:rowidAlias(sql)});
    }
    return tables;
  }
  select(table, {maxRows = MAX_ROWS} = {}) {
    const meta = this.tables.get(table);
    if (!meta || /\bWITHOUT\s+ROWID\b|\bVIRTUAL\s+TABLE\b/i.test(meta.sql)) fail(`unsupported/missing table: ${table}`);
    const rows = [];
    for (const [rowid,values] of this._walk(meta.rootpage)) {
      if (values.length > meta.columns.length) fail('SQLite column count mismatch');
      const obj = Object.create(null);
      meta.columns.forEach((c,i) => { obj[c] = c === meta.rowidAlias ? rowid : values[i] ?? null; });
      rows.push(obj); if (rows.length > maxRows) fail(`too many rows in ${table}`);
    }
    return rows;
  }
  tableNames() { return [...this.tables.keys()].sort(); }
}
const CONSTRAINT = /^(constraint|primary|unique|check|foreign)\b/i;
function identifierPart(s) {
  const m = /^(?:"((?:[^"]|"")+)"|`((?:[^`]|``)+)`|\[([^\]]+)\]|([^\s]+))/.exec(s);
  if (!m) fail('invalid SQLite column identifier');
  return (m[1] ?? m[2] ?? m[3] ?? m[4]).replace(/""/g,'"').replace(/``/g,'`');
}
export function parseColumns(sql) {
  const m = /\(([\s\S]*)\)\s*(?:WITHOUT\s+ROWID|STRICT)?\s*$/i.exec(sql || '');
  if (!m) return [];
  const parts = []; let current = '', depth = 0, quote = null;
  for (let i = 0; i < m[1].length; i++) {
    const ch = m[1][i];
    if (quote) {
      current += ch;
      if (ch === quote) { if (m[1][i+1] === quote && quote !== ']') current += m[1][++i]; else quote = null; }
      continue;
    }
    if (['"',"'",'`','['].includes(ch)) quote = ch === '[' ? ']' : ch;
    else if (ch === '(') depth++;
    else if (ch === ')') { if (--depth < 0) fail('invalid SQLite schema parentheses'); }
    if (ch === ',' && depth === 0 && !quote) { parts.push(current); current = ''; } else current += ch;
  }
  if (quote || depth) fail('unclosed SQLite schema token');
  parts.push(current);
  const cols = parts.map(s => s.trim()).filter(s => s && !CONSTRAINT.test(s)).map(identifierPart);
  if (cols.length > 512 || new Set(cols).size !== cols.length) fail('invalid SQLite columns');
  return cols;
}
export function rowidAlias(sql) {
  if (/\bWITHOUT\s+ROWID\b/i.test(sql)) return null;
  const inline = /[(,]\s*["`[]?(\w+)["`\]]?\s+integer\s+primary\s+key(?!\s+desc\b)/i.exec(sql || '');
  if (inline) return inline[1];
  const pk = /\bprimary\s+key\s*\(\s*["`[]?(\w+)["`\]]?\s*\)/i.exec(sql || '');
  if (!pk) return null;
  const declared = new RegExp(`[(,]\\s*["\x60[]?${pk[1]}["\x60\\]]?\\s+integer\\b`,'i');
  return declared.test(sql) ? pk[1] : null;
}
