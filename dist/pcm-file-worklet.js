import {createPcmResamplerFromKernel} from './pcm-resampler.js?v=15d483d12b5c45ed';

/** Bounded PCM reader. At most six fixed-size pages live on the audio thread. */
class PcmFileProcessor extends AudioWorkletProcessor {
  constructor({processorOptions: options}) {
    super();
    this.length = options.length;
    this.sourceRate = options.sampleRate;
    this.pageFrames = options.pageFrames;
    this.channelCount = Math.min(2, options.channels);
    this.pages = new Map();
    this.requested = new Set();
    this.generation = 0;
    this.position = 0;
    this.rate = 1;
    this.loop = null;
    this.active = false;
    this.disposed = false;
    this.scratch = false;
    this.target = 0;
    this.motionFrames = 0;
    this.amplitude = 0;
    this.session = 0;
    this.blocks = 0;
    this.buffering = false;
    this.resampler = createPcmResamplerFromKernel(options.kernel);
    this.readers = [0, 1].map(channel => index => this.readFrame(index, channel));
    this.port.onmessage = ({data}) => this.message(data);
  }

  frame(seconds) {return Math.max(0, Math.min(this.length, Number.isFinite(seconds) ? seconds * this.sourceRate : 0));}
  setLoop(loop) {
    this.loop = loop && Number.isFinite(loop.start) && Number.isFinite(loop.end) && loop.end > loop.start
      ? {start: this.frame(loop.start), end: this.frame(loop.end)} : null;
  }
  message(data) {
    if (data?.type === 'page') {
      this.requested.delete(data.index);
      if (data.generation !== this.generation || !this.active || !this.wanted().has(data.index)) return;
      const size = Math.min(this.pageFrames, this.length - data.index * this.pageFrames);
      if (!Array.isArray(data.channels) || data.channels.length !== this.channelCount ||
          !data.channels.every(channel => channel instanceof Float32Array && channel.length === size)) return;
      this.pages.set(data.index, data.channels);
      this.prefetch();
      return;
    }
    if (data?.type === 'start' || data?.type === 'begin') {
      this.generation++;
      this.pages.clear(); this.requested.clear();
      this.position = this.frame(data.position);
      this.rate = Number.isFinite(data.rate) ? Math.max(.25, Math.min(4, data.rate)) : 1;
      if (data.kernel) this.resampler = createPcmResamplerFromKernel(data.kernel);
      this.scratch = data.type === 'begin';
      this.session = data.session;
      this.target = this.position; this.motionFrames = 0; this.amplitude = 0;
      this.lastStamp = null;
      this.setLoop(this.scratch ? null : data.loop);
      this.active = true;
      this.prefetch();
    } else if (data?.type === 'target' && this.active && this.scratch) {
      this.target = Math.min(this.length - 1, this.frame(data.position));
      const interval = Number.isFinite(data.timeStamp) && this.lastStamp !== null
        ? Math.max(5, Math.min(50, data.timeStamp - this.lastStamp)) : 20;
      this.lastStamp = Number.isFinite(data.timeStamp) ? data.timeStamp : null;
      this.motionFrames = Math.max(1, Math.round(sampleRate * interval / 1000));
      this.prefetch();
    } else if (data?.type === 'rate' && Number.isFinite(data.value)) {
      this.rate = Math.max(.25, Math.min(4, data.value));
      this.resampler = createPcmResamplerFromKernel(data.kernel);
    } else if (data?.type === 'loop') {
      this.setLoop(data.loop); this.prefetch();
    } else if (['end', 'stop', 'dispose'].includes(data?.type)) {
      this.active = false; this.generation++;
      if (data.type === 'dispose') this.disposed = true;
      this.pages.clear(); this.requested.clear();
    }
  }

