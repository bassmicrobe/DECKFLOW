/** Persist owned bytes: storing a File or File.slice directly can retain its
 * external filesystem backing even after an IndexedDB transaction commits. */
export const AUDIO_CHUNK_BYTES = 1024 * 1024;
const FORMAT = 'deckflow.audio-chunks';
const STAGING = '@audio-stage/';
const PREFIX = /^@audio\/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\/$/;

function invalidAudio() {
  return new Error('保存済み音源の分割データが壊れているか不足しています。元の音源を追加し直してください。');
}

export function validateAudioDescriptor(value) {
  if (!value || value.format !== FORMAT || value.version !== 1 || !PREFIX.test(value.prefix)
    || value.chunkSize !== AUDIO_CHUNK_BYTES || !Number.isSafeInteger(value.size) || value.size < 0
    || !Number.isSafeInteger(value.count) || value.count !== Math.ceil(value.size / AUDIO_CHUNK_BYTES)
    || typeof value.type !== 'string' || value.type.length > 255 || /[^\x20-\x7e]/.test(value.type)) {
    throw invalidAudio();
  }
  return value;
}

function prefixRange(prefix) { return IDBKeyRange.bound(prefix, `${prefix}\uffff`); }

export function deleteAudioChunks(store, value) {
  if (value === undefined || value instanceof Blob) return;
  const descriptor = validateAudioDescriptor(value);
  store.delete(prefixRange(descriptor.prefix));
}

/** All child requests run in the descriptor's transaction, excluding a racing
 * replacement/deletion. Only Blob references, never all decoded bytes, collect. */
export function readStoredAudio(store, value, done, fail) {
  if (value === undefined || value instanceof Blob) { done(value ?? null); return; }
  try {
    const descriptor = validateAudioDescriptor(value);
    const read = (index, parts) => {
      if (index === descriptor.count) { done(new Blob(parts, {type: descriptor.type})); return; }
      const request = store.get(`${descriptor.prefix}${index}`);
      request.onsuccess = () => {
        try {
          const size = Math.min(AUDIO_CHUNK_BYTES, descriptor.size - index * AUDIO_CHUNK_BYTES);
          if (!(request.result instanceof Blob) || request.result.size !== size) throw invalidAudio();
          read(index + 1, [...parts, request.result]);
        } catch (error) { fail(error); }
      };
    };
    read(0, []);
  } catch (error) { fail(error); }
}

function checkAbort(signal) {
  if (signal?.aborted) throw new DOMException('音源の保存を中止しました。変更は保存していません。', 'AbortError');
}

async function ownedChunk(blob, start, signal) {
  checkAbort(signal);
  try {
    const end = Math.min(blob.size, start + AUDIO_CHUNK_BYTES);
    const bytes = await blob.slice(start, end).arrayBuffer();
    if (bytes.byteLength !== end - start) throw new Error('音源の読み取りサイズが一致しません。');
    checkAbort(signal);
    return new Blob([bytes]);
  } catch (error) {
    if (error?.name === 'AbortError') throw error;
    throw new Error('元の音源を読み取れませんでした。保存が完了するまで音源を接続しておいてください。変更は保存していません。', {cause: error});
  }
}

async function cleanupStaging(transaction) {
  // An exclusive Web Lock guarantees that no cooperating tab is copying. A
  // journal is removed in the same transaction that publishes its descriptor,
  // so every remaining lock-protected journal belongs to an interrupted copy.
  return transaction(['audio'], 'readwrite', (tx, done, fail) => {
    const store = tx.objectStore('audio');
    const request = store.openCursor(prefixRange(STAGING));
    request.onsuccess = () => {
      const cursor = request.result;
      if (!cursor) return;
      try {
        const stage = cursor.value;
        if (stage?.lockProtected === true) {
          const descriptor = validateAudioDescriptor(stage.audio);
          if (cursor.key !== STAGING + descriptor.prefix.split('/')[1]) throw invalidAudio();
          deleteAudioChunks(store, descriptor);
          cursor.delete();
        }
        cursor.continue();
      } catch (error) { fail(error); }
    };
  });
}

async function copyAndCommit(blob, transaction, commit, {signal, lockProtected}) {
  checkAbort(signal);
  const token = crypto.randomUUID();
  const stageKey = STAGING + token;
  const audio = {format: FORMAT, version: 1, prefix: `@audio/${token}/`,
    chunkSize: AUDIO_CHUNK_BYTES, count: Math.ceil(blob.size / AUDIO_CHUNK_BYTES), size: blob.size, type: blob.type};
  validateAudioDescriptor(audio);
  await transaction(['audio'], 'readwrite', tx => tx.objectStore('audio').put({audio, lockProtected}, stageKey));
  try {
    for (let index = 0; index < audio.count; index++) {
      // Read the next chunk only after the preceding transaction committed.
      const chunk = await ownedChunk(blob, index * AUDIO_CHUNK_BYTES, signal);
      await transaction(['audio'], 'readwrite', tx => tx.objectStore('audio').put(chunk, `${audio.prefix}${index}`));
    }
    checkAbort(signal);
    return await commit(audio, stageKey);
  } catch (error) {
    try {
      await transaction(['audio'], 'readwrite', tx => {
        const store = tx.objectStore('audio');
        deleteAudioChunks(store, audio);
        store.delete(stageKey);
      });
    } catch (cleanupError) {
      throw new Error(`${error.message} 中断した音源の一時データを削除できませんでした。保存領域を確認して再試行してください。`,
        {cause: new AggregateError([error, cleanupError])});
    }
    throw error;
  }
}

/** Keep the v1 store layout. A shared lock protects active staging from orphan
 * collection across tabs; the exclusive, non-waiting cleanup runs before a new
 * copy. Without Web Locks, failures still clean their own UUID but crash
 * journals are conservatively retained rather than deleting another tab's data. */
export async function withOwnedAudio(blob, transaction, commit, {signal, databaseName} = {}) {
  const locks = globalThis.navigator?.locks;
  const copy = lockProtected => copyAndCommit(blob, transaction, commit, {signal, lockProtected});
  if (!locks?.request) return copy(false);
  const name = `deckflow.audio-copy/${databaseName}`;
  await locks.request(name, {mode: 'exclusive', ifAvailable: true}, lock => lock ? cleanupStaging(transaction) : undefined);
  return locks.request(name, {...(signal ? {signal} : {}), mode: 'shared'}, () => copy(true));
}
