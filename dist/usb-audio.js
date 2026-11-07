/** Source-rate decoding and bounded PCM for direct device export. */
import {readWavInfo, openAudioFile, isPcmFileResource} from './audio-resource.js?v=b48f446ea6c7f1bb';
const fail = message => { throw new Error(message); };
const abort = signal => signal?.throwIfAborted();
const text = bytes => String.fromCharCode(...bytes);

function mp3Header(bytes) {
  if (bytes.length < 4 || bytes[0] !== 255 || (bytes[1] & 0xe0) !== 0xe0) return null;
  const version = (bytes[1] >> 3) & 3, layer = (bytes[1] >> 1) & 3;
  const rateIndex = (bytes[2] >> 2) & 3, bitrateIndex = bytes[2] >> 4;
  if (version === 1 || layer !== 1 || rateIndex === 3 || !bitrateIndex || bitrateIndex === 15) return null;
  const sampleRate = [44100,48000,32000][rateIndex] / (version === 3 ? 1 : version === 2 ? 2 : 4);
  const bitRate = (version === 3 ? [0,32,40,48,56,64,80,96,112,128,160,192,224,256,320] : [0,8,16,24,32,40,48,56,64,80,96,112,128,144,160])[bitrateIndex];
  return {version,sampleRate,bitRate,channels:(bytes[3] >> 6) === 3 ? 1 : 2,
    frameBytes:Math.floor((version === 3 ? 144000 : 72000)*bitRate/sampleRate)+((bytes[2] >> 1)&1),samples:version === 3 ? 1152 : 576};
}
export async function readUsbAudioInfo(blob,filename,{signal} = {}) {
  if (!blob?.size || blob.size > 0xffffffff) fail('USB音源は4 GiB未満のファイルにしてください。');
  abort(signal);
  if (/\.wav$/i.test(filename)) {
    const info = await readWavInfo(blob,{signal});
    if (!info || info.format !== 'pcm' || ![16,24].includes(info.bitsPerSample) || ![44100,48000,88200,96000].includes(info.sampleRate) || info.numberOfChannels > 2) {
      fail(`${filename}: CDJ用WAVは16/24 bit PCM、44.1/48/88.2/96 kHz、1〜2チャンネルにしてください。`);
    }
    return {codec:'wav',sampleRate:info.sampleRate,channels:info.numberOfChannels,bitDepth:info.bitsPerSample,
      bitRate:Math.round(info.byteRate*8/1000),duration:info.duration};
  }
  if (!/\.mp3$/i.test(filename)) fail(`${filename}: iPadからの新規USB転送は現在WAV・MP3に対応しています。`);
  let windowStart = -1, windowBytes = new Uint8Array();
  const read = async (start,length) => {
    abort(signal);
    if (start < windowStart || start+length > windowStart+windowBytes.length) {
      windowStart=start;windowBytes=new Uint8Array(await blob.slice(start,Math.min(blob.size,start+1024*1024)).arrayBuffer());
    }
    return windowBytes.subarray(start-windowStart,start-windowStart+length);
  };
  let offset=0,frames=0,samples=0,audioBytes=0,first,vbrHeader=null;
  let end=blob.size;
  // Tags are outside the MPEG stream. Validate their boundaries before walking
  // frames, so a shortened final audio frame cannot be mistaken for metadata.
  if (end>=128 && text(await read(end-128,3))==='TAG') end-=128;
  if (end>=32) {
    const footer=await read(end-32,32);
    if (text(footer.subarray(0,8))==='APETAGEX') {
      const view=new DataView(footer.buffer,footer.byteOffset,footer.byteLength);
      const version=view.getUint32(8,true),size=view.getUint32(12,true),flags=view.getUint32(20,true);
      if (![1000,2000].includes(version) || size<32 || size>end || (flags&0x20000000)) fail(`${filename}: APEタグの長さが不正です。`);
      end-=size;
      if (flags&0x80000000) {
        if (end<32 || text(await read(end-32,8))!=='APETAGEX') fail(`${filename}: APEヘッダーがありません。`);
        end-=32;
      }
    }
  }
  const header=await read(0,10);
  if (text(header.subarray(0,3)) === 'ID3') {
    if (header.length < 10 || ![2,3,4].includes(header[3]) || header[4]===255 || header.subarray(6,10).some(value=>value&128)) fail(`${filename}: ID3ヘッダーを読み取れません。`);
    offset=10+((header[6]<<21)|(header[7]<<14)|(header[8]<<7)|header[9])+((header[3]===4 && header[5]&16)?10:0);
    if (offset>end) fail(`${filename}: ID3タグが途中で切れています。`);
  }
  while (offset<end) {
    if (offset+4>end) fail(`${filename}: MP3フレームが途中で切れています。`);
    const bytes=await read(offset,8), frame=mp3Header(bytes);
    if (!frame) fail(`${filename}: MP3フレームを読み取れません。`);
    if (offset+frame.frameBytes>end) fail(`${filename}: MP3が途中で切れています。`);
    if (!first) {
      const body=await read(offset,frame.frameBytes);
      // Xing/Info starts after MPEG side information; VBRI uses byte 36.
      // Both are metadata-only frames, excluded from the ANLZ PVBR trailer.
      // Format references: https://ffmpeg.org/doxygen/trunk/mp3dec_8c_source.html
      const xingOffset=4+(frame.version===3?(frame.channels===1?17:32):(frame.channels===1?9:17));
      const tag=text(body.subarray(xingOffset,xingOffset+4));
      const view=new DataView(body.buffer,body.byteOffset,body.byteLength);
      if (tag==='Xing' || tag==='Info') {
        if (body.length<xingOffset+8) fail(`${filename}: Xingヘッダーが途中で切れています。`);
        const flags=view.getUint32(xingOffset+4);
        const required=xingOffset+8+((flags&1)?4:0)+((flags&2)?4:0)+((flags&4)?100:0)+((flags&8)?4:0);
        if (flags&~15 || body.length<required) fail(`${filename}: Xingヘッダーの形式が不正です。`);
        vbrHeader={kind:tag,frames:(flags&1)?view.getUint32(xingOffset+8):null};
      } else if (text(body.subarray(36,40))==='VBRI') {
        if (body.length<54 || view.getUint16(40)!==1) fail(`${filename}: VBRIヘッダーの形式が不正です。`);
        vbrHeader={kind:'VBRI',frames:view.getUint32(50)};
      }
    }
    first ??= frame;
    if (frame.sampleRate !== first.sampleRate || frame.channels !== first.channels) fail(`${filename}: MP3の形式が曲中で変わっています。`);
    if (vbrHeader && frames===0 && !vbrHeader.skipped) {
      vbrHeader.skipped=true;offset+=frame.frameBytes;continue;
    }
    samples+=frame.samples;audioBytes+=frame.frameBytes;frames++;offset+=frame.frameBytes;
    if (frames%2000===0) await new Promise(resolve=>setTimeout(resolve,0));
  }
  if (!first || !frames || ![32000,44100,48000].includes(first.sampleRate)) fail(`${filename}: CDJ用MP3は32/44.1/48 kHzにしてください。`);
  if (vbrHeader?.frames != null && vbrHeader.frames!==frames && !(vbrHeader.kind==='VBRI' && vbrHeader.frames===frames+1)) {
    fail(`${filename}: MP3のヘッダーと実際のフレーム数が一致しません。`);
  }
  const duration=samples/first.sampleRate;
  return {codec:'mp3',sampleRate:first.sampleRate,channels:first.channels,bitDepth:16,
    bitRate:Math.round(audioBytes*8/duration/1000),duration,mp3AudioFrames:frames};
}

