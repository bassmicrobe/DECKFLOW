/**
 * DECKFLOW browser audio transport. Only the two loaded decks retain decoded audio.
 * Browser output is the current system route; this is not a multichannel CUE driver.
 * Key lock uses locally vendored SoundTouchJS; scratch reads PCM in its own worklet.
 */
import {openAudioFile} from './audio-resource.js?v=7c8bf604d2c9c1e4';
import {PcmFileSource, isPcmFile} from './pcm-file-source.js?v=7c8bf604d2c9c1e4';
import {normalizeBeatGrid, beatSegment, beatPosition} from './beat-grid.js?v=7c8bf604d2c9c1e4';

const clamp = (value, min, max) => Math.min(max, Math.max(min, Number.isFinite(Number(value)) ? Number(value) : min));

function createDeck(id) {
  return {
    id, buffer: null, source: null, nodes: null,
    offset: 0, startedAt: 0, rate: 1, volume: 0.85,
    eq: { low: 0, mid: 0, high: 0 }, cue: 0, loop: null,
    playing: false, wantsPlay: false, command: 0, generation: 0,
    quantize: false, sync: false, phaseSync: false, syncMaster: id === 'a' ? 'b' : 'a', grid: [], pendingSource: null, retired: new Set(),
    meter: new Float32Array(256), keyLock: true, keyLockNode: null, keyLockError: null, transportGain: null,
    scratch: { token: 0, pending: false, active: false, resume: false, target: 0, start: 0, timeStamp: null,
      node: null, ready: null, resolveReady: null, cancelBegin: null, buffer: null, loadId: 0 },
  };
}

export class AudioEngine {
  constructor({ onEnded = () => {}, onStatus = () => {} } = {}) {
    this.context = null;
    this.onEnded = onEnded;
    this.onStatus = onStatus;
    this.decks = { a: createDeck('a'), b: createDeck('b') };
    this.crossfader = 0.5;
    this.master = 0.8;
    this.masterNodes = null;
    this.masterMeter = new Float32Array(256);
    this.disposed = false;
    this.keyLockReady = false;
    this.keyLockError = null;
    this.keyLockRegistration = null;
    this.SoundTouchNode = null;
    this.scratchRegistration = null;
  }

  _deck(id) {
    const deck = this.decks[id];
    if (!deck) throw new Error('デッキが見つかりません。');
    return deck;
  }

  _ensureContext() {
    if (this.disposed) throw new Error('音声エンジンは終了しています。ページを再読み込みしてください。');
    if (this.context) return this.context;
    const AudioContextClass = globalThis.AudioContext || globalThis.webkitAudioContext;
    if (!AudioContextClass) throw new Error('このブラウザーは音声処理に対応していません。');
    const context = new AudioContextClass({ latencyHint: 'interactive' });
    this.context = context;
    const gain = context.createGain();
    gain.gain.value = this.master;
    const limiter = context.createDynamicsCompressor();
    limiter.threshold.value = -1;
    limiter.knee.value = 3;
    limiter.ratio.value = 20;
    limiter.attack.value = 0.003;
    limiter.release.value = 0.15;
    const analyser = context.createAnalyser();
    analyser.fftSize = 256;
    gain.connect(limiter).connect(analyser).connect(context.destination);
    this.masterNodes = { gain, limiter, analyser };
    for (const deck of Object.values(this.decks)) {
      const low = context.createBiquadFilter();
      low.type = 'lowshelf'; low.frequency.value = 250; low.gain.value = deck.eq.low;
      const mid = context.createBiquadFilter();
      mid.type = 'peaking'; mid.frequency.value = 1000; mid.Q.value = 0.8; mid.gain.value = deck.eq.mid;
      const high = context.createBiquadFilter();
      high.type = 'highshelf'; high.frequency.value = 4000; high.gain.value = deck.eq.high;
      const volume = context.createGain();
      volume.gain.value = deck.volume;
      const cross = context.createGain();
      cross.gain.value = this._crossGain(deck.id);
      const meter = context.createAnalyser();
      meter.fftSize = 256;
      low.connect(mid).connect(high).connect(volume).connect(meter).connect(cross).connect(gain);
      deck.nodes = { low, mid, high, volume, cross, meter };
    }
    return context;
  }

  async init() {
    const context = this._ensureContext();
    if (context.state === 'suspended' || context.state === 'interrupted') await context.resume();
    await this._registerKeyLock();
    return context;
  }

