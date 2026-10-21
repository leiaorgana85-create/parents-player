(() => {
  'use strict';

  const audio = document.getElementById('audio');
  const playBtn = document.getElementById('playBtn');
  const trackList = document.getElementById('trackList');

  function setPlayerState(state) {
    if (!playBtn) return;
    playBtn.textContent = '';
    playBtn.dataset.state = state;
    playBtn.setAttribute('aria-label', state === 'pause' ? '일시정지' : '재생');
  }

  if (audio && playBtn) {
    setPlayerState(audio.paused ? 'play' : 'pause');
    audio.addEventListener('play', () => setPlayerState('pause'));
    audio.addEventListener('pause', () => setPlayerState('play'));
    audio.addEventListener('ended', () => setPlayerState('play'));
  }

  function simplifyTrackRows() {
    if (!trackList) return;

    trackList.querySelectorAll('.track-row').forEach(row => {
      const mark = row.querySelector('.offline-mark');
      const meta = row.querySelector('.track-meta');
      if (!mark || !meta) return;

      const state = mark.textContent.trim();
      const saved = state === '✓';
      row.classList.toggle('offline-current', saved);

      if (saved) {
        meta.hidden = true;
        mark.setAttribute('aria-label', '오프라인 저장됨');
      } else if (state === '!') {
        meta.hidden = false;
        if (meta.textContent !== '업데이트 필요 · 저장된 이전 파일 있음') {
          meta.textContent = '업데이트 필요 · 저장된 이전 파일 있음';
        }
        mark.setAttribute('aria-label', '업데이트 필요');
      } else {
        meta.hidden = false;
        if (meta.textContent !== '다운로드 필요') meta.textContent = '다운로드 필요';
        mark.setAttribute('aria-label', '다운로드 필요');
      }
    });
  }

  if (trackList) {
    simplifyTrackRows();
    new MutationObserver(simplifyTrackRows).observe(trackList, {
      childList: true,
      subtree: true,
      characterData: true
    });
  }

  if (!document.querySelector('script[data-fullscreen-now-playing="1"]')) {
    const script = document.createElement('script');
    script.src = './now-playing-fullscreen.js?v=1';
    script.defer = true;
    script.dataset.fullscreenNowPlaying = '1';
    document.head.appendChild(script);
  }
})();
