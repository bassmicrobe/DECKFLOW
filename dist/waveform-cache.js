import {DEFAULT_WAVEFORM_FPS, MAX_WAVEFORM_FRAMES, WAVEFORM_VERSION, validateWaveform, waveformBytes, waveformDimensions} from './waveform-data.js?v=b48f446ea6c7f1bb';

const DEFAULT_BYTES = 16 * 1024 * 1024;
const DISK_BYTES = 32 * 1024 * 1024;
const CHUNK_BYTES = 1024 * 1024;
const abortError = () => new Error('波形の生成を中止しました。');
function natural(value, name, minimum = 0) {
  if (!Number.isSafeInteger(value) || value < minimum) throw new RangeError(`${name} is invalid.`);
  return value;
}

/** A bounded derived-data cache. It never changes the library database or audio. */
export class WaveformCache {
  constructor({maxBytes = DEFAULT_BYTES, maxEntries = 8, maxPending = 6,
    persistentBytes = DISK_BYTES, persistentEntries = 128, framesPerSecond = DEFAULT_WAVEFORM_FPS,
    maxFrames = MAX_WAVEFORM_FRAMES, chunkSamples = 32768, timeoutMs = 120000,
    indexedDB = globalThis.indexedDB,
    workerFactory = () => new Worker(new URL('./waveform-worker.js?v=b48f446ea6c7f1bb', import.meta.url), {type: 'module'}),
  } = {}) {
    this.maxBytes = natural(maxBytes, 'RAM limit');
    this.maxEntries = natural(maxEntries, 'RAM entries');
    this.maxPending = natural(maxPending, 'Pending limit', 1);
    this.persistentBytes = Math.min(DISK_BYTES, natural(persistentBytes, 'Persistent limit'));
    this.persistentEntries = Math.min(128, natural(persistentEntries, 'Persistent entries'));
    this.chunkSamples = Math.min(32768, natural(chunkSamples, 'Chunk size', 1));
    this.timeoutMs = natural(timeoutMs, 'Worker timeout', 1);
    if (!Number.isFinite(framesPerSecond) || framesPerSecond < 1 || framesPerSecond > 1000) throw new RangeError('Waveform rate is invalid.');
    natural(maxFrames, 'Waveform limit', 1);
    if (maxFrames > MAX_WAVEFORM_FRAMES || typeof workerFactory !== 'function') throw new TypeError('Waveform options are invalid.');
    this.options = {framesPerSecond, maxFrames};
    this.indexedDB = indexedDB;
    this.workerFactory = workerFactory;
    this.entries = new Map();
    this.pending = new Map();
    this.jobs = new Set();
    this.bytes = 0;
    this.tail = Promise.resolve();
    this.diskTail = Promise.resolve();
    this.disposed = false;
    this.serial = 0;
    this.revision = 0;
    this.counters = {hits: 0, persistentHits: 0, generated: 0, shared: 0, evictions: 0, diskErrors: 0};
  }
  get stats() { return {...this.counters, bytes: this.bytes, entries: this.entries.size, pending: this.jobs.size}; }

  /** A fingerprint identifies immutable source audio, so persisted envelopes
   * can be restored before opening or decoding that audio at all. */
  async find(key) {
    if (this.disposed) throw abortError();
    if (typeof key !== 'string' || !key || key.length > 4096) throw new TypeError('Waveform cache key is invalid.');
    const cached = this.entries.get(key);
    if (cached) {
      this.entries.delete(key); this.entries.set(key, cached); this.counters.hits++;
      return cached.waveform;
    }
    const pending = this.pending.get(key);
    if (pending) { this.counters.shared++; return pending.promise; }
    const revision = this.revision;
    const entry = await this._disk(() => this._findDisk(key));
    if (this.disposed || revision !== this.revision || !entry) return null;
    const waveform = validateWaveform(entry.waveform);
    this._remember(key, entry.signature, waveform); this.counters.persistentHits++;
    return waveform;
  }

