/** Read-only, bounded adapter for native USB files. The store copies its bytes
 * into owned chunks; it never persists a native permission or file reference. */
const sources = new WeakSet();
export const isAudioReadSource = value => value != null && sources.has(value);
export function createAudioReadSource({name, size, type = '', lastModified = 0, read}) {
  if (typeof name !== 'string' || !Number.isSafeInteger(size) || size < 0 ||
      typeof type !== 'string' || type.length > 255 || /[^\x20-\x7e]/.test(type) || typeof read !== 'function') {
    throw new TypeError('音源の読み取り情報が正しくありません。');
  }
  const range = (start, end) => ({async arrayBuffer() {
    const bytes = new Uint8Array(end - start);
    for (let offset = start; offset < end; offset += 1024 * 1024) {
      const length = Math.min(1024 * 1024, end - offset), chunk = await read(offset, length);
      if (!(chunk instanceof Uint8Array) || chunk.byteLength !== length) throw new Error('USBのファイルを最後まで読み取れませんでした。');
      bytes.set(chunk, offset - start);
    }
    return bytes.buffer;
  }});
  const source = Object.freeze({name, size, type, lastModified,
    slice(start = 0, end = size) {
      const clamp = value => Math.max(0, Math.min(size, value < 0 ? size + Math.trunc(value) : Math.trunc(value)));
      start = clamp(start); end = Math.max(start, clamp(end));
      if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end)) throw new RangeError('読み取り範囲を確認してください。');
      return range(start, end);
    },
    arrayBuffer: () => range(0, size).arrayBuffer(),
  });
  sources.add(source); return source;
}
export async function ownAudioReadSource(source) {
  const parts = [];
  for (let offset = 0; offset < source.size; offset += 1024 * 1024) {
    parts.push(await source.slice(offset, offset + 1024 * 1024).arrayBuffer());
  }
  return new Blob(parts, {type:source.type});
}
