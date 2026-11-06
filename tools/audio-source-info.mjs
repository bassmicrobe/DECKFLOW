/** Read source headers with bounded positional I/O; never load an audio file whole. */
import {open} from 'node:fs/promises';
import {readWavInfo} from '../dist/audio-resource.js';

const MAX_HEADER_READ = 1024 * 1024;
const MAX_DEVICE_FILE_BYTES = 0xffffffff;

export async function sourceAudioInfo(path) {
  const file = await open(path, 'r');
  try {
    const stat = await file.stat();
    if (!stat.isFile() || !Number.isSafeInteger(stat.size) || stat.size <= 0) {
      throw new Error('元音源には空でない通常ファイルを指定してください。');
    }
    // Device Library uses a uint32 byte count. baken would silently saturate
    // larger values; refuse an inaccurate legacy device export explicitly.
    if (stat.size > MAX_DEVICE_FILE_BYTES) {
      throw new Error('この音源は従来のDevice Libraryが記録できる4 GiB未満の範囲を超えています。Webの取り込み制限ではなく、USB書き出し形式の上限です。');
    }
    const blob = {size:stat.size, slice(start, end) {
      const count = Math.min(end, stat.size) - start;
      if (!Number.isSafeInteger(start) || !Number.isSafeInteger(count) || start < 0 || count < 0 || count > MAX_HEADER_READ) {
        throw new Error('音源ヘッダーの読み取り範囲が不正です。');
      }
      return {async arrayBuffer() {
        const bytes = Buffer.alloc(count);
        const {bytesRead} = await file.read(bytes, 0, count, start);
        if (bytesRead !== count) throw new Error('音源ファイルが変更されたか、途中までしか読み取れませんでした。');
        return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.length);
      }};
    }};
    const wav = await readWavInfo(blob);
    return {size:stat.size, ...(wav ? {sampleRate:wav.sampleRate,
      bitRate:Math.floor(wav.byteRate * 8 / 1000), duration:wav.duration} : {})};
  } finally { await file.close(); }
}

export async function sourceAudioMetadata(library, sources) {
  const entries = [];
  for (const track of library.tracks) {
    const info = await sourceAudioInfo(sources.get(track.id));
    if (track.rekordbox?.size != null && track.rekordbox.size !== info.size) {
      throw new Error(`${track.filename}: 元ライブラリと音源のファイルサイズが一致しません。元の音源を選んでください。`);
    }
    if (info.duration != null && Math.abs(info.duration - track.duration) > 1.1) {
      throw new Error(`${track.filename}: 曲情報と元音源の長さが一致しません。元の音源を選んでください。`);
    }
    entries.push([track.id, info]);
  }
  return new Map(entries);
}

export function verifyAudioMetadata(track, deviceTrack, info) {
  if (deviceTrack.size !== info.size || deviceTrack.duration !== Math.ceil(track.duration) ||
      (info.sampleRate != null && deviceTrack.sampleRate !== info.sampleRate) ||
      (info.bitRate != null && deviceTrack.bitRate !== info.bitRate)) {
    throw new Error(`${track.filename}: PDBの音源サイズ・曲長・サンプルレート・ビットレートが元音源と一致しません。`);
  }
}
