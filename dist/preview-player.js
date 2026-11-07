/** A single library audition, independent of the DJ decks and mixer. */
import {openAudioFile} from './audio-resource.js?v=7c8bf604d2c9c1e4';
import {PcmFileSource, isPcmFile} from './pcm-file-source.js?v=7c8bf604d2c9c1e4';

export class PreviewPlayer {
  constructor({getAudio, getBuffer = null, openAudio = openAudioFile, onChange = () => {}, createContext = () => {
    const AudioContextClass = globalThis.AudioContext || globalThis.webkitAudioContext;
    if (!AudioContextClass) throw new Error('このブラウザーは音声処理に対応していません。');
    return new AudioContextClass({latencyHint:'interactive'});
  }} = {}) {
    this.getAudio = getAudio;
    this.getBuffer = getBuffer;
    this.openAudio = openAudio;
    this.onChange = onChange;
    this.createContext = createContext;
    this.context = null;
    this.gain = null;
    this.limiter = null;
    this.eqNodes = null;
    this.source = null;
    this.buffer = null;
    this.trackId = null;
    this.loading = false;
    this.playing = false;
    this.position = 0;
    this.duration = 0;
    this.startedAt = 0;
    this.rate = 1;
    this.eq = {low:0,mid:0,high:0};
    this.error = null;
    this.command = 0;
    this.disposed = false;
  }

  getState() {
    const position = this.playing && this.source instanceof PcmFileSource ? this.source.position
      : this.playing ? this.position + (this.context.currentTime - this.startedAt) * this.rate : this.position;
    return {trackId:this.trackId, loading:this.loading, playing:this.playing,
      position:Math.max(0, Math.min(this.duration, position)), duration:this.duration, error:this.error,
      rate:this.rate, eq:{...this.eq}};
  }

  _notify() {
    try { this.onChange(this.getState()); } catch { /* Rendering cannot change transport state. */ }
  }

  _ensureContext() {
    if (this.context) return this.context;
    const context = this.createContext();
    const gain = context.createGain();
    gain.gain.value = .65;
    const limiter = context.createDynamicsCompressor();
    limiter.threshold.value = -1;
    limiter.knee.value = 3;
    limiter.ratio.value = 20;
    limiter.attack.value = .003;
    limiter.release.value = .15;
    const low = context.createBiquadFilter();
    low.type = 'lowshelf'; low.frequency.value = 250; low.gain.value = this.eq.low;
    const mid = context.createBiquadFilter();
    mid.type = 'peaking'; mid.frequency.value = 1000; mid.Q.value = .8; mid.gain.value = this.eq.mid;
    const high = context.createBiquadFilter();
    high.type = 'highshelf'; high.frequency.value = 4000; high.gain.value = this.eq.high;
    low.connect(mid).connect(high).connect(gain);
    gain.connect(limiter).connect(context.destination);
    this.context = context;
    this.gain = gain;
    this.limiter = limiter;
    this.eqNodes = {low,mid,high};
    return context;
  }

  _disconnect() {
    const source = this.source;
    this.source = null;
    this.playing = false;
    if (!source) return;
    source.onended = null;
    try { source.stop(); } catch { /* It may already have ended. */ }
    source.disconnect();
  }

  _start(command) {
    const source = isPcmFile(this.buffer) ? new PcmFileSource(this.context, this.buffer) : this.context.createBufferSource();
    if (!isPcmFile(this.buffer)) source.buffer = this.buffer;
    source.playbackRate.value = this.rate;
    source.connect(this.eqNodes.low);
    source.onended = () => {
      if (this.source !== source || this.command !== command || this.disposed) return;
      this.source = null;
      source.disconnect();
      this.playing = false;
      this.position = 0;
      this.buffer = null;
      this._notify();
    };
    this.source = source;
    this.startedAt = this.context.currentTime;
    source.onerror = error => {
      if (this.source !== source || this.command !== command || this.disposed) return;
      this.position = this.getState().position;
      this._disconnect(); this.loading = false;
      this.error = error?.message || '音源を読み取れませんでした。'; this._notify();
    };
    const started = source.start(0, this.position);
    this.playing = true;
    if (started?.catch) return started.catch(error => {source.onerror(error);});
  }

  /** Select metadata for inspection without opening audio or starting playback. */
  select(trackId, duration = 0) {
    if (this.disposed) throw new Error('試聴プレイヤーは終了しています。ページを再読み込みしてください。');
    if (typeof trackId !== 'string' || !trackId || trackId === this.trackId) return;
    this.command++;
    this._disconnect();
    this.buffer = null;
    this.trackId = trackId;
    this.duration = Number.isFinite(duration) ? Math.max(0, duration) : 0;
    this.position = 0;
    this.loading = false;
    this.error = null;
    this._resetTone();
    this._notify();
  }

