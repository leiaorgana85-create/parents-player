(() => {
  'use strict';

  const SETTINGS_KEY = 'parentsPlayerSettings';
  const API_KEY_STORAGE = 'parentsPlayerPublicApiKey';
  const TOKEN_KEY = 'parentsPlayerGoogleAccessToken';
  const AUTH_MARKER_KEY = 'parentsPlayerGoogleAuthorized';
  const FORCE_CONSENT_KEY = 'parentsPlayerGoogleForceConsent';
  const PUBLIC_TOKEN = 'parents-player-public-folder';
  const FETCH_PATCH = '__parentsPlayerPublicFetchPatched';
  const DEFAULT_FOLDER_ID = '1LkvFEALAV1penT439jh5NyM7ilsG9TC6';

  const rawFetch = window.fetch.bind(window);

  function apiKey() {
    return String(localStorage.getItem(API_KEY_STORAGE) || '').trim();
  }

  function validKey(value) {
    const key = String(value || '').trim();
    return /^AIza[\w-]{20,}$/.test(key);
  }

  function publicModeEnabled() {
    return validKey(apiKey());
  }

  function primeOauthShim() {
    if (!publicModeEnabled()) return;
    localStorage.setItem(TOKEN_KEY, JSON.stringify({
      token: PUBLIC_TOKEN,
      expiresAt: Date.now() + (3650 * 24 * 60 * 60 * 1000)
    }));
    localStorage.setItem(AUTH_MARKER_KEY, '1');
    localStorage.removeItem(FORCE_CONSENT_KEY);
  }

  function clearOauthShim() {
    try {
      const record = JSON.parse(localStorage.getItem(TOKEN_KEY) || '{}');
      if (record?.token === PUBLIC_TOKEN) localStorage.removeItem(TOKEN_KEY);
    } catch {}
  }

  function patchDriveFetch() {
    if (window[FETCH_PATCH]) return;
    window.fetch = (input, init = {}) => {
      const key = apiKey();
      const rawUrl = typeof input === 'string'
        ? input
        : input instanceof URL
          ? input.href
          : input?.url;

      if (!validKey(key) || !rawUrl) return rawFetch(input, init);

      let url;
      try { url = new URL(rawUrl, location.href); }
      catch { return rawFetch(input, init); }

      if (url.origin !== 'https://www.googleapis.com' || !url.pathname.startsWith('/drive/v3/')) {
        return rawFetch(input, init);
      }

      url.searchParams.set('key', key);
      const inherited = input instanceof Request ? input.headers : undefined;
      const headers = new Headers(init.headers || inherited || {});
      headers.delete('Authorization');
      headers.delete('authorization');
      return rawFetch(url.toString(), { ...init, headers });
    };
    window[FETCH_PATCH] = true;
  }

  function injectApiKeyField() {
    const folderInput = document.getElementById('folderIdInput');
    if (!folderInput || document.getElementById('publicApiKeyInput')) return;

    const label = document.createElement('label');
    label.className = 'field';
    label.innerHTML = '<span>Google Drive API key</span><input id="publicApiKeyInput" type="password" autocomplete="off" spellcheck="false" />';
    folderInput.closest('.field')?.insertAdjacentElement('afterend', label);

    const input = document.getElementById('publicApiKeyInput');
    if (input) input.value = apiKey();

    const oauthLabel = document.getElementById('clientIdInput')?.closest('.field');
    if (oauthLabel) oauthLabel.style.display = 'none';
  }

  function installSaveHandler() {
    const button = document.getElementById('saveSettingsBtn');
    if (!button) return;

    button.addEventListener('click', () => {
      const input = document.getElementById('publicApiKeyInput');
      const next = String(input?.value || '').trim();

      if (next && !validKey(next)) {
        alert('Google Drive API key 형식이 올바르지 않습니다. AIza로 시작하는 키를 확인해 주세요.');
        return;
      }

      if (next) {
        localStorage.setItem(API_KEY_STORAGE, next);
        primeOauthShim();
      } else {
        localStorage.removeItem(API_KEY_STORAGE);
        clearOauthShim();
      }

      const settings = (() => {
        try { return JSON.parse(localStorage.getItem(SETTINGS_KEY) || '{}'); }
        catch { return {}; }
      })();
      if (!settings.folderId) {
        settings.folderId = DEFAULT_FOLDER_ID;
        localStorage.setItem(SETTINGS_KEY, JSON.stringify(settings));
      }

      setTimeout(() => location.reload(), 50);
    }, true);
  }

  function cleanPublicModeCopy() {
    if (!publicModeEnabled()) return;
    const detail = document.getElementById('statusDetail');
    const driveStatus = document.getElementById('driveStorageStatus');
    if (driveStatus) driveStatus.textContent = '연결됨';
    if (!detail || typeof MutationObserver === 'undefined') return;

    const clean = () => {
      const text = detail.textContent || '';
      if (/Google 로그인이 한 번 필요합니다/.test(text)) detail.textContent = 'PLAYLIST 폴더를 확인하고 있습니다.';
      if (/Google 계정을 승인/.test(text)) detail.textContent = 'PLAYLIST 폴더를 확인하고 있습니다.';
    };
    new MutationObserver(clean).observe(detail, { childList: true, characterData: true, subtree: true });
    clean();
  }

  window.ParentsPublicDrive = {
    enabled: publicModeEnabled,
    getApiKey: apiKey,
    clear() {
      localStorage.removeItem(API_KEY_STORAGE);
      clearOauthShim();
    }
  };

  patchDriveFetch();
  primeOauthShim();

  window.addEventListener('DOMContentLoaded', () => {
    injectApiKeyField();
    installSaveHandler();
    cleanPublicModeCopy();
  }, { once: true });
})();
