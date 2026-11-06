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
    this.active = false;
    this.blocks = 0;
    this.port.onmessage = ({ data }) => {
      if (data?.type === 'load') {
        this.channels = (data.channels || []).filter(channel => channel instanceof Float32Array);
        this.sourceRate = Number.isFinite(data.sampleRate) ? data.sampleRate : sampleRate;
        this.position = 0; this.target = 0; this.velocity = 0; this.active = false;
        this.port.postMessage({ type: 'ready', id: data.id });
      } else if (data?.type === 'begin') {
        this.position = this._frame(data.position);
        this.target = this.position;
        this.velocity = 0; this.amplitude = 0; this.active = true;
      } else if (data?.type === 'target' && Number.isFinite(data.position)) {
        this.target = this._frame(data.position);
      } else if (data?.type === 'end') {
        this.active = false; this.velocity = 0; this.amplitude = 0;
      } else if (data?.type === 'dispose') {
        this.active = false; this.channels = [];
      }
    };
  }

  _frame(seconds) {
    const limit = Math.max(0, (this.channels[0]?.length || 1) - 1);
    return Math.max(0, Math.min(limit, (Number.isFinite(seconds) ? seconds : 0) * this.sourceRate));
  }

  _read(channel, position) {
    // Cubic Hermite interpolation handles fractional frames in either direction.
    const index = Math.floor(position);
    const fraction = position - index;
    const last = channel.length - 1;
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
    const velocitySmoothing = 1 - Math.exp(-1 / (sampleRate * 0.003));
    const amplitudeSmoothing = 1 - Math.exp(-1 / (sampleRate * 0.003));
    for (let frame = 0; frame < frames; frame++) {
      // Follow the finger with a short, damped trajectory; zero movement fades
      // to silence instead of holding a DC sample at the stopped needle.
      const requested = Math.max(-16 * scale, Math.min(16 * scale, (this.target - this.position) / (sampleRate * 0.012)));
      this.velocity += (requested - this.velocity) * velocitySmoothing;
      this.position += this.velocity;
      if (this.position <= 0 || this.position >= maximum) {
        this.position = Math.max(0, Math.min(maximum, this.position));
        this.velocity = 0;
      }
      const targetAmplitude = Math.min(1, Math.abs(this.velocity / scale) * 8);
      this.amplitude += (targetAmplitude - this.amplitude) * amplitudeSmoothing;
      for (let channel = 0; channel < output.length; channel++) {
        const pcm = this.channels[Math.min(channel, this.channels.length - 1)];
        const sample = this._read(pcm, this.position) * this.amplitude;
        output[channel][frame] = Number.isFinite(sample) ? Math.max(-1, Math.min(1, sample)) : 0;
      }
    }
    if (++this.blocks % 8 === 0) this.port.postMessage({ type: 'position', position: this.position / this.sourceRate });
    return true;
  }
}

registerProcessor('deckflow-scratch', DeckflowScratchProcessor);