  get(key, buffer) {
    if (this.disposed) return Promise.reject(abortError());
    let dimensions;
    try {
      if (typeof key !== 'string' || !key || key.length > 4096 ||
          (typeof buffer?.getChannelData !== 'function' && !(buffer?.kind === 'pcm-file' && typeof buffer.readFrames === 'function'))) throw new TypeError('Waveform cache key or audio is invalid.');
      dimensions = waveformDimensions(buffer);
    } catch (error) { return Promise.reject(error); }
    const signature = JSON.stringify([WAVEFORM_VERSION, dimensions.sourceLength, dimensions.sampleRate, dimensions.channels, this.options.framesPerSecond, this.options.maxFrames]);
    const cached = this.entries.get(key);
    if (cached?.signature === signature) {
      this.entries.delete(key); this.entries.set(key, cached); this.counters.hits++;
      return Promise.resolve(cached.waveform);
    }
    const prior = this.pending.get(key);
    if (prior?.signature === signature) { this.counters.shared++; return prior.promise; }
    if (this.jobs.size >= this.maxPending) return Promise.reject(new Error('波形を準備しています。少し待ってから選択してください。'));
    if (prior) prior.invalidated = true;
    this._remove(key);
    const job = {key, signature, diskKey: JSON.stringify([key, signature]), invalidated: false};
    const current = () => !this.disposed && !job.invalidated && this.pending.get(key) === job;
    this.jobs.add(job);
    job.promise = this.tail.then(async () => {
      try {
        if (this.disposed) throw abortError();
        let waveform = await this._disk(() => this._readDisk(job));
        if (this.disposed) throw abortError();
        if (waveform) this.counters.persistentHits++;
        else { waveform = await this._generate(buffer, dimensions); this.counters.generated++; }
        validateWaveform(waveform);
        if (waveform.sourceLength !== dimensions.sourceLength || waveform.sampleRate !== dimensions.sampleRate || waveform.channels !== dimensions.channels || waveform.requestedFramesPerSecond !== this.options.framesPerSecond || waveform.frameCount !== Math.min(dimensions.sourceLength, this.options.maxFrames, Math.ceil(dimensions.duration * this.options.framesPerSecond))) throw new Error('波形と音源の長さが一致しません。');
        if (current()) {
          this._remember(key, signature, waveform);
          // Cache writes are optional: never hold up a DJ transport on storage.
          void this._disk(() => !this.disposed && !job.invalidated ? this._writeDisk(job, waveform) : undefined);
        }
        return waveform;
      } finally {
        this.jobs.delete(job);
        if (this.pending.get(key) === job) this.pending.delete(key);
      }
    });
    this.pending.set(key, job);
    this.tail = job.promise.then(() => {}, () => {});
    return job.promise;
  }

  _remove(key) {
    const entry = this.entries.get(key);
    if (entry) this.bytes -= waveformBytes(entry.waveform);
    this.entries.delete(key);
  }
  _remember(key, signature, waveform) {
    const bytes = waveformBytes(waveform);
    if (!this.maxEntries || bytes > this.maxBytes) return;
    this._remove(key);
    while (this.entries.size >= this.maxEntries || this.bytes + bytes > this.maxBytes) {
      this._remove(this.entries.keys().next().value); this.counters.evictions++;
    }
    this.entries.set(key, {signature, waveform}); this.bytes += bytes;
  }
  delete(key) {
    this.revision++;
    this._remove(key);
    const job = this.pending.get(key);
    if (job) job.invalidated = true;
    this.pending.delete(key);
    return this._disk(() => this._deleteDisk(key));
  }
  clear() {
    this.revision++;
    this.entries.clear(); this.bytes = 0;
    for (const job of this.jobs) job.invalidated = true;
    this.pending.clear();
    return this._disk(() => this._clearDisk());
  }
  dispose() {
    if (this.disposed) return;
    this.disposed = true;
    this.revision++;
    this.entries.clear(); this.bytes = 0;
    for (const job of this.jobs) job.invalidated = true;
    this.pending.clear();
    this.cancelGeneration?.();
    this.worker?.terminate(); this.worker = null;
    void this.database?.then(database => database?.close());
  }

