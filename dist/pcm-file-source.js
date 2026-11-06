import {createPcmResampler} from './pcm-resampler.js?v=15d483d12b5c45ed';

const PAGE_FRAMES = 32768;
const registrations = new WeakMap();
export const isPcmFile = value => value?.kind === 'pcm-file' && typeof value.readFrames === 'function';

async function register(context) {
  if (!context.audioWorklet || !globalThis.AudioWorkletNode) {
    throw new Error('大容量音源の再生にはAudioWorklet対応ブラウザーとHTTPSまたはlocalhostが必要です。');
  }
  if (!registrations.has(context)) {
    const promise = context.audioWorklet.addModule(new URL('./pcm-file-worklet.js?v=15d483d12b5c45ed', import.meta.url));
    registrations.set(context, promise);
    promise.catch(() => {if (registrations.get(context) === promise) registrations.delete(context);});
  }
  return registrations.get(context);
}

/** AudioNode-shaped source with one in-flight read and six requested PCM pages. */
export class PcmFileSource {
  constructor(context, resource) {
    if (!isPcmFile(resource) || !Number.isSafeInteger(resource.length) || resource.length <= 0 ||
        !Number.isFinite(resource.sampleRate) || resource.sampleRate <= 0 ||
        !Number.isInteger(resource.numberOfChannels) || resource.numberOfChannels < 1 || resource.numberOfChannels > 32) {
      throw new TypeError('大容量音源の形式が正しくありません。');
    }
    this.context = context; this.resource = resource;
    this.node = null; this.connections = new Set();
    this.requests = new Map(); this.reading = false; this.disposed = false;
    this.generation = 0; this.wanted = new Set();
    this.position = 0; this.buffering = false; this.started = false;
    this.onended = null; this.onerror = null; this.onposition = null;
    this.rate = 1; this._loop = false; this._loopStart = 0; this._loopEnd = resource.duration;
    const owner = this;
    this.playbackRate = {
      get value() {return owner.rate;},
      set value(value) {
        owner.rate = value;
        if (owner.node && !owner.disposed) owner.send({type: 'rate', value,
          kernel: createPcmResampler(resource.sampleRate / context.sampleRate * value).kernel});
      },
      setValueAtTime(value) {this.value = value;},
    };
    this.port = {
      onmessage: null,
      postMessage: message => {
        if (message.type === 'dispose') this.stop();
        else if (message.type === 'begin') {this.position = message.position; this.started = true; this.send(message);}
        else this.send(message);
      },
      close: () => this.stop(),
    };
    this.ready = this.initialize();
    // A synchronously stopped source still owns an initialization promise.
    // Consumers can await ready; this handler prevents orphaned rejections.
    this.ready.catch(error => this.fail(error));
  }
  async initialize() {
    await register(this.context);
    if (this.disposed) return false;
    const node = new AudioWorkletNode(this.context, 'deckflow-pcm-file', {
      numberOfInputs: 0, numberOfOutputs: 1, outputChannelCount: [Math.min(2, this.resource.numberOfChannels)],
      processorOptions: {length: this.resource.length, sampleRate: this.resource.sampleRate,
        channels: this.resource.numberOfChannels, pageFrames: PAGE_FRAMES,
        kernel: createPcmResampler(this.resource.sampleRate / this.context.sampleRate * this.rate).kernel},
    });
    this.node = node;
    node.port.onmessage = ({data}) => this.message(data);
    node.onprocessorerror = () => this.fail(new Error('大容量音源の音声処理が停止しました。再生し直してください。'));
    for (const target of this.connections) node.connect(target);
    return true;
  }
  connect(target) {this.connections.add(target); this.node?.connect(target); return target;}
  disconnect() {this.connections.clear(); this.node?.disconnect();}
  send(message) {if (!this.disposed) this.node?.port.postMessage(message);}
  get loop() {return this._loop;}
  set loop(value) {this._loop = Boolean(value); this.updateLoop();}
  get loopStart() {return this._loopStart;}
  set loopStart(value) {this._loopStart = value; this.updateLoop();}
  get loopEnd() {return this._loopEnd;}
  set loopEnd(value) {this._loopEnd = value; this.updateLoop();}
  loopValue() {return this._loop ? {start: this._loopStart, end: this._loopEnd} : null;}
  updateLoop() {this.send({type: 'loop', loop: this.loopValue()});}
  async start(_when, offset = 0) {
    this.position = offset;
    if (!await this.ready || this.disposed) return false;
    this.started = true;
    this.send({type: 'start', position: offset, rate: this.rate, loop: this.loopValue()});
    return true;
  }
  message(data) {
    if (this.disposed) return;
    if (data?.type === 'request') {
      if (!Number.isSafeInteger(data.index) || data.index < 0 || data.index * PAGE_FRAMES >= this.resource.length) return;
      if (data.generation < this.generation) return;
      if (data.generation !== this.generation) {this.generation = data.generation; this.requests.clear();}
      this.wanted = new Set((data.wanted || [data.index]).slice(0, 6));
      for (const index of this.requests.keys()) if (!this.wanted.has(index)) this.requests.delete(index);
      this.requests.set(data.index, data.generation);
      void this.drain();
    } else if (data?.type === 'position' && Number.isFinite(data.position)) {
      this.position = Math.max(0, Math.min(this.resource.duration, data.position));
      this.onposition?.(this.position);
      this.port.onmessage?.({data});
    } else if (data?.type === 'buffering') this.buffering = Boolean(data.value);
    else if (data?.type === 'ended') {
      this.position = this.resource.duration;
      this.onended?.(); this.stop();
    }
  }
  async drain() {
    if (this.reading || this.disposed) return;
    this.reading = true;
    try {
      while (this.requests.size && !this.disposed) {
        const [index, generation] = this.requests.entries().next().value;
        this.requests.delete(index);
        const start = index * PAGE_FRAMES;
        const count = Math.min(PAGE_FRAMES, this.resource.length - start);
        const channels = await this.resource.readFrames(start, count);
        if (this.disposed || generation !== this.generation || !this.wanted.has(index)) continue;
        if (!Array.isArray(channels) || channels.length !== this.resource.numberOfChannels ||
            !channels.every(channel => channel instanceof Float32Array && channel.length === count)) {
          throw new Error('音源の読み取り結果が正しくありません。ファイルを選び直してください。');
        }
        const output = channels.slice(0, 2);
        this.node.port.postMessage({type: 'page', generation, index, channels: output}, output.map(channel => channel.buffer));
      }
    } catch (error) {this.fail(error);}
    finally {this.reading = false;}
  }
  fail(error) {
    if (this.disposed) return;
    this.stop();
    this.onerror?.(error);
  }
  stop() {
    if (this.disposed) return;
    this.disposed = true;
    this.requests.clear(); this.wanted.clear(); this.connections.clear();
    if (this.node) {
      this.node.port.postMessage({type: 'dispose'});
      this.node.disconnect(); this.node.port.close(); this.node.port.onmessage = null;
    }
    this.node = null;
  }
}
