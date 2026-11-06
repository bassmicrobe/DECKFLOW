import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp, open, writeFile, rm} from 'node:fs/promises';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {sourceAudioInfo, sourceAudioMetadata, verifyAudioMetadata} from '../tools/audio-source-info.mjs';

function header(frames = 96000) {
  const result = Buffer.alloc(44);
  result.write('RIFF'); result.writeUInt32LE(36 + frames * 6, 4); result.write('WAVEfmt ', 8);
  result.writeUInt32LE(16, 16); result.writeUInt16LE(1, 20); result.writeUInt16LE(2, 22);
  result.writeUInt32LE(96000, 24); result.writeUInt32LE(576000, 28);
  result.writeUInt16LE(6, 32); result.writeUInt16LE(24, 34);
  result.write('data', 36); result.writeUInt32LE(frames * 6, 40);
  return result;
}

test('source headers supply measured metadata without reading audio data into memory', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'deckflow-source-info-'));
  const path = join(directory, 'source.wav'), frames = Math.floor(1024 ** 3 / 6);
  try {
    const file = await open(path, 'wx');
    try { await file.write(header(frames)); await file.truncate(44 + frames * 6); }
    finally { await file.close(); }
    assert.deepEqual(await sourceAudioInfo(path), {size:44 + frames * 6, sampleRate:96000,
      bitRate:4608, duration:frames / 96000});
    const library = {tracks:[{id:'a', filename:'source.wav', duration:frames / 96000}]};
    const metadata = await sourceAudioMetadata(library, new Map([['a',path]]));
    assert.equal(metadata.get('a').size, 44 + frames * 6);
    for (const change of [{duration:5}, {rekordbox:{size:12}}]) {
      const invalid = {tracks:library.tracks.map(track => ({...track,...change}))};
      await assert.rejects(sourceAudioMetadata(invalid,new Map([['a',path]])), /一致しません/);
    }
  } finally { await rm(directory,{recursive:true,force:true}); }
});

test('legacy USB format rejects size saturation before invoking a writer', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'deckflow-source-range-'));
  const path = join(directory, 'too-large.wav');
  try {
    const file = await open(path, 'wx');
    try { await file.truncate(2 ** 32); } finally { await file.close(); }
    await assert.rejects(sourceAudioInfo(path), /Device Library.*4 GiB/);
    await writeFile(path, new Uint8Array());
    await assert.rejects(sourceAudioInfo(path), /空でない/);
  } finally { await rm(directory,{recursive:true,force:true}); }
});

test('device metadata readback catches truncated size, length, sample rate and bitrate', () => {
  const track = {filename:'source.wav',duration:1864.135};
  const info = {size:1073741864,sampleRate:96000,bitRate:4608};
  const device = {...info,duration:1865};
  verifyAudioMetadata(track,device,info);
  for (const field of ['size','duration','sampleRate','bitRate']) {
    assert.throws(() => verifyAudioMetadata(track,{...device,[field]:0},info), /元音源と一致しません/);
  }
});
