/** Small in-memory PCM cache shared by audition and DJ decks.
 * Encoded audio remains in IndexedDB; this cache never persists decoded PCM.
 * Keys must change when the source audio changes (or be explicitly deleted).
 */
export class AudioBufferCache {
  constructor({maxBytes = 96 * 1024 * 1024, maxEntries = 2, maxPending = 8} = {}) {
    for (const [name, value] of Object.entries({maxBytes, maxEntries, maxPending})) {
      if (!Number.isSafeInteger(value) || value < (name === 'maxPending' ? 1 : 0)) {
        throw new TypeError(`${name} must be a non-negative integer.`);
      }
    }
    this.maxBytes = maxBytes;
    this.maxEntries = maxEntries;
    this.maxPending = maxPending;
    this.entries = new Map();
    this.pending = new Map();
    this.bytes = 0;
    this.jobs = 0;
    this.tail = Promise.resolve();
    this.counts = {hits: 0, misses: 0, shared: 0, evictions: 0};
  }

  get stats() {
    return {...this.counts, entries: this.entries.size, bytes: this.bytes, pending: this.jobs};
  }

  get(key, loader) {
    if (typeof key !== 'string' || !key || typeof loader !== 'function') {
      return Promise.reject(new TypeError('Audio cache needs a key and a loader.'));
    }
    const cached = this.entries.get(key);
    if (cached) {
      this.entries.delete(key);
      this.entries.set(key, cached);
      this.counts.hits++;
      return Promise.resolve(cached.buffer);
    }
    const existing = this.pending.get(key);
    if (existing) {
      this.counts.shared++;
      return existing.promise;
    }
    if (this.jobs >= this.maxPending) {
      return Promise.reject(new Error('音源を準備しています。少し待ってから選択してください。'));
    }
    this.jobs++;
    this.counts.misses++;
    const job = {};
    // Serialize decoding: two large decoders can otherwise spike iPad memory.
    job.promise = this.tail.then(async () => {
      try {
        const buffer = await loader();
        const bytes = buffer?.length * buffer?.numberOfChannels * Float32Array.BYTES_PER_ELEMENT;
        if (!Number.isSafeInteger(buffer?.length) || buffer.length <= 0 ||
            !Number.isSafeInteger(buffer?.numberOfChannels) || buffer.numberOfChannels < 1 ||
            buffer.numberOfChannels > 32 || !Number.isSafeInteger(bytes) ||
            !Number.isFinite(buffer?.duration) || buffer.duration <= 0) {
          throw new Error('デコードした音源の形式が正しくありません。');
        }
        // delete/clear detach pending work. It may still satisfy its original
        // caller, but must never repopulate the cache after invalidation.
        if (this.pending.get(key) === job && this.maxEntries > 0 && bytes <= this.maxBytes) {
          while (this.entries.size >= this.maxEntries || this.bytes + bytes > this.maxBytes) {
            this._remove(this.entries.keys().next().value);
            this.counts.evictions++;
          }
          this.entries.set(key, {buffer, bytes});
          this.bytes += bytes;
        }
        return buffer;
      } finally {
        this.jobs--;
        if (this.pending.get(key) === job) this.pending.delete(key);
      }
    });
    this.pending.set(key, job);
    // A failed decode cannot block subsequent jobs or create an unhandled
    // rejection solely from the internal scheduling chain.
    this.tail = job.promise.then(() => {}, () => {});
    return job.promise;
  }

  _remove(key) {
    const entry = this.entries.get(key);
    if (entry) this.bytes -= entry.bytes;
    this.entries.delete(key);
  }

  delete(key) {
    this._remove(key);
    this.pending.delete(key);
  }

  clear() {
    this.entries.clear();
    this.pending.clear();
    this.bytes = 0;
  }
}
