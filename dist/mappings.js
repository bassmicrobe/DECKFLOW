/**
 * MIDI and keyboard input profiles. No MIDI permission is requested until
 * enableMIDI() is called by a user action. Storage stays in this browser.
 * Keyboard assignments intentionally target button actions; sliders use MIDI.
 */
const STORAGE_KEY = 'deckflow.input-profile.v1';
const MAX_MAPPINGS = 256;
const MODES = new Set(['absolute', 'relative-twos', 'relative-offset']);
const KEY_CODES = /^(Key[A-Z]|Digit[0-9]|Numpad(?:[0-9]|Add|Subtract|Multiply|Divide|Decimal|Enter)|Arrow(?:Up|Down|Left|Right)|Space|Enter|Backspace|Delete|BracketLeft|BracketRight|Backslash|Semicolon|Quote|Comma|Period|Slash|Minus|Equal|Backquote|IntlBackslash|IntlRo|IntlYen)$/;
const DEFAULT_KEYS = {
  'a.play': 'KeyQ', 'b.play': 'KeyP', 'a.cue': 'KeyA',
  'b.cue': 'KeyL', 'mixer.center': 'KeyG',
};
const copy = value => JSON.parse(JSON.stringify(value));
const clamp = value => Math.min(1, Math.max(0, value));
const isInt = (value, min, max) => Number.isInteger(value) && value >= min && value <= max;
let nextId = 0;
const makeId = () => `mapping-${Date.now().toString(36)}-${++nextId}`;

function sameBinding(a, b) {
  if (a.source !== b.source) return false;
  const x = a.binding, y = b.binding;
  if (a.source === 'keyboard') return x.code === y.code && x.shift === y.shift && x.alt === y.alt;
  return x.type === y.type && x.channel === y.channel && x.number === y.number &&
    (!x.device || !y.device || x.device === y.device);
}

function keyBinding(event) {
  if (event.metaKey || event.ctrlKey || !KEY_CODES.test(event.code || '')) return null;
  // These are navigation shortcuts in browsers; do not capture them even in Learn.
  if (event.altKey && ['ArrowLeft', 'ArrowRight', 'Home'].includes(event.code)) return null;
  return {code: event.code, shift: !!event.shiftKey, alt: !!event.altKey};
}

function editingTarget(event) {
  const nodes = typeof event.composedPath === 'function' ? event.composedPath() : [event.target];
  return nodes.some(node => {
    if (!node || typeof node !== 'object') return false;
    if (node.isContentEditable || ['INPUT', 'TEXTAREA', 'SELECT'].includes(node.tagName)) return true;
    return typeof node.closest === 'function' && !!node.closest(
      'input,textarea,select,form,dialog,[role="dialog"],[role="textbox"],[contenteditable]:not([contenteditable="false"])',
    );
  });
}

function parseMidi(data) {
  if (!data || data.length < 3 || !isInt(data[0], 0x80, 0xef) ||
      !isInt(data[1], 0, 127) || !isInt(data[2], 0, 127)) return null;
  const command = data[0] >> 4, channel = data[0] & 15;
  if (command === 8 || command === 9) {
    const pressed = command === 9 && data[2] > 0;
    return {type: 'note', channel, number: data[1], raw: pressed ? data[2] : 0, value: pressed ? data[2] / 127 : 0, pressed};
  }
  if (command === 11) return {type: 'cc', channel, number: data[1], raw: data[2], value: data[2] / 127, pressed: data[2] >= 64};
  if (command === 14) {
    const raw = data[1] | (data[2] << 7);
    return {type: 'pitchbend', channel, raw, value: raw / 16383, pressed: raw > 8191};
  }
  return null;
}

