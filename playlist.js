(() => {
  'use strict';

  const PLAYLIST_KEY = 'parentsPlayerPlaylistV1';
  const VIEW_KEY = 'parentsPlayerViewMode';
  const POSITION_KEY = 'parentsPlayerPositions';

  const trackList = document.getElementById('trackList');
  const trackCount = document.getElementById('trackCount');
  const sectionHead = document.querySelector('.section-head');
  const heading = sectionHead?.querySelector('h2');
  const audio = document.getElementById('audio');
  const playBtn = document.getElementById('playBtn');
  const prevBtn = document.getElementById('prevBtn');
  const nextBtn = document.getElementById('nextBtn');
  const repeatBtn = document.getElementById('repeatBtn');

  if (!trackList || !trackCount || !sectionHead || !heading || !audio || !playBtn || !prevBtn || !nextBtn || !repeatBtn) return;

  let viewMode = localStorage.getItem(VIEW_KEY) === 'playlist' ? 'playlist' : 'all';
  let queueMode = viewMode;
  let editMode = false;
  let returnView = viewMode;
  let uiScheduled = false;
  let queueClick = false;

  function loadPlaylist() {
    try {
      const value = JSON.parse(localStorage.getItem(PLAYLIST_KEY) || '[]');
      return new Set(Array.isArray(value) ? value.filter(id => typeof id === 'string' && id) : []);
    } catch {
      return new Set();
    }
  }

  function savePlaylist(set) {
    localStorage.setItem(PLAYLIST_KEY, JSON.stringify([...set]));
  }

  function rowId(row) {
    return String(row?.dataset?.id || '');
  }

  function allRows() {
    return [...trackList.children].filter(child => child.classList?.contains('track-row'));
  }

  function validIds() {
    return new Set(allRows().map(rowId).filter(Boolean));
  }

  function prunePlaylist() {
    const valid = validIds();
    if (!valid.size) return;
    const selected = loadPlaylist();
    let changed = false;
    for (const id of [...selected]) {
      if (!valid.has(id)) {
        selected.delete(id);
        changed = true;
      }
    }
    if (changed) savePlaylist(selected);
  }

  function playlistRows() {
    const selected = loadPlaylist();
    return allRows().filter(row => selected.has(rowId(row)));
  }

  function currentRow() {
    return allRows().find(row => row.classList.contains('playing')) || null;
  }

  function currentId() {
    return rowId(currentRow());
  }

  function clickRow(row) {
    const main = row?.querySelector('.track-main');
    if (!main) return;
    queueClick = true;
    try { main.click(); } finally { queueClick = false; }
  }

  function repeatMode() {
    return repeatBtn.dataset.mode || 'all';
  }

  function clearSavedPosition(id) {
    if (!id) return;
    try {
      const positions = JSON.parse(localStorage.getItem(POSITION_KEY) || '{}');
      if (positions && typeof positions === 'object' && !Array.isArray(positions)) {
        delete positions[id];
        localStorage.setItem(POSITION_KEY, JSON.stringify(positions));
      }
    } catch {}
  }

  const tabs = document.createElement('div');
  tabs.className = 'library-mode-tabs';

  const allBtn = document.createElement('button');
  allBtn.id = 'allViewBtn';
  allBtn.className = 'library-mode-btn';
  allBtn.type = 'button';
  allBtn.textContent = '전체';

  const playlistBtn = document.createElement('button');
  playlistBtn.id = 'playlistViewBtn';
  playlistBtn.className = 'library-mode-btn';
  playlistBtn.type = 'button';
  playlistBtn.textContent = '내 재생목록';

  const editBtn = document.createElement('button');
  editBtn.id = 'playlistEditBtn';
  editBtn.className = 'playlist-edit-btn';
  editBtn.type = 'button';
  editBtn.textContent = '편집';

  tabs.append(allBtn, playlistBtn);
  heading.replaceWith(tabs);
  sectionHead.insertBefore(editBtn, trackCount);

  function ensureCheckbox(row, selected) {
    let box = row.querySelector('.playlist-check');
    if (!editMode) {
      box?.remove();
      row.classList.remove('playlist-edit-row');
      return;
    }

    row.classList.add('playlist-edit-row');
    if (!box) {
      box = document.createElement('button');
      box.type = 'button';
      box.className = 'playlist-check';
      box.setAttribute('aria-label', '내 재생목록 선택');
      row.insertBefore(box, row.querySelector('.offline-mark'));
      box.addEventListener('click', event => {
        event.preventDefault();
        event.stopPropagation();
        toggleRow(row);
      });
    }
    box.classList.toggle('selected', selected);
    box.textContent = selected ? '✓' : '';
    box.setAttribute('aria-pressed', selected ? 'true' : 'false');
  }

  function toggleRow(row) {
    const id = rowId(row);
    if (!id) return;
    const selected = loadPlaylist();
    if (selected.has(id)) selected.delete(id);
    else selected.add(id);
    savePlaylist(selected);
    syncUi();
  }

  function syncUi() {
    uiScheduled = false;
    prunePlaylist();
    const rows = allRows();
    const selected = loadPlaylist();
    const selectedCount = rows.reduce((count, row) => count + (selected.has(rowId(row)) ? 1 : 0), 0);

    allBtn.classList.toggle('active', viewMode === 'all' || editMode);
    playlistBtn.classList.toggle('active', viewMode === 'playlist' && !editMode);
    editBtn.textContent = editMode ? '완료' : '편집';
    playlistBtn.disabled = editMode;

    for (const row of rows) {
      const isSelected = selected.has(rowId(row));
      ensureCheckbox(row, isSelected);
      row.classList.toggle('playlist-member', isSelected);
      row.classList.toggle('playlist-hidden', !editMode && viewMode === 'playlist' && !isSelected);
    }

    trackCount.textContent = editMode
      ? `${selectedCount}개`
      : viewMode === 'playlist' ? `${selectedCount}개` : `${rows.length}개`;
  }

  function scheduleSyncUi() {
    if (uiScheduled) return;
    uiScheduled = true;
    queueMicrotask(syncUi);
  }

  function setView(mode) {
    if (editMode) return;
    viewMode = mode === 'playlist' ? 'playlist' : 'all';
    if (!currentId()) queueMode = viewMode;
    localStorage.setItem(VIEW_KEY, viewMode);
    syncUi();
  }

  allBtn.addEventListener('click', () => setView('all'));
  playlistBtn.addEventListener('click', () => setView('playlist'));
  editBtn.addEventListener('click', () => {
    if (!editMode) {
      returnView = viewMode;
      editMode = true;
      viewMode = 'all';
    } else {
      editMode = false;
      viewMode = returnView;
      if (!currentId()) queueMode = viewMode;
      localStorage.setItem(VIEW_KEY, viewMode);
    }
    syncUi();
  });

  trackList.addEventListener('click', event => {
    const row = event.target.closest('.track-row');
    if (!row || !trackList.contains(row)) return;

    if (editMode && event.target.closest('.track-main')) {
      event.preventDefault();
      event.stopImmediatePropagation();
      toggleRow(row);
      return;
    }

    if (!queueClick && event.target.closest('.track-main')) {
      queueMode = viewMode === 'playlist' ? 'playlist' : 'all';
    }
  }, true);

  function playlistQueue() {
    return playlistRows().filter(row => row.querySelector('.offline-mark')?.textContent.trim() !== '↓');
  }

  function playlistNext({ ended = false } = {}) {
    const queue = playlistQueue();
    if (!queue.length) return false;

    const mode = repeatMode();
    const id = currentId();
    if (ended && mode === 'one' && id) {
      clearSavedPosition(id);
      clickRow(currentRow());
      return true;
    }

    const idx = queue.findIndex(row => rowId(row) === id);
    if (idx >= 0 && idx < queue.length - 1) {
      clickRow(queue[idx + 1]);
      return true;
    }
    if (idx < 0) {
      clickRow(queue[0]);
      return true;
    }
    if (mode === 'all') {
      clickRow(queue[0]);
      return true;
    }
    return true;
  }

  function playlistPrev() {
    const queue = playlistQueue();
    if (!queue.length) return false;

    if ((audio.currentTime || 0) > 3) {
      audio.currentTime = 0;
      return true;
    }

    const id = currentId();
    const idx = queue.findIndex(row => rowId(row) === id);
    if (idx > 0) {
      clickRow(queue[idx - 1]);
      return true;
    }
    if (idx < 0) {
      clickRow(queue[0]);
      return true;
    }
    if (repeatMode() === 'all') {
      clickRow(queue[queue.length - 1]);
      return true;
    }
    audio.currentTime = 0;
    return true;
  }

  playBtn.addEventListener('click', event => {
    if (editMode || queueMode !== 'playlist' || currentId()) return;
    const first = playlistQueue()[0];
    if (!first) return;
    event.preventDefault();
    event.stopImmediatePropagation();
    clickRow(first);
  }, true);

  nextBtn.addEventListener('click', event => {
    if (queueMode !== 'playlist') return;
    if (!playlistQueue().length) return;
    event.preventDefault();
    event.stopImmediatePropagation();
    playlistNext();
  }, true);

  prevBtn.addEventListener('click', event => {
    if (queueMode !== 'playlist') return;
    if (!playlistQueue().length) return;
    event.preventDefault();
    event.stopImmediatePropagation();
    playlistPrev();
  }, true);

  audio.addEventListener('ended', event => {
    if (queueMode !== 'playlist') return;
    if (!playlistQueue().length) return;
    event.preventDefault();
    event.stopImmediatePropagation();
    clearSavedPosition(currentId());
    playlistNext({ ended: true });
  }, true);

  function installMediaHandlers() {
    if (!('mediaSession' in navigator)) return;
    try {
      navigator.mediaSession.setActionHandler('previoustrack', () => {
        if (queueMode === 'playlist' && playlistQueue().length) playlistPrev();
        else prevBtn.click();
      });
      navigator.mediaSession.setActionHandler('nexttrack', () => {
        if (queueMode === 'playlist' && playlistQueue().length) playlistNext();
        else nextBtn.click();
      });
    } catch {}
  }

  const observer = new MutationObserver(scheduleSyncUi);
  observer.observe(trackList, { childList: true });

  syncUi();
  window.addEventListener('load', installMediaHandlers);
  window.addEventListener('pageshow', installMediaHandlers);
  audio.addEventListener('playing', installMediaHandlers);
})();