export async function feedUsbAudio(blob,info,meter,{signal,decode} = {}) {
  abort(signal);
  // decodeAudioData materializes the complete compressed track as PCM. PCM
  // WAV takes the bounded file reader below; long MP3 needs a streaming
  // decoder before it can safely offer the same capacity on an iPad.
  if (info.codec === 'mp3' && (blob.size > 32 * 1024 * 1024 ||
      info.duration * info.sampleRate * info.channels * 4 > 256 * 1024 * 1024)) {
    fail('長尺MP3のUSB波形生成は現在32 MiB／展開後256 MiBまでです。大容量の曲はPCM WAVを使用してください。');
  }
  const decodeAudioData = decode ?? (async bytes => {
    const Constructor=globalThis.OfflineAudioContext ?? globalThis.webkitOfflineAudioContext;
    if (!Constructor) fail('この環境で音源を解析できません。');
    // Decode at the source rate, not the current playback device's rate.
    const context=new Constructor(info.channels,1,info.sampleRate);
    return context.decodeAudioData(bytes);
  });
  const resource=await openAudioFile(blob,{sampleRate:info.sampleRate,decodeAudioData},{signal});
  if (resource.sampleRate !== info.sampleRate || resource.numberOfChannels !== info.channels) fail('音源のサンプルレートまたはチャンネル数が一致しません。');
  const chunkFrames=Math.min(32768,resource.maxReadFrames ?? 32768);
  for (let offset=0;offset<resource.length;offset+=chunkFrames) {
    abort(signal);const frames=Math.min(chunkFrames,resource.length-offset);
    const channels=isPcmFileResource(resource)?await resource.readFrames(offset,frames,{signal}):
      Array.from({length:resource.numberOfChannels},(_,channel)=>resource.getChannelData(channel).subarray(offset,offset+frames));
    const interleaved=new Float32Array(frames*channels.length);
    for(let frame=0;frame<frames;frame++)for(let channel=0;channel<channels.length;channel++) interleaved[frame*channels.length+channel]=channels[channel][frame];
    meter.push(interleaved);
    if (offset% (chunkFrames*16) === 0) await new Promise(resolve=>setTimeout(resolve,0));
  }
}