export class MappingManager {
  constructor({actions = [], onAction = () => {}, onChange = () => {}, onStatus = () => {}} = {}) {
    this.actions = new Map(actions.filter(action => action && typeof action.id === 'string' &&
      ['trigger', 'continuous'].includes(action.kind)).map(action => [action.id, {...action}]));
    this.onAction = onAction;
    this.onChange = onChange;
    this.onStatus = onStatus;
    this.learning = null;
    this._midiAccess = null;
    this._midiRequest = null;
    this._ports = new Map();
    this._heldKeys = new Map();
    this._heldMidi = new Set();
    this._values = new Map();
    this._disposed = false;
    this._onStateChange = () => this._refreshPorts();
    this._releaseHeld = () => { this._heldKeys.clear(); this._heldMidi.clear(); };
    this._onVisibilityChange = () => { if (globalThis.document?.hidden) this._releaseHeld(); };
    globalThis.addEventListener?.('blur', this._releaseHeld);
    globalThis.document?.addEventListener?.('visibilitychange', this._onVisibilityChange);
    this.status = {
      state: typeof globalThis.navigator?.requestMIDIAccess === 'function' ? 'disconnected' : 'unavailable',
      message: typeof globalThis.navigator?.requestMIDIAccess === 'function'
        ? 'MIDIは未接続です。「MIDIを接続」から許可してください。'
        : 'このブラウザではWeb MIDIを利用できません。キー割り当てと画面操作は使えます。',
      inputs: [],
    };
    this._profile = this._defaults();
    try {
      const saved = globalThis.localStorage?.getItem(STORAGE_KEY);
      if (saved) this._profile = this._validate(saved);
    } catch {
      // Keep a usable default profile when site data is inaccessible or obsolete.
      this.status.message += ' 保存済み設定を読めなかったため、初期割り当てを使用しています。';
    }
  }

  get profile() { return copy(this._profile); }

  _defaults() {
    return {version: 1, name: 'DECKFLOW マイコントローラー', mappings: Object.entries(DEFAULT_KEYS)
      .filter(([actionId]) => this.actions.get(actionId)?.kind === 'trigger')
      .map(([actionId, code]) => ({id: `default-${actionId}`, actionId, source: 'keyboard',
        binding: {code, shift: false, alt: false}, mode: 'absolute'}))};
  }

  _status(message, state = this.status.state) {
    if (this._disposed) return;
    this.status = {...this.status, state, message};
    this.onStatus(copy(this.status));
  }

  _change() {
    if (this._disposed) return;
    try { globalThis.localStorage?.setItem(STORAGE_KEY, JSON.stringify(this._profile)); }
    catch { this._status('設定を端末に保存できませんでした。設定ファイルを書き出して保管してください。'); }
    this.onChange(this.profile);
  }

  _assertAction(actionId) {
    const action = this.actions.get(actionId);
    if (!action) throw new Error('この操作は割り当てできません。');
    return action;
  }

  setActionValue(actionId, value) {
    this._assertAction(actionId);
    if (!Number.isFinite(value)) throw new Error('操作値には数値を指定してください。');
    this._values.set(actionId, clamp(value));
  }

  async enableMIDI() {
    if (this._disposed) return false;
    if (typeof globalThis.navigator?.requestMIDIAccess !== 'function') {
      this._status('このブラウザではWeb MIDIを利用できません。iPadでは機材接続用のネイティブ処理が必要です。', 'unavailable');
      return false;
    }
    if (this._midiAccess) { this._refreshPorts(); return true; }
    if (this._midiRequest) return this._midiRequest;
    const pending = (async () => {
      try {
        const access = await globalThis.navigator.requestMIDIAccess({sysex: false});
        if (this._disposed) return false;
        this._midiAccess = access;
        if (typeof access.addEventListener === 'function') access.addEventListener('statechange', this._onStateChange);
        else access.onstatechange = this._onStateChange;
        this._refreshPorts();
        return true;
      } catch {
        if (!this._disposed) {
          this.learning = null;
          this._status('MIDIへのアクセスを許可できませんでした。ブラウザの権限と接続を確認してください。', 'error');
          this.onChange(this.profile);
        }
        return false;
      }
    })();
    this._midiRequest = pending;
    try { return await pending; }
    finally { if (this._midiRequest === pending) this._midiRequest = null; }
  }