  wanted() {
    const current = Math.floor(Math.min(this.length - 1, this.position) / this.pageFrames);
    const indices = [current, current - 1, current + 1];
    const alternate = this.scratch ? this.target
      : this.loop && this.loop.end - this.position <= this.pageFrames * 2 ? this.loop.start
      : this.loop && this.position >= this.loop.start && this.position - this.loop.start <= this.resampler.radius ? this.loop.end - 1
      : null;
    if (alternate !== null) {
      const page = Math.floor(alternate / this.pageFrames);
      indices.push(page, page - 1, page + 1);
    }
    return new Set([...new Set(indices.filter(index => index >= 0 && index * this.pageFrames < this.length))].slice(0, 6));
  }
  prefetch() {
    if (!this.active) return;
    const wanted = this.wanted();
    for (const index of this.pages.keys()) if (!wanted.has(index)) this.pages.delete(index);
    for (const index of this.requested) if (!wanted.has(index)) this.requested.delete(index);
    for (const index of wanted) {
      if (this.pages.has(index) || this.requested.has(index)) continue;
      this.requested.add(index);
      this.port.postMessage({type: 'request', index, generation: this.generation, wanted: [...wanted]});
    }
  }
  readFrame(position, channel) {
    let frame = position;
    if (!this.scratch && this.loop && this.renderPosition >= this.loop.start) {
      const length = this.loop.end - this.loop.start;
      if (frame < this.loop.start || frame >= this.loop.end) frame = this.loop.start + ((frame - this.loop.start) % length + length) % length;
    }
    const index = Math.max(0, Math.min(this.length - 1, Math.floor(frame)));
    const page = this.pages.get(Math.floor(index / this.pageFrames));
    return page ? page[Math.min(channel, page.length - 1)][index % this.pageFrames] : null;
  }
  read(position, channel) {
    if (!this.scratch) return this.resampler.sample(position, this.readers[channel]);
    const index = Math.floor(position), fraction = position - index;
    const left = this.readFrame(index, channel), right = this.readFrame(index + 1, channel);
    return left === null || right === null ? null : left + (right - left) * fraction;
  }

  process(_inputs, outputs) {
    if (this.disposed) return false;
    const output = outputs[0];
    if (!output?.length) return true;
    for (const channel of output) channel.fill(0);
    if (!this.active) return true;
    let blocked = false;
    const scale = this.sourceRate / sampleRate;
    const smoothing = 1 - Math.exp(-1 / (sampleRate * .003));
    for (let index = 0; index < output[0].length; index++) {
      if (!this.scratch && this.loop && this.position >= this.loop.end) {
        this.position = this.loop.start + (this.position - this.loop.start) % (this.loop.end - this.loop.start);
      }
      if (!this.scratch && this.position >= this.length) {
        this.position = this.length; this.active = false;
        this.port.postMessage({type: 'ended'}); break;
      }
      const movement = this.scratch
        ? Math.max(-16 * scale, Math.min(16 * scale, (this.target - this.position) / Math.max(1, this.motionFrames)))
        : this.rate * scale;
      const position = this.scratch ? Math.max(0, Math.min(this.length - 1, this.position + movement)) : this.position;
      this.renderPosition = position;
      const left = this.read(position, 0), right = this.channelCount > 1 ? this.read(position, 1) : left;
      if (left === null || right === null) {blocked = true; this.prefetch(); break;}
      if (this.scratch) {
        this.position = position;
        this.motionFrames = Math.max(0, this.motionFrames - 1);
        this.amplitude += (Math.min(1, Math.abs(movement / scale) * 8) - this.amplitude) * smoothing;
      } else this.position += movement;
      for (let channel = 0; channel < output.length; channel++) {
        const value = (channel ? right : left) * (this.scratch ? this.amplitude : 1);
        output[channel][index] = Number.isFinite(value) ? value : 0;
      }
    }
    if (this.buffering !== blocked) {
      this.buffering = blocked;
      this.port.postMessage({type: 'buffering', value: blocked});
    }
    this.prefetch();
    if (++this.blocks % 4 === 0 || blocked || !this.active) {
      this.port.postMessage({type: 'position', position: this.position / this.sourceRate, session: this.session});
    }
    return true;
  }
}
registerProcessor('deckflow-pcm-file', PcmFileProcessor);
