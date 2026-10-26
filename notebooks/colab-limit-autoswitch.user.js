// ==UserScript==
// @name         OpenCode Colab - Limit Auto-Switch
// @namespace    opencode-proxy
// @version      1.0.0
// @description  When the OpenCode free limit is hit in Colab: delete the runtime assignment via API, reload the page, wait for it to load, click Connect (through its shadow DOM), and verify a fresh assignment is live. The panel cell (Run on startup) then boots the proxy in OpenCode mode.
// @match        https://colab.research.google.com/*
// @run-at       document-idle
// @grant        none
// @updateURL    https://raw.githubusercontent.com/recursive-factory/opencode-proxy/main/notebooks/colab-limit-autoswitch.user.js
// @downloadURL  https://raw.githubusercontent.com/recursive-factory/opencode-proxy/main/notebooks/colab-limit-autoswitch.user.js
// ==/UserScript==
// Install: Tampermonkey -> Create a new script -> replace all with this file -> Save.
// It lives in the browser, so unlike a pasted console script it survives reloads.
// Manual controls in the page console:  __ocAutoSwitch.now()  /  __ocAutoSwitch.stop()
// Or click the small badge at the bottom-right to switch immediately.

(function () {
  'use strict';

  // ---------------------------------------------------------------- config
  const AUTO_ON_LIMIT = true;        // switch automatically when the panel banner appears
  const MAX_PER_HOUR = 2;            // loop guard (persisted in localStorage)
  const AFTER_LOAD_WAIT_MS = 5000;   // after a reload, wait this long before clicking Connect
  const CONNECT_TIMEOUT_MS = 300000; // give up after 5 min
  const FLAG = 'oc-switch-reload';   // sessionStorage: survives reload, per tab
  const TIMES = 'oc-limit-switch-times';

  const sleep = (ms) => new Promise(r => setTimeout(r, ms));

  // ---------------------------------------------------------------- badge
  const badge = document.createElement('div');
  badge.textContent = '🔔 limit auto-switch: watching';
  badge.title = 'Click to switch session now';
  badge.style.cssText = 'position:fixed;right:12px;bottom:12px;z-index:99999;background:#202124;color:#e8eaed;' +
    'font:12px/1.4 system-ui;padding:6px 10px;border-radius:8px;opacity:.85;cursor:pointer;max-width:320px';
  const sayBadge = (t) => { badge.textContent = t; console.log('[auto-switch]', t); };
  badge.addEventListener('click', () => { if (confirm('Switch Colab session now? This deletes the current runtime.')) switchNow('badge click'); });
  (document.body || document.documentElement).appendChild(badge);

  // ---------------------------------------------------------------- helpers
  const fire = (el) => {
    for (const type of ['pointerdown', 'mousedown', 'pointerup', 'mouseup', 'click'])
      el.dispatchEvent(new MouseEvent(type, { bubbles: true, composed: true, cancelable: true, view: window }));
  };
  const deepFind = (root, pred) => {
    if (!root?.querySelectorAll) return null;
    for (const el of root.querySelectorAll('*')) {
      if (pred(el)) return el;
      if (el.shadowRoot) { const hit = deepFind(el.shadowRoot, pred); if (hit) return hit; }
    }
    return null;
  };
  const clickConnect = () => {
    // colab-connect-button -> (shadow) colab-toolbar-button#connect
    //   -> (shadow) md-text-button#button -> (shadow) button#button
    // (the sibling #connect-dropdown arrow is a different branch - avoided
    //  by searching only inside #connect)
    const host = document.querySelector('colab-connect-button');
    if (!host) return false;
    const toolbar = host.shadowRoot?.querySelector('#connect') || host;
    const btn = deepFind(toolbar.shadowRoot || toolbar, el => el.tagName === 'BUTTON');
    fire(btn || toolbar);
    sayBadge('🖱️ clicked Connect - waiting for a new assignment…');
    return true;
  };

  const cookie = (name) => {
    const hit = document.cookie.split('; ').find(c => c.startsWith(name + '='));
    return hit ? hit.slice(name.length + 1) : null;
  };
  const sha1hex = async (text) => {
    const buf = await crypto.subtle.digest('SHA-1', new TextEncoder().encode(text));
    return [...new Uint8Array(buf)].map(b => b.toString(16).padStart(2, '0')).join('');
  };
  const authHeader = async () => {
    const sapisid = cookie('SAPISID') || cookie('__Secure-3PAPISID') || cookie('APISID');
    if (!sapisid) throw new Error('SAPISID cookie not readable');
    const ts = Math.floor(Date.now() / 1000);
    const hash = await sha1hex(ts + ' ' + sapisid + ' https://colab.research.google.com');
    return 'SAPISIDHASH ' + ts + '_' + hash + ' SAPISID1PHASH ' + ts + '_' + hash + ' SAPISID3PHASH ' + ts + '_' + hash;
  };
  const rpc = async (method, body) => {
    const res = await fetch('https://colab.clients6.google.com/$rpc/google.internal.colab.v1.RuntimeService/' + method, {
      method: 'POST',
      credentials: 'include',
      headers: {
        'content-type': 'application/json+protobuf',
        'x-goog-api-key': 'AIzaSyA2BvntLwNwFthUB4w6_Bhn0cMlVHwyaHc', // Colab web client's public key
        'x-goog-authuser': '0',
        'x-user-agent': 'grpc-web-javascript/0.1',
        'authorization': await authHeader(),
      },
      body: JSON.stringify(body),
    });
    const text = await res.text();
    if (!res.ok) throw new Error(method + ' -> ' + res.status + ' ' + text);
    return JSON.parse(text);
  };

  const ID_RE = /^m-[a-z0-9]+(?:-[a-z0-9]+)+$/;
  const listIds = async () => {
    const data = await rpc('ListAssignments', []);
    const ids = [];
    const walk = (v) => {
      if (!Array.isArray(v)) return;
      if (typeof v[0] === 'string' && ID_RE.test(v[0])) ids.push(v[0]);
      v.forEach(walk);
    };
    walk(data);
    return [...new Set(ids)];
  };
  const flatten = (v, out = []) => {
    if (typeof v === 'string') out.push(v);
    else if (Array.isArray(v)) v.forEach(x => flatten(x, out));
    return out;
  };
  const pickCurrentAssignment = async () => {
    const data = await rpc('ListAssignments', []);
    const records = [];
    const walk = (v) => {
      if (!Array.isArray(v)) return;
      if (typeof v[0] === 'string' && ID_RE.test(v[0])) records.push(v);
      v.forEach(walk);
    };
    walk(data);
    if (!records.length) return null;
    if (records.length === 1) return records[0][0];
    const pageSources = [location.href, ...Object.values(localStorage), ...Object.values(sessionStorage)].join('\n');
    const byHash = records.find(r => flatten(r).some(s => s.length >= 40 && pageSources.includes(s)));
    if (byHash) return byHash[0];
    console.warn('[auto-switch] multiple assignments, no notebook match:', records.map(r => r[0]));
    return null;
  };

  const recentSwitches = () => {
    let a = [];
    try { a = JSON.parse(localStorage.getItem(TIMES) || '[]'); } catch (e) {}
    a = a.filter(t => Date.now() - t < 3600e3);
    localStorage.setItem(TIMES, JSON.stringify(a));
    return a;
  };

  async function waitForNewAssignment(deletedId) {
    const deadline = Date.now() + CONNECT_TIMEOUT_MS;
    let lastClick = 0;
    await sleep(AFTER_LOAD_WAIT_MS); // "once loaded, after a sometime"
    while (Date.now() < deadline) {
      try {
        const fresh = (await listIds()).filter(id => id !== deletedId);
        if (fresh.length) { sayBadge('✅ new session live: ' + fresh[0] + ' - panel autostart is booting the proxy'); return fresh[0]; }
      } catch (e) { /* backend mid-switch */ }
      if (Date.now() - lastClick > 8000) { if (clickConnect()) lastClick = Date.now(); }
      await sleep(3000);
    }
    sayBadge('⚠️ no new assignment after 5 min - click Connect manually');
    return null;
  }

  let switching = false;
  async function switchNow(reason) {
    if (switching) return;
    const times = recentSwitches();
    if (times.length >= MAX_PER_HOUR) { sayBadge('⚠️ already switched ' + times.length + 'x this hour - paused (' + reason + ')'); return; }
    switching = true;
    try {
      sayBadge('🚨 limit hit - finding current assignment… (' + reason + ')');
      const id = await pickCurrentAssignment();
      if (!id) { sayBadge('⚠️ could not identify the current assignment - not deleting anything'); return; }
      times.push(Date.now());
      localStorage.setItem(TIMES, JSON.stringify(times));
      sessionStorage.setItem(FLAG, JSON.stringify({ ts: Date.now(), deletedId: id }));
      sayBadge('🗑️ deleting ' + id + ' then reloading…');
      await rpc('DeleteAssignment', [id]);
      await sleep(600);
      location.reload(); // phase 2 below runs after load (userscript survives)
    } catch (e) {
      sayBadge('❌ switch failed: ' + e.message);
    } finally {
      switching = false;
    }
  }

  // Colab's run-on-startup (autoexec) fires once per notebook *page load*,
  // not per runtime assignment: reconnecting in the same page does not
  // re-run it (the cell keeps its old execution_count). Our reload should
  // make it fire, but do not depend on it - if the panel cell still shows
  // its stale saved count after the new kernel settles, click its run
  // button (deep, through colab-run-button's shadow DOM) ourselves.
  async function ensurePanelStarted() {
    const findPanel = () => [...document.querySelectorAll('.cell')]
      .find(c => (c.textContent || '').includes('colab_panel.py'));
    const deadline = Date.now() + 90000;
    while (Date.now() < deadline) {
      const panel = findPanel();
      if (panel) {
        const head = (panel.innerText || '').slice(0, 300);
        const count = head.match(/\[\s*(\d+|\*)\s*\]/)?.[1];
        if (count === '*' || count === '1') { sayBadge('✅ panel auto-ran on the new session'); return; }
      }
      await sleep(5000);
    }
    if (!findPanel()) { sayBadge('⚠️ panel cell not found - run it manually'); return; }
    // Run all == run the panel: it is the notebook's only code cell, the
    // rest are markdown. First choice: the toolbar's own Run-all button
    // (#toolbar-run-button -> (shadow) md-text-button -> (shadow) button).
    const runHost = document.querySelector('#toolbar-run-button');
    const runBtn = runHost && deepFind(runHost.shadowRoot || runHost, el => el.tagName === 'BUTTON');
    if (runBtn || runHost) {
      fire(runBtn || runHost);
      sayBadge('▶️ panel did not auto-run - clicked the toolbar Run all button');
      return;
    }
    // Fallback: Runtime menu -> [command="runall"] (Cmd/Ctrl+F9 equivalent).
    // goog-* menus open on mousedown, which fire() already sends.
    const menuBtn = document.querySelector('#runtime-menu-button');
    if (!menuBtn) { sayBadge('⚠️ Runtime menu not found - press Cmd/Ctrl+F9 manually'); return; }
    fire(menuBtn);
    const menuDeadline = Date.now() + 6000;
    let item = null;
    while (Date.now() < menuDeadline && !item) {
      item = document.querySelector('[command="runall"]');
      if (!item) await sleep(300);
    }
    if (item) {
      fire(item);
      sayBadge('▶️ panel did not auto-run - invoked Runtime → Run all (only code cell is the panel)');
    } else {
      sayBadge('⚠️ Run all menu item not found - press Cmd/Ctrl+F9 manually');
    }
  }

  // Panel -> page signal: the kernel's JS lives in a cross-origin output
  // frame (*.colab.googleusercontent.com), so its DOM/storage/title are
  // invisible here. It posts {type:'oc-limit-hit'} to window.top instead.
  window.addEventListener('message', (e) => {
    let host = '';
    try { host = new URL(e.origin).hostname; } catch (err) {}
    if (!host.endsWith('colab.googleusercontent.com')) return;
    const d = e.data || {};
    if (d.type === 'oc-limit-test') { sayBadge('✅ test signal received from panel (no switch)'); return; }
    if (d.type === 'oc-limit-clear') { sayBadge('✅ panel reports requests working again'); return; }
    if (d.type === 'oc-limit-hit') {
      if (d.ts && Date.now() - d.ts > 120000) { sayBadge('⚠️ ignored stale limit signal'); return; }
      switchNow('postMessage from panel (' + (d.source || '?') + ')');
    }
  });

  // ---------------------------------------------------------------- phases
  async function main() {
    // Phase 2: we just reloaded after a delete -> connect to a fresh runtime.
    let flag = null;
    try { flag = JSON.parse(sessionStorage.getItem(FLAG) || 'null'); } catch (e) {}
    if (flag && Date.now() - flag.ts < 600000) {
      sayBadge('🔄 page reloaded after delete - connecting in ' + (AFTER_LOAD_WAIT_MS / 1000) + 's…');
      const got = await waitForNewAssignment(flag.deletedId);
      if (got) { sessionStorage.removeItem(FLAG); await ensurePanelStarted(); }
      return;
    }

    // Phase 1: watch for the panel's limit signal (banner text or tab title).
    if (!AUTO_ON_LIMIT) { sayBadge('🔔 limit auto-switch: manual only (badge click or __ocAutoSwitch.now())'); return; }
    const looksLikeLimit = () =>
      document.title.includes('OpenCode limit hit') ||
      (document.body?.innerText || '').includes('OpenCode free limit hit');
    const check = () => { if (looksLikeLimit()) switchNow('limit banner/title'); };
    new MutationObserver(check).observe(document.documentElement, { subtree: true, childList: true, characterData: true });
    setInterval(check, 3000);
    sayBadge('🔔 limit auto-switch: watching');
  }

  window.__ocAutoSwitch = {
    now: () => switchNow('manual'),
    stop: () => { sayBadge('⏹️ auto-switch stopped for this page'); window.__ocAutoSwitch = null; },
  };
  main();
})();