  _refreshPorts() {
    if (this._disposed || !this._midiAccess) return;
    const inputs = [...this._midiAccess.inputs.values()].filter(port => port.state !== 'disconnected');
    const ids = new Set(inputs.map(port => port.id));
    for (const [id, entry] of this._ports) {
      if (!ids.has(id) || !inputs.includes(entry.port)) this._detachPort(id, entry);
    }
    for (const port of inputs) {
      if (this._ports.has(port.id)) continue;
      const handler = event => this._handleMidi(event, port);
      const eventListener = typeof port.addEventListener === 'function';
      const previous = eventListener ? null : port.onmidimessage;
      this._ports.set(port.id, {port, handler, eventListener, previous});
      if (eventListener) port.addEventListener('midimessage', handler);
      else port.onmidimessage = handler;
      if (typeof port.open === 'function') Promise.resolve(port.open()).catch(() => {
        if (!this._disposed && this._ports.get(port.id)?.port === port) this._status(`${port.name || 'MIDI機器'}を開けませんでした。`, 'error');
      });
    }
    this.status.inputs = inputs.map(port => ({id: String(port.id), name: port.name || 'MIDI入力',
      manufacturer: port.manufacturer || '', state: port.state || 'connected', connection: port.connection || 'open'}));
    this._status(inputs.length ? `${inputs.length}台のMIDI入力に接続しています。` : 'MIDIの使用は許可済みです。コントローラーを接続してください。',
      inputs.length ? 'connected' : 'disconnected');
  }

  _detachPort(id, entry) {
    if (entry.eventListener) entry.port.removeEventListener?.('midimessage', entry.handler);
    else if (entry.port.onmidimessage === entry.handler) entry.port.onmidimessage = entry.previous;
    this._ports.delete(id);
    const prefix = `${id}:`;
    for (const key of this._heldMidi) if (key.startsWith(prefix)) this._heldMidi.delete(key);
    // Removing our handlers is sufficient; do not close a port another app component may use.
  }

  learn(actionId, source, {mode = 'absolute'} = {}) {
    if (this._disposed) return;
    const action = this._assertAction(actionId);
    if (!['midi', 'keyboard'].includes(source) || !MODES.has(mode)) throw new Error('割り当て方式を確認してください。');
    if (source === 'keyboard' && action.kind !== 'trigger') throw new Error('キーは再生・CUEなどのボタン操作に割り当ててください。');
    if (source === 'keyboard' && mode !== 'absolute') throw new Error('相対モードはMIDIのCC専用です。');
    if (action.kind === 'trigger' && mode !== 'absolute') throw new Error('ボタン操作には絶対値モードを使用してください。');
    if (source === 'midi' && !this._midiAccess) {
      throw new Error(typeof globalThis.navigator?.requestMIDIAccess === 'function'
        ? '先に「MIDIを接続」を押してから学習してください。'
        : 'このブラウザではMIDI学習を利用できません。キー割り当てと画面操作は使えます。');
    }
    this.learning = {actionId, source, mode};
    this.onChange(this.profile);
  }

  cancelLearn() {
    if (!this.learning) return;
    this.learning = null;
    if (!this._disposed) this.onChange(this.profile);
  }

