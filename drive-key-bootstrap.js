(() => {
  'use strict';
  const KEY = 'parentsPlayerPublicApiKey';
  const URL = 'https://script.google.com/macros/s/AKfycbz_XRJcYb9_2bMZWeX9kDVJkbVxcjH-znPH0yHiUgGiJUXktPxCbClo3WLSLL1NvC5e/exec';
  let pending = null;
  const valid = value => /^AIza[\w-]{20,}$/.test(value || '');
  function googleOrigin(origin) {
    try {
      const u = new window.URL(origin);
      return u.protocol === 'https:' && (u.hostname === 'script.google.com' || u.hostname === 'script.googleusercontent.com' || u.hostname.endsWith('-script.googleusercontent.com'));
    } catch { return false; }
  }
  function attempt() {
    return new Promise((resolve, reject) => {
      const nonce = Array.from(crypto.getRandomValues(new Uint8Array(20)), x => x.toString(16).padStart(2, '0')).join('');
      const frame = document.createElement('iframe');
      frame.hidden = true;
      frame.tabIndex = -1;
      frame.setAttribute('aria-hidden', 'true');
      let timer;
      function finish(error) {
        clearTimeout(timer);
        window.removeEventListener('message', receive);
        frame.remove();
        if (error) reject(error); else resolve(true);
      }
      function receive(event) {
        const d = event.data;
        // The existing key-delivery service runs inside Google's nested sandbox.
        // This app only consumes configuration; it never invokes writer RPCs.
        if (!googleOrigin(event.origin) || !event.source || !d || d.nonce !== nonce) return;
        if (d.type === 'dad-music-config-error') return finish(new Error('연결 설정을 불러오지 못했습니다. 다시 업데이트해 주세요.'));
        if (d.type !== 'dad-music-config' || d.version !== 6 || d.folderId !== '1c7Dj_Dnysp8YSIO4QQqUJ-fLA4nbqTec' || !valid(d.apiKey)) return;
        try { localStorage.setItem(KEY, d.apiKey); }
        catch (error) { return finish(error); }
        finish();
      }
      window.addEventListener('message', receive);
      timer = setTimeout(() => finish(new Error('연결 시간이 초과되었습니다. 인터넷 연결 후 다시 업데이트해 주세요.')), 30000);
      frame.src = URL + '?mode=bridge&nonce=' + encodeURIComponent(nonce);
      document.body.appendChild(frame);
    });
  }
  async function ensureReady() {
    if (valid(localStorage.getItem(KEY))) return true;
    if (pending) return pending;
    if (!navigator.onLine) throw new Error('인터넷에 연결한 후 업데이트해 주세요.');
    pending = (async () => {
      for (let i = 0; i < 2; i += 1) {
        try { return await attempt(); }
        catch (error) { if (!navigator.onLine || i === 1) throw error; }
      }
    })();
    try { return await pending; } finally { pending = null; }
  }
  window.ParentsDriveKey = Object.freeze({ ensureReady });
})();
