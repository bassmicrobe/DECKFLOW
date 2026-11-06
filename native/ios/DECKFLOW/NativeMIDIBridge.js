(() => {
  'use strict';
  Object.defineProperty(window, 'DECKFLOW_NATIVE', {value: Object.freeze({platform: 'ios', midi: true, audio: 'web-audio', usbExport: false})});
  if (typeof navigator.requestMIDIAccess === 'function') return;
  let access = null;
  let pending = null;
  let nextRequest = 0;
  const requests = new Map();
  function emit(target, type, additions = {}) {
    const event = new Event(type);
    for (const [key, value] of Object.entries(additions)) Object.defineProperty(event, key, {value});
    target.dispatchEvent(event);
    target['on' + type]?.(event);
  }
  class NativeInput extends EventTarget {
    constructor(value, owner) {
      super(); this.owner = owner; this.id = value.id; this.type = 'input'; this.version = '1';
      this.name = value.name; this.manufacturer = value.manufacturer || '';
      this.state = 'connected'; this.connection = 'closed';
      this.onmidimessage = null; this.onstatechange = null;
    }
    async open() {
      if (this.state !== 'connected') throw new DOMException('MIDI input is disconnected', 'InvalidStateError');
      this.connection = 'open'; return this;
    }
    async close() { this.connection = 'closed'; return this; }
    message(bytes) {
      if (this.connection !== 'open' || this.state !== 'connected') return;
      if (!Array.isArray(bytes) || !bytes.every(value => Number.isInteger(value) && value >= 0 && value <= 255)) return;
      emit(this, 'midimessage', {data: new Uint8Array(bytes), receivedTime: performance.now()});
    }
  }
  class NativeAccess extends EventTarget {
    constructor() { super(); this.inputs = new Map(); this.outputs = new Map(); this.sysexEnabled = false; this.onstatechange = null; }
    ports(ports) {
      if (!Array.isArray(ports)) return;
      const found = new Set();
      const changed = [];
      for (const value of ports) {
        if (!value || typeof value.id !== 'string' || typeof value.name !== 'string') continue;
        found.add(value.id);
        const existing = this.inputs.get(value.id);
        if (existing) { existing.name = value.name; existing.manufacturer = value.manufacturer || ''; }
        else { const input = new NativeInput(value, this); this.inputs.set(value.id, input); changed.push(input); }
      }
      for (const [id, input] of this.inputs) {
        if (!found.has(id)) { input.state = 'disconnected'; input.connection = 'closed'; this.inputs.delete(id); changed.push(input); }
      }
      for (const input of changed) { emit(input, 'statechange', {port: input}); emit(this, 'statechange', {port: input}); }
    }
  }
  Object.defineProperty(window, '__deckflowNativeMIDI', {value: Object.freeze({
    receive(payload) {
      if (!payload || typeof payload !== 'object') return;
      if (payload.kind === 'access') {
        access ||= new NativeAccess();
        access.ports(payload.inputs);
        const request = requests.get(payload.requestId);
        requests.delete(payload.requestId); request?.resolve(access);
      } else if (payload.kind === 'ports') access?.ports(payload.inputs);
      else if (payload.kind === 'messages') {
        const input = access?.inputs.get(payload.inputId);
        if (input && Array.isArray(payload.messages)) for (const bytes of payload.messages) input.message(bytes);
      } else if (payload.kind === 'error') {
        const request = requests.get(payload.requestId);
        requests.delete(payload.requestId);
        request?.reject(new DOMException(String(payload.message || 'MIDIを開始できません。'), 'NotAllowedError'));
      }
    },
  })});
  Object.defineProperty(navigator, 'requestMIDIAccess', {value: function(options = {}) {
    if (options.sysex) return Promise.reject(new DOMException('SysEx is not supported by DECKFLOW', 'NotSupportedError'));
    if (access) return Promise.resolve(access);
    if (pending) return pending;
    pending = new Promise((resolve, reject) => {
      const requestId = ++nextRequest;
      const timer = setTimeout(() => {
        requests.delete(requestId); reject(new DOMException('MIDI接続がタイムアウトしました。', 'TimeoutError'));
      }, 10000);
      requests.set(requestId, {resolve: value => {clearTimeout(timer); resolve(value);}, reject: error => {clearTimeout(timer); reject(error);}});
      try { window.webkit.messageHandlers.deckflowMIDI.postMessage({command: 'enable', requestId}); }
      catch (error) { clearTimeout(timer); requests.delete(requestId); reject(error); }
    }).finally(() => { pending = null; });
    return pending;
  }});
})();