  _capture(source, binding) {
    const learning = this.learning;
    if (!learning || learning.source !== source) return;
    if (source === 'midi' && learning.mode !== 'absolute' && binding.type !== 'cc') {
      this._status('相対モードではCCを送るエンコーダーを回してください。');
      return;
    }
    const mapping = {id: makeId(), actionId: learning.actionId, source, binding, mode: learning.mode};
    const conflicts = this._profile.mappings.filter(old => sameBinding(old, mapping));
    const remaining = this._profile.mappings.filter(old => !sameBinding(old, mapping));
    if (remaining.length >= MAX_MAPPINGS) {
      this._status(`割り当ては${MAX_MAPPINGS}件までです。不要な割り当てを削除するか、既存の入力を選んで置き換えてください。`);
      return;
    }
    this._profile = {...this._profile, mappings: [...remaining, mapping]};
    this.learning = null;
    this._change();
    this._status(conflicts.some(old => old.actionId !== mapping.actionId)
      ? '同じ入力の以前の割り当てを置き換えました。'
      : '割り当てを保存しました。');
  }

  handleKeyDown(event) {
    if (this._disposed || event.defaultPrevented) return false;
    if (this.learning?.source === 'keyboard' && event.code === 'Escape') {
      event.preventDefault?.(); this.cancelLearn(); return true;
    }
    if (event.repeat || this._heldKeys.has(event.code)) return false;
    const binding = keyBinding(event);
    if (!binding) return false;
    if (this.learning?.source === 'keyboard') {
      event.preventDefault?.();
      this._heldKeys.set(event.code, null);
      this._capture('keyboard', binding);
      return true;
    }
    if (this.learning || editingTarget(event)) return false;
    const mapping = this._profile.mappings.find(item => item.source === 'keyboard' &&
      item.binding.code === binding.code && item.binding.shift === binding.shift && item.binding.alt === binding.alt);
    if (!mapping) return false;
    this._heldKeys.set(event.code, mapping.id);
    event.preventDefault?.();
    this.onAction(mapping.actionId, 1, 'press');
    return true;
  }

  handleKeyUp(event) {
    if (this._disposed) return false;
    // Use the original physical code even when Shift/Alt or focus changed while held.
    const held = this._heldKeys.has(event.code);
    this._heldKeys.delete(event.code);
    if (held) event.preventDefault?.();
    return held;
  }

  _handleMidi(event, port) {
    if (this._disposed) return;
    const input = parseMidi(event.data);
    if (!input) return;
    const physical = `${port.id}:${input.type}:${input.channel}:${input.number ?? ''}`;
    const wasHeld = this._heldMidi.has(physical);
    if (input.pressed) this._heldMidi.add(physical); else this._heldMidi.delete(physical);
    if (this.learning?.source === 'midi') {
      if (input.type === 'note' && !input.pressed) return;
      const binding = {type: input.type, channel: input.channel};
      if (input.number !== undefined) binding.number = input.number;
      this._capture('midi', binding);
      return;
    }
    if (this.learning) return;
    for (const mapping of this._profile.mappings) {
      if (mapping.source !== 'midi') continue;
      const b = mapping.binding;
      if (b.type !== input.type || b.channel !== input.channel || b.number !== input.number ||
          (b.device && b.device !== port.id && b.device !== port.name)) continue;
      const action = this.actions.get(mapping.actionId);
      if (!action) continue;
      if (action.kind === 'trigger') {
        if (input.pressed && !wasHeld) this.onAction(mapping.actionId, 1, 'press');
      } else {
        let value = input.value;
        if (mapping.mode !== 'absolute') {
          const delta = mapping.mode === 'relative-twos'
            ? (input.raw < 64 ? input.raw : input.raw - 128)
            : input.raw - 64;
          if (!delta) continue;
          value = clamp((this._values.get(mapping.actionId) ?? .5) + delta / 127);
        }
        this._values.set(mapping.actionId, value);
        this.onAction(mapping.actionId, value, 'change');
      }
    }
  }

  getMappings(actionId) { return copy(this._profile.mappings.filter(mapping => mapping.actionId === actionId)); }

  removeMapping(mappingId) {
    const remaining = this._profile.mappings.filter(mapping => mapping.id !== mappingId);
    if (remaining.length === this._profile.mappings.length) return false;
    this._profile.mappings = remaining;
    this._heldKeys.clear(); this._heldMidi.clear();
    this._change();
    return true;
  }

