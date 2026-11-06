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
