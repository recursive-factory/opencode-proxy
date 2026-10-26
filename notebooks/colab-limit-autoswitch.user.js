// ==UserScript==
// @name         OpenCode Colab - Limit Auto-Switch
// @namespace    opencode-proxy
// @version      2.0.0
// @description  On the panel's limit signal: ack it (the panel then unassigns its own runtime), reload, wait for the old assignment to disappear, press Ctrl+F9, and wait for the panel to announce it started on the fresh runtime.
// @match        https://colab.research.google.com/*
// @run-at       document-idle
// @grant        none
// @updateURL    https://raw.githubusercontent.com/recursive-factory/opencode-proxy/main/notebooks/colab-limit-autoswitch.user.js
// @downloadURL  https://raw.githubusercontent.com/recursive-factory/opencode-proxy/main/notebooks/colab-limit-autoswitch.user.js
// ==/UserScript==
// Install: Tampermonkey -> Create a new script -> replace all with this file -> Save.
// It lives in the browser, so unlike a pasted console script it survives reloads.
// Console controls: __ocAutoSwitch.reset() (clear loop guard) / .stop()
//
// The whole protocol is postMessage, because the Colab kernel's JS runs in
// a cross-origin output iframe (*.colab.googleusercontent.com) whose DOM,
// title and storage are invisible from this page:
//   panel -> page   {type:'oc-limit-hit', ts, source, test}
//   page  -> panel  {type:'oc-limit-ack'}            (panel then calls
//                     google.colab.runtime.unassign() on itself)
//   panel -> page   {type:'oc-panel-started'}        (panel cell running)
//   panel -> page   {type:'oc-panel-ready'}          (setup+tests+start done)
//   panel -> page   {type:'oc-limit-test'|'oc-limit-clear'}  (badge only)