  async _registerKeyLock() {
    if (this.keyLockRegistration) return this.keyLockRegistration;
    const context = this._ensureContext();
    if (!context.audioWorklet || !globalThis.AudioWorkletNode) {
      this.keyLockError = 'この環境ではKEY LOCKを利用できません。テンポ変更に合わせて音程も変わります。';
      return false;
    }
    this.keyLockRegistration = (async () => {
      try {
        const module = await import('./vendor/soundtouchjs/packages/audio-worklet/.dist/SoundTouchNode.js?v=7c8bf604d2c9c1e4');
        const processorUrl = new URL('./vendor/soundtouchjs/packages/audio-worklet/.dist/soundtouch-processor.js?v=7c8bf604d2c9c1e4', import.meta.url);
        await module.SoundTouchNode.register(context, processorUrl);
        if (this.disposed || context !== this.context) return false;
        this.SoundTouchNode = module.SoundTouchNode;
        this.keyLockReady = true;
        return true;
      } catch {
        this.keyLockReady = false;
        this.keyLockError = 'KEY LOCKを準備できませんでした。テンポ変更に合わせて音程も変わります。';
        try { this.onStatus({ type: 'keylock', available: false, message: this.keyLockError }); } catch { /* UI callback. */ }
        return false;
      }
    })();
    return this.keyLockRegistration;
  }

  async _registerScratch() {
    if (this.scratchRegistration) return this.scratchRegistration;
    const context = this._ensureContext();
    if (!context.audioWorklet || !globalThis.AudioWorkletNode) {
      throw new Error('この環境はスクラッチ音声に対応していません。HTTPSまたはlocalhostで対応ブラウザーを使ってください。');
    }
    this.scratchRegistration = context.audioWorklet.addModule(new URL('./scratch-worklet.js?v=7c8bf604d2c9c1e4', import.meta.url)).catch(error => {
      this.scratchRegistration = null;
      throw error;
    });
    return this.scratchRegistration;
  }

  _releaseScratch(deck) {
    const scratch = deck.scratch;
    scratch.cancelBegin?.();
    scratch.cancelBegin = null;
    scratch.token += 1;
    scratch.pending = false;
    scratch.active = false;
    scratch.resume = false;
    if (scratch.resolveReady) scratch.resolveReady(false);
    scratch.resolveReady = null;
    if (scratch.node) {
      scratch.node.port.postMessage({ type: 'dispose' });
      scratch.node.disconnect();
      scratch.node.port.close();
    }
    scratch.node = null; scratch.ready = null; scratch.buffer = null;
  }

  async _prepareScratch(deck) {
    const scratch = deck.scratch;
    const buffer = deck.buffer;
    if (!buffer) throw new Error('スクラッチする曲を読み込んでください。');
    if (scratch.buffer === buffer && scratch.ready) return scratch.ready;
    if (isPcmFile(buffer)) {
      const node = new PcmFileSource(this._ensureContext(), buffer);
      scratch.node = node; scratch.buffer = buffer;
      scratch.ready = node.ready;
      node.port.onmessage = ({data}) => {
        if (scratch.node === node && scratch.active && data.session === scratch.token && Number.isFinite(data.position)) {
          deck.offset = clamp(data.position, 0, buffer.duration);
        }
      };
      node.onerror = () => {
        if (scratch.node !== node) return;
        this._releaseScratch(deck);
        try {this.onStatus({type: 'scratch', available: false, message: '音源の読み取りに失敗しました。ファイルを確認して再生し直してください。'});} catch { /* UI callback. */ }
      };
      return scratch.ready;
    }
    await this._registerScratch();
    if (this.disposed || deck.buffer !== buffer) return false;
    // A second caller may have prepared the same buffer while the module loaded.
    if (scratch.buffer === buffer && scratch.ready) return scratch.ready;
    const node = new AudioWorkletNode(this.context, 'deckflow-scratch', {
      numberOfInputs: 0, numberOfOutputs: 1,
      outputChannelCount: [Math.min(2, buffer.numberOfChannels)],
    });
    scratch.node = node;
    scratch.buffer = buffer;
    const id = ++scratch.loadId;
    scratch.ready = new Promise((resolve, reject) => {
      scratch.resolveReady = resolve;
      node.port.onmessage = ({ data }) => {
        if (scratch.node !== node) return;
        if (data?.type === 'ready' && data.id === id) {
          scratch.resolveReady = null;
          resolve(true);
        }
        if (data?.type === 'position' && scratch.active && data.session === scratch.token && Number.isFinite(data.position)) {
          deck.offset = clamp(data.position, 0, buffer.duration);
        }
      };
      node.onprocessorerror = () => {
        reject(new Error('スクラッチ音声処理を開始できませんでした。'));
        if (scratch.node === node) {
          this._releaseScratch(deck);
          try { this.onStatus({ type: 'scratch', available: false, message: 'スクラッチ音声処理が停止しました。曲を読み込み直してください。' }); } catch { /* UI callback. */ }
        }
      };
    });
    // Transfer one owned copy of each channel. Never detach AudioBuffer storage.
    const channels = [];
    for (let index = 0; index < Math.min(2, buffer.numberOfChannels); index++) channels.push(buffer.getChannelData(index).slice());
    node.port.postMessage({ type: 'load', id, sampleRate: buffer.sampleRate, channels }, channels.map(channel => channel.buffer));
    return scratch.ready;
  }