  reset() {
    this._profile = this._defaults();
    this.learning = null;
    this._heldKeys.clear(); this._heldMidi.clear(); this._values.clear();
    this._change();
  }

  exportProfile() { return JSON.stringify(this._profile, null, 2); }

  importProfile(json) {
    const profile = this._validate(json);
    this._profile = profile;
    this.learning = null;
    this._heldKeys.clear(); this._heldMidi.clear(); this._values.clear();
    this._change();
    return this.profile;
  }

  _validate(json) {
    let profile;
    if (typeof json !== 'string' || json.length > 200000) throw new Error('設定ファイルのサイズまたは形式を確認してください。');
    try { profile = JSON.parse(json); } catch { throw new Error('設定ファイルをJSONとして読み込めません。'); }
    if (!profile || profile.version !== 1 || !Array.isArray(profile.mappings) || profile.mappings.length > MAX_MAPPINGS ||
        typeof profile.name !== 'string' || !profile.name.trim() || profile.name.length > 80) {
      throw new Error('対応していない設定ファイルです。バージョン1の割り当て設定を選んでください。');
    }
    const ids = new Set(), mappings = [];
    for (const item of profile.mappings) {
      if (!item || typeof item.id !== 'string' || !item.id || item.id.length > 120 || ids.has(item.id) ||
          !['keyboard', 'midi'].includes(item.source) || !MODES.has(item.mode)) throw new Error('割り当てに不正な項目または重複IDがあります。');
      const action = this._assertAction(item.actionId);
      const b = item.binding;
      if (!b || typeof b !== 'object' || Array.isArray(b)) throw new Error('入力情報がありません。');
      let binding;
      if (item.source === 'keyboard') {
        if (action.kind !== 'trigger' || item.mode !== 'absolute' || typeof b.code !== 'string' || !KEY_CODES.test(b.code) ||
            typeof b.shift !== 'boolean' || typeof b.alt !== 'boolean' ||
            !keyBinding({code: b.code, shiftKey: b.shift, altKey: b.alt})) throw new Error('キー割り当ての内容を確認してください。');
        binding = {code: b.code, shift: b.shift, alt: b.alt};
      } else {
        if (!['note', 'cc', 'pitchbend'].includes(b.type) || !isInt(b.channel, 0, 15) ||
            (b.type !== 'pitchbend' && !isInt(b.number, 0, 127)) ||
            (b.type === 'pitchbend' && b.number !== undefined) ||
            (item.mode !== 'absolute' && (b.type !== 'cc' || action.kind !== 'continuous')) ||
            (b.device !== undefined && (typeof b.device !== 'string' || !b.device || b.device.length > 128))) {
          throw new Error('MIDI割り当ての内容を確認してください。');
        }
        binding = {type: b.type, channel: b.channel};
        if (b.type !== 'pitchbend') binding.number = b.number;
        if (b.device !== undefined) binding.device = b.device;
      }
      const clean = {id: item.id, actionId: item.actionId, source: item.source, binding, mode: item.mode};
      if (mappings.some(old => sameBinding(old, clean))) throw new Error('同じ入力が複数の操作に割り当てられています。');
      ids.add(item.id); mappings.push(clean);
    }
    return {version: 1, name: profile.name.trim(), mappings};
  }

  dispose() {
    this._disposed = true;
    globalThis.removeEventListener?.('blur', this._releaseHeld);
    globalThis.document?.removeEventListener?.('visibilitychange', this._onVisibilityChange);
    if (this._midiAccess?.removeEventListener) this._midiAccess.removeEventListener('statechange', this._onStateChange);
    else if (this._midiAccess?.onstatechange === this._onStateChange) this._midiAccess.onstatechange = null;
    for (const [id, entry] of this._ports) this._detachPort(id, entry);
    this.learning = null;
    this._heldKeys.clear(); this._heldMidi.clear();
    this._midiAccess = null;
  }
}