(function () {
  'use strict';

  const AUTO_ON_LIMIT = true;
  const MAX_PER_HOUR = 2;            // loop guard for AUTOMATIC switches only
  const OLD_GONE_MS = 60000;         // wait for the old assignment to disappear
  const START_TIMEOUT_MS = 300000;   // total patience for the new panel to start
  const FLAG = 'oc-switch-reload';   // sessionStorage: survives reload, per tab
  const TIMES = 'oc-limit-switch-times';

  const sleep = (ms) => new Promise(r => setTimeout(r, ms));

  // ---------------------------------------------------------------- badge
  const badge = document.createElement('div');
  badge.textContent = '🔔 limit auto-switch: watching';
  badge.style.cssText = 'position:fixed;right:12px;bottom:12px;z-index:99999;background:#202124;color:#e8eaed;' +
    'font:12px/1.4 system-ui;padding:6px 10px;border-radius:8px;opacity:.85;max-width:320px';
  const sayBadge = (t) => { badge.textContent = t; console.log('[auto-switch]', t); };
  (document.body || document.documentElement).appendChild(badge);

  // -------------------------------------------- assignment list (verify)
  // Only used to tell old assignments from fresh ones - never to pick a
  // delete target (the kernel deletes its own runtime via unassign()).
  const cookie = (name) => (document.cookie.split('; ').find(c => c.startsWith(name + '=')) || '').slice(name.length + 1) || null;
  const listIds = async () => {
    const sapisid = cookie('SAPISID') || cookie('__Secure-3PAPISID') || cookie('APISID');
    if (!sapisid) throw new Error('SAPISID cookie not readable');
    const ts = Math.floor(Date.now() / 1000);
    const buf = await crypto.subtle.digest('SHA-1', new TextEncoder().encode(ts + ' ' + sapisid + ' https://colab.research.google.com'));
    const hash = [...new Uint8Array(buf)].map(b => b.toString(16).padStart(2, '0')).join('');
    const res = await fetch('https://colab.clients6.google.com/$rpc/google.internal.colab.v1.RuntimeService/ListAssignments', {
      method: 'POST', credentials: 'include',
      headers: { 'content-type': 'application/json+protobuf', 'x-goog-api-key': 'AIzaSyA2BvntLwNwFthUB4w6_Bhn0cMlVHwyaHc', 'x-goog-authuser': '0', 'x-user-agent': 'grpc-web-javascript/0.1', 'authorization': 'SAPISIDHASH ' + ts + '_' + hash },
      body: '[]',
    });
    if (!res.ok) throw new Error('ListAssignments -> ' + res.status);
    const ids = [];
    const walk = (v) => { if (Array.isArray(v)) { if (typeof v[0] === 'string' && /^m-[a-z0-9]+(?:-[a-z0-9]+)+$/.test(v[0])) ids.push(v[0]); v.forEach(walk); } };
    walk(await res.json());
    return [...new Set(ids)];
  };

  // ---------------------------------------------------------- Ctrl+F9 key
  // Run all cells. With no runtime attached Colab connects to a fresh one
  // first, so this both reconnects and runs the panel (the notebook's
  // only code cell). keyCode/which: legacy props some handlers still read.
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

  // ------------------------------------------------------------ loop guard
  const recentSwitches = () => {
    let a = [];
    try { a = JSON.parse(localStorage.getItem(TIMES) || '[]'); } catch (e) {}
    a = a.filter(t => Date.now() - t < 3600e3);
    localStorage.setItem(TIMES, JSON.stringify(a));
    return a;
  };

  // ------------------------------------------------------- panel signalling
  let startedAt = 0; // last oc-panel-started from the current page lifetime

  // Phase 1: limit hit -> ack (panel unassigns itself) -> reload.
  let switching = false;
  async function onLimitHit(d) {
    if (switching) return;
    const manual = d.test === true; // panel's Test button / human-triggered
    if (!manual && recentSwitches().length >= MAX_PER_HOUR) {
      sayBadge('⚠️ already switched ' + MAX_PER_HOUR + 'x this hour - paused, not acking. __ocAutoSwitch.reset() clears');
      return; // no ack -> panel leaves its runtime alone
    }
    switching = true;
    try {
      sayBadge('🚨 limit hit - telling the panel to unassign its runtime… (' + (d.source || '?') + ')');
      for (const f of document.querySelectorAll('iframe')) {
        try { f.contentWindow.postMessage({ type: 'oc-limit-ack' }, '*'); } catch (e) {}
      }
      let beforeIds = [];
      try { beforeIds = await listIds(); } catch (e) {}
      if (!manual) {
        const times = recentSwitches(); times.push(Date.now());
        localStorage.setItem(TIMES, JSON.stringify(times));
      }
      sessionStorage.setItem(FLAG, JSON.stringify({ ts: Date.now(), beforeIds }));
      await sleep(1000); // let the panel see the ack and start unassigning
      location.reload();
    } catch (e) {
      sayBadge('❌ switch failed: ' + e.message);
      switching = false;
    }
  }

  window.addEventListener('message', (e) => {
    let host = '';
    try { host = new URL(e.origin).hostname; } catch (err) {}
    if (!host.endsWith('colab.googleusercontent.com')) return;
    const d = e.data || {};
    if (d.type === 'oc-limit-test') { sayBadge('✅ test signal received from panel (no switch)'); return; }
    if (d.type === 'oc-limit-clear') { sayBadge('✅ panel reports requests working again'); return; }
    if (d.type === 'oc-panel-started') {
      startedAt = Date.now();
      if (sessionStorage.getItem(FLAG)) sayBadge('✅ panel started on the new session - proxy is booting…');
      return;
    }
    if (d.type === 'oc-panel-ready') {
      if (sessionStorage.getItem(FLAG)) { sessionStorage.removeItem(FLAG); sayBadge('✅ panel ready on the new session - proxy is up'); }
      return;
    }
    if (d.type === 'oc-limit-hit') {
      if (!AUTO_ON_LIMIT) { sayBadge('🔕 limit signal received but AUTO_ON_LIMIT is off'); return; }
      if (d.ts && Date.now() - d.ts > 120000) { sayBadge('⚠️ ignored stale limit signal'); return; }
      onLimitHit(d);
    }
  });

  const waitStarted = async (deadline) => {
    while (Date.now() < deadline) {
      if (startedAt) return true;
      await sleep(2000);
    }
    return !!startedAt;
  };

  // Phase 2 (after reload): wait for the old assignment to vanish, give
  // run-on-startup a chance, then Ctrl+F9 until the panel announces itself.
  async function reconnect(beforeIds) {
    sayBadge('🔄 page reloaded - waiting for the old runtime to disappear…');
    const goneDeadline = Date.now() + OLD_GONE_MS;
    while (Date.now() < goneDeadline) {
      if (await waitStarted(Date.now())) return; // panel already up (fast path)
      try {
        const now = await listIds();
        if (now.some(id => !beforeIds.includes(id)) || beforeIds.some(id => !now.includes(id))) break;
      } catch (e) { break; } // cannot verify - proceed anyway
      await sleep(3000);
    }
    if (await waitStarted(Date.now() + 20000)) return; // run-on-startup did it
    const deadline = Date.now() + START_TIMEOUT_MS;
    while (Date.now() < deadline) {
      pressRunAll();
      sayBadge('⌨️ pressed Ctrl+F9 - connecting to a fresh runtime and running the panel…');
      if (await waitStarted(Date.now() + 45000)) return;
    }
    sayBadge('⚠️ panel did not start after 5 min - press Ctrl+F9 manually');
  }

  async function main() {
    let flag = null;
    try { flag = JSON.parse(sessionStorage.getItem(FLAG) || 'null'); } catch (e) {}
    if (flag && Date.now() - flag.ts < 600000) { await reconnect(flag.beforeIds || []); return; }
    sayBadge(AUTO_ON_LIMIT ? '🔔 limit auto-switch: watching' : '🔔 limit auto-switch: manual only');
  }

  window.__ocAutoSwitch = {
    reset: () => { localStorage.removeItem(TIMES); sayBadge('🔔 loop-guard cleared - watching again'); },
    stop: () => { sayBadge('⏹️ auto-switch stopped for this page'); window.__ocAutoSwitch = null; },
  };
  main();
})();
