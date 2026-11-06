/** File-backed PCM keeps large WAV audio out of a whole-track AudioBuffer.
 * RIFF chunks and WAVEFORMATEXTENSIBLE follow Microsoft's mmreg definitions.
 * No files are uploaded; each read is a bounded slice of the selected Blob.
 */
const MAX_READ_BYTES = 8 * 1024 * 1024;
const SMALL_DECODE_BYTES = 32 * 1024 * 1024;
const MAX_CHUNKS = 65536;
const fail = message => { throw new Error(`WAVを開けません。${message}`); };
const fourCC = (bytes, offset = 0) => String.fromCharCode(...bytes.subarray(offset, offset + 4));

function validateFile(blob) {
  if (!Number.isSafeInteger(blob?.size) || blob.size <= 0 || typeof blob.slice !== 'function') {
    throw new TypeError('読み込める音声ファイルを選んでください。');
  }
}

async function readBytes(blob, start, length, signal) {
  signal?.throwIfAborted();
  if (!Number.isSafeInteger(start) || !Number.isSafeInteger(length) || start < 0 || length < 0 ||
      length > MAX_READ_BYTES || start + length > blob.size) fail('ファイルの範囲または読み取り量が正しくありません。');
  let bytes;
  try { bytes = await blob.slice(start, start + length).arrayBuffer(); }
  catch (cause) {
    signal?.throwIfAborted();
    throw new Error('元の音源を読み取れません。音源の接続を確認して、ファイルを選び直してください。', {cause});
  }
  signal?.throwIfAborted();
  if (!(bytes instanceof ArrayBuffer) || bytes.byteLength !== length) fail('ファイルが途中で切れています。選択し直してください。');
  return new Uint8Array(bytes);
}

function waveFormat(bytes, chunkBytes) {
  if (bytes.length < 16) fail('fmtチャンクが不足しています。');
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const tag = view.getUint16(0, true), channels = view.getUint16(2, true);
  const sampleRate = view.getUint32(4, true), byteRate = view.getUint32(8, true);
  const blockAlign = view.getUint16(12, true), bits = view.getUint16(14, true);
  let format = tag, validBits = bits;
  if (tag === 0xfffe) {
    if (bytes.length < 40 || view.getUint16(16, true) < 22 || 18 + view.getUint16(16, true) > chunkBytes) fail('拡張fmtチャンクが不足しています。');
    validBits = view.getUint16(18, true);
    const suffix = [0, 0, 0x10, 0, 0x80, 0, 0, 0xaa, 0, 0x38, 0x9b, 0x71];
    if (!suffix.every((value, index) => bytes[28 + index] === value)) fail('未対応の拡張音声形式です。PCMまたはIEEE floatで保存してください。');
    format = view.getUint32(24, true);
    const mask = view.getUint32(20, true);
    const speakers = mask.toString(2).replaceAll('0', '').length;
    if (mask && speakers !== channels) fail('チャンネル配置とチャンネル数が一致しません。');
  }
  if (![1, 3].includes(format)) fail('このWAVの圧縮方式には対応していません。PCMまたはIEEE floatで保存してください。');
  if (channels < 1 || channels > 32 || sampleRate < 1000 || sampleRate > 384000 ||
      !(format === 1 ? [8, 16, 24, 32] : [32, 64]).includes(bits) ||
      validBits < 1 || validBits > bits || (format === 3 && validBits !== bits) ||
      blockAlign !== channels * bits / 8 || byteRate !== sampleRate * blockAlign) {
    fail('サンプルレート、チャンネル数、ビット数またはフレーム幅を確認してください。');
  }
  return {format: format === 1 ? 'pcm' : 'float', sampleRate, numberOfChannels: channels,
    bitsPerSample: bits, validBitsPerSample: validBits, blockAlign, byteRate};
}

/** Accepts a Blob or a size/slice adapter, including the read-only Mac helper. */
export async function readWavInfo(blob, {signal} = {}) {
  validateFile(blob);
  signal?.throwIfAborted();
  if (blob.size < 12) return null;
  const header = await readBytes(blob, 0, 12, signal), signature = fourCC(header);
  if (['RF64', 'BW64', 'RIFX'].includes(signature)) fail('RF64・BW64・ビッグエンディアンWAVには対応していません。RIFF/WAVEを選んでください。');
  if (signature !== 'RIFF' || fourCC(header, 8) !== 'WAVE') return null;
  const end = new DataView(header.buffer).getUint32(4, true) + 8;
  if (end < 12 || end > blob.size) fail('RIFFの長さがファイルの範囲外です。');
  let format = null, data = null, offset = 12, chunks = 0;
  while (offset < end) {
    if (++chunks > MAX_CHUNKS || offset + 8 > end) fail('チャンク構造を確認してください。');
    const chunk = await readBytes(blob, offset, 8, signal);
    const tag = fourCC(chunk), size = new DataView(chunk.buffer).getUint32(4, true), start = offset + 8;
    if (start + size > end || start + size + size % 2 > end) fail('チャンクが途中で切れています。');
    if (tag === 'fmt ') {
      if (format) fail('fmtチャンクが重複しています。');
      format = waveFormat(await readBytes(blob, start, Math.min(size, 40), signal), size);
    }
    if (tag === 'data') {
      if (data) fail('複数のdataチャンクには対応していません。');
      data = {dataOffset: start, dataBytes: size};
    }
    offset = start + size + size % 2;
  }
  if (!format || !data || !data.dataBytes || data.dataBytes % format.blockAlign) fail('音声データまたはフレーム境界が正しくありません。');
  const length = data.dataBytes / format.blockAlign;
  return Object.freeze({...format, ...data, length, duration: length / format.sampleRate});
}

