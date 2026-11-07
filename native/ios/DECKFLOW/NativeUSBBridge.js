/* Direct, user-selected USB access. Audio stays chunked; no ZIP/download path. */
(() => {
  'use strict';
  const handler = window.webkit?.messageHandlers?.deckflowUSB;
  if (!handler || window !== window.top) return;
  const chunkSize = 1024 * 1024;
  const request = (command, args = {}) => handler.postMessage({command, ...args});
  const bytes = value => value instanceof Uint8Array ? value : new Uint8Array(value);
  const encode = value => {
    let text = '';
    for (let i = 0; i < value.length; i += 8192) text += String.fromCharCode(...value.subarray(i, i + 8192));
    return btoa(text);
  };
  const aborted = signal => {
    if (signal?.aborted) throw signal.reason || new DOMException('USB操作を中止しました。', 'AbortError');
  };
  const api = {
    available: true,
    chunkSize,
    listDevices: () => request('listDevices'),
    chooseDirectory: () => request('chooseDirectory'),
    restoreDirectory: rootId => request('restoreDirectory', {rootId}),
    list: (rootId, {path = '', recursive = true} = {}) => request('list', {rootId, path, recursive}),
    stat: (rootId, path) => request('stat', {rootId, path}),
    async readRange(rootId, path, {offset = 0, length = chunkSize} = {}) {
      const result = await request('readRange', {rootId, path, offset, length});
      const text = atob(result.data);
      return Uint8Array.from(text, character => character.charCodeAt(0));
    },
    beginTransaction: (rootId, writes, {guards = []} = {}) => request('beginTransaction', {rootId, writes, guards}),
    writeChunk: (rootId, transactionId, path, offset, data) => request('writeChunk', {rootId, transactionId, path, offset, data: encode(bytes(data))}),
    commitTransaction: (rootId, transactionId) => request('commitTransaction', {rootId, transactionId}),
    rollbackTransaction: (rootId, transactionId) => request('rollbackTransaction', {rootId, transactionId}),
    recover: rootId => request('recover', {rootId}),
    async writeBatch(rootId, entries, {signal, onProgress, guards = []} = {}) {
      aborted(signal);
      if (!Array.isArray(entries) || !entries.length) throw new Error('書き込みファイルを指定してください。');
      const prepared = entries.map(entry => {
        if (!Object.prototype.hasOwnProperty.call(entry, 'expectedFingerprint')) throw new Error('USBの変更確認値がありません。');
        if (!(entry.blob instanceof Blob) && !(entry.blob instanceof Uint8Array) && !(entry.blob instanceof ArrayBuffer)) throw new TypeError('書き込み元はBlobまたはバイト列で指定してください。');
        const blob = entry.blob instanceof Blob ? entry.blob : new Blob([bytes(entry.blob)]);
        return {...entry, blob};
      });
      const totalBytes = prepared.reduce((total, entry) => total + entry.blob.size, 0);
      if (!Number.isSafeInteger(totalBytes)) throw new Error('書き込みサイズが大きすぎます。');
      const progress = value => { try { onProgress?.(value); } catch { /* UI callbacks cannot change transaction state. */ } };
      const transaction = await api.beginTransaction(rootId, prepared.map(({path, blob, expectedFingerprint}) => ({path, size: blob.size, expectedFingerprint})), {guards});
      let completedBytes = 0;
      let committed = false;
      try {
        for (const [index, entry] of prepared.entries()) {
          for (let offset = 0; offset < entry.blob.size; offset += chunkSize) {
            aborted(signal);
            const data = new Uint8Array(await entry.blob.slice(offset, offset + chunkSize).arrayBuffer());
            aborted(signal);
            await api.writeChunk(rootId, transaction.id, entry.path, offset, data);
            completedBytes += data.byteLength;
            progress({phase: 'staging', path: entry.path, completedBytes, totalBytes, completedFiles: index, totalFiles: prepared.length});
          }
        }
        aborted(signal);
        progress({phase: 'committing', completedBytes, totalBytes, completedFiles: prepared.length, totalFiles: prepared.length});
        // Once commit starts, native code finishes or rolls the batch back.
        const result = await api.commitTransaction(rootId, transaction.id);
        committed = true;
        progress({phase: 'complete', completedBytes, totalBytes, completedFiles: prepared.length, totalFiles: prepared.length});
        return result;
      } catch (error) {
        if (!committed) {
          try { await api.rollbackTransaction(rootId, transaction.id); }
          catch (recoveryError) {
            // Commit can already have rolled back and removed the journal.
            // A missing transaction is harmless; an unplugged disk retains its
            // native journal and is surfaced as recoveryRequired to the caller.
            const failure = new Error(`${error.message || error}\n復旧状態を確認してください: ${recoveryError.message || recoveryError}`);
            failure.cause = error; failure.recoveryRequired = true; failure.rootId = rootId;
            throw failure;
          }
        }
        throw error;
      }
    }
  };
  Object.defineProperty(window, 'nativeUSB', {value: Object.freeze(api), configurable: false, writable: false});
})();
