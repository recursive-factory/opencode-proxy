// ==UserScript==
// @name         OpenCode Colab - Limit Auto-Switch
// @namespace    opencode-proxy
// @version      3.0.0
// @description  On the panel's limit signal, reload the page, wait, and press Ctrl+F9. The panel unassigns its own runtime. Stop when the new panel posts oc-panel-started.
// @match        https://colab.research.google.com/*
// @run-at       document-idle
// @grant        none
// @updateURL    https://raw.githubusercontent.com/recursive-factory/opencode-proxy/main/notebooks/colab-limit-autoswitch.user.js
// @downloadURL  https://raw.githubusercontent.com/recursive-factory/opencode-proxy/main/notebooks/colab-limit-autoswitch.user.js
// ==/UserScript==
// Install: Tampermonkey -> Create a new script -> replace all with this file -> Save.
// Console: __ocAutoSwitch.stop()
//
// Kernel JS runs in a cross-origin iframe, so the only channel is postMessage:
//   panel -> page   {type:'oc-limit-hit'}     then the panel calls runtime.unassign()
//   panel -> page   {type:'oc-panel-started'} panel cell is running on this kernel

(function () {
  'use strict';

  const WAIT_MS = 8000;          // after reload, let the old runtime finish dying
  const RETRY_MS = 15000;        // press Ctrl+F9 again if the panel has not started
  const START_TIMEOUT_MS = 300000;
  const FLAG = 'oc-switch-reload';

  const sleep = (ms) => new Promise(r => setTimeout(r, ms));

  const badge = document.createElement('div');
  badge.textContent = '🔔 limit auto-switch: watching';
  badge.style.cssText = 'position:fixed;right:12px;bottom:12px;z-index:99999;background:#202124;color:#e8eaed;' +
    'font:12px/1.4 system-ui;padding:6px 10px;border-radius:8px;opacity:.85;max-width:320px';
  const sayBadge = (t) => { badge.textContent = t; console.log('[auto-switch]', t); };
  (document.body || document.documentElement).appendChild(badge);

  const pressRunAll = () => {
    const makeKey = (type) => {
      const e = new KeyboardEvent(type, { key: 'F9', code: 'F9', ctrlKey: true, bubbles: true, cancelable: true, composed: true });
      Object.defineProperty(e, 'keyCode', { get: () => 120 });
      Object.defineProperty(e, 'which', { get: () => 120 });
      return e;
    };
    const target = (document.activeElement && document.activeElement !== document.body) ? document.activeElement : document.body;
    target.dispatchEvent(makeKey('keydown'));
    target.dispatchEvent(makeKey('keyup'));
  };

  let started = false;
  let switching = false;

  function onLimitHit() {
    if (switching || sessionStorage.getItem(FLAG)) return;
    switching = true;
    sessionStorage.setItem(FLAG, String(Date.now()));
    sayBadge('🚨 limit hit - reloading…');
    setTimeout(() => location.reload(), 500);
  }

  window.addEventListener('message', (e) => {
    let host = '';
    try { host = new URL(e.origin).hostname; } catch (err) {}
    if (!host.endsWith('colab.googleusercontent.com')) return;
    const d = e.data || {};
    if (d.type === 'oc-limit-hit') {
      if (d.ts && Date.now() - d.ts > 120000) { sayBadge('⚠️ ignored stale limit signal'); return; }
      onLimitHit();
    } else if (d.type === 'oc-panel-started' && sessionStorage.getItem(FLAG)) {
      started = true;
      sessionStorage.removeItem(FLAG);
      sayBadge('✅ panel started on the new session');
    }
  });

  async function reconnect() {
    sayBadge('🔄 page reloaded - Ctrl+F9 in ' + (WAIT_MS / 1000) + 's…');
    await sleep(WAIT_MS);
    const deadline = Date.now() + START_TIMEOUT_MS;
    while (!started && Date.now() < deadline) {
      pressRunAll();
      sayBadge('⌨️ pressed Ctrl+F9 - waiting for the panel to start…');
      const until = Date.now() + RETRY_MS;
      while (!started && Date.now() < until) await sleep(1000);
    }
    if (!started) sayBadge('⚠️ panel did not start - press Ctrl+F9 manually');
  }

  window.__ocAutoSwitch = {
    stop: () => { sessionStorage.removeItem(FLAG); sayBadge('⏹️ auto-switch stopped for this page'); },
  };

  if (sessionStorage.getItem(FLAG) && Date.now() - Number(sessionStorage.getItem(FLAG)) < 600000) reconnect();
  else sayBadge('🔔 limit auto-switch: watching');
})();
