import {open} from 'node:fs/promises';

/** A real 1 GiB sparse file: synthetic clicks in several windows, silence elsewhere. */
export async function writeLargeWav(path, {bytes = 1024 ** 3, sampleRate = 48000} = {}) {
  const frames = Math.floor((bytes - 44) / 4), duration = frames / sampleRate;
  const header = Buffer.alloc(44);
  header.write('RIFF'); header.writeUInt32LE(36 + frames * 4, 4); header.write('WAVEfmt ', 8);
  header.writeUInt32LE(16, 16); header.writeUInt16LE(1, 20); header.writeUInt16LE(2, 22);
  header.writeUInt32LE(sampleRate, 24); header.writeUInt32LE(sampleRate * 4, 28);
  header.writeUInt16LE(4, 32); header.writeUInt16LE(16, 34); header.write('data', 36);
  header.writeUInt32LE(frames * 4, 40);
  const file = await open(path, 'wx');
  try {
    await file.truncate(44 + frames * 4); await file.write(header, 0, header.length, 0);
    const second = Buffer.alloc(sampleRate * 4);
    for (let i = 0; i < sampleRate; i++) {
      const time = i / sampleRate, beat = time % .5;
      const sample = Math.round(22000 * Math.sin(2 * Math.PI * 110 * time) * Math.exp(-beat * 24));
      second.writeInt16LE(sample, i * 4); second.writeInt16LE(-sample, i * 4 + 2);
    }
    const starts = [0, ...[.12,.46,.78].map(part => Math.floor(duration * part)), Math.floor(duration) - 42];
    for (const start of starts) for (let offset = 0; offset < 41; offset++) {
      await file.write(second, 0, second.length, 44 + (start + offset) * sampleRate * 4);
    }
    return {bytes:44 + frames * 4, duration, sampleRate, channels:2};
  } finally { await file.close(); }
}
