(() => {
  'use strict';

  const MAIN_DB_NAME = 'parents-player-db';
  const MAIN_DB_VERSION = 1;
  const AUDIO_DB_NAME = 'parents-player-audio-db';
  const AUDIO_DB_VERSION = 1;
  const AUDIO_STORE = 'audio';
  const LIBRARY_STORE = 'library';

  let audioDb = null;
  let legacyFallback = false;
  let migrationResult = { migrated: 0, normalized: 0, cleanedLegacyDatabase: false, fallback: false };

  function requestPromise(request) {
    return new Promise((resolve, reject) => {
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error || new Error('IndexedDB 요청에 실패했습니다.'));
    });
  }

  function transactionPromise(transaction) {
    return new Promise((resolve, reject) => {
      transaction.oncomplete = resolve;
      transaction.onerror = () => reject(transaction.error || new Error('IndexedDB 저장에 실패했습니다.'));
      transaction.onabort = () => reject(transaction.error || new Error('IndexedDB 작업이 취소되었습니다.'));
    });
  }

  function audioValueSize(value) {
    const audio = value?.blob ?? value;
    if (!audio) return 0;
    if (audio.__bytes instanceof ArrayBuffer) return audio.__bytes.byteLength;
    if (audio instanceof ArrayBuffer) return audio.byteLength;
    if (ArrayBuffer.isView(audio)) return audio.byteLength;
    if (typeof Blob !== 'undefined' && audio instanceof Blob) return audio.size;
    return 0;
  }

  // Parents Player targets Samsung/Android Chrome. Persist new audio as Blob
  // objects so IndexedDB can keep large media out of the JS heap. The app can
  // still read historical ArrayBuffer-wrapper rows during migration/fallback.
  function normalizeRowForDedicatedStorage(row) {
    if (!row || typeof row !== 'object') return row;
    const audio = row.blob;
    if (audio?.__bytes instanceof ArrayBuffer) {
      return {
        ...row,
        blob: new Blob([audio.__bytes], { type: audio.type || 'audio/mpeg' })
      };
    }
    return row;
  }

  function openAudioDb() {
    if (audioDb) return Promise.resolve(audioDb);
    return new Promise((resolve, reject) => {
      const request = indexedDB.open(AUDIO_DB_NAME, AUDIO_DB_VERSION);
      request.onupgradeneeded = () => {
        const db = request.result;
        if (!db.objectStoreNames.contains(AUDIO_STORE)) {
          db.createObjectStore(AUDIO_STORE, { keyPath: 'id' });
        }
      };
      request.onsuccess = () => {
        audioDb = request.result;
        audioDb.onversionchange = () => {
          try { audioDb?.close(); } catch {}
          audioDb = null;
        };
        resolve(audioDb);
      };
      request.onerror = () => reject(request.error || new Error('오프라인 오디오 저장공간을 열지 못했습니다.'));
      request.onblocked = () => reject(new Error('다른 불경 듣기 창을 닫고 다시 시도해 주세요.'));
    });
  }

  async function audioRequest(mode, makeRequest) {
    for (let attempt = 0; attempt < 2; attempt += 1) {
      try {
        const db = await openAudioDb();
        const transaction = db.transaction(AUDIO_STORE, mode);
        const request = makeRequest(transaction.objectStore(AUDIO_STORE));
        const result = await requestPromise(request);
        if (mode === 'readwrite') await transactionPromise(transaction);
        return result;
      } catch (error) {
        const name = String(error?.name || '');
        const message = String(error?.message || '');
        const recoverable = (
          name === 'InvalidStateError' && /connection is (closing|closed)|database connection is (closing|closed)|not ready/i.test(message)
        ) || (
          name === 'UnknownError' && /indexed database server|connection to indexed database server lost/i.test(message)
        );
        if (attempt === 0 && recoverable) {
          try { audioDb?.close(); } catch {}
          audioDb = null;
          await new Promise(resolve => setTimeout(resolve, 0));
          continue;
        }
        throw error;
      }
    }
    throw new Error('오프라인 오디오 저장 요청에 실패했습니다.');
  }

  function openMainDb() {
    return new Promise((resolve, reject) => {
      const request = indexedDB.open(MAIN_DB_NAME, MAIN_DB_VERSION);
      request.onupgradeneeded = () => {
        const db = request.result;
        if (!db.objectStoreNames.contains(LIBRARY_STORE)) {
          db.createObjectStore(LIBRARY_STORE, { keyPath: 'id' });
        }
      };
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error || new Error('불경 목록 저장공간을 열지 못했습니다.'));
      request.onblocked = () => reject(new Error('불경 목록 저장공간이 다른 창에서 사용 중입니다.'));
    });
  }

  async function readStore(db, storeName) {
    if (!db.objectStoreNames.contains(storeName)) return [];
    const transaction = db.transaction(storeName, 'readonly');
    return requestPromise(transaction.objectStore(storeName).getAll());
  }

  async function writeRows(db, storeName, rows) {
    if (!rows.length) return;
    const transaction = db.transaction(storeName, 'readwrite');
    const store = transaction.objectStore(storeName);
    for (const row of rows) store.put(row);
    await transactionPromise(transaction);
  }

  function deleteDatabaseByName(name) {
    return new Promise((resolve, reject) => {
      const request = indexedDB.deleteDatabase(name);
      request.onsuccess = resolve;
      request.onerror = () => reject(request.error || new Error(`${name} 삭제에 실패했습니다.`));
      request.onblocked = () => reject(new Error(`${name}이 다른 불경 듣기 창에서 사용 중입니다.`));
    });
  }

  async function rebuildMainDatabaseWithLibrary(libraryRows) {
    await deleteDatabaseByName(MAIN_DB_NAME);
    const db = await openMainDb();
    try {
      await writeRows(db, LIBRARY_STORE, libraryRows);
    } finally {
      db.close();
    }
  }

  async function legacyAudioRows() {
    const db = await openMainDb();
    try {
      return await readStore(db, AUDIO_STORE);
    } finally {
      db.close();
    }
  }

  async function dedicatedRows() {
    return audioRequest('readonly', store => store.getAll());
  }

  async function normalizeExistingDedicatedRows() {
    const rows = await dedicatedRows();
    let normalized = 0;
    for (const row of rows) {
      const next = normalizeRowForDedicatedStorage(row);
      if (next === row) continue;
      try {
        await audioRequest('readwrite', store => store.put(next));
        normalized += 1;
      } catch (error) {
        // Optimization only: never make otherwise-readable offline audio or app
        // startup depend on a successful ArrayBuffer -> Blob normalization.
        console.warn('Parents Player audio normalization skipped', row?.id, error);
      }
    }
    return normalized;
  }

  async function migrateLegacyStorage() {
    const legacyDb = await openMainDb();
    let libraryRows = [];
    let oldAudioRows = [];
    try {
      libraryRows = await readStore(legacyDb, LIBRARY_STORE);
      if (!legacyDb.objectStoreNames.contains(AUDIO_STORE)) {
        return { migrated: 0, cleanedLegacyDatabase: false, fallback: false };
      }
      oldAudioRows = await readStore(legacyDb, AUDIO_STORE);
    } finally {
      legacyDb.close();
    }

    try {
      const existing = await dedicatedRows();
      const existingById = new Map(existing.map(row => [row.id, row]));
      let migrated = 0;

      // Never overwrite a non-empty dedicated row during a migration retry.
      // A dedicated row may be newer than the legacy copy if an earlier
      // cleanup attempt was blocked and the app subsequently downloaded an
      // updated Drive file into the new database.
      for (const legacyRow of oldAudioRows) {
        const current = existingById.get(legacyRow.id);
        if (current && audioValueSize(current) > 0) continue;
        const next = normalizeRowForDedicatedStorage(legacyRow);
        await audioRequest('readwrite', store => store.put(next));
        existingById.set(legacyRow.id, next);
        migrated += 1;
      }

      const verifiedRows = await dedicatedRows();
      const verifiedById = new Map(verifiedRows.map(row => [row.id, row]));
      for (const legacyRow of oldAudioRows) {
        const copy = verifiedById.get(legacyRow.id);
        if (!copy || audioValueSize(copy) <= 0) {
          throw new Error('기존 오프라인 오디오 이전 확인에 실패했습니다.');
        }
      }

      // Recreate the historical shared DB only after every legacy audio ID is
      // safely represented in the dedicated DB. This drops the old audio store
      // and any empty-but-allocated backing space while preserving the library.
      await rebuildMainDatabaseWithLibrary(libraryRows);
      legacyFallback = false;
      return { migrated, cleanedLegacyDatabase: true, fallback: false };
    } catch (error) {
      console.warn('Parents Player storage migration fallback', error);
      legacyFallback = true;
      return {
        migrated: 0,
        cleanedLegacyDatabase: false,
        fallback: true,
        error: String(error?.message || error || '')
      };
    }
  }

  async function getAll() {
    const current = await dedicatedRows();
    if (!legacyFallback) return current;
    const legacy = await legacyAudioRows().catch(() => []);
    const merged = new Map(legacy.map(row => [row.id, row]));
    for (const row of current) merged.set(row.id, row);
    return [...merged.values()];
  }

  async function get(key) {
    const current = await audioRequest('readonly', store => store.get(key));
    if (current || !legacyFallback) return current;
    const legacy = await legacyAudioRows().catch(() => []);
    return legacy.find(row => row.id === key);
  }

  async function put(value) {
    const normalized = normalizeRowForDedicatedStorage(value);
    return audioRequest('readwrite', store => store.put(normalized));
  }

  async function deleteKey(id) {
    await audioRequest('readwrite', store => store.delete(id));
    if (legacyFallback) {
      const db = await openMainDb();
      try {
        if (db.objectStoreNames.contains(AUDIO_STORE)) {
          const transaction = db.transaction(AUDIO_STORE, 'readwrite');
          transaction.objectStore(AUDIO_STORE).delete(id);
          await transactionPromise(transaction);
        }
      } finally {
        db.close();
      }
    }
  }

  async function readStats() {
    const rows = await getAll();
    return {
      count: rows.filter(row => audioValueSize(row) > 0).length,
      bytes: rows.reduce((sum, row) => sum + audioValueSize(row), 0)
    };
  }

  async function deleteDatabase() {
    try { audioDb?.close(); } catch {}
    audioDb = null;

    // The normal architecture keeps the library DB untouched. Only rebuild it
    // if a historical shared audio store is still present, e.g. after a prior
    // migration was blocked by another open app window.
    const mainDb = await openMainDb();
    let libraryRows = [];
    let hasLegacyAudioStore = false;
    try {
      hasLegacyAudioStore = mainDb.objectStoreNames.contains(AUDIO_STORE);
      if (hasLegacyAudioStore) libraryRows = await readStore(mainDb, LIBRARY_STORE);
    } finally {
      mainDb.close();
    }

    await deleteDatabaseByName(AUDIO_DB_NAME);
    if (hasLegacyAudioStore) {
      await rebuildMainDatabaseWithLibrary(libraryRows);
    }
    legacyFallback = false;

    // Recreate a fresh tiny audio DB so the running app can continue and verify
    // the deletion without requiring an app reinstall.
    await openAudioDb();
    return readStats();
  }

  const ready = (async () => {
    await openAudioDb();
    migrationResult = await migrateLegacyStorage();
    const normalized = await normalizeExistingDedicatedRows();
    migrationResult = { ...migrationResult, normalized };
    return migrationResult;
  })();

  window.ParentsAudioStorage = {
    databaseName: AUDIO_DB_NAME,
    storeName: AUDIO_STORE,
    ready,
    getAll,
    get,
    put,
    deleteKey,
    readStats,
    deleteDatabase,
    migrationStatus: () => ({ ...migrationResult })
  };
})();