  _generate(buffer, dimensions) {
    return new Promise((resolve, reject) => {
      let worker, timer, offset = 0, settled = false;
      const id = ++this.serial;
      const finish = (error, waveform) => {
        if (settled) return;
        settled = true; clearTimeout(timer); this.cancelGeneration = null;
        if (worker) { worker.onmessage = null; worker.onerror = null; worker.onmessageerror = null; }
        if (error) { worker?.terminate(); if (this.worker === worker) this.worker = null; reject(error); }
        else resolve(waveform);
      };
      try {
        worker = this.worker ??= this.workerFactory();
        const fileBacked = buffer.kind === 'pcm-file' && typeof buffer.readFrames === 'function';
        const channels = fileBacked ? null : Array.from({length: dimensions.channels}, (_, i) => buffer.getChannelData(i));
        if (channels && !channels.every(channel => channel instanceof Float32Array && channel.length === dimensions.sourceLength)) throw new TypeError('Decoded audio channels are invalid.');
        const chunkLength = Math.min(this.chunkSamples, Math.floor(CHUNK_BYTES / 4 / dimensions.channels),
          fileBacked ? (buffer.maxReadFrames ?? this.chunkSamples) : this.chunkSamples);
        natural(chunkLength, 'Waveform read size', 1);
        const armTimeout = () => {
          clearTimeout(timer);
          timer = setTimeout(() => finish(new Error('波形の生成に時間がかかっています。')), this.timeoutMs);
        };
        const sendChunk = async () => {
          if (settled) return;
          if (this.disposed) return finish(abortError());
          if (offset >= dimensions.sourceLength) { worker.postMessage({type: 'finish', id}); return; }
          const end = Math.min(dimensions.sourceLength, offset + chunkLength);
          // Copy only this chunk, never detach the live AudioBuffer backing store.
          const owned = fileBacked ? await buffer.readFrames(offset, end - offset) : channels.map(channel => channel.slice(offset, end));
          if (settled || this.disposed) return;
          if (!Array.isArray(owned) || owned.length !== dimensions.channels ||
              !owned.every(channel => channel instanceof Float32Array && channel.length === end - offset)) throw new TypeError('File audio channels are invalid.');
          offset = end;
          armTimeout();
          worker.postMessage({type: 'chunk', id, channels: owned}, owned.map(channel => channel.buffer));
        };
        worker.onmessage = ({data}) => {
          if (data?.id !== id || settled) return;
          try {
            if (data.type === 'ready' || data.type === 'ack') { armTimeout(); void sendChunk().catch(error => finish(error)); }
            else if (data.type === 'result') finish(null, validateWaveform(data.waveform));
            else if (data.type === 'error') finish(new Error(data.message || '波形を生成できませんでした。'));
          } catch (error) { finish(error); }
        };
        worker.onerror = () => finish(new Error('波形の生成を開始できませんでした。'));
        worker.onmessageerror = () => finish(new Error('波形データを受け取れませんでした。'));
        this.cancelGeneration = () => finish(abortError());
        armTimeout();
        worker.postMessage({type: 'start', id, dimensions, options: this.options});
      } catch (error) { finish(error); }
    });
  }