  async decode(arrayBuffer) {
    if (!(arrayBuffer instanceof ArrayBuffer) || !arrayBuffer.byteLength) {
      throw new Error('読み込める音声データがありません。');
    }
    const context = this._ensureContext();
    let buffer;
    try {
      // Do not resume here: file import need not wait for an audio-unlock gesture.
      buffer = await context.decodeAudioData(arrayBuffer);
    } catch {
      throw new Error('音声を開けません。MP3、AAC、WAVなど、このブラウザーで再生できるファイルを選んでください。');
    }
    if (!buffer?.length || !Number.isFinite(buffer.duration) || buffer.duration <= 0) {
      throw new Error('音声の長さを読み取れませんでした。');
    }
    return buffer;
  }

  decodeFile(blob) {return openAudioFile(blob, this._ensureContext());}

  load(id, audioBuffer) {
    const deck = this._deck(id);
    if (!audioBuffer || !Number.isFinite(audioBuffer.duration) || audioBuffer.duration <= 0 || !audioBuffer.length) {
      throw new Error('有効な音声ファイルを読み込んでください。');
    }
    this.pause(id);
    this._releaseScratch(deck);
    deck.buffer = audioBuffer;
    deck.offset = 0;
    deck.startedAt = this.context?.currentTime || 0;
    deck.cue = 0;
    deck.loop = null;
    deck.grid = []; deck.sync = false; this._refreshPhaseRoutes();
    // Preload the audio-thread PCM while the user chooses the next action.
    this._prepareScratch(deck).catch(() => {});
  }

  unload(id) {
    const deck = this._deck(id);
    this.pause(id);
    this._releaseScratch(deck);
    deck.buffer = null;
    deck.offset = 0;
    deck.startedAt = this.context?.currentTime || 0;
    deck.cue = 0;
    deck.loop = null; deck.grid = []; deck.sync = false; this._refreshPhaseRoutes();
  }

  _crossGain(id) {
    return id === 'a' ? Math.cos(this.crossfader * Math.PI / 2) : Math.sin(this.crossfader * Math.PI / 2);
  }

  _position(deck, now = this.context?.currentTime || 0) {
    if (!deck.buffer) return 0;
    if (deck.playing && deck.source instanceof PcmFileSource) return deck.source.position;
    let position = deck.offset + (deck.playing ? Math.max(0, now - deck.startedAt) * deck.rate : 0);
    if (deck.loop && position >= deck.loop.end) {
      const length = deck.loop.end - deck.loop.start;
      position = deck.loop.start + ((position - deck.loop.start) % length + length) % length;
    }
    return clamp(position, 0, deck.buffer.duration);
  }

  _capture(deck) {
    deck.offset = this._position(deck);
    deck.startedAt = this.context?.currentTime || 0;
  }

  _stopSource(deck, when = 0) {
    const source = deck.source, keyLockNode = deck.keyLockNode, gain = deck.transportGain;
    deck.generation += 1;
    deck.source = null; deck.keyLockNode = null; deck.transportGain = null;
    deck.pendingSource?.stop(); deck.pendingSource = null;
    const cleanup = () => {
      if (source) {source.onended = null; try {source.stop();} catch {} try {source.disconnect();} catch {}}
      if (keyLockNode) {keyLockNode.disconnect(); keyLockNode.port.close();}
      gain?.disconnect(); deck.retired.delete(cleanup);
    };
    if (source && when > (this.context?.currentTime || 0)) {
      // Continue the old phrase until the scheduled HOT CUE beat. Audio clock
      // scheduling handles the cut; JS only releases nodes after completion.
      gain?.gain.setValueAtTime(0, when);
      source.onended = cleanup;
      deck.retired.add(cleanup);
      source.stop(when);
    } else {
      cleanup();
      for (const retire of [...deck.retired]) retire();
    }
  }

