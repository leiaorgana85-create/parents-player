(() => {
  'use strict';

  const DEFAULT_FOLDER_ID = '1LkvFEALAV1penT439jh5NyM7ilsG9TC6';
  const API_KEY_STORAGE = 'parentsPlayerPublicApiKey';
  const DB_NAME = 'parents-player-db';
  const DB_VERSION = 1;
  const SETTINGS_KEY = 'parentsPlayerSettings';
  const SPEED_KEY = 'parentsPlayerPlaybackSpeed';
  const POSITION_KEY = 'parentsPlayerPositions';
  const REPEAT_KEY = 'parentsPlayerRepeatMode';
  const SUPPORTED_MIMES = new Set(['audio/mpeg', 'audio/mp4', 'audio/x-m4a', 'audio/aac', 'audio/flac', 'audio/x-flac', 'audio/wav', 'audio/x-wav']);

  const els = Object.fromEntries([
    'syncBtn','settingsBtn','statusTitle','statusDetail','trackCount','trackList','emptyState','player','nowTitle','nowStatus',
    'speed1Btn','speed2Btn','repeatBtn','seek','timeCurrent','timeTotal','prevBtn','backBtn','playBtn','forwardBtn','nextBtn','audio',
    'settingsDialog','settingsForm','apiKeyInput','folderIdInput','offlineStats','storageEstimate','driveStorageStatus',
    'deleteOfflineBtn','factoryResetBtn','storageResult','saveSettingsBtn'
  ].map(id => [id, document.getElementById(id)]));

  let db = null;
  let library = [];
  let audioRows = new Map();
  let currentId = null;
  let currentUrl = null;
  let seekDragging = false;
  let operationBusy = false;
  let playbackGeneration = 0;
  let settings = loadSettings();
  let playbackSpeed = Number(localStorage.getItem(SPEED_KEY) || '1') === 2 ? 2 : 1;
  let repeatMode = normalizeRepeat(localStorage.getItem(REPEAT_KEY) || 'all');

  function normalizeRepeat(value) {
    return value === 'off' || value === 'one' ? value : 'all';
  }

  function loadSettings() {
    try {
      const stored = JSON.parse(localStorage.getItem(SETTINGS_KEY) || '{}') || {};
      return { folderId: String(stored.folderId || DEFAULT_FOLDER_ID).trim() || DEFAULT_FOLDER_ID };
    } catch {
      return { folderId: DEFAULT_FOLDER_ID };
    }
  }

  function saveSettings() {
    localStorage.setItem(SETTINGS_KEY, JSON.stringify({ folderId: settings.folderId || DEFAULT_FOLDER_ID }));
  }

  function readApiKey() {
    return String(localStorage.getItem(API_KEY_STORAGE) || '').trim();
  }

  function validApiKey(value = readApiKey()) {
    return /^AIza[\w-]{20,}$/.test(String(value || '').trim());
  }

  let keyModule = null;
  function ensureDriveKey() {
    if (window.ParentsDriveKey) return window.ParentsDriveKey.ensureReady();
    if (!keyModule) keyModule = new Promise((resolve, reject) => {
      const script = document.createElement('script');
      script.src = './drive-key-bootstrap.js?v=1';
      script.onload = () => {
        if (window.ParentsDriveKey) resolve(window.ParentsDriveKey);
        else { keyModule = null; script.remove(); reject(new Error('연결 설정을 불러오지 못했습니다.')); }
      };
      script.onerror = () => { keyModule = null; script.remove(); reject(new Error('인터넷 연결 후 다시 업데이트해 주세요.')); };
      document.head.appendChild(script);
    });
    return keyModule.then(module => module.ensureReady());
  }

  function cleanLegacyAuthState() {
    localStorage.removeItem('parentsPlayerGoogleAccessToken');
    localStorage.removeItem('parentsPlayerGoogleAuthorized');
    localStorage.removeItem('parentsPlayerGoogleForceConsent');
  }

  function cleanTitle(name = '') {
    return name.replace(/\.(mp3|m4a|aac|flac|wav)$/i, '').trim();
  }

  function fmtBytes(n) {
    const x = Number(n || 0);
    if (x <= 0) return '0 MB';
    if (x >= 1024 * 1024 * 1024) return `${(x / 1024 / 1024 / 1024).toFixed(2)} GB`;
    if (x >= 1024 * 1024) return `${(x / 1024 / 1024).toFixed(1)} MB`;
    return `${Math.round(x / 1024)} KB`;
  }

  function fmtTime(seconds) {
    const s = Number.isFinite(seconds) ? Math.max(0, Math.floor(seconds)) : 0;
    const h = Math.floor(s / 3600);
    const m = Math.floor((s % 3600) / 60);
    const sec = s % 60;
    return h ? `${h}:${String(m).padStart(2, '0')}:${String(sec).padStart(2, '0')}` : `${m}:${String(sec).padStart(2, '0')}`;
  }

  // New track selections always start at zero; pause/play keeps the loaded position.
  function removePosition() { localStorage.removeItem(POSITION_KEY); }

  async function runOperation(action) {
    if (operationBusy) return;
    operationBusy = true;
    els.deleteOfflineBtn.disabled = true;
    els.syncBtn.disabled = true;
    els.saveSettingsBtn.disabled = true;
    if (els.factoryResetBtn) els.factoryResetBtn.disabled = true;
    const run = async () => {
      await audioStorage().ready;
      if (!db) db = await openDb();
      await reloadLocal();
      return action();
    };
    try {
      // Also serialize separate tabs of this app, without locking sibling apps.
      if (navigator.locks?.request) return await navigator.locks.request(DB_NAME + '-mutation', run);
      return await run();
    } catch (error) {
      console.error(error);
      try { await reloadLocal(); } catch {}
      updateStatus('작업을 완료하지 못했습니다', error.message || '다시 시도해 주세요.');
    } finally {
      operationBusy = false;
      els.deleteOfflineBtn.disabled = false;
      els.syncBtn.disabled = false;
      els.saveSettingsBtn.disabled = false;
      if (els.factoryResetBtn) els.factoryResetBtn.disabled = false;
      render();
    }
  }

  async function removeLocalTrack(id) {
    if (currentId === id) stopPlayer();
    await dbDelete('audio', id);
    if (await audioStorage().get(id)) throw new Error('오디오 삭제를 확인하지 못했습니다. 다시 시도해 주세요.');
    audioRows.delete(id);
    // Metadata stays recoverable until the separate audio deletion is verified.
    await dbDelete('library', id);
    removePosition(id);
  }

  async function resumeAudio() {
    const generation = playbackGeneration;
    try { await els.audio.play(); }
    catch (error) {
      if (generation !== playbackGeneration || error.name === 'AbortError') return;
      updateStatus('재생하지 못했습니다', '재생 버튼을 다시 눌러 주세요. ' + (error.message || ''));
    }
  }

  function openDb() {
    return new Promise((resolve, reject) => {
      const req = indexedDB.open(DB_NAME, DB_VERSION);
      req.onupgradeneeded = () => {
        const idb = req.result;
        if (!idb.objectStoreNames.contains('library')) idb.createObjectStore('library', { keyPath: 'id' });
      };
      req.onsuccess = () => {
        const connection = req.result;
        connection.onversionchange = () => { connection.close(); if (db === connection) db = null; };
        resolve(connection);
      };
      req.onblocked = () => reject(new Error('다른 앱 창을 닫고 다시 시도해 주세요.'));
      req.onerror = () => reject(req.error);
    });
  }

  function reqP(req) {
    return new Promise((resolve, reject) => {
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    });
  }

  function isRecoverableDbError(error) {
    const name = String(error?.name || '');
    const message = String(error?.message || '');
    return (
      name === 'InvalidStateError' && /connection is (closing|closed)|database connection is (closing|closed)/i.test(message)
    ) || (
      name === 'UnknownError' && /indexed database server|connection to indexed database server lost/i.test(message)
    );
  }

  async function reopenDb() {
    try { db?.close(); } catch {}
    db = null;
    await new Promise(resolve => setTimeout(resolve, 0));
    db = await openDb();
    return db;
  }

  async function dbRequest(store, mode, makeRequest) {
    for (let attempt = 0; attempt < 2; attempt += 1) {
      try {
        if (!db) db = await openDb();
        const transaction = db.transaction(store, mode);
        const committed = new Promise((resolve, reject) => {
          transaction.oncomplete = resolve;
          transaction.onabort = () => reject(transaction.error || new Error('저장 작업이 취소되었습니다.'));
          transaction.onerror = () => reject(transaction.error || new Error('저장하지 못했습니다.'));
        });
        const [result] = await Promise.all([reqP(makeRequest(transaction.objectStore(store))), committed]);
        return result;
      } catch (error) {
        if (attempt === 0 && isRecoverableDbError(error)) {
          await reopenDb();
          continue;
        }
        throw error;
      }
    }
    throw new Error('IndexedDB 요청에 실패했습니다.');
  }

  function audioStorage() {
    if (!window.ParentsAudioStorage) throw new Error('오프라인 오디오 저장 모듈을 불러오지 못했습니다.');
    return window.ParentsAudioStorage;
  }

  async function dbGetAll(store) {
    if (store === 'audio') {
      const storage = audioStorage();
      await storage.ready;
      return storage.getAll();
    }
    return dbRequest(store, 'readonly', objectStore => objectStore.getAll());
  }

  async function dbPut(store, value) {
    if (store === 'audio') {
      const storage = audioStorage();
      await storage.ready;
      return storage.put(value);
    }
    return dbRequest(store, 'readwrite', objectStore => objectStore.put(value));
  }

  async function dbDelete(store, key) {
    if (store === 'audio') {
      const storage = audioStorage();
      await storage.ready;
      return storage.deleteKey(key);
    }
    return dbRequest(store, 'readwrite', objectStore => objectStore.delete(key));
  }

  function audioValueSize(value) {
    if (!value) return 0;
    if (value.__bytes instanceof ArrayBuffer) return value.__bytes.byteLength;
    if (value instanceof ArrayBuffer) return value.byteLength;
    if (ArrayBuffer.isView(value)) return value.byteLength;
    if (typeof Blob !== 'undefined' && value instanceof Blob) return value.size;
    return 0;
  }

  function audioValueToUrl(value) {
    if (value?.__bytes instanceof ArrayBuffer) {
      return URL.createObjectURL(new Blob([value.__bytes], { type: value.type || 'audio/mpeg' }));
    }
    return URL.createObjectURL(value);
  }

  async function responseToAudioValue(response) {
    return response.blob();
  }

  function rowIsCurrent(track, row) {
    if (!track || !row?.blob) return false;
    const actual = audioValueSize(row.blob);
    const expected = Number(track.size || 0);
    if (actual <= 0) return false;
    if (expected > 0 && actual !== expected) return false;
    if (track.modifiedTime && track.modifiedTime !== row.modifiedTime) return false;
    return true;
  }

  async function reloadLocal() {
    library = await dbGetAll('library');
    library.sort((a, b) => String(a.name).localeCompare(String(b.name), 'ko'));
    const rows = await dbGetAll('audio');
    audioRows = new Map(rows.map(row => [row.id, row]));
    render();
    updateStatus();
    updateOfflineStats();
  }

  function totalOfflineBytes() {
    return library.reduce((sum, track) => {
      const row = audioRows.get(track.id);
      return sum + (rowIsCurrent(track, row) ? audioValueSize(row.blob) : 0);
    }, 0);
  }

  function currentOfflineCount() {
    return library.filter(track => rowIsCurrent(track, audioRows.get(track.id))).length;
  }

  function storedAudioCount() {
    return [...audioRows.values()].filter(row => audioValueSize(row?.blob) > 0).length;
  }

  function storedAudioBytes() {
    return [...audioRows.values()].reduce((sum, row) => sum + audioValueSize(row?.blob), 0);
  }

  function updateOfflineStats() {
    if (els.offlineStats) els.offlineStats.textContent = `${storedAudioCount()}개 · ${fmtBytes(storedAudioBytes())}`;
  }

  async function updateStorageEstimate() {
    if (!els.storageEstimate) return;
    els.storageEstimate.textContent = '계산 중…';
    try {
      const estimate = await navigator.storage?.estimate?.();
      els.storageEstimate.textContent = estimate && Number.isFinite(estimate.usage)
        ? fmtBytes(estimate.usage)
        : '확인 불가';
    } catch {
      els.storageEstimate.textContent = '확인 불가';
    }
  }

  async function updateSettingsStatus() {
    updateOfflineStats();
    await updateStorageEstimate();
    if (els.driveStorageStatus) {
      if (!navigator.onLine) els.driveStorageStatus.textContent = '오프라인';
      else if (validApiKey()) els.driveStorageStatus.textContent = '연결 준비됨';
      else els.driveStorageStatus.textContent = '업데이트 시 자동 연결';
    }
  }

  function updateStatus(title, detail) {
    const offline = currentOfflineCount();
    const total = library.length;
    els.statusTitle.textContent = title || (total ? (offline === total ? '오프라인 재생 준비 완료' : '다운로드가 필요합니다') : '저장된 불경이 없습니다');
    els.statusDetail.textContent = detail != null
      ? detail
      : total ? `${offline}/${total}개 저장됨 · ${fmtBytes(totalOfflineBytes())}` : '불경 업데이트를 눌러 Google Drive에서 받아오세요.';
  }

  function render() {
    els.trackCount.textContent = `${library.length}개`;
    els.emptyState.classList.toggle('hidden', library.length > 0);
    els.trackList.innerHTML = '';

    library.forEach((track, index) => {
      const row = document.createElement('div');
      row.className = 'track-row';
      row.dataset.id = track.id;
      if (track.id === currentId) row.classList.add('playing');

      const number = document.createElement('div');
      number.className = 'track-number';
      number.textContent = track.id === currentId ? '▶' : String(index + 1);

      const main = document.createElement('button');
      main.className = 'track-main';
      main.type = 'button';
      const title = document.createElement('span');
      title.className = 'track-title';
      title.textContent = cleanTitle(track.name);
      const meta = document.createElement('span');
      meta.className = 'track-meta';
      const audioRow = audioRows.get(track.id);
      const saved = rowIsCurrent(track, audioRow);
      const stale = !saved && !!audioRow?.blob;
      meta.textContent = saved
        ? `오프라인 저장됨 · ${fmtBytes(track.size)}`
        : stale ? `업데이트 필요 · 저장된 이전 파일 있음 · ${fmtBytes(track.size)}`
          : `다운로드 필요 · ${fmtBytes(track.size)}`;
      main.append(title, meta);
      main.addEventListener('click', () => playTrack(track.id));

      const mark = document.createElement('div');
      mark.className = 'offline-mark';
      mark.textContent = saved ? '✓' : stale ? '!' : '↓';

      row.append(number, main, mark);
      els.trackList.appendChild(row);
    });
  }

  async function driveFetch(url, options = {}) {
    if (!validApiKey()) await ensureDriveKey();
    const key = readApiKey();
    if (!validApiKey(key)) throw new Error('연결 설정을 확인하지 못했습니다. 다시 업데이트해 주세요.');

    const target = new URL(url);
    target.searchParams.set('key', key);
    const response = await fetch(target.toString(), { ...options, signal: AbortSignal.timeout(90000), cache: 'no-store' });
    if (!response.ok) {
      let message = '';
      try { message = (await response.json())?.error?.message || ''; } catch {}
      throw new Error(message || `Google Drive 오류 (${response.status})`);
    }
    return response;
  }

  async function listDriveFolder() {
    const folderId = settings.folderId || DEFAULT_FOLDER_ID;
    const files = [];
    let pageToken = '';
    const seenPages = new Set();
    do {
      const q = encodeURIComponent(`'${folderId}' in parents and trashed=false`);
      const fields = encodeURIComponent('nextPageToken,incompleteSearch,files(id,name,mimeType,size,createdTime,modifiedTime)');
      const page = pageToken ? `&pageToken=${encodeURIComponent(pageToken)}` : '';
      const url = `https://www.googleapis.com/drive/v3/files?q=${q}&fields=${fields}&pageSize=1000&orderBy=name${page}`;
      const json = await (await driveFetch(url)).json();
      if (json.incompleteSearch || !Array.isArray(json.files) || json.files.some(file => !file.id || typeof file.name !== 'string')) {
        throw new Error('Drive 목록이 불완전합니다. 저장된 파일을 유지했습니다.');
      }
      files.push(...json.files);
      pageToken = json.nextPageToken || '';
      if (pageToken && seenPages.has(pageToken)) throw new Error('Drive 페이지를 확인하지 못했습니다.');
      seenPages.add(pageToken);
    } while (pageToken);
    return files.filter(file => SUPPORTED_MIMES.has(file.mimeType) || /\.(mp3|m4a|aac|flac|wav)$/i.test(file.name));
  }

  async function downloadTrack(track) {
    const oldRow = audioRows.get(track.id) || null;
    const url = `https://www.googleapis.com/drive/v3/files/${encodeURIComponent(track.id)}?alt=media`;
    const response = await driveFetch(url);
    const blob = await responseToAudioValue(response);
    const actual = audioValueSize(blob);
    const expected = Number(track.size || 0);
    if (actual <= 0 || (expected > 0 && actual !== expected)) {
      if (oldRow) audioRows.set(track.id, oldRow);
      throw new Error(`${cleanTitle(track.name)} 다운로드 확인에 실패했습니다. 기존 저장본은 유지했습니다.`);
    }
    const row = { id: track.id, blob, modifiedTime: track.modifiedTime || null };
    await dbPut('audio', row);
    audioRows.set(track.id, row);
  }

  async function syncLibrary() {
    return runOperation(syncLibraryNow);
  }

  async function syncLibraryNow() {
    if (!navigator.onLine) {
      updateStatus('오프라인 상태입니다');
      return;
    }

    els.syncBtn.disabled = true;
    els.syncBtn.textContent = '업데이트 중…';

    try {
      updateStatus('Google Drive 확인 중…', 'PLAYLIST 폴더를 확인하고 있습니다.');
      const incoming = await listDriveFolder();

      if (!incoming.length) {
        throw new Error('Drive에서 파일을 찾지 못했습니다. 기존 오프라인 파일은 그대로 유지했습니다.');
      }

      const incomingIds = new Set(incoming.map(file => file.id));
      const oldById = new Map(library.map(track => [track.id, track]));

      for (const old of library) {
        if (!incomingIds.has(old.id)) {
          await removeLocalTrack(old.id);
        }
      }

      for (const file of incoming) {
        const old = oldById.get(file.id);
        const track = {
          id: file.id,
          name: file.name,
          mimeType: file.mimeType,
          size: Number(file.size || 0),
          createdTime: file.createdTime || old?.createdTime || null,
          modifiedTime: file.modifiedTime || old?.modifiedTime || null
        };
        await dbPut('library', track);
      }

      await reloadLocal();
      const needsDownload = library.filter(track => !rowIsCurrent(track, audioRows.get(track.id)));

      if (navigator.storage?.persist) {
        try { await navigator.storage.persist(); } catch {}
      }

      const failures = [];
      for (let i = 0; i < needsDownload.length; i++) {
        const track = needsDownload[i];
        updateStatus(`다운로드 중 ${i + 1}/${needsDownload.length}`, cleanTitle(track.name));
        try { await downloadTrack(track); } catch (error) { failures.push(error.message || cleanTitle(track.name)); }
        render();
        updateOfflineStats();
      }

      await reloadLocal();
      if (failures.length) throw new Error(`${failures.length}개 다운로드 실패 · 업데이트를 다시 누르면 이어서 받습니다. ${failures[0]}`);
      updateStatus('모든 불경이 최신 상태입니다');
    } catch (error) {
      console.error(error);
      updateStatus('업데이트하지 못했습니다', error.message || '다시 시도해 주세요.');
    } finally {
      els.syncBtn.textContent = '불경 업데이트';
    }
  }

  function setSpeed(speed) {
    playbackSpeed = speed === 2 ? 2 : 1;
    localStorage.setItem(SPEED_KEY, String(playbackSpeed));
    els.audio.playbackRate = playbackSpeed;
    els.speed1Btn.classList.toggle('active', playbackSpeed === 1);
    els.speed2Btn.classList.toggle('active', playbackSpeed === 2);
    updateNowStatus();
    updateMediaPosition();
  }

  function repeatLabel() {
    if (repeatMode === 'one') return '↻ 1곡';
    if (repeatMode === 'all') return '↻ 전체';
    return '↻ 끔';
  }

  function updateRepeatButton() {
    els.repeatBtn.textContent = repeatLabel();
    els.repeatBtn.dataset.mode = repeatMode;
    const label = repeatMode === 'one' ? '한 곡 반복' : repeatMode === 'all' ? '전체 반복' : '반복 끔';
    els.repeatBtn.setAttribute('aria-label', label);
  }

  function cycleRepeat() {
    repeatMode = repeatMode === 'off' ? 'all' : repeatMode === 'all' ? 'one' : 'off';
    localStorage.setItem(REPEAT_KEY, repeatMode);
    updateRepeatButton();
    updateNowStatus();
  }

  function updateNowStatus(stale = null) {
    if (!currentId) return;
    const track = library.find(item => item.id === currentId);
    const row = audioRows.get(currentId);
    const isStale = stale == null ? !rowIsCurrent(track, row) : stale;
    const repeat = repeatMode === 'one' ? '한 곡 반복' : repeatMode === 'all' ? '전체 반복' : '반복 끔';
    els.nowStatus.textContent = `${playbackSpeed}배속 · ${repeat}${isStale ? ' · 저장된 이전 파일' : ' · 오프라인 재생'}`;
  }

  function stopPlayer() {
    playbackGeneration += 1;
    els.audio.onloadedmetadata = null;
    try { els.audio.pause(); } catch {}
    els.audio.removeAttribute('src');
    try { els.audio.load(); } catch {}
    if (currentUrl) URL.revokeObjectURL(currentUrl);
    currentUrl = null;
    currentId = null;
    els.player.classList.add('hidden');
    els.nowTitle.textContent = '—';
    els.nowStatus.textContent = '—';
    els.timeCurrent.textContent = '0:00';
    els.timeTotal.textContent = '0:00';
    els.seek.value = 0;
    render();
  }

  async function playTrack(id) {
    const track = library.find(item => item.id === id);
    if (!track) return;
    const row = audioRows.get(id);
    if (!row?.blob) {
      updateStatus('아직 다운로드되지 않았습니다', '불경 업데이트를 눌러 오프라인 파일을 받아오세요.');
      return;
    }

    const previousUrl = currentUrl;

    const stale = !rowIsCurrent(track, row);
    currentId = id;
    currentUrl = audioValueToUrl(row.blob);
    els.audio.src = currentUrl;
    try { els.audio.currentTime = 0; } catch {}
    els.audio.playbackRate = playbackSpeed;
    els.nowTitle.textContent = cleanTitle(track.name);
    els.player.classList.remove('hidden');
    updateNowStatus(stale);
    render();

    const generation = ++playbackGeneration;
    els.audio.onloadedmetadata = () => {
      if (generation !== playbackGeneration) return;
      els.timeTotal.textContent = fmtTime(els.audio.duration);
      updateSeek();
      updateMediaPosition();
    };
    // Start inside the tap/ended handler, rather than waiting for metadata.
    // Replacing src starts a fresh resource at 0:00; pause/play does not reload it.
    resumeAudio();
    if (previousUrl) URL.revokeObjectURL(previousUrl);

    if ('mediaSession' in navigator) {
      try {
        navigator.mediaSession.metadata = new MediaMetadata({
          title: cleanTitle(track.name),
          artist: '불경',
          album: '불경 듣기'
        });
      } catch {}
    }
  }

  function updateSeek() {
    const duration = els.audio.duration || 0;
    const current = els.audio.currentTime || 0;
    if (!seekDragging) els.seek.value = duration ? Math.round((current / duration) * 1000) : 0;
    els.timeCurrent.textContent = fmtTime(current);
    els.timeTotal.textContent = fmtTime(duration);
  }

  function updateMediaPosition() {
    if (!('mediaSession' in navigator)) return;
    if (!Number.isFinite(els.audio.duration) || els.audio.duration <= 0) return;
    try {
      navigator.mediaSession.setPositionState({
        duration: els.audio.duration,
        playbackRate: els.audio.playbackRate || 1,
        position: Math.min(els.audio.currentTime || 0, els.audio.duration)
      });
    } catch {}
  }

  function playableQueue() { return library.filter(track => audioValueSize(audioRows.get(track.id)?.blob) > 0); }

  function currentIndex() {
    return playableQueue().findIndex(item => item.id === currentId);
  }

  function playNext(auto = false) {
    const queue = playableQueue();
    if (!queue.length || !currentId) return;
    if (auto && repeatMode === 'one') return playTrack(currentId);

    const idx = currentIndex();
    if (idx >= 0 && idx < queue.length - 1) return playTrack(queue[idx + 1].id);
    if (repeatMode === 'all') return playTrack(queue[0].id);
  }

  function playPrev() {
    const queue = playableQueue();
    if (!queue.length || !currentId) return;
    if ((els.audio.currentTime || 0) > 3) {
      els.audio.currentTime = 0;
      return;
    }

    const idx = currentIndex();
    if (idx > 0) return playTrack(queue[idx - 1].id);
    if (repeatMode === 'all') return playTrack(queue[queue.length - 1].id);
    els.audio.currentTime = 0;
  }

  function openSettings() {
    if (els.apiKeyInput) els.apiKeyInput.value = readApiKey();
    els.folderIdInput.value = settings.folderId || DEFAULT_FOLDER_ID;
    updateSettingsStatus();
    if (els.storageResult) els.storageResult.textContent = '';
    els.settingsDialog.showModal();
  }

  async function deleteAllOfflineAudio() {
    return runOperation(deleteAllOfflineAudioNow);
  }

  async function deleteAllOfflineAudioNow() {
    const count = storedAudioCount();
    const size = storedAudioBytes();
    const description = count
      ? `오프라인 오디오 ${count}개 (${fmtBytes(size)})를 모두 삭제할까요?`
      : '오프라인 오디오 저장공간을 초기화할까요?';

    const confirmed = confirm(
      `${description}\n\n` +
      '오디오 전용 데이터베이스 자체를 삭제하고 새 빈 데이터베이스로 다시 만듭니다. Google Drive 원본과 불경 목록은 삭제되지 않습니다.'
    );
    if (!confirmed) return;

    if (els.storageResult) els.storageResult.textContent = '오프라인 오디오 저장공간을 삭제하는 중…';
    try {
      stopPlayer();
      try { db?.close(); } catch {}
      db = null;

      const storage = audioStorage();
      await storage.ready;
      const after = await storage.deleteDatabase();
      if (after.count !== 0 || after.bytes !== 0) {
        throw new Error(`삭제 확인 실패: ${after.count}개의 오디오가 남아 있습니다.`);
      }

      db = await openDb();
      await reloadLocal();
      await updateStorageEstimate();
      if (els.storageResult) els.storageResult.textContent = '확인 완료: 오프라인 오디오 0개 · 0 MB';
      updateStatus('오프라인 오디오를 삭제했습니다', '다시 받으려면 불경 업데이트를 누르세요.');
    } catch (error) {
      console.error(error);
      if (!db) {
        try { db = await openDb(); } catch {}
      }
      if (els.storageResult) els.storageResult.textContent = '완전한 삭제를 확인하지 못했습니다.';
      updateStatus('오프라인 오디오를 삭제하지 못했습니다', error.message || '다시 시도해 주세요.');
    } finally {
      updateOfflineStats();
    }
  }

  els.syncBtn.addEventListener('click', syncLibrary);
  els.settingsBtn.addEventListener('click', openSettings);
  els.speed1Btn.addEventListener('click', () => setSpeed(1));
  els.speed2Btn.addEventListener('click', () => setSpeed(2));
  els.repeatBtn.addEventListener('click', cycleRepeat);
  els.prevBtn.addEventListener('click', playPrev);
  els.nextBtn.addEventListener('click', () => playNext(false));
  els.backBtn.addEventListener('click', () => {
    els.audio.currentTime = Math.max(0, (els.audio.currentTime || 0) - 15);
  });
  els.forwardBtn.addEventListener('click', () => {
    els.audio.currentTime = Math.min(els.audio.duration || Infinity, (els.audio.currentTime || 0) + 15);
  });
  els.playBtn.addEventListener('click', () => {
    if (!currentId && playableQueue()[0]) return playTrack(playableQueue()[0].id);
    els.audio.paused ? resumeAudio() : els.audio.pause();
  });

  els.saveSettingsBtn.addEventListener('click', () => {
    const nextKey = els.apiKeyInput ? els.apiKeyInput.value.trim() : readApiKey();
    if (nextKey && !validApiKey(nextKey)) {
      alert('Google Drive API 키 형식이 올바르지 않습니다. AIza로 시작하는 키를 확인해 주세요.');
      return;
    }
    if (nextKey) localStorage.setItem(API_KEY_STORAGE, nextKey);
    else localStorage.removeItem(API_KEY_STORAGE);
    settings.folderId = els.folderIdInput.value.trim() || DEFAULT_FOLDER_ID;
    saveSettings();
    cleanLegacyAuthState();
    updateStatus('고급 설정을 저장했습니다', '다음 업데이트 때 새 설정을 사용합니다.');
    updateSettingsStatus();
  });

  els.deleteOfflineBtn.addEventListener('click', deleteAllOfflineAudio);
  els.factoryResetBtn?.addEventListener('click', () => {
    const confirmed = confirm(
      '이 기기의 불경 듣기를 처음 상태로 되돌릴까요?\n\n' +
      '불경 듣기의 로컬 목록, 오프라인 오디오, 재생 위치, 설정과 앱 캐시를 삭제합니다. Google Drive의 원본 파일은 삭제되지 않습니다.'
    );
    if (!confirmed) return;
    location.href = './reset.html';
  });

  els.seek.addEventListener('input', () => {
    seekDragging = true;
    const duration = els.audio.duration || 0;
    if (duration) els.timeCurrent.textContent = fmtTime((Number(els.seek.value) / 1000) * duration);
  });
  els.seek.addEventListener('change', () => {
    const duration = els.audio.duration || 0;
    if (duration) els.audio.currentTime = (Number(els.seek.value) / 1000) * duration;
    seekDragging = false;
    updateMediaPosition();
  });

  els.audio.addEventListener('timeupdate', () => {
    updateSeek();
    updateMediaPosition();

  });

  els.audio.addEventListener('play', () => {
    els.playBtn.textContent = '';
    els.playBtn.dataset.state = 'pause';
    els.playBtn.setAttribute('aria-label', '일시정지');
    if ('mediaSession' in navigator) {
      try { navigator.mediaSession.playbackState = 'playing'; } catch {}
    }
  });

  els.audio.addEventListener('pause', () => {
    els.playBtn.textContent = '';
    els.playBtn.dataset.state = 'play';
    els.playBtn.setAttribute('aria-label', '재생');
    if ('mediaSession' in navigator) {
      try { navigator.mediaSession.playbackState = 'paused'; } catch {}
    }
  });

  els.audio.addEventListener('ended', () => {
    if (currentId) removePosition(currentId);
    playNext(true);
  });

  window.addEventListener('online', () => updateStatus());
  window.addEventListener('offline', () => updateStatus('오프라인 상태입니다'));

  if ('mediaSession' in navigator) {
    try {
      navigator.mediaSession.setActionHandler('play', resumeAudio);
      navigator.mediaSession.setActionHandler('pause', () => els.audio.pause());
      navigator.mediaSession.setActionHandler('previoustrack', playPrev);
      navigator.mediaSession.setActionHandler('nexttrack', () => playNext(false));
      navigator.mediaSession.setActionHandler('seekbackward', details => {
        els.audio.currentTime = Math.max(0, els.audio.currentTime - (details.seekOffset || 15));
      });
      navigator.mediaSession.setActionHandler('seekforward', details => {
        els.audio.currentTime = Math.min(els.audio.duration || Infinity, els.audio.currentTime + (details.seekOffset || 15));
      });
      navigator.mediaSession.setActionHandler('seekto', details => {
        if (details.seekTime != null) els.audio.currentTime = details.seekTime;
      });
    } catch {}
  }

  els.audio.addEventListener('error', () => {
    if (currentId) updateStatus('오디오를 재생하지 못했습니다', '다른 곡을 선택하거나 업데이트를 다시 눌러 주세요.');
  });
  window.addEventListener('pageshow', () => {
    if (!operationBusy && db) runOperation(async () => {}).catch(() => {});
  });

  window.addEventListener('beforeunload', () => {
    if (currentUrl) URL.revokeObjectURL(currentUrl);
  });

  async function boot() {
    cleanLegacyAuthState();
    removePosition();
    saveSettings();

    if ('serviceWorker' in navigator) {
      navigator.serviceWorker.register('./sw.js').then(registration => {
        registration.update().catch(() => {});
      }).catch(error => console.warn('Service worker unavailable', error));
    }

    setSpeed(playbackSpeed);
    updateRepeatButton();
    await audioStorage().ready;
    db = await openDb();
    await reloadLocal();

    if (navigator.onLine) {
      updateStatus(library.length ? undefined : '처음에는 불경 업데이트를 눌러 주세요');
    } else {
      updateStatus('오프라인 상태입니다');
    }
  }

  boot().catch(error => {
    console.error(error);
    els.statusTitle.textContent = '앱을 시작하지 못했습니다';
    els.statusDetail.textContent = error.message || '';
  });
})();