/** Coalesce browsing into one active waveform job and the latest selection.
 * This coordinator has no audio transport: selecting cannot start/resume sound.
 */
export class SelectedWaveformLoader {
  constructor({load, onState = () => {}, delay = 160,
    setTimer = (callback, milliseconds) => globalThis.setTimeout(callback, milliseconds),
    clearTimer = timer => globalThis.clearTimeout(timer)} = {}) {
    if (typeof load !== 'function') throw new TypeError('A waveform loader is required.');
    this.load = load; this.onState = onState; this.delay = delay;
    this.setTimer = setTimer; this.clearTimer = clearTimer;
    this.selected = null; this.queued = null; this.running = false; this.timer = null;
  }

  select(key, value) {
    if (key && this.selected?.key === key) return;
    this.clearTimer(this.timer); this.timer = null; this.queued = null;
    this.selected = key ? {key, value} : null;
    if (!this.selected) { this.onState({key: null, status: 'idle'}); return; }
    const request = this.selected;
    this.onState({key, status: 'loading'});
    this.timer = this.setTimer(() => {
      this.timer = null;
      if (this.selected !== request) return;
      this.queued = request;
      void this._drain();
    }, this.delay);
  }

  async _drain() {
    if (this.running || !this.queued) return;
    const request = this.queued; this.queued = null;
    if (this.selected !== request) return;
    this.running = true;
    const current = () => this.selected === request;
    try {
      const result = await this.load(request.value, current);
      if (current()) this.onState({key: request.key, status: result === false ? 'unavailable' : 'ready'});
    } catch (error) {
      if (current()) this.onState({key: request.key, status: 'error', error});
    } finally {
      this.running = false;
      void this._drain();
    }
  }

  cancel() { this.select(null); }
}
