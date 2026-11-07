import {createPcmResamplerFromKernel} from './pcm-resampler.js?v=7c8bf604d2c9c1e4';

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
    this.preparing = false;
    this.startTime = 0;
    this.stopTime = Infinity;
    this.readPageIndex = -1;
    this.readPage = null;
    this.disposed = false;
    this.scratch = false;
    this.target = 0;
    this.motionFrames = 0; this.motion = []; this.scratchFrames = 0; this.timeOrigin = null;
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
      if (data.generation !== this.generation || (!this.active && !this.preparing) || !this.wanted().has(data.index)) return;
      const size = Math.min(this.pageFrames, this.length - data.index * this.pageFrames);
      if (!Array.isArray(data.channels) || data.channels.length !== this.channelCount ||
          !data.channels.every(channel => channel instanceof Float32Array && channel.length === size)) return;
      this.pages.set(data.index, data.channels);
      this.readPageIndex = -1;
      this.prefetch();
      if (this.preparing && this.hasStartPages()) {this.preparing = false; this.port.postMessage({type: 'prepared', id: this.prepareId});}
      return;
    }
    if (data?.type === 'prepare' || data?.type === 'start' || data?.type === 'begin') {
      this.generation++;
      this.requested.clear(); this.readPageIndex = -1;
      this.preparing = data.type === 'prepare'; this.prepareId = data.id;
      this.startTime = Number.isFinite(data.when) ? data.when : 0;
      this.stopTime = Infinity;
      this.position = this.frame(data.position);
      this.rate = Number.isFinite(data.rate) ? Math.max(.25, Math.min(4, data.rate)) : 1;
      if (data.kernel) this.resampler = createPcmResamplerFromKernel(data.kernel);
      this.scratch = data.type === 'begin';
      this.session = data.session;
      this.target = this.position; this.motionFrames = 0; this.amplitude = 0;
      this.lastStamp = null;
      this.motion = [{frame: 0, position: this.position}]; this.scratchFrames = 0; this.timeOrigin = null;
      this.setLoop(this.scratch ? null : data.loop);
      this.active = data.type !== 'prepare';
      this.prefetch();
      if (this.preparing && this.hasStartPages()) {this.preparing = false; this.port.postMessage({type: 'prepared', id: this.prepareId});}
    } else if (data?.type === 'target' && this.active && this.scratch) {
      this.target = Math.min(this.length - 1, this.frame(data.position));
      const stamp = Number.isFinite(data.timeStamp) ? data.timeStamp : null;
      if (stamp !== null && this.timeOrigin === null) this.timeOrigin = stamp - this.scratchFrames / sampleRate * 1000;
      let frame = stamp === null ? this.scratchFrames : (stamp - this.timeOrigin) / 1000 * sampleRate;
      if (frame - this.scratchFrames > sampleRate * .05) {
        frame = this.scratchFrames; this.timeOrigin = stamp - frame / sampleRate * 1000;
        this.motion = [{frame: frame - sampleRate * .02, position: this.position}];
      }
      const previous = this.motion.at(-1);
      if (!previous || frame > previous.frame) this.motion.push({frame, position: this.target});
      else if (frame === previous.frame) previous.position = this.target;
      if (this.motion.length > 32) this.motion.splice(0, this.motion.length - 32);
      this.prefetch();
    } else if (data?.type === 'rate' && Number.isFinite(data.value)) {
      this.rate = Math.max(.25, Math.min(4, data.value));
      this.resampler = createPcmResamplerFromKernel(data.kernel);
    } else if (data?.type === 'loop') {
      this.setLoop(data.loop); this.prefetch();
    } else if (data?.type === 'stopAt' && Number.isFinite(data.when)) {
      this.stopTime = data.when;
    } else if (['end', 'stop', 'dispose'].includes(data?.type)) {
      this.active = false; this.preparing = false; this.generation++;
      if (data.type === 'dispose') this.disposed = true;
      this.pages.clear(); this.requested.clear();
    }
  }

  hasStartPages() {
    const first = Math.max(0, Math.floor((this.position - this.resampler.radius) / this.pageFrames));
    const last = Math.min(Math.floor((this.length - 1) / this.pageFrames), Math.floor((this.position + this.resampler.radius + 128 * this.rate) / this.pageFrames));
    for (let page = first; page <= last; page++) if (!this.pages.has(page)) return false;
    if (this.loop && this.position >= this.loop.start) {
      const radius = this.resampler.radius;
      if (this.position - this.loop.start <= radius) {
        for (const frame of [this.loop.end - 1, Math.max(this.loop.start, this.loop.end - radius)]) if (!this.pages.has(Math.floor(frame / this.pageFrames))) return false;
      }
      if (this.loop.end - this.position <= radius + 128 * this.rate) {
        for (const frame of [this.loop.start, Math.min(this.loop.end - 1, this.loop.start + radius)]) if (!this.pages.has(Math.floor(frame / this.pageFrames))) return false;
      }
    }
    return true;
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
    if (!this.active && !this.preparing) return;
    const wanted = this.wanted();
    for (const index of this.pages.keys()) if (!wanted.has(index)) {this.pages.delete(index); this.readPageIndex = -1;}
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
    const pageIndex = Math.floor(index / this.pageFrames);
    if (pageIndex !== this.readPageIndex) {this.readPageIndex = pageIndex; this.readPage = this.pages.get(pageIndex);}
    const page = this.readPage;
    return page ? page[Math.min(channel, page.length - 1)][index % this.pageFrames] : null;
  }
  read(position, channel, movement = 0) {
    if (!this.scratch) return this.resampler.sample(position, this.readers[channel]);
    // Integrate the traversed sample interval at fast speeds. This bounded
    // aperture filter reduces the aliases of a plain reverse point sampler.
    const width = Math.abs(movement);
    if (width > 1.000001) {
      const count = Math.min(32, Math.ceil(width)); let sum = 0;
      for (let sample = 0; sample < count; sample++) {
        const value = this.read(Math.max(0, Math.min(this.length - 1, position + ((sample + .5) / count - .5) * width)), channel);
        if (value === null) return null; sum += value;
      }
      return sum / count;
    }
    // Cubic interpolation matches in-memory scratch quality in both directions.
    const index = Math.floor(position), fraction = position - index;
    const y0 = this.readFrame(index - 1, channel), y1 = this.readFrame(index, channel);
    const y2 = this.readFrame(index + 1, channel), y3 = this.readFrame(index + 2, channel);
    if (y0 === null || y1 === null || y2 === null || y3 === null) return null;
    const c1 = (y2 - y0) * .5, c2 = y0 - 2.5 * y1 + 2 * y2 - .5 * y3;
    const c3 = .5 * (y3 - y0) + 1.5 * (y1 - y2);
    return ((c3 * fraction + c2) * fraction + c1) * fraction + y1;
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
    const blockTime = typeof currentTime === 'number' ? currentTime : 0;
    for (let index = 0; index < output[0].length; index++) {
      const time = blockTime + index / sampleRate;
      if (!this.scratch && time < this.startTime) continue;
      if (time >= this.stopTime) {this.active = false; this.port.postMessage({type: 'stopped'}); break;}
      if (!this.scratch && this.loop && this.position >= this.loop.end) {
        this.position = this.loop.start + (this.position - this.loop.start) % (this.loop.end - this.loop.start);
      }
      if (!this.scratch && this.position >= this.length) {
        this.position = this.length; this.active = false;
        this.port.postMessage({type: 'ended'}); break;
      }
      let movement = this.rate * scale;
      if (this.scratch) {
        const time = this.scratchFrames + index - sampleRate * .020;
        while (this.motion.length > 1 && this.motion[1].frame <= time) this.motion.shift();
        const from = this.motion[0], to = this.motion[1];
        let target = from?.position ?? this.position;
        if (to) target += (to.position - from.position) * Math.max(0, Math.min(1, (time - from.frame) / (to.frame - from.frame)));
        movement = Math.max(-16 * scale, Math.min(16 * scale, target - this.position));
      }
      const position = this.scratch ? Math.max(0, Math.min(this.length - 1, this.position + movement)) : this.position;
      this.renderPosition = position;
      const left = this.read(position, 0, movement), right = this.channelCount > 1 ? this.read(position, 1, movement) : left;
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
    if (this.scratch) this.scratchFrames += output[0].length;
    const bufferingChanged = this.buffering !== blocked;
    if (bufferingChanged) {
      this.buffering = blocked;
      this.port.postMessage({type: 'buffering', value: blocked});
    }
    if (blocked || this.blocks % 8 === 0) this.prefetch();
    if (++this.blocks % 4 === 0 || bufferingChanged || !this.active) {
      this.port.postMessage({type: 'position', position: this.position / this.sourceRate, session: this.session, buffering: this.buffering, contextTime: blockTime + output[0].length / sampleRate});
    }
    return true;
  }
}
registerProcessor('deckflow-pcm-file', PcmFileProcessor);
