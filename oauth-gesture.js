(() => {
  'use strict';

  const OLD_CLIENT_ID = '543436064136-27a477uk691qocpaft25q925lg88hl98.apps.googleusercontent.com';
  const DEFAULT_CLIENT_ID = '620289818773-nsdjjvi232l5n9v10ec6bdee3kp0jb8l.apps.googleusercontent.com';
  const OLD_FOLDER_ID = '1UwItRZzBt3fMKfLvaHqhoipzhCvmyUZ6';
  const NEW_FOLDER_ID = '1LkvFEALAV1penT439jh5NyM7ilsG9TC6';
  const SETTINGS_KEY = 'parentsPlayerSettings';
  const TOKEN_KEY = 'parentsPlayerGoogleAccessToken';
  const AUTH_MARKER_KEY = 'parentsPlayerGoogleAuthorized';
  const FORCE_CONSENT_KEY = 'parentsPlayerGoogleForceConsent';
  const GOOGLE_SCRIPT_SELECTOR = 'script[data-google-identity]';
  const CACHED_BRIDGE_MARKER = '__parentsPlayerCachedBridge';
  const DRIVE_SCOPE = 'https://www.googleapis.com/auth/drive.readonly';

  let originalInitTokenClient = null;
  let googleReady = false;
  let googleLoading = false;
  let authInFlight = false;
  let retryTimer = null;

  function safeJsonParse(value, fallback = null) {
    try { return JSON.parse(value); } catch { return fallback; }
  }

  function normalizedClientId(value) {
    const clientId = String(value || '').trim();
    return !clientId || clientId === OLD_CLIENT_ID ? DEFAULT_CLIENT_ID : clientId;
  }

  function normalizedFolderId(value) {
    const folderId = String(value || '').trim();
    return !folderId || folderId === OLD_FOLDER_ID ? NEW_FOLDER_ID : folderId;
  }

  function currentClientId() {
    const current = safeJsonParse(localStorage.getItem(SETTINGS_KEY), {}) || {};
    return normalizedClientId(current.clientId);
  }

  function migrateSettings() {
    const current = safeJsonParse(localStorage.getItem(SETTINGS_KEY), {}) || {};
    const clientId = normalizedClientId(current.clientId);
    const folderId = normalizedFolderId(current.folderId);
    const oauthChanged = current.clientId !== clientId;
    const changed = oauthChanged || current.folderId !== folderId;

    if (changed) {
      current.clientId = clientId;
      current.folderId = folderId;
      localStorage.setItem(SETTINGS_KEY, JSON.stringify(current));
    }
    if (oauthChanged) {
      localStorage.removeItem(TOKEN_KEY);
      localStorage.removeItem(AUTH_MARKER_KEY);
      localStorage.removeItem(FORCE_CONSENT_KEY);
    }
  }

  function readCachedToken() {
    const record = safeJsonParse(localStorage.getItem(TOKEN_KEY), null);
    if (!record?.token || !Number.isFinite(record.expiresAt)) return null;
    if (record.expiresAt <= Date.now() + 60_000) {
      localStorage.removeItem(TOKEN_KEY);
      return null;
    }
    return record;
  }

  function saveToken(response) {
    if (!response?.access_token) return;
    const seconds = Math.max(60, Number(response.expires_in || 3600));
    localStorage.setItem(TOKEN_KEY, JSON.stringify({
      token: response.access_token,
      expiresAt: Date.now() + (seconds * 1000)
    }));
    localStorage.setItem(AUTH_MARKER_KEY, '1');
    localStorage.removeItem(FORCE_CONSENT_KEY);
  }

  function clearToken() {
    localStorage.removeItem(TOKEN_KEY);
  }

  function setStatus(title, detail = '') {
    const titleEl = document.getElementById('statusTitle');
    const detailEl = document.getElementById('statusDetail');
    if (titleEl) titleEl.textContent = title;
    if (detailEl) detailEl.textContent = detail;
  }

  function setSyncReady(ready) {
    const button = document.getElementById('syncBtn');
    if (!button || !navigator.onLine) return;
    button.disabled = !ready;
  }

  function hasCachedBridge() {
    return window.google?.accounts?.oauth2?.[CACHED_BRIDGE_MARKER] === true;
  }

  function clearCachedBridge() {
    if (!hasCachedBridge()) return;
    try { delete window.google.accounts.oauth2; }
    catch { window.google.accounts.oauth2 = undefined; }
  }

  function installCachedTokenBridge() {
    const cached = readCachedToken();
    if (!cached) return false;
    if (window.google?.accounts?.oauth2 && !hasCachedBridge()) return false;

    window.google = window.google || {};
    window.google.accounts = window.google.accounts || {};
    window.google.accounts.oauth2 = {
      [CACHED_BRIDGE_MARKER]: true,
      initTokenClient(config = {}) {
        return {
          requestAccessToken(options = {}) {
            const record = readCachedToken();
            const explicitConsent = options?.prompt === 'consent';
            if (record && !explicitConsent) {
              queueMicrotask(() => config.callback?.({
                access_token: record.token,
                expires_in: Math.max(1, Math.floor((record.expiresAt - Date.now()) / 1000)),
                scope: DRIVE_SCOPE,
                token_type: 'Bearer'
              }));
              return;
            }

            clearToken();
            localStorage.setItem(FORCE_CONSENT_KEY, '1');
            queueMicrotask(() => config.callback?.({
              error: 'interaction_required',
              error_description: 'Google Drive authorization needs renewal.'
            }));
          }
        };
      }
    };
    return true;
  }

  function clearRetryTimer() {
    if (retryTimer) clearTimeout(retryTimer);
    retryTimer = null;
  }

  function removeFailedGoogleScript() {
    const script = document.querySelector(GOOGLE_SCRIPT_SELECTOR);
    if (script && (!window.google?.accounts?.oauth2 || hasCachedBridge())) script.remove();
  }

  function patchGoogleTokenClient() {
    googleLoading = false;
    clearRetryTimer();
    if (hasCachedBridge()) return;
    if (!window.google?.accounts?.oauth2?.initTokenClient) return;
    if (googleReady) {
      setSyncReady(true);
      return;
    }

    originalInitTokenClient = window.google.accounts.oauth2.initTokenClient.bind(window.google.accounts.oauth2);
    window.google.accounts.oauth2.initTokenClient = config => {
      return {
        requestAccessToken(options = {}) {
          const cached = readCachedToken();
          const explicitConsent = options?.prompt === 'consent';

          if (cached && !explicitConsent) {
            queueMicrotask(() => config.callback?.({
              access_token: cached.token,
              expires_in: Math.max(1, Math.floor((cached.expiresAt - Date.now()) / 1000)),
              scope: DRIVE_SCOPE,
              token_type: 'Bearer'
            }));
            return;
          }

          clearToken();
          localStorage.setItem(FORCE_CONSENT_KEY, '1');
          queueMicrotask(() => config.callback?.({
            error: 'interaction_required',
            error_description: 'Google Drive authorization must be started from the Update button.'
          }));
        }
      };
    };

    googleReady = true;
    setSyncReady(true);
  }

  function scheduleQuietRetry() {
    clearRetryTimer();
    if (!navigator.onLine || document.visibilityState === 'hidden' || googleReady || readCachedToken()) return;
    retryTimer = setTimeout(() => {
      retryTimer = null;
      loadGoogleIdentity(false, false);
    }, 1500);
  }

  function loadGoogleIdentity(announceFailure = false, allowRetry = true) {
    if (window.google?.accounts?.oauth2 && !hasCachedBridge()) {
      patchGoogleTokenClient();
      return;
    }
    if (googleLoading) return;

    clearCachedBridge();
    removeFailedGoogleScript();
    let script = document.querySelector(GOOGLE_SCRIPT_SELECTOR);
    if (!script) {
      script = document.createElement('script');
      script.src = 'https://accounts.google.com/gsi/client';
      script.async = true;
      script.defer = true;
      script.dataset.googleIdentity = '1';
      document.head.appendChild(script);
    }

    googleLoading = true;
    script.addEventListener('load', patchGoogleTokenClient, { once: true });
    script.addEventListener('error', () => {
      googleLoading = false;
      googleReady = false;
      originalInitTokenClient = null;
      removeFailedGoogleScript();
      setSyncReady(true);
      if (announceFailure) {
        setStatus('Google 로그인 준비 중…', '연결을 다시 준비하고 있습니다. 잠시 후 불경 업데이트를 다시 눌러 주세요.');
      }
      if (allowRetry) scheduleQuietRetry();
    }, { once: true });
  }

  function requestTokenFromDirectTap() {
    if (!originalInitTokenClient || authInFlight) return;
    authInFlight = true;

    const button = document.getElementById('syncBtn');
    if (button) button.disabled = true;
    setStatus('Google Drive 연결 중…', '처음 한 번만 Google 계정을 승인해 주세요.');

    const previouslyAuthorized = localStorage.getItem(AUTH_MARKER_KEY) === '1';
    const forceConsent = localStorage.getItem(FORCE_CONSENT_KEY) === '1';
    const prompt = (!previouslyAuthorized || forceConsent) ? 'consent' : '';

    const client = originalInitTokenClient({
      client_id: currentClientId(),
      scope: DRIVE_SCOPE,
      callback: response => {
        authInFlight = false;
        if (button) button.disabled = false;

        if (response?.error || !response?.access_token) {
          localStorage.setItem(FORCE_CONSENT_KEY, '1');
          setStatus('Google Drive 연결이 필요합니다', '불경 업데이트를 다시 눌러 Google 계정을 연결해 주세요.');
          return;
        }

        saveToken(response);
        installCachedTokenBridge();
        setStatus('Google Drive 연결 완료', '불경을 확인하고 있습니다…');
        setTimeout(() => button?.click(), 0);
      },
      error_callback: error => {
        authInFlight = false;
        if (button) button.disabled = false;
        localStorage.setItem(FORCE_CONSENT_KEY, '1');
        const message = String(error?.message || error?.type || 'Google 로그인 창을 열지 못했습니다.');
        setStatus('Google Drive 연결을 완료하지 못했습니다', message);
      }
    });

    client.requestAccessToken({ prompt });
  }

  function installSettingsGuard() {
    const saveButton = document.getElementById('saveSettingsBtn');
    const clientInput = document.getElementById('clientIdInput');
    const folderInput = document.getElementById('folderIdInput');
    if (!saveButton) return;

    saveButton.addEventListener('click', () => {
      if (clientInput) clientInput.value = normalizedClientId(clientInput.value);
      if (folderInput) folderInput.value = normalizedFolderId(folderInput.value);
    }, true);
  }

  function installTapGuard() {
    const button = document.getElementById('syncBtn');
    if (!button) return;

    button.addEventListener('click', event => {
      if (!navigator.onLine || readCachedToken()) return;
      if (!googleReady || !originalInitTokenClient) {
        event.preventDefault();
        event.stopImmediatePropagation();
        setStatus('Google 로그인 준비 중…', 'Google 연결을 다시 준비하고 있습니다.');
        setSyncReady(false);
        loadGoogleIdentity(true, true);
        return;
      }

      event.preventDefault();
      event.stopImmediatePropagation();
      requestTokenFromDirectTap();
    }, true);
  }

  function quietPreload() {
    if (!navigator.onLine || googleReady || googleLoading) return;
    if (readCachedToken()) {
      installCachedTokenBridge();
      setSyncReady(true);
      return;
    }
    loadGoogleIdentity(false, true);
  }

  migrateSettings();
  installCachedTokenBridge();

  window.addEventListener('DOMContentLoaded', () => {
    installSettingsGuard();
    installTapGuard();
    if (navigator.onLine) {
      setSyncReady(true);
      quietPreload();
    }
  }, { once: true });

  window.addEventListener('online', () => {
    setSyncReady(true);
    quietPreload();
  });

  window.addEventListener('pageshow', quietPreload);
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible') quietPreload();
  });
})();