  _usesKeyLock(deck, rate = deck.rate) {
    // At unity rate pitch correction has no effect. Bypass its window/buffer
    // latency so releasing a scratch resumes PCM immediately at normal tempo.
    return !deck.phaseSync && deck.keyLock && this.keyLockReady && this.SoundTouchNode && Math.abs(rate - 1) > 0.000001;
  }

  _fallbackKeyLock(deck, source, transportGain) {
    source.disconnect();
    if (deck.keyLockNode) {
      deck.keyLockNode.disconnect();
      deck.keyLockNode.port.close();
    }
    deck.keyLockNode = null;
    deck.keyLock = false;
    deck.keyLockError = 'KEY LOCKの音声処理を利用できないため、ピッチ連動で再生を続けています。';
    source.connect(transportGain);
    try { this.onStatus({ type: 'keylock', deck: deck.id, available: true, enabled: false, message: deck.keyLockError }); } catch { /* UI callback. */ }
  }

  _start(deck, {when = 0, source: preparedSource = null} = {}) {
    const context = this._ensureContext();
    if (!deck.buffer) return;
    if (deck.offset >= deck.buffer.duration) deck.offset = 0;
    const source = preparedSource || (isPcmFile(deck.buffer) ? new PcmFileSource(context, deck.buffer) : context.createBufferSource());
    if (!isPcmFile(deck.buffer)) source.buffer = deck.buffer;
    source.playbackRate.value = deck.rate;
    if (deck.loop) {
      source.loopStart = deck.loop.start;
      source.loopEnd = deck.loop.end;
      source.loop = true;
    }
    const transportGain = context.createGain();
    transportGain.gain.value = 0;
    transportGain.gain.setTargetAtTime(1, Math.max(context.currentTime, when), 0.003);
    transportGain.connect(deck.nodes.low);
    deck.transportGain = transportGain;
    if (this._usesKeyLock(deck)) {
      try {
        const processor = new this.SoundTouchNode({ context, outputChannelCount: Math.min(2, deck.buffer.numberOfChannels) });
        deck.keyLockNode = processor;
        processor.playbackRate.value = deck.rate;
        processor.pitch.value = 1;
        source.connect(processor).connect(transportGain);
        processor.onprocessorerror = () => {
          if (deck.keyLockNode !== processor || deck.source !== source) return;
          this._fallbackKeyLock(deck, source, transportGain);
        };
      } catch {
        this._fallbackKeyLock(deck, source, transportGain);
      }
    } else source.connect(transportGain);
    deck.source = source;
    const generation = ++deck.generation;
    deck.startedAt = Math.max(context.currentTime, when);
    deck.playing = true;
    source.onerror = error => {
      if (deck.source !== source) return;
      this._capture(deck); this._stopSource(deck);
      deck.playing = false; deck.wantsPlay = false;
      try {this.onStatus({type: 'audio', deck: deck.id, available: false,
        message: error?.message || '音源の読み取りに失敗しました。再生し直してください。'});} catch { /* UI callback. */ }
    };
    source.onended = () => {
      if (deck.source !== source || deck.generation !== generation) return;
      deck.offset = deck.buffer?.duration || 0;
      deck.startedAt = context.currentTime;
      deck.playing = false;
      deck.wantsPlay = false;
      deck.source = null;
      source.disconnect();
      if (deck.keyLockNode) {
        deck.keyLockNode.disconnect();
        deck.keyLockNode.port.close();
        deck.keyLockNode = null;
      }
      if (deck.transportGain) {deck.transportGain.disconnect(); deck.transportGain = null;}
      try { this.onEnded(deck.id); } catch { /* A view callback must not break the transport. */ }
    };
    try {
      const started = source.start(when, deck.offset);
      if (started?.catch) return started.catch(error => {source.onerror(error);});
    } catch (error) {
      this._stopSource(deck);
      deck.playing = false;
      deck.wantsPlay = false;
      throw error;
    }
  }

  async play(id, {quantize = true} = {}) {
    const deck = this._deck(id);
    if (deck.scratch.active || deck.scratch.pending) this._finishScratch(deck);
    if (!deck.buffer || deck.playing) return;
    deck.pendingSource?.stop(); deck.pendingSource = null;
    deck.wantsPlay = true;
    const command = ++deck.command;
    let preparedSource = null;
    try {
      await this.init();
      if (this.disposed || deck.command !== command || !deck.wantsPlay || deck.playing || !deck.buffer) return;
      if (quantize && deck.quantize && isPcmFile(deck.buffer)) {
        preparedSource = new PcmFileSource(this.context, deck.buffer);
        preparedSource.playbackRate.value = deck.rate;
        deck.pendingSource = preparedSource;
        const offset = beatPosition(deck.grid, deck.offset);
        if (!await preparedSource.prepare(offset) || deck.command !== command || !deck.wantsPlay || this.disposed) {preparedSource.stop(); return;}
        deck.pendingSource = null;
      }
      const plan = this._playPlan(deck, quantize);
      deck.offset = plan.position;
      await this._start(deck, {when: plan.when, source: preparedSource});
    } catch (error) {
      preparedSource?.stop();
      if (deck.pendingSource === preparedSource) deck.pendingSource = null;
      if (deck.command === command) deck.wantsPlay = false;
      throw error;
    }
  }