  _disk(operation) {
    const promise = this.diskTail.then(async () => {
      if (this.disposed || this.diskDisabled || !this.persistentBytes || !this.persistentEntries) return null;
      try { return await operation(); }
      catch { this.counters.diskErrors++; return null; }
    });
    this.diskTail = promise.then(() => {}, () => {});
    return promise;
  }
  _database() {
    if (!this.indexedDB) return Promise.resolve(null);
    if (this.database) return this.database;
    const opening = new Promise(resolve => {
      let request, settled = false;
      const complete = database => {
        if (settled) { database?.close(); return; }
        settled = true; clearTimeout(timer);
        if (!database) this.counters.diskErrors++;
        resolve(database);
      };
      const timer = setTimeout(() => complete(null), 1500);
      try {
        request = this.indexedDB.open('deckflow-waveform-cache', 1);
        request.onupgradeneeded = () => {
          if (settled) { request.transaction?.abort(); return; }
          const database = request.result;
          if (!database.objectStoreNames.contains('data')) database.createObjectStore('data');
          if (!database.objectStoreNames.contains('lru')) database.createObjectStore('lru', {keyPath: 'key'});
        };
        request.onsuccess = () => {
          const database = request.result;
          database.onversionchange = () => { database.close(); this.diskDisabled = true; };
          complete(database);
        };
        request.onerror = request.onblocked = () => complete(null);
      } catch { complete(null); }
    });
    this.database = opening;
    // A slow/blocked open only skips this disk operation. Clearing after the
    // promise resolves also handles synchronous open() throws without a TDZ or
    // a late callback discarding a newer, successful connection.
    void opening.then(database => {
      if (!database && this.database === opening) this.database = undefined;
    });
    return opening;
  }
  async _transaction(operation) {
    const database = await this._database();
    if (!database || this.disposed) return null;
    return new Promise((resolve, reject) => {
      let result;
      const transaction = database.transaction(['data', 'lru'], 'readwrite');
      transaction.oncomplete = () => resolve(result);
      transaction.onabort = () => reject(transaction.error || new Error('Waveform cache transaction failed.'));
      transaction.onerror = () => {};
      try { operation(transaction, value => { result = value; }); }
      catch (error) { transaction.abort(); reject(error); }
    });
  }
  _readDisk(job) {
    return this._transaction((transaction, done) => {
      const request = transaction.objectStore('data').get(job.diskKey);
      request.onsuccess = () => {
        try {
          if (!request.result) return;
          const waveform = validateWaveform(request.result);
          const dimensions = JSON.parse(job.signature);
          if (waveform.sourceLength !== dimensions[1] || waveform.sampleRate !== dimensions[2] || waveform.channels !== dimensions[3] || waveform.requestedFramesPerSecond !== dimensions[4] || waveform.frameCount !== Math.min(dimensions[1], dimensions[5], Math.ceil(waveform.duration * dimensions[4]))) return;
          transaction.objectStore('lru').put({key: job.diskKey, owner: job.key, bytes: waveformBytes(waveform), at: Date.now()});
          done(waveform);
        } catch { transaction.objectStore('data').delete(job.diskKey); transaction.objectStore('lru').delete(job.diskKey); }
      };
    });
  }
  _findDisk(key) {
    return this._transaction((transaction, done) => {
      const data = transaction.objectStore('data'), lru = transaction.objectStore('lru');
      const request = lru.getAll();
      request.onsuccess = () => {
        const candidates = request.result.filter(entry => entry.owner === key).sort((a, b) => b.at - a.at);
        const readNext = () => {
          const entry = candidates.shift();
          if (!entry) return;
          let signature;
          try {
            const parts = JSON.parse(entry.key); signature = parts[1];
            const dimensions = JSON.parse(signature);
            if (parts[0] !== key || dimensions[0] !== WAVEFORM_VERSION ||
                dimensions[4] !== this.options.framesPerSecond || dimensions[5] !== this.options.maxFrames) return readNext();
          } catch { return readNext(); }
          const read = data.get(entry.key);
          read.onsuccess = () => {
            try {
              const waveform = validateWaveform(read.result), dimensions = JSON.parse(signature);
              if (waveform.sourceLength !== dimensions[1] || waveform.sampleRate !== dimensions[2] || waveform.channels !== dimensions[3] ||
                  waveform.requestedFramesPerSecond !== dimensions[4] || waveform.frameCount !== Math.min(dimensions[1], dimensions[5], Math.ceil(waveform.duration * dimensions[4]))) throw new Error('Cached dimensions differ.');
              lru.put({...entry, at: Date.now()}); done({signature, waveform});
            } catch { data.delete(entry.key); lru.delete(entry.key); readNext(); }
          };
        };
        readNext();
      };
    });
  }
  _writeDisk(job, waveform) {
    const bytes = waveformBytes(waveform);
    if (bytes > this.persistentBytes || job.invalidated) return;
    return this._transaction(transaction => {
      const data = transaction.objectStore('data'), lru = transaction.objectStore('lru');
      const request = lru.getAll();
      request.onsuccess = () => {
        if (job.invalidated || this.disposed) return;
        const entries = [];
        for (const entry of request.result) {
          if (entry.key === job.diskKey) continue;
          if (typeof entry.key !== 'string' || typeof entry.owner !== 'string' || !Number.isSafeInteger(entry.bytes) || entry.bytes <= 0 || entry.bytes > this.persistentBytes || !Number.isFinite(entry.at)) {
            data.delete(entry.key); lru.delete(entry.key);
          } else entries.push(entry);
        }
        entries.sort((a, b) => a.at - b.at);
        let total = entries.reduce((sum, entry) => sum + entry.bytes, 0) + bytes;
        while (entries.length && (total > this.persistentBytes || entries.length >= this.persistentEntries)) {
          const entry = entries.shift(); total -= entry.bytes; data.delete(entry.key); lru.delete(entry.key);
        }
        data.put(waveform, job.diskKey);
        lru.put({key: job.diskKey, owner: job.key, bytes, at: Date.now()});
      };
    });
  }
  _deleteDisk(key) {
    return this._transaction(transaction => {
      const data = transaction.objectStore('data'), lru = transaction.objectStore('lru'), request = lru.getAll();
      request.onsuccess = () => { for (const entry of request.result) if (entry.owner === key) { data.delete(entry.key); lru.delete(entry.key); } };
    });
  }
  _clearDisk() {
    return this._transaction(transaction => { transaction.objectStore('data').clear(); transaction.objectStore('lru').clear(); });
  }
}