function sampleValue(view, offset, info) {
  if (info.format === 'float') {
    const value = info.bitsPerSample === 32 ? view.getFloat32(offset, true) : view.getFloat64(offset, true);
    // Float WAV can legitimately exceed full scale; keep that headroom for the
    // mixer/limiter instead of clipping before the user can reduce the level.
    const sample = Math.fround(value);
    return Number.isFinite(sample) ? sample : 0;
  }
  if (info.bitsPerSample === 8) return (view.getUint8(offset) - 128) / 128;
  if (info.bitsPerSample === 16) return view.getInt16(offset, true) / 32768;
  if (info.bitsPerSample === 24) {
    const raw = view.getUint8(offset) | view.getUint8(offset + 1) << 8 | view.getUint8(offset + 2) << 16;
    return (raw << 8 >> 8) / 8388608;
  }
  return view.getInt32(offset, true) / 2147483648;
}

function fileResource(blob, info) {
  const maxReadFrames = Math.floor(MAX_READ_BYTES / Math.max(info.blockAlign, info.numberOfChannels * 4));
  return Object.freeze({kind: 'pcm-file', ...info, maxReadFrames,
    async readFrames(start, count, {signal} = {}) {
      if (!Number.isSafeInteger(start) || !Number.isSafeInteger(count) || count < 0 || count > maxReadFrames) {
        throw new RangeError(`音声の読み取り範囲を確認してください（1回${maxReadFrames}フレームまで）。`);
      }
      signal?.throwIfAborted();
      const first = Math.max(0, Math.min(info.length, start)), frames = Math.min(count, info.length - first);
      const channels = Array.from({length: info.numberOfChannels}, () => new Float32Array(frames));
      if (!frames) return channels;
      const bytes = await readBytes(blob, info.dataOffset + first * info.blockAlign, frames * info.blockAlign, signal);
      const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength), sampleBytes = info.bitsPerSample / 8;
      for (let frame = 0; frame < frames; frame++) {
        for (let channel = 0; channel < channels.length; channel++) {
          channels[channel][frame] = sampleValue(view, frame * info.blockAlign + channel * sampleBytes, info);
        }
      }
      return channels;
    },
  });
}

export function isPcmFileResource(value) {
  return value?.kind === 'pcm-file' && typeof value.readFrames === 'function' &&
    Number.isSafeInteger(value.length) && value.length > 0 && Number.isSafeInteger(value.numberOfChannels) &&
    value.numberOfChannels > 0 && value.numberOfChannels <= 32 && Number.isFinite(value.sampleRate) && value.sampleRate > 0;
}

export async function openAudioFile(blob, context, {signal} = {}) {
  validateFile(blob);
  const info = await readWavInfo(blob, {signal});
  const decodedRate = info ? Math.max(info.sampleRate, Number.isFinite(context?.sampleRate) ? context.sampleRate : info.sampleRate) : 0;
  if (info && (blob.size > SMALL_DECODE_BYTES || Math.ceil(info.duration * decodedRate) * info.numberOfChannels * 4 > SMALL_DECODE_BYTES)) {
    return fileResource(blob, info);
  }
  signal?.throwIfAborted();
  let buffer;
  try {
    const bytes = await blob.arrayBuffer();
    signal?.throwIfAborted();
    buffer = await context.decodeAudioData(bytes);
  } catch (cause) {
    signal?.throwIfAborted();
    throw new Error('音声を開けません。このブラウザーで再生できる音源、またはPCM WAVを選んでください。', {cause});
  }
  signal?.throwIfAborted();
  if (!Number.isSafeInteger(buffer?.length) || buffer.length <= 0 || !Number.isFinite(buffer.duration) || buffer.duration <= 0 ||
      !Number.isSafeInteger(buffer.numberOfChannels) || buffer.numberOfChannels < 1 || buffer.numberOfChannels > 32) {
    throw new Error('音声の長さまたはチャンネル数を読み取れませんでした。');
  }
  return buffer;
}