  pause(id) {
    const deck = this._deck(id);
    if (deck.scratch.active || deck.scratch.pending) this._finishScratch(deck);
    this._capture(deck);
    deck.command += 1;
    deck.wantsPlay = false;
    deck.playing = false;
    this._stopSource(deck);
    for (const follower of Object.values(this.decks)) {
      if (follower !== deck && follower.sync && follower.syncMaster === id && follower.wantsPlay && (follower.pendingSource || (follower.playing && follower.startedAt > (this.context?.currentTime || 0)))) this.pause(follower.id);
    }
  }

  async toggle(id) {
    const deck = this._deck(id);
    if (deck.playing || deck.wantsPlay) this.pause(id);
    else await this.play(id);
  }

  seek(id, seconds) {
    const deck = this._deck(id);
    if (!deck.buffer) return;
    const wasPlaying = deck.playing || ((deck.scratch.active || deck.scratch.pending) && deck.scratch.resume);
    if (deck.scratch.active || deck.scratch.pending) this._finishScratch(deck);
    this._stopSource(deck);
    deck.playing = false;
    deck.offset = clamp(seconds, 0, deck.buffer.duration);
    if (deck.loop && deck.offset >= deck.loop.end) deck.offset = deck.loop.start;
    deck.startedAt = this.context?.currentTime || 0;
    if (wasPlaying && deck.offset < deck.buffer.duration) this._start(deck);
    else if (wasPlaying) {
      deck.command += 1;
      deck.wantsPlay = false;
    }
  }

  getState(id) {
    const deck = this._deck(id);
    return {
      loaded: Boolean(deck.buffer),
      playing: deck.playing,
      scheduled: deck.playing && deck.startedAt > (this.context?.currentTime || 0),
      quantize: deck.quantize, sync: deck.sync,
      position: this._position(deck),
      duration: deck.buffer?.duration || 0,
      rate: deck.rate,
      volume: deck.volume,
      cue: deck.cue,
      loop: deck.loop ? { ...deck.loop } : null,
      scratching: deck.scratch.active || deck.scratch.pending,
      buffering: Boolean(deck.source?.buffering),
      keyLock: deck.keyLock && this.keyLockReady && !deck.phaseSync,
      keyLockEffective: deck.keyLock && this.keyLockReady && !deck.phaseSync,
      keyLockBypassReason: deck.phaseSync ? '拍同期中はPITCH LINKで再生します。KEY LOCKの設定は保持されます。' : null,
      keyLockRequested: deck.keyLock,
      keyLockAvailable: this.keyLockReady,
      keyLockError: deck.keyLockError || this.keyLockError,
    };
  }

  setRate(id, rate, {preserveSync = false, propagate = true} = {}) {
    const deck = this._deck(id);
    if (!preserveSync) {deck.sync = false; this._refreshPhaseRoutes();}
    this._capture(deck);
    deck.rate = clamp(rate, 0.25, 4);
    if (deck.playing && Boolean(deck.keyLockNode) !== Boolean(this._usesKeyLock(deck))) {
      this._stopSource(deck);
      deck.playing = false;
      this._start(deck);
    } else {
      if (deck.source) deck.source.playbackRate.setValueAtTime(deck.rate, this.context.currentTime);
      if (deck.keyLockNode) deck.keyLockNode.playbackRate.setValueAtTime(deck.rate, this.context.currentTime);
    }
    if (propagate) this._updateFollowers(id);
  }

  _updateFollowers(masterId) {
    const master = this._deck(masterId), masterTempo = beatSegment(master.grid, this._position(master));
    if (!masterTempo) return;
    for (const follower of Object.values(this.decks)) {
      if (!follower.sync || follower.syncMaster !== masterId) continue;
      const tempo = beatSegment(follower.grid, this._position(follower));
      if (!tempo) continue;
      const rate = masterTempo.bpm * master.rate / tempo.bpm;
      if (rate >= .5 && rate <= 1.5) this.setRate(follower.id, rate, {preserveSync:true, propagate:false});
    }
  }

