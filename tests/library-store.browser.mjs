import {openLibrary, validateLibrarySnapshot} from '../dist/library-store.js';

const results = document.querySelector('#results');
const run = document.querySelector('#run');
const check = (condition, message) => { if (!condition) throw new Error(message); };
const equal = (actual, expected, message) => check(JSON.stringify(actual) === JSON.stringify(expected), message);
const sample = (id = 'fixture-track') => ({id, title: 'Before', artist: '', bpm: 120, duration: 60,
  cue: 12, filename: 'fixture.wav', peaks: [], hotcues: Array(8).fill(null)});
async function rejects(operation, pattern) {
  try { await operation(); }
  catch (error) { check(pattern.test(error.message), `想定外の拒否理由: ${error.message}`); return; }
  throw new Error('拒否されるべき保存が成功しました。');
}

run.addEventListener('click', async () => {
  run.disabled = true;
  results.textContent = '検証中…';
  const nativeIndexedDB = window.indexedDB;
  const descriptor = Object.getOwnPropertyDescriptor(window, 'indexedDB');
  const databaseName = `deckflow-audit-test-${crypto.randomUUID()}`;
  const connections = [];
  const messages = [];
  let passed = 0;
  let failed = false;
  // The production module opens its usual name, but only this fixture rewrites
  // that call to a unique test database before any connection is created.
  Object.defineProperty(window, 'indexedDB', {configurable: true, value: {
    open(name, version) {
      check(name === 'deckflow-library', '想定外のデータベース名です。');
      const request = nativeIndexedDB.open(databaseName, version);
      request.addEventListener('success', () => connections.push(request.result));
      return request;
    },
  }});
  const test = async (name, operation) => {
    try { await operation(); passed++; messages.push(`PASS: ${name}`); }
    catch (error) { messages.push(`FAIL: ${name}: ${error.message}`); throw error; }
    finally { results.textContent = messages.join('\n'); }
  };
  try {
    const first = await openLibrary(), second = await openLibrary();
    check(first.persistent && second.persistent, 'IndexedDBが利用できず一時保存になりました。');
    await first.putTrack(sample(), new Blob(['fixture audio']));

    const audioKeys = () => first._transaction(['audio'], 'readonly', (transaction, done) => {
      const request = transaction.objectStore('audio').getAllKeys();
      request.onsuccess = () => done(request.result);
    });

    await test('音源は1MiB以内で読み、4MiB単位の確定後に進捗を更新して全バイトを復元', async () => {
      const bytes = Uint8Array.from({length: 9 * 1024 * 1024 + 7}, (_, index) => index % 251);
      const reads = [], progress = [];
      class ObservedBlob extends Blob {
        arrayBuffer() { throw new Error('音源全体を一度に読み込んでいます。'); }
        slice(start, end, type) { reads.push([start, end]); return super.slice(start, end, type); }
      }
      await first.putTrack(sample('owned-copy'), new ObservedBlob([bytes], {type: 'audio/wav'}), {onProgress: value => progress.push(value)});
      check(reads.length === 10 && reads.every(([start, end]) => end - start <= 1024 * 1024), '1MiBごとの実データ所有化が行われていません。');
      equal(progress.map(value => value.completed), [0, 4 * 1024 * 1024, 8 * 1024 * 1024, bytes.length], '確定したバッチ単位の進捗が不正です。');
      check(progress.every(value => value.total === bytes.length), '音源全体のバイト数が不正です。');
      const audio = await second.getAudio('owned-copy');
      equal(audio.type, 'audio/wav', '音源の形式が失われています。');
      const restored = new Uint8Array(await audio.arrayBuffer());
      check(restored.length === bytes.length && restored.every((value, index) => value === bytes[index]), '保存した音源のバイト列が異なります。');
      await first.removeTrack('owned-copy');
    });

    await test('元音源の途中読み取り失敗では既存曲と音源を保持し、分割データを残さない', async () => {
      const before = await first.getTracks(), keys = await audioKeys();
      class FailedBlob extends Blob {
        slice(start, end) {
          if (start >= 5 * 1024 * 1024) throw new DOMException('Synthetic detached source', 'NotReadableError');
          return super.slice(start, end);
        }
      }
      await rejects(() => first.putTrack({...sample(), title: 'Uncommitted'}, new FailedBlob([new Uint8Array(9 * 1024 * 1024 + 1)])), /音源|読み/);
      equal(await first.getTracks(), before, '元音源の読み取り失敗で曲情報が変わりました。');
      equal(await audioKeys(), keys, '失敗した分割データが残っています。');
      equal(await (await first.getAudio('fixture-track')).text(), 'fixture audio', '元音源が失われました。');
    });

    await test('分割保存と最終確定の容量不足を注入しても旧音源を保持し、一時データを削除', async () => {
      const before = await first.getTracks(), keys = await audioKeys();
      const originalPut = IDBObjectStore.prototype.put;
      for (const failure of ['chunk', 'commit']) {
        let chunks = 0;const progress = [], size = 8 * 1024 * 1024 + 1;
        IDBObjectStore.prototype.put = function (value) {
          const target = this.transaction.db.name === databaseName;
          if (target && this.name === 'audio' && value instanceof Blob) chunks++;
          if (target && ((failure === 'chunk' && this.name === 'audio' && value instanceof Blob && chunks === 6)
            || (failure === 'commit' && this.name === 'tracks'))) {
            throw new DOMException('Injected audio quota failure', 'QuotaExceededError');
          }
          return originalPut.apply(this, arguments);
        };
        try {
          await rejects(() => second.putTrack({...sample(), title: 'Uncommitted'}, new Blob([new Uint8Array(size)]),
            {onProgress: value => progress.push(value.completed)}), /保存容量/);
        } finally { IDBObjectStore.prototype.put = originalPut; }
        equal(progress, failure === 'chunk' ? [0, 4 * 1024 * 1024] : [0, 4 * 1024 * 1024, 8 * 1024 * 1024, size], '未確定のバッチを進捗に含めています。');
        equal(await first.getTracks(), before, '容量不足で曲情報が変わりました。');
        equal(await audioKeys(), keys, '容量不足で一時データが残りました。');
        equal(await (await first.getAudio('fixture-track')).text(), 'fixture audio', '容量不足で旧音源が消えました。');
      }
    });

    await test('差し替え・削除で旧分割データを除去し、音源なしの編集では音源を保持', async () => {
      const before = await audioKeys();
      await first.putTrack(sample('replace-audio'), new Blob([new Uint8Array(1024 * 1024 + 1)]));
      await first.putTrack(sample('replace-audio'), new Blob(['replacement']));
      const afterReplacement = await audioKeys();
      equal(afterReplacement.length - before.length, 2, '旧音源の分割データが残っています。');
      await first.putTrack({...sample('replace-audio'), title: 'Metadata only'});
      equal(await audioKeys(), afterReplacement, '音源なしの編集で保存済み音源を変更しました。');
      equal(await (await second.getAudio('replace-audio')).text(), 'replacement', '差し替えた音源を復元できません。');
      await first.removeTrack('replace-audio');
      equal(await audioKeys(), before, '削除した音源の分割データが残っています。');
    });

    await test('長時間コピー中の別接続からの編集や削除を上書き・復活させない', async () => {
      const baselineKeys = await audioKeys();
      for (const operation of ['edit', 'delete', 'audio']) {
        await first.putTrack(sample('copy-race'), new Blob(['original']));
        const originalKeys = await audioKeys();
        class ConcurrentBlob extends Blob {
          slice(start, end) {
            const part = super.slice(start, end);
            return {arrayBuffer: async () => {
              if (operation === 'edit') await second.putTrack({...sample('copy-race'), title: 'Concurrent edit'});
              else if (operation === 'audio') await second.putTrack(sample('copy-race'), new Blob(['new audio']));
              else await second.removeTrack('copy-race');
              return part.arrayBuffer();
            }};
          }
        }
        await rejects(() => first.putTrack({...sample('copy-race'), title: 'Stale edit'}, new ConcurrentBlob(['replacement'])), /別の画面|変更|削除/);
        if (operation === 'edit') {
          equal((await second.getTracks()).find(item => item.id === 'copy-race').title, 'Concurrent edit', '最新の編集を上書きしました。');
          equal(await (await second.getAudio('copy-race')).text(), 'original', '競合した音源を公開しました。');
          equal(await audioKeys(), originalKeys, '競合したコピーが残っています。');
          await second.removeTrack('copy-race');
        } else if (operation === 'delete') {
          check(!(await second.getTracks()).some(item => item.id === 'copy-race'), '削除した曲が復活しました。');
          equal(await second.getAudio('copy-race'), null, '削除後に音源が復活しました。');
        } else {
          equal(await (await second.getAudio('copy-race')).text(), 'new audio', '同じ曲情報のまま差し替えた最新音源を上書きしました。');
          equal((await audioKeys()).length, originalKeys.length, '競合したコピーが残っています。');
          await second.removeTrack('copy-race');
        }
        equal(await audioKeys(), baselineKeys, '競合したコピーの分割データが残っています。');
      }
    });

    await test('保存を中止した場合は既存曲を保持し、一時データを削除', async () => {
      const before = await first.getTracks(), keys = await audioKeys();
      const controller = new AbortController();
      class AbortedBlob extends Blob {
        slice(start, end) {
          const part = super.slice(start, end);
          return {arrayBuffer: async () => { if (start >= 5 * 1024 * 1024) controller.abort(); return part.arrayBuffer(); }};
        }
      }
      await rejects(() => first.putTrack({...sample(), title: 'Uncommitted'}, new AbortedBlob([new Uint8Array(9 * 1024 * 1024 + 1)]), {signal: controller.signal}), /中止/);
      equal(await first.getTracks(), before, '中止後に曲情報が変わりました。');
      equal(await audioKeys(), keys, '中止後に一時データが残っています。');
    });

    await test('同時コピーの一時データを回収せず、中断したコピーだけ次回保存時に回収', async () => {
      const before = await audioKeys();
      let release, entered;
      const gate = new Promise(resolve => { release = resolve; });
      const reading = new Promise(resolve => { entered = resolve; });
      class PausedBlob extends Blob {
        slice(start, end) {
          const part = super.slice(start, end);
          return {arrayBuffer: async () => { entered(); await gate; return part.arrayBuffer(); }};
        }
      }
      const active = first.putTrack(sample('active-copy'), new PausedBlob(['active bytes']));
      await reading;
      try { await second.putTrack(sample('parallel-copy'), new Blob(['parallel bytes'])); }
      finally { release(); }
      await active;
      equal(await (await first.getAudio('active-copy')).text(), 'active bytes', '同時コピー中の一時データが削除されました。');
      equal(await (await second.getAudio('parallel-copy')).text(), 'parallel bytes', '別接続のコピーが失われました。');
      await first.removeTrack('active-copy');
      await second.removeTrack('parallel-copy');
      const token = crypto.randomUUID(), prefix = `@audio/${token}/`;
      await first._transaction(['audio'], 'readwrite', transaction => {
        const store = transaction.objectStore('audio');
        store.put({lockProtected: true, audio: {format: 'deckflow.audio-chunks', version: 1, prefix,
          chunkSize: 1024 * 1024, count: 1, size: 7, type: ''}}, `@audio-stage/${token}`);
        store.put(new Blob(['partial']), `${prefix}0`);
      });
      await second.putTrack(sample('after-crash'), new Blob(['complete']));
      await second.removeTrack('after-crash');
      equal(await audioKeys(), before, '中断したコピーの一時データが回収されませんでした。');
    });

    await test('読み取り中の差し替え・削除でも旧音源を最後まで読み、次の読み取りへ変更を反映', async () => {
      const bytes = new Uint8Array(2 * 1024 * 1024 + 3).fill(73);
      await first.putTrack(sample('read-race'), new Blob([bytes]));
      const reading = first.getAudio('read-race');
      const replacing = second.putTrack(sample('read-race'), new Blob(['new bytes']));
      const previous = new Uint8Array(await (await reading).arrayBuffer());
      check(previous.length === bytes.length && previous.every(value => value === 73), '差し替え中に旧音源の一部が失われました。');
      await replacing;
      equal(await (await first.getAudio('read-race')).text(), 'new bytes', '差し替えた音源を読めません。');
      await first.putTrack(sample('read-race'), new Blob([bytes]));
      const beforeDeletion = first.getAudio('read-race');
      const deleting = second.removeTrack('read-race');
      const retained = new Uint8Array(await (await beforeDeletion).arrayBuffer());
      check(retained.length === bytes.length && retained.every(value => value === 73), '削除と競合した読み取りで音源の一部が失われました。');
      await deleting;
      equal(await first.getAudio('read-race'), null, '削除後の新しい読み取りで音源が残っています。');
    });

    await test('別接続からの同時プレイリスト作成で両方の保存を保持', async () => {
      await Promise.all([
        first.createPlaylist({id: 'first', name: 'First', trackIds: []}),
        second.createPlaylist({id: 'second', name: 'Second', trackIds: []}),
      ]);
      equal((await first.getPlaylists()).map(item => item.id).sort(), ['first', 'second'], '片方の作成が消失しています。');
    });

    await test('曲編集とプレイリスト追加の同時確定・最新CUEと音源の保持', async () => {
      await first.putTrack({...sample(), cue: 24});
      const result = await second.updateTrackDetails('fixture-track', {title: 'Edited', artist: '', bpm: 64}, 'first');
      equal(result.track.cue, 24, '最新のCUEが失われています。');
      equal((await first.getTracks())[0].title, 'Edited', '曲名が保存されていません。');
      equal((await first.getPlaylists()).find(item => item.id === 'first').trackIds, ['fixture-track'], '所属が保存されていません。');
      equal(await (await first.getAudio('fixture-track')).text(), 'fixture audio', '音源が変わっています。');
    });

    await test('追加先プレイリスト消失時は曲情報も変更しない', async () => {
      await first.putPlaylists((await first.getPlaylists()).filter(item => item.id !== 'second'));
      const before = await first.getTracks();
      await rejects(() => second.updateTrackDetails('fixture-track', {title: 'Uncommitted', artist: '', bpm: 90}, 'second'), /プレイリスト/);
      equal(await first.getTracks(), before, '拒否後に曲情報が変わっています。');
    });

    await test('後半の保存失敗を注入すると曲・プレイリストが両方ロールバック', async () => {
      const beforeTracks = await first.getTracks(), beforeLists = await first.getPlaylists();
      const originalPut = IDBObjectStore.prototype.put;
      IDBObjectStore.prototype.put = function (value, key) {
        if (this.transaction.db.name === databaseName && this.name === 'config' && key === 'playlists') {
          this.transaction.abort();
          throw new DOMException('Injected storage failure', 'QuotaExceededError');
        }
        return originalPut.apply(this, arguments);
      };
      try {
        await rejects(() => second.updateTrackDetails('fixture-track', {title: 'Uncommitted', artist: '', bpm: 90}, 'first'), /保存容量/);
      } finally { IDBObjectStore.prototype.put = originalPut; }
      equal(await first.getTracks(), beforeTracks, 'トランザクション中断後に曲情報が残っています。');
      equal(await first.getPlaylists(), beforeLists, 'トランザクション中断後に所属変更が残っています。');
      equal(await (await first.getAudio('fixture-track')).text(), 'fixture audio', '元音源が変わっています。');
    });

    await test('読み込み元参照の後半保存失敗は曲・リストも戻し、再試行で重複しない', async () => {
      const beforeTracks = await first.getTracks(), beforeLists = await first.getPlaylists();
      const source = {id: 'import-source', label: 'Import', trackIds: ['import-track']};
      const incoming = [sample('import-track')];
      const lists = [{id: 'import-list', name: 'Import', trackIds: ['import-track']}];
      const originalPut = IDBObjectStore.prototype.put;
      IDBObjectStore.prototype.put = function (value, key) {
        if (this.transaction.db.name === databaseName && this.name === 'config' && key === 'sources') {
          this.transaction.abort();
          throw new DOMException('Injected source failure', 'QuotaExceededError');
        }
        return originalPut.apply(this, arguments);
      };
      try {
        for (let attempt = 0; attempt < 2; attempt++) {
          await rejects(() => second.importTracks(incoming, lists, source), /保存容量/);
          equal(await first.getTracks(), beforeTracks, '失敗後に取り込んだ曲が残っています。');
          equal(await first.getPlaylists(), beforeLists, '失敗後に取り込んだリストが残っています。');
          equal(await first.getSources(), [], '失敗後に参照が残っています。');
        }
      } finally { IDBObjectStore.prototype.put = originalPut; }
      await second.importTracks(incoming, lists, source);
      equal((await first.getTracks()).length, 2, '再試行で曲が重複しました。');
      equal((await first.getPlaylists()).length, 2, '再試行でリストが重複しました。');
      equal((await first.getSources()).length, 1, '再試行で参照が重複しました。');
      await first.removeTrack('import-track');
      await first.putPlaylists(beforeLists);
      await first.removeSource('import-source');
    });

    await test('読み込み元20件の上限で曲・リストを保存せず、再試行しても不変', async () => {
      for (let index = 0; index < 20; index++) await first.putSource({id: `source-${index}`, label: 'Existing', trackIds: []});
      const beforeTracks = await first.getTracks(), beforeLists = await first.getPlaylists(), beforeSources = await first.getSources();
      for (let attempt = 0; attempt < 2; attempt++) {
        const id = `orphan-${attempt}`;
        await rejects(() => second.importTracks([sample(id)], [{id, name: 'Import', trackIds: [id]}], {id, label: 'Import', trackIds: [id]}), /20件/);
        equal(await first.getTracks(), beforeTracks, '参照上限で曲が残っています。');
        equal(await first.getPlaylists(), beforeLists, '参照上限でリストが残っています。');
        equal(await first.getSources(), beforeSources, '参照上限で既存参照が変わっています。');
      }
      await first.importTracks([], [], {...beforeSources[0], label: 'Refreshed'});
      equal((await first.getSources()).find(item => item.id === 'source-0').label, 'Refreshed', '上限で既存参照を更新できません。');
      for (const source of beforeSources) await first.removeSource(source.id);
    });

    await test('9,999曲での同時追加は1曲だけ成功し、上限でも編集・削除後の再追加が可能', async () => {
      await first.importTracks(Array.from({length: 9_998}, (_, index) => sample(`capacity-${index}`)), []);
      const states = await Promise.allSettled([
        first.putTrack(sample('last-a'), new Blob(['a'])),
        second.putTrack(sample('last-b'), new Blob(['b'])),
      ]);
      equal(states.map(item => item.status).sort(), ['fulfilled', 'rejected'], '上限を超えて同時追加が成功しました。');
      const rejected = states.findIndex(item => item.status === 'rejected');
      check(/10,000/.test(states[rejected].reason.message), '曲数上限以外のエラーです。');
      equal(await first.getAudio(['last-a', 'last-b'][rejected]), null, '拒否した曲の音源が残っています。');
      equal((await first.getTracks()).length, 10_000, '上限件数が守られていません。');
      await first.putTrack({...sample(), title: 'Edited at capacity'});
      equal((await first.getTracks()).find(item => item.id === 'fixture-track').title, 'Edited at capacity', '上限で編集できません。');
      await first.removeTrack(['last-b', 'last-a'][rejected]);
      await second.putTrack(sample('replacement'), new Blob(['replacement']));
      equal(await (await first.getAudio('replacement')).text(), 'replacement', '削除後に追加できません。');
      equal(validateLibrarySnapshot({format: 'deckflow.library', version: 1, tracks: await first.getTracks(), playlists: await first.getPlaylists()}).tracks.length, 10_000, '書き出し形式を検証できません。');
    });

    await test('新しい接続から保存内容を読み直せる', async () => {
      const reopened = await openLibrary();
      check(reopened.persistent, '永続ストアを再度開けません。');
      equal((await reopened.getTracks()).length, 10_000, '再接続後の曲数が異なります。');
      equal((await reopened.getPlaylists())[0].trackIds, ['fixture-track'], '再接続後の所属が異なります。');
    });
  } catch (error) {
    failed = true;
    if (!messages.some(message => message.startsWith('FAIL:'))) messages.push(`FAIL: ${error.message}`);
  } finally {
    for (const database of connections) database.close();
    if (descriptor) Object.defineProperty(window, 'indexedDB', descriptor);
    else delete window.indexedDB;
    try {
      await new Promise((resolve, reject) => {
        const request = nativeIndexedDB.deleteDatabase(databaseName);
        request.onsuccess = resolve;
        request.onerror = () => reject(request.error);
        request.onblocked = () => reject(new Error('検証用データベースの削除がブロックされました。'));
      });
      messages.push('CLEANUP: 検証用データベースを削除しました。');
    } catch (error) { failed = true; messages.push(`CLEANUP FAILED: ${error.message}`); }
    messages.push(`結果: ${passed}件成功 / ${failed ? '失敗あり' : '失敗なし'}`);
    results.textContent = messages.join('\n');
    results.dataset.status = failed ? 'failed' : 'passed';
    run.disabled = false;
  }
});
