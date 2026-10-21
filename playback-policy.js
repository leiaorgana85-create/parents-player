(() => {
  'use strict';

  const audio = document.getElementById('audio');
  if (!audio) return;

  const POSITION_KEY = 'parentsPlayerPositions';
  try { localStorage.removeItem(POSITION_KEY); } catch {}

  // Parents Player should start a newly selected/loaded track from 0:00.
  // Pause/play on the currently loaded track is unaffected because it does
  // not reload metadata.
  const originalGetItem = Storage.prototype.getItem;
  const originalSetItem = Storage.prototype.setItem;
  Storage.prototype.getItem = function patchedGetItem(key) {
    if (this === localStorage && String(key) === POSITION_KEY) return null;
    return originalGetItem.call(this, key);
  };
  Storage.prototype.setItem = function patchedSetItem(key, value) {
    if (this === localStorage && String(key) === POSITION_KEY) return;
    return originalSetItem.call(this, key, value);
  };

  audio.addEventListener('loadedmetadata', () => {
    setTimeout(() => {
      try {
        if (audio.currentTime !== 0) audio.currentTime = 0;
      } catch {}
    }, 0);
  });
})();