  setKeyLock(id, enabled) {
    const deck = this._deck(id);
    const value = Boolean(enabled);
    if (deck.keyLock === value) return;
    const wasPlaying = deck.playing;
    this._capture(deck);
    this._stopSource(deck);
    deck.playing = false;
    deck.keyLock = value;
    deck.keyLockError = null;
    if (wasPlaying) this._start(deck);
  }

  async beginScratch(id) {
    const deck = this._deck(id);
    if (!deck.buffer) throw new Error('スクラッチする曲を読み込んでください。');
    const scratch = deck.scratch;
    if (scratch.active || scratch.pending) return;
    const resume = deck.playing || deck.wantsPlay;
    this.pause(id);
    this.clearLoop(id);
    const token = ++scratch.token;
    scratch.pending = true;
    scratch.resume = resume;
    scratch.target = deck.offset;
    scratch.start = deck.offset;
    scratch.timeStamp = null;
    let timeout;
    const canceled = new Promise(resolve => { scratch.cancelBegin = () => resolve(false); });
    try {
      const context = this._ensureContext();
      const preparation = (async () => {
        if (context.state === 'suspended' || context.state === 'interrupted') await context.resume();
        return this._prepareScratch(deck);
      })();
      const ready = await Promise.race([preparation, canceled, new Promise((_, reject) => {
        timeout = setTimeout(() => reject(new Error('スクラッチ音声の準備が完了しませんでした。曲を読み込み直してください。')), 10000);
      })]);
      if (!ready || this.disposed || scratch.token !== token || !scratch.pending) return;
      scratch.pending = false;
      scratch.active = true;
      scratch.node.port.postMessage({ type: 'begin', position: scratch.start, session: token });
      scratch.node.port.postMessage({ type: 'target', position: scratch.target, timeStamp: scratch.timeStamp });
      scratch.node.connect(deck.nodes.low);
    } catch (error) {
      if (scratch.token !== token) return;
      this._finishScratch(deck);
      if (resume) await this.play(id, {quantize: false});
      throw error;
    } finally {
      clearTimeout(timeout);
      if (scratch.token === token) scratch.cancelBegin = null;
    }
  }

  scratchTo(id, seconds, timeStamp) {
    const deck = this._deck(id);
    const scratch = deck.scratch;
    if (!deck.buffer || (!scratch.active && !scratch.pending)) return;
    scratch.target = clamp(seconds, 0, Math.max(0, deck.buffer.duration - 1 / deck.buffer.sampleRate));
    scratch.timeStamp = Number.isFinite(timeStamp) ? timeStamp : null;
    if (scratch.active && scratch.node) scratch.node.port.postMessage({ type: 'target', position: scratch.target, timeStamp: scratch.timeStamp });
    else deck.offset = scratch.target;
  }

  _finishScratch(deck) {
    const scratch = deck.scratch;
    const resume = scratch.resume;
    scratch.cancelBegin?.();
    scratch.cancelBegin = null;
    scratch.token += 1;
    scratch.pending = false; scratch.active = false; scratch.resume = false;
    if (scratch.node) {
      scratch.node.port.postMessage({ type: 'end' });
      scratch.node.disconnect();
    }
    deck.offset = clamp(scratch.target, 0, deck.buffer?.duration || 0);
    deck.startedAt = this.context?.currentTime || 0;
    return resume;
  }

  async endScratch(id) {
    const deck = this._deck(id);
    if (!deck.scratch.active && !deck.scratch.pending) return;
    const resume = this._finishScratch(deck);
    if (resume) await this.play(id, {quantize: false});
  }

  setBeatGrid(id, metadata) {
    const deck = this._deck(id);
    deck.grid = normalizeBeatGrid(metadata);
    this._refreshPhaseRoutes(); this._updateFollowers(id);
  }

  setQuantize(id, enabled) {
    const deck = this._deck(id); deck.quantize = Boolean(enabled); this._refreshPhaseRoutes(); return deck.quantize;
  }

  _refreshPhaseRoutes() {
    const participants = new Set();
    for (const deck of Object.values(this.decks)) {
      const master = this.decks[deck.syncMaster];
      if (deck.sync && deck.quantize && deck.grid.length && master?.grid.length) {participants.add(deck.id); participants.add(master.id);}
    }
    let activated = false;
    for (const deck of Object.values(this.decks)) {
      const value = participants.has(deck.id);
      if (deck.phaseSync === value) continue;
      deck.phaseSync = value;
      if (value && deck.keyLock) activated = true;
      if (deck.playing && Boolean(deck.keyLockNode) !== Boolean(this._usesKeyLock(deck))) {
        this._capture(deck); this._stopSource(deck); deck.playing = false; this._start(deck);
      }
    }
    if (activated) {try {this.onStatus({type:'keylock', available:true, enabled:false, message:'拍同期中は両デッキをPITCH LINKで再生します。KEY LOCKの設定は保持されます。'});} catch {}}
  }

