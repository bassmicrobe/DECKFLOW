/** Poll only already-authorized USB bookmarks. Discovering a new volume still
 * requires the native folder picker; this helper never requests permission. */
export function normalizeUSBDevices(value) {
  if (!Array.isArray(value)) throw new TypeError('USBデバイス一覧を読み取れませんでした。');
  const seen = new Set(), devices = [];
  for (const item of value) {
    if (typeof item?.id !== 'string' || !item.id || item.id.length > 1024 || seen.has(item.id)) continue;
    seen.add(item.id);
    devices.push({id: item.id, name: typeof item.name === 'string' && item.name ? item.name : 'USB',
      connected: item.connected === true,
      libraryFormats: [...new Set((Array.isArray(item.libraryFormats) ? item.libraryFormats : []).filter(format => ['pdb', 'onelibrary'].includes(format)))],
      pendingTransactions: Number.isSafeInteger(item.pendingTransactions) && item.pendingTransactions > 0 ? item.pendingTransactions : 0,
      ...(typeof item.error === 'string' && item.error ? {error: item.error} : {})});
  }
  return devices;
}

/** Membership uses imported local IDs, including empty USB playlists. Track
 * overlap alone would mix unrelated USBs that happen to contain the same song. */
export function sourcePlaylistIds(source) {
  const ids = new Set(Object.keys(source?.nativeUSB?.playlists ?? {}));
  for (const playlist of source?.parsed?.playlists ?? []) if (typeof playlist?.id === 'string') ids.add(playlist.id);
  return ids;
}

/** Recognize a saved device database, not a physically connected USB volume. */
export function isDeviceLibrarySource(source) {
  return !!source?.nativeUSB || /(?:^|[\\/])(?:export\.pdb|exportLibrary\.db)$/i.test(source?.databasePath??'');
}

export class USBDeviceMonitor {
  constructor({listDevices, onChange = () => {}, onError = () => {},
    isVisible = () => !globalThis.document?.hidden, isBusy = () => false, interval = 3000,
    setTimer = (callback, delay) => globalThis.setTimeout(callback, delay),
    clearTimer = timer => globalThis.clearTimeout(timer)} = {}) {
    if (typeof listDevices !== 'function' || !Number.isFinite(interval) || interval < 1) throw new TypeError('USB監視の設定が不正です。');
    Object.assign(this, {listDevices, onChange, onError, isVisible, isBusy, interval, setTimer, clearTimer});
    this.active = false; this.timer = null; this.running = false; this.generation = 0; this.again = false;
  }

  start() {
    if (this.active) return;
    this.active = true; this.generation++; this.refresh();
  }

  stop() {
    this.active = false; this.generation++; this.again = false;
    this.clearTimer(this.timer); this.timer = null;
  }

  refresh() {
    this.clearTimer(this.timer); this.timer = null;
    if (!this.active || !this.isVisible()) return;
    if (this.running) { this.again = true; return; }
    if (this.isBusy()) { this._schedule(); return; }
    void this._read();
  }

  _schedule() {
    if (!this.active || !this.isVisible() || this.timer !== null) return;
    this.timer = this.setTimer(() => {this.timer = null; this.refresh();}, this.interval);
  }

  async _read() {
    this.running = true;
    const generation = this.generation;
    const current = () => this.active && this.generation === generation && this.isVisible() && !this.isBusy();
    try {
      const devices = normalizeUSBDevices(await this.listDevices());
      if (current()) this.onChange(devices);
    } catch (error) {
      if (current()) this.onError(error);
    } finally {
      this.running = false;
      if (this.again) {this.again = false; this.refresh();}
      else this._schedule();
    }
  }
}
