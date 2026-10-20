(() => {
  'use strict';

  const MAIN_DB_NAME = 'parents-player-db';
  const LIBRARY_STORE = 'library';
  const syncBtn = document.getElementById('syncBtn');
  const deleteBtn = document.getElementById('deleteOfflineBtn');
  const storage = window.ParentsAudioStorage;
  const nativeStoreDelete = IDBObjectStore.prototype.delete;
  const pendingLibraryDeletes = new Set();

  let deleteBarrier = false;
  let deleteComplete = false;
  let syncWasActiveAtDelete = false;
  let syncDisabledBeforeDelete = false;

  function syncIsActive() {
    return String(syncBtn?.textContent || '').includes('업데이트 중');
  }

  function maybeReleaseDeleteBarrier() {
    if (!deleteComplete || (syncWasActiveAtDelete && syncIsActive())) return;
    deleteBarrier = false;
    deleteComplete = false;
    if (syncBtn) syncBtn.disabled = syncWasActiveAtDelete ? false : syncDisabledBeforeDelete;
    syncWasActiveAtDelete = false;
  }

  function waitTransaction(transaction) {
    return new Promise((resolve, reject) => {
      transaction.oncomplete = resolve;
      transaction.onerror = () => reject(transaction.error || new Error('Library deletion failed.'));
      transaction.onabort = () => reject(transaction.error || new Error('Library deletion was cancelled.'));
    });
  }

  function openMainDb() {
    return new Promise((resolve, reject) => {
      const request = indexedDB.open(MAIN_DB_NAME);
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error || new Error('Could not open the local library.'));
      request.onblocked = () => reject(new Error('The local library is open in another app window.'));
    });
  }

  async function commitLibraryDelete(id) {
    const key = String(id || '');
    if (!key || !pendingLibraryDeletes.has(key)) return;

    const db = await openMainDb();
    try {
      if (!db.objectStoreNames.contains(LIBRARY_STORE)) {
        pendingLibraryDeletes.delete(key);
        return;
      }
      const transaction = db.transaction(LIBRARY_STORE, 'readwrite');
      nativeStoreDelete.call(transaction.objectStore(LIBRARY_STORE), key);
      await waitTransaction(transaction);
      pendingLibraryDeletes.delete(key);
    } finally {
      db.close();
    }
  }

  // The core reconciler currently asks to remove the library row before it
  // removes the separate audio row. Stage that metadata delete instead. The
  // audio wrapper below commits it only after read-back proves the audio is gone.
  IDBObjectStore.prototype.delete = function guardedDelete(key) {
    if (this.transaction?.db?.name === MAIN_DB_NAME && this.name === LIBRARY_STORE) {
      pendingLibraryDeletes.add(String(key || ''));
      return this.get(key);
    }
    return nativeStoreDelete.call(this, key);
  };

  if (storage?.put && storage?.deleteDatabase) {
    const originalPut = storage.put.bind(storage);
    const originalDeleteDatabase = storage.deleteDatabase.bind(storage);
    const originalDeleteKey = storage.deleteKey?.bind(storage);
    const originalGet = storage.get?.bind(storage);

    storage.put = async value => {
      if (deleteBarrier) throw new DOMException('Offline-audio update cancelled by Delete All.', 'AbortError');
      return originalPut(value);
    };

    if (originalDeleteKey && originalGet) {
      storage.deleteKey = async id => {
        let lastError = null;
        for (let attempt = 0; attempt < 3; attempt += 1) {
          try {
            await originalDeleteKey(id);
            const remaining = await originalGet(id);
            if (!remaining) {
              await commitLibraryDelete(id);
              return;
            }
            lastError = new Error('Offline audio row still exists after deletion.');
          } catch (error) {
            lastError = error;
          }
          await new Promise(resolve => setTimeout(resolve, 60 * (attempt + 1)));
        }
        throw lastError || new Error('Could not verify offline audio removal.');
      };
    }

    storage.deleteDatabase = async (...args) => {
      deleteBarrier = true;
      deleteComplete = false;
      if (syncBtn) syncBtn.disabled = true;
      try {
        return await originalDeleteDatabase(...args);
      } finally {
        deleteComplete = true;
        maybeReleaseDeleteBarrier();
      }
    };
  }

  deleteBtn?.addEventListener('click', () => {
    syncWasActiveAtDelete = syncIsActive();
    syncDisabledBeforeDelete = !!syncBtn?.disabled;
    deleteBarrier = true;
    queueMicrotask(() => {
      if (!deleteBtn.disabled) {
        deleteBarrier = false;
        syncWasActiveAtDelete = false;
        return;
      }
      if (syncBtn) syncBtn.disabled = true;
    });
  }, true);

  if (syncBtn) {
    new MutationObserver(maybeReleaseDeleteBarrier).observe(syncBtn, {
      childList: true,
      subtree: true,
      attributes: true,
      attributeFilter: ['disabled']
    });
  }
})();