  setSync(id, enabled, masterId = id === 'a' ? 'b' : 'a') {
    const deck = this._deck(id), master = this._deck(masterId);
    if (master === deck) throw new Error('同期先に別のデッキを選んでください。');
    if (!enabled) {deck.sync = false; this._refreshPhaseRoutes(); return false;}
    const ownTempo = beatSegment(deck.grid, this._position(deck));
    const masterTempo = beatSegment(master.grid, this._position(master));
    if (!ownTempo || !masterTempo) throw new Error('両方のデッキへBPMのある曲を読み込んでください。');
    const rate = masterTempo.bpm * master.rate / ownTempo.bpm;
    if (rate < .5 || rate > 1.5) throw new Error('BPM差がテンポの調整範囲（±50%）を超えています。');
    if (master.sync && master.syncMaster === id) master.sync = false;
    deck.sync = true; deck.syncMaster = masterId;
    this._refreshPhaseRoutes();
    this.setRate(id, rate, {preserveSync: true});
    return true;
  }

  _playPlan(deck, quantize = true, offset = deck.offset) {
    const now = this.context?.currentTime || 0;
    let position = quantize && deck.quantize ? beatPosition(deck.grid, offset) : offset;
    if (deck.buffer && position >= deck.buffer.duration) position = quantize && deck.quantize
      ? beatPosition(deck.grid, deck.buffer.duration - 1 / deck.buffer.sampleRate, 'previous') : 0;
    const master = this.decks[deck.syncMaster];
    if (!quantize || !deck.quantize || !deck.sync || !master?.playing || !master.grid.length || !deck.grid.length) return {position, when: 0};
    if (master.source?.buffering) throw new Error('同期先の音源を読み込み中です。再生が安定してから操作してください。');
    // Reserve on the audio clock, never setTimeout. Lead time gives both
    // native sources and prepared file worklets time to receive the schedule.
    const earliest = Math.max(now + .030, master.startedAt);
    let masterPosition = this._position(master) + Math.max(0, earliest - Math.max(now, master.startedAt)) * master.rate;
    if (master.loop && masterPosition >= master.loop.end) masterPosition = master.loop.start + (masterPosition - master.loop.start) % (master.loop.end - master.loop.start);
    let next = beatPosition(master.grid, masterPosition, 'next');
    let distance = Math.max(0, next - masterPosition);
    if (master.loop && next >= master.loop.end) {
      next = beatPosition(master.grid, master.loop.start, 'next');
      if (next >= master.loop.end) next = master.loop.start;
      distance = Math.max(0, master.loop.end - masterPosition) + Math.max(0, next - master.loop.start);
    }
    const tempo = beatSegment(master.grid, next), ownTempo = beatSegment(deck.grid, position);
    const rate = tempo.bpm * master.rate / ownTempo.bpm;
    if (rate < .5 || rate > 1.5) throw new Error('次の拍のBPM差がテンポの調整範囲（±50%）を超えています。');
    deck.rate = rate;
    return {position, when: earliest + distance / master.rate};
  }

  async triggerCue(id, seconds, {loop = null} = {}) {
    const deck = this._deck(id);
    if (!deck.buffer) return;
    if (deck.scratch.active || deck.scratch.pending) this._finishScratch(deck);
    deck.pendingSource?.stop(); deck.pendingSource = null;
    const command = ++deck.command;
    deck.wantsPlay = true;
    try {await this.init();}
    catch (error) {if (deck.command === command) deck.wantsPlay = deck.playing; throw error;}
    if (deck.command !== command || !deck.wantsPlay || this.disposed) return;
    const target = clamp(deck.quantize ? beatPosition(deck.grid, seconds) : seconds, 0, Math.max(0, deck.buffer.duration - 1 / deck.buffer.sampleRate));
    let preparedSource = null;
    if (isPcmFile(deck.buffer)) {
      preparedSource = new PcmFileSource(this.context, deck.buffer); preparedSource.playbackRate.value = deck.rate;
      if (loop && Number.isFinite(loop.start) && Number.isFinite(loop.end) && loop.end > loop.start) {
        preparedSource.loopStart = loop.start; preparedSource.loopEnd = loop.end; preparedSource.loop = true;
      }
      deck.pendingSource = preparedSource;
      try {
        if (!await preparedSource.prepare(target) || deck.command !== command || !deck.wantsPlay || this.disposed) {preparedSource.stop(); return;}
      } catch (error) {if (deck.pendingSource === preparedSource) deck.pendingSource = null; if (deck.command === command) deck.wantsPlay = deck.playing; throw error;}
      deck.pendingSource = null;
    }
    let plan;
    try {plan = this._playPlan(deck, true, target);}
    catch (error) {preparedSource?.stop(); if (deck.command === command) deck.wantsPlay = deck.playing; throw error;}
    this._stopSource(deck, plan.when);
    deck.playing = false; deck.offset = plan.position;
    deck.loop = loop && Number.isFinite(loop.start) && Number.isFinite(loop.end) && loop.end > loop.start
      ? {start: loop.start, end: loop.end} : null;
    await this._start(deck, {when: plan.when, source: preparedSource});
  }

