/** DECKFLOW scratch transport: fractional, bidirectional PCM reading on the audio thread. */
class DeckflowScratchProcessor extends AudioWorkletProcessor {
  constructor() {
    super();
    this.channels = [];
    this.sourceRate = sampleRate;
    this.position = 0;
    this.target = 0;
    this.velocity = 0;
    this.amplitude = 0;
    this.motion = [];
    this.elapsedFrames = 0;
    this.timeOrigin = null;
    this.session = 0;
    this.active = false;
    this.blocks = 0;
    this.port.onmessage = ({ data }) => {
      if (data?.type === 'load') {
        this.channels = (data.channels || []).filter(channel => channel instanceof Float32Array);
        this.sourceRate = Number.isFinite(data.sampleRate) && data.sampleRate > 0 ? data.sampleRate : sampleRate;
        this.position = 0; this.target = 0; this.velocity = 0; this.active = false;
        this.motion = []; this.elapsedFrames = 0; this.timeOrigin = null;
        this.port.postMessage({ type: 'ready', id: data.id });
      } else if (data?.type === 'begin') {
        this.position = this._frame(data.position);
        this.target = this.position;
        this.velocity = 0; this.amplitude = 0; this.active = true;
        this.motion = [{ frame: 0, position: this.position }];
        this.elapsedFrames = 0; this.timeOrigin = null; this.session = data.session;
      } else if (data?.type === 'target' && this.active && Number.isFinite(data.position)) {
        this.target = this._frame(data.position);
        // Keep a short timeline of actual finger samples. A 20 ms lookbehind
        // covers a 60 Hz touch interval plus one audio quantum. Linear time
        // interpolation gives a constant read speed for constant finger speed,
        // even when main-thread events arrive in bursts. Never extrapolate.
        const stamp = Number.isFinite(data.timeStamp) ? data.timeStamp : null;
        if (stamp !== null && this.timeOrigin === null) this.timeOrigin = stamp - this.elapsedFrames / sampleRate * 1000;
        let frame = stamp === null ? this.elapsedFrames : (stamp - this.timeOrigin) / 1000 * sampleRate;
        // An interrupted AudioContext stops its clock while DOM timestamps
        // continue. Re-anchor on recovery instead of queuing seconds ahead.
        if (frame - this.elapsedFrames > sampleRate * 0.050) {
          frame = this.elapsedFrames;
          this.timeOrigin = stamp - frame / sampleRate * 1000;
          this.motion = [{ frame: frame - sampleRate * 0.020, position: this.position }];
        }
        const previous = this.motion[this.motion.length - 1];
        if (!previous || frame > previous.frame) this.motion.push({ frame, position: this.target });
        else if (frame === previous.frame) previous.position = this.target;
        // Bound storage during long gestures or event bursts.
        if (this.motion.length > 32) this.motion.splice(0, this.motion.length - 32);
      } else if (data?.type === 'end') {
        this.active = false; this.velocity = 0; this.amplitude = 0;
      } else if (data?.type === 'dispose') {
        this.active = false; this.channels = []; this.motion = [];
      }
    };
  }

  _frame(seconds) {
    const limit = Math.max(0, (this.channels[0]?.length || 1) - 1);
    return Math.max(0, Math.min(limit, (Number.isFinite(seconds) ? seconds : 0) * this.sourceRate));
  }

  _read(channel, position, movement = 0) {
    const width = Math.abs(movement);
    if (width > 1.000001) {
      const count = Math.min(32, Math.ceil(width)); let sum = 0;
      for (let sample = 0; sample < count; sample++) sum += this._read(channel,
        Math.max(0, Math.min(channel.length - 1, position + ((sample + .5) / count - .5) * width)));
      return sum / count;
    }
    // Cubic Hermite interpolation handles fractional frames in either direction.
    const index = Math.floor(position);
    const fraction = position - index;
    const last = channel.length - 1;
    if (last < 0) return 0;
    const y0 = channel[Math.max(0, index - 1)];
    const y1 = channel[Math.min(last, index)];
    const y2 = channel[Math.min(last, index + 1)];
    const y3 = channel[Math.min(last, index + 2)];
    const c1 = (y2 - y0) * 0.5;
    const c2 = y0 - 2.5 * y1 + 2 * y2 - 0.5 * y3;
    const c3 = 0.5 * (y3 - y0) + 1.5 * (y1 - y2);
    return ((c3 * fraction + c2) * fraction + c1) * fraction + y1;
  }

  process(_inputs, outputs) {
    const output = outputs[0];
    if (!output?.length) return true;
    for (const channel of output) channel.fill(0);
    if (!this.active || !this.channels[0]?.length) return true;
    const frames = output[0].length;
    const maximum = this.channels[0].length - 1;
    const scale = this.sourceRate / sampleRate;
    const amplitudeSmoothing = 1 - Math.exp(-1 / (sampleRate * 0.003));
    const delayFrames = sampleRate * 0.020;
    for (let frame = 0; frame < frames; frame++) {
      const time = this.elapsedFrames++ - delayFrames;
      while (this.motion.length > 1 && this.motion[1].frame <= time) this.motion.shift();
      const from = this.motion[0];
      const to = this.motion[1];
      let position = from?.position ?? this.position;
      if (to) {
        const fraction = Math.max(0, Math.min(1, (time - from.frame) / (to.frame - from.frame)));
        position += (to.position - from.position) * fraction;
      }
      this.velocity = Math.max(-16 * scale, Math.min(16 * scale, position - this.position));
      this.position += this.velocity;
      if (this.position <= 0 || this.position >= maximum) {
        this.position = Math.max(0, Math.min(maximum, this.position));
        this.velocity = 0;
      }
      const targetAmplitude = Math.min(1, Math.abs(this.velocity / scale) * 8);
      this.amplitude += (targetAmplitude - this.amplitude) * amplitudeSmoothing;
      for (let channel = 0; channel < output.length; channel++) {
        const pcm = this.channels[Math.min(channel, this.channels.length - 1)];
        const sample = this._read(pcm, this.position, this.velocity) * this.amplitude;
        output[channel][frame] = Number.isFinite(sample) ? Math.max(-1, Math.min(1, sample)) : 0;
      }
    }
    if (++this.blocks % 8 === 0) this.port.postMessage({ type: 'position', position: this.position / this.sourceRate, session: this.session });
    return true;
  }
}

registerProcessor('deckflow-scratch', DeckflowScratchProcessor);
