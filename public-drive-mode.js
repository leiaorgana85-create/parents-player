(() => {
  'use strict';
  const SETTINGS_KEY = 'parentsPlayerSettings';
  const KEY_NAME = 'parentsPlayerPublicApiKey';
  const rawFetch = window.fetch.bind(window);

  function apiKey() {
    return String(localStorage.getItem(KEY_NAME) || '').trim();
  }

  function folderId() {
    try {
      const s = JSON.parse(localStorage.getItem(SETTINGS_KEY) || '{}');
      return String(s.folderId || '1LkvFEALAV1penT439jh5NyM7ilsG9TC6').trim();
    } catch {
      return '1LkvFEALAV1penT439jh5NyM7ilsG9TC6';
    }
  }

  window.ParentsPublicDrive = {
    enabled: () => !!apiKey(),
    folderId,
    setApiKey: value => localStorage.setItem(KEY_NAME, String(value || '').trim()),
    clearApiKey: () => localStorage.removeItem(KEY_NAME)
  };

  window.fetch = (input, init = {}) => {
    const key = apiKey();
    const raw = typeof input === 'string' ? input : input?.url;
    if (!key || !raw) return rawFetch(input, init);

    let url;
    try { url = new URL(raw, location.href); } catch { return rawFetch(input, init); }
    if (url.origin !== 'https://www.googleapis.com' || !url.pathname.startsWith('/drive/v3/')) {
      return rawFetch(input, init);
    }

    url.searchParams.set('key', key);
    const headers = new Headers(init.headers || (input instanceof Request ? input.headers : undefined));
    headers.delete('Authorization');
    return rawFetch(url.toString(), { ...init, headers });
  };
})();