  _smooth(param, value) {
    const now = this.context.currentTime;
    param.cancelScheduledValues(now);
    param.setTargetAtTime(value, now, 0.008);
  }

  setVolume(id, value) {
    const deck = this._deck(id);
    deck.volume = clamp(value, 0, 1);
    if (deck.nodes) this._smooth(deck.nodes.volume.gain, deck.volume);
  }

  setEQ(id, band, dB) {
    const deck = this._deck(id);
    if (!['low', 'mid', 'high'].includes(band)) throw new Error('EQの帯域が正しくありません。');
    deck.eq[band] = clamp(dB, -24, 12);
    if (deck.nodes) this._smooth(deck.nodes[band].gain, deck.eq[band]);
  }

  setCrossfader(value) {
    this.crossfader = clamp(value, 0, 1);
    for (const deck of Object.values(this.decks)) {
      if (deck.nodes) this._smooth(deck.nodes.cross.gain, this._crossGain(deck.id));
    }
  }

  setMaster(value) {
    this.master = clamp(value, 0, 1);
    if (this.masterNodes) this._smooth(this.masterNodes.gain.gain, this.master);
  }

  setCue(id, seconds) {
    const deck = this._deck(id);
    deck.cue = clamp(deck.quantize ? beatPosition(deck.grid, seconds) : seconds, 0, deck.buffer ? Math.max(0, deck.buffer.duration - 1 / deck.buffer.sampleRate) : 0);
  }

  jumpCue(id) {
    const deck = this._deck(id);
    this.pause(id);
    this.clearLoop(id);
    this.seek(id, deck.quantize ? beatPosition(deck.grid, deck.cue) : deck.cue);
  }

  setLoop(id, startSeconds, endSeconds) {
    const deck = this._deck(id);
    if (!deck.buffer) return;
    const start = clamp(startSeconds, 0, deck.buffer.duration);
    const end = clamp(endSeconds, 0, deck.buffer.duration);
    if (end - start < 0.02) throw new Error('ループの開始と終了を20 ms以上離してください。');
    this._capture(deck);
    deck.loop = { start, end };
    if (deck.source) {
      deck.source.loopStart = start;
      deck.source.loopEnd = end;
      deck.source.loop = true;
    }
    if (deck.offset >= end) this.seek(id, start);
  }

  clearLoop(id) {
    const deck = this._deck(id);
    this._capture(deck);
    deck.loop = null;
    if (deck.source) deck.source.loop = false;
  }

  _rms(analyser, data) {
    analyser.getFloatTimeDomainData(data);
    let sum = 0;
    for (let i = 0; i < data.length; i++) sum += data[i] * data[i];
    return clamp(Math.sqrt(sum / data.length), 0, 1);
  }

  getLevels() {
    if (!this.context || !this.masterNodes) return { a: 0, b: 0, master: 0 };
    return {
      a: this._rms(this.decks.a.nodes.meter, this.decks.a.meter),
      b: this._rms(this.decks.b.nodes.meter, this.decks.b.meter),
      master: this._rms(this.masterNodes.analyser, this.masterMeter),
    };
  }

  dispose() {
    if (this.disposed) return;
    for (const deck of Object.values(this.decks)) {
      this.pause(deck.id);
      this._releaseScratch(deck);
      deck.buffer = null;
      if (deck.nodes) for (const node of Object.values(deck.nodes)) node.disconnect();
      deck.nodes = null;
    }
    if (this.masterNodes) for (const node of Object.values(this.masterNodes)) node.disconnect();
    this.masterNodes = null;
    const context = this.context;
    this.context = null;
    this.disposed = true;
    if (context && context.state !== 'closed') context.close().catch(() => {});
  }
}