  async toggle(trackId) {
    if (this.disposed) throw new Error('試聴プレイヤーは終了しています。ページを再読み込みしてください。');
    if (typeof trackId !== 'string' || !trackId) return;
    if (trackId === this.trackId && this.loading) { this.stop(); return; }
    if (trackId === this.trackId && this.playing) {
      this.position = this.getState().position;
      this.command++;
      this._disconnect();
      this._notify();
      return;
    }
    const command = ++this.command;
    if (trackId !== this.trackId) {
      this._disconnect();
      this.buffer = null;
      this.position = 0;
      this.duration = 0;
      this.trackId = trackId;
      this._resetTone();
    }
    this.loading = true;
    this.error = null;
    this._notify();
    const current = () => this.command === command && !this.disposed;
    try {
      // Do this before the first await: Safari must see the user's gesture
      // when opening/resuming audio, before IndexedDB and decoding finish.
      const context = this._ensureContext();
      const resume = context.state === 'running' ? undefined : context.resume();
      await resume;
      if (!current()) return;
      if (context.state !== 'running') throw new Error('音声を開始できませんでした。もう一度試聴ボタンを押してください。');
      if (!this.buffer) {
        const decode = async () => {
          const blob = await this.getAudio(trackId);
          // A shared job may also serve a deck or a newer audition. Cancelling
          // this transport must not cancel their decode. The default path still
          // avoids decoding after its sole consumer has stopped.
          if (!this.getBuffer && !current()) return null;
          if (!blob) throw new Error('元の音源を読み込めません。曲を追加し直してください。');
          const buffer = await this.openAudio(blob, context);
          if (!Number.isFinite(buffer?.duration) || buffer.duration <= 0) {
            throw new Error('再生できる音源を選んでください。');
          }
          return buffer;
        };
        const buffer = this.getBuffer ? await this.getBuffer(trackId, decode) : await decode();
        if (!current()) return;
        if (!Number.isFinite(buffer?.duration) || buffer.duration <= 0) {
          throw new Error('再生できる音源を選んでください。');
        }
        this.buffer = buffer;
        this.duration = buffer.duration;
      }
      if (this.position >= this.duration) this.position = 0;
      await this._start(command);
      if (!current()) return;
      this.loading = false;
      this._notify();
    } catch (error) {
      if (!current()) return;
      this._disconnect();
      this.buffer = null;
      this.loading = false;
      this.position = 0;
      this.error = error?.message || 'この曲を試聴できませんでした。';
      this._notify();
      throw error;
    }
  }

  stop() {
    this.command++;
    this._disconnect();
    this.buffer = null;
    this.position = 0;
    this.loading = false;
    this.error = null;
    this._notify();
  }

  clear() {
    this.trackId = null;
    this.duration = 0;
    this._resetTone();
    this.stop();
  }

  _resetTone() {
    this.rate = 1;
    this.eq = {low:0,mid:0,high:0};
    for (const node of Object.values(this.eqNodes || {})) node.gain.value = 0;
  }

  setRate(rate) {
    const value = Number(rate);
    if (!Number.isFinite(value)) return;
    // Anchor the current song position before changing its clock slope.
    if (this.playing) {
      this.position = this.getState().position;
      this.startedAt = this.context.currentTime;
    }
    this.rate = Math.max(.5, Math.min(1.5, value));
    if (this.source) this.source.playbackRate.value = this.rate;
    this._notify();
  }

  setEQ(band, db) {
    const value = Number(db);
    if (!['low','mid','high'].includes(band) || !Number.isFinite(value)) return;
    this.eq[band] = Math.max(-24, Math.min(12, value));
    if (this.eqNodes) this.eqNodes[band].gain.value = this.eq[band];
    this._notify();
  }

  seek(seconds) {
    const value = Number(seconds);
    if (!this.trackId || !Number.isFinite(value)) return;
    const playing = this.playing;
    const position = Math.max(0, Math.min(this.duration, value));
    if (playing) { this.command++; this._disconnect(); }
    this.position = position;
    if (playing && position < this.duration) this._start(this.command);
    this._notify();
  }

  dispose() {
    if (this.disposed) return;
    this.disposed = true;
    this.clear();
    for (const node of Object.values(this.eqNodes || {})) node.disconnect();
    this.gain?.disconnect();
    this.limiter?.disconnect();
    this.context?.close().catch(() => {});
  }
}
