// ==UserScript==
// @name         OpenCode Colab - Limit Auto-Switch
// @namespace    opencode-proxy
// @version      1.5.0
// @description  When the OpenCode free limit is hit in Colab: ack the panel so it unassigns its own runtime (google.colab.runtime.unassign), reload the page, wait for the old assignment to disappear, press Ctrl+F9 (Run all - Colab connects to a fresh runtime AND runs the panel cell; API delete / button clicks are fallbacks), and verify a fresh assignment is live. The proxy then boots in OpenCode mode on the fresh session.
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
//
// How the limit signal reaches this script: the Colab kernel's JS runs in a
// cross-origin output iframe (*.colab.googleusercontent.com). Its DOM,
// title and localStorage are invisible from this page, so the panel signals
// with window.top.postMessage({type:'oc-limit-hit', ts, source}) instead
// (see notebooks/colab_panel.py: notify_limit_hit). That is the ONLY
// trigger - scanning this page's DOM for the banner cannot work.

(function () {
  'use strict';

  // ---------------------------------------------------------------- config
  const AUTO_ON_LIMIT = true;        // switch automatically on the panel's limit signal
  const MAX_PER_HOUR = 2;            // loop guard (persisted in localStorage)
  const CONNECT_TIMEOUT_MS = 300000; // give up after 5 min
  const PANEL_GRACE_MS = 25000;      // after reconnect, give run-on-startup this long before clicking Run all ourselves
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
  badge.addEventListener('click', () => { if (confirm('Switch Colab session now? This deletes the current runtime.')) switchNow('badge click', true); });
  (document.body || document.documentElement).appendChild(badge);

  // ------------------------------------------------------------- DOM utils
  const fire = (el) => {
    if (!el) return false;
    for (const type of ['pointerdown', 'mousedown', 'pointerup', 'mouseup', 'click'])
      el.dispatchEvent(new MouseEvent(type, { bubbles: true, composed: true, cancelable: true, view: window }));
    return true;
  };
  // Depth-first search that also descends into shadow roots (incl. root's own).
  const deepFind = (root, pred) => {
    if (!root) return null;
    if (root.nodeType === 1 && pred(root)) return root;
    if (root.shadowRoot) { const hit = deepFind(root.shadowRoot, pred); if (hit) return hit; }
    if (root.querySelectorAll) {
      for (const el of root.querySelectorAll('*')) {
        if (pred(el)) return el;
        if (el.shadowRoot) { const hit = deepFind(el.shadowRoot, pred); if (hit) return hit; }
      }
    }
    return null;
  };
  const clickConnect = () => {
    // colab-connect-button -> (shadow) colab-toolbar-button#connect
    //   -> (shadow) md-text-button#button -> (shadow) button
    // (the sibling #connect-dropdown arrow is a different branch - avoided
    //  by searching only inside #connect)
    const host = document.querySelector('colab-connect-button');
    if (!host) return false;
    const connectEl = deepFind(host, el => el.id === 'connect');
    if (!connectEl) return false; // shadow DOM not rendered yet - caller retries
    const btn = deepFind(connectEl, el => el.tagName === 'BUTTON');
    if (!fire(btn || connectEl)) return false;
    sayBadge('🖱️ clicked Connect - waiting for a new assignment…');
    return true;
  };
  // Ctrl+F9 = Colab's "Run all cells" shortcut. Dispatching the keyboard
  // event is far more robust than clicking through 3 shadow roots, and
  // with no runtime attached Colab connects to a fresh one first - so
  // this one event both reconnects and runs the panel. keyCode/which are
  // legacy read-only props some shortcut handlers still check, so define
  // them explicitly (120 = F9).
  const pressRunAllShortcut = () => {
    const makeKey = (type) => {
      const e = new KeyboardEvent(type, { key: 'F9', code: 'F9', ctrlKey: true, bubbles: true, cancelable: true, composed: true });
      Object.defineProperty(e, 'keyCode', { get: () => 120 });
      Object.defineProperty(e, 'which', { get: () => 120 });
      return e;
    };
    const target = (document.activeElement && document.activeElement !== document.body) ? document.activeElement : document.body;
    target.dispatchEvent(makeKey('keydown'));
    target.dispatchEvent(makeKey('keyup'));
    return true;
  };
  const clickRunAll = async () => {
    // Toolbar first: #toolbar-run-button -> (shadow) md-text-button
    //   -> (shadow) button.
    const runHost = document.querySelector('#toolbar-run-button');
    if (runHost) {
      const btn = deepFind(runHost, el => el.tagName === 'BUTTON');
      if (fire(btn || runHost)) return true;
    }
    // Fallback: Runtime menu -> [command="runall"] (Cmd/Ctrl+F9 equivalent).
    // goog-* menus open on mousedown, which fire() already sends.
    const menuBtn = document.querySelector('#runtime-menu-button');
    if (!menuBtn) return false;
    fire(menuBtn);
    const deadline = Date.now() + 6000;
    while (Date.now() < deadline) {
      const item = document.querySelector('[command="runall"]');
      if (item) return fire(item);
      await sleep(300);
    }
    return false;
  };

  // ------------------------------------------------------- Colab RPC (API)
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
  const listRecords = async () => {
    const data = await rpc('ListAssignments', []);
    const records = [];
    const walk = (v) => {
      if (!Array.isArray(v)) return;
      if (typeof v[0] === 'string' && ID_RE.test(v[0])) records.push(v);
      v.forEach(walk);
    };
    walk(data);
    return records;
  };
  const listIds = async () => [...new Set((await listRecords()).map(r => r[0]))];
  const flatten = (v, out = []) => {
    if (typeof v === 'string') out.push(v);
    else if (Array.isArray(v)) v.forEach(x => flatten(x, out));
    return out;
  };
  // Everything on this page that might mention the current assignment:
  // URL, serialized frontend state (innerHTML), iframe URLs, loaded
  // resource URLs, and storage keys AND values (not just values).
  const pageText = () => {
    const parts = [location.href, document.documentElement?.innerHTML || ''];
    for (const f of document.querySelectorAll('iframe')) parts.push(f.src || '');
    try { for (const e of performance.getEntriesByType('resource')) parts.push(e.name); } catch (e) {}
    for (const store of [localStorage, sessionStorage]) {
      try { for (let i = 0; i < store.length; i++) { const k = store.key(i); parts.push(k, store.getItem(k)); } } catch (e) {}
    }
    return parts.join('\n');
  };
  const pickCurrentAssignment = async () => {
    const records = await listRecords();
    if (!records.length) { console.warn('[auto-switch] ListAssignments returned no assignments'); return null; }
    if (records.length === 1) return records[0][0];
    // Multiple live assignments: only delete one we can tie to THIS
    // notebook/page. When unsure, delete nothing - a wrong delete
    // kills another notebook's VM.
    const text = pageText();
    // (a) the assignment ID itself is mentioned somewhere on the page
    const byId = records.find(r => text.includes(r[0]));
    if (byId) return byId[0];
    // (b) a long record field (e.g. the notebook hash) appears on the page
    const byHash = records.find(r => flatten(r).some(s => s.length >= 40 && text.includes(s)));
    if (byHash) return byHash[0];
    console.warn('[auto-switch] multiple assignments, no page match:', records.map(r => r[0]));
    return null;
  };

  const recentSwitches = () => {
    let a = [];
    try { a = JSON.parse(localStorage.getItem(TIMES) || '[]'); } catch (e) {}
    a = a.filter(t => Date.now() - t < 3600e3);
    localStorage.setItem(TIMES, JSON.stringify(a));
    return a;
  };

  // ------------------------------------------------------------- switching
  // After a reload we expect the OLD assignment to disappear first (the
  // panel unassigns its own runtime on our ack; or we deleted it via the
  // API in the manual path). Do NOT press Ctrl+F9 while the old runtime
  // is still attached - Run all would just re-run the panel on the old,
  // limited kernel. If the old assignment is still there after 40s, the
  // kernel-side unassign evidently did not happen: delete it via the
  // API ourselves as a fallback.
  // Then the reconnect itself: press Ctrl+F9 (Run all). With no runtime
  // attached, Colab connects to a fresh one on its own and then runs
  // the cells - and the panel is the notebook's only code cell, so that
  // one keypress both reconnects and boots the panel. Button clicks
  // through the shadow DOM are the last-resort fallback.
  async function waitForNewAssignment(beforeIds) {
    const deadline = Date.now() + CONNECT_TIMEOUT_MS;
    let current = [];
    // Phase A: wait for the old assignment to go away (or a fresh one
    // to appear, if the switch somehow already happened).
    const goneDeadline = Date.now() + 40000;
    while (Date.now() < goneDeadline) {
      try {
        current = await listIds();
        const fresh = current.filter(id => !beforeIds.includes(id));
        if (fresh.length) { sayBadge('✅ new session live: ' + fresh[0]); return fresh[0]; }
        if (beforeIds.some(id => !current.includes(id))) break; // ours is gone
      } catch (e) { /* backend mid-switch */ }
      await sleep(3000);
    }
    if (beforeIds.length && beforeIds.every(id => current.includes(id))) {
      sayBadge('⚠️ old runtime still assigned - deleting it via API as fallback…');
      try {
        const id = await pickCurrentAssignment();
        if (id) { await rpc('DeleteAssignment', [id]); await sleep(2000); }
      } catch (e) { console.warn('[auto-switch] fallback delete failed:', e.message); }
    }
    // Phase B: Ctrl+F9 until a fresh assignment appears.
    const started = Date.now();
    let lastAction = 0;
    while (Date.now() < deadline) {
      try {
        const fresh = (await listIds()).filter(id => !beforeIds.includes(id));
        if (fresh.length) { sayBadge('✅ new session live: ' + fresh[0]); return fresh[0]; }
      } catch (e) { /* backend mid-switch */ }
      if (Date.now() - lastAction > 10000) {
        let acted = false;
        if (Date.now() - started < 60000) {
          acted = pressRunAllShortcut();
          if (acted) sayBadge('⌨️ pressed Ctrl+F9 (Run all) - Colab connects to a fresh runtime and runs the panel…');
        } else {
          acted = (await clickRunAll()) || clickConnect();
        }
        if (acted) lastAction = Date.now();
      }
      await sleep(3000);
    }
    sayBadge('⚠️ no new assignment after 5 min - click Connect manually');
    return null;
  }

  let switching = false;
  // The MAX_PER_HOUR guard only applies to AUTOMATIC switches: its job is
  // to stop a loop where every fresh session instantly hits the limit
  // again. Manual switches (badge click, __ocAutoSwitch.now(), the
  // panel's Test limit alert button) are a human's explicit choice, so
  // they neither check nor consume the guard's budget.
  async function switchNow(reason, manual = false) {
    if (switching) return;
    if (!manual && recentSwitches().length >= MAX_PER_HOUR) { sayBadge('⚠️ already switched ' + MAX_PER_HOUR + 'x this hour - paused (' + reason + '). Manual: __ocAutoSwitch.reset() clears this'); return; }
    switching = true;
    try {
      sayBadge('🚨 limit hit - finding current assignment… (' + reason + ')');
      const id = await pickCurrentAssignment();
      if (!id) { sayBadge('⚠️ could not identify the current assignment - not deleting anything'); return; }
      sayBadge('🗑️ deleting ' + id + ' then reloading…');
      await rpc('DeleteAssignment', [id]);
      if (!manual) { // only successful automatic deletes count
        const times = recentSwitches(); times.push(Date.now());
        localStorage.setItem(TIMES, JSON.stringify(times));
      }
      sessionStorage.setItem(FLAG, JSON.stringify({ ts: Date.now(), beforeIds: [id] }));
      await sleep(600);
      location.reload(); // phase 2 in main() runs after load (userscript survives)
    } catch (e) {
      sayBadge('❌ switch failed: ' + e.message);
    } finally {
      switching = false;
    }
  }

  // Colab's run-on-startup (autoexec) fires once per notebook *page load*,
  // not per runtime assignment: reconnecting in the same page does not
  // re-run it. Our reload normally makes it fire once the new kernel
  // connects - give it a short grace period, watching the panel cell's
  // prompt ([*] = running, [1] = first cell of the fresh kernel done).
  // If it still has not started, click Run all ourselves: the panel is
  // the notebook's only code cell, so Run all == run the panel.
  async function ensurePanelStarted() {
    const findPanel = () => [...document.querySelectorAll('.cell')]
      .find(c => (c.textContent || '').includes('colab_panel.py'));
    const panelState = () => {
      const panel = findPanel();
      if (!panel) return 'missing';
      const head = (panel.innerText || '').slice(0, 300);
      const count = head.match(/\[\s*(\d+|\*)\s*\]/)?.[1];
      if (count === '*') return 'running';
      if (count === '1') return 'ran';
      return 'idle';
    };
    const graceDeadline = Date.now() + PANEL_GRACE_MS;
    while (Date.now() < graceDeadline) {
      const s = panelState();
      if (s === 'running' || s === 'ran') { sayBadge('✅ panel auto-ran on the new session - proxy is booting'); return; }
      await sleep(2500);
    }
    if (panelState() === 'missing') { sayBadge('⚠️ panel cell not found - run it manually'); return; }
    // Stage 1: keyboard shortcut. Stage 2 (if the panel still has not
    // started 10s later): click the Run all button through its shadow DOM.
    const waitStarted = async (ms) => {
      const deadline = Date.now() + ms;
      while (Date.now() < deadline) {
        const s = panelState();
        if (s === 'running' || s === 'ran') { sayBadge('✅ panel is running on the new session'); return true; }
        await sleep(2500);
      }
      return false;
    };
    pressRunAllShortcut();
    sayBadge('⌨️ panel did not auto-run - pressed Ctrl+F9 (Run all; panel is the only code cell)');
    if (await waitStarted(10000)) return;
    if (await clickRunAll()) {
      sayBadge('▶️ shortcut did not take - clicked the Run all button instead');
      if (await waitStarted(20000)) return;
    }
    sayBadge('⚠️ panel still has not started - press Ctrl+F9 manually');
  }

  // Primary limit path: the panel deletes its OWN runtime. It posts
  // oc-limit-hit and waits for our ack; on the ack it calls
  // google.colab.runtime.unassign() - no guessing which assignment is
  // whose on this side. Our job: ack immediately, snapshot the current
  // assignment IDs (so phase 2 can tell old from fresh), set the reload
  // flag, and reload. If the loop-guard is tripped we do NOT ack, so
  // the panel leaves its runtime alone.
  async function switchViaUnassign(reason, manual = false) {
    if (switching) return;
    if (!manual && recentSwitches().length >= MAX_PER_HOUR) { sayBadge('⚠️ already switched ' + MAX_PER_HOUR + 'x this hour - paused, not acking (' + reason + '). Manual: __ocAutoSwitch.reset() clears this'); return; }
    switching = true;
    try {
      sayBadge('🚨 limit hit - telling the panel to unassign its runtime… (' + reason + ')');
      for (const f of document.querySelectorAll('iframe')) {
        try { f.contentWindow.postMessage({ type: 'oc-limit-ack' }, '*'); } catch (e) {}
      }
      let beforeIds = [];
      try { beforeIds = await listIds(); } catch (e) { /* phase 2 falls back to API delete */ }
      if (!manual) {
        const times = recentSwitches(); times.push(Date.now());
        localStorage.setItem(TIMES, JSON.stringify(times));
      }
      sessionStorage.setItem(FLAG, JSON.stringify({ ts: Date.now(), beforeIds }));
      await sleep(1000); // let the panel see the ack and start unassigning
      location.reload(); // phase 2 in main() runs after load (userscript survives)
    } catch (e) {
      sayBadge('❌ switch failed: ' + e.message);
    } finally {
      switching = false;
    }
  }

  // Panel -> page signal (see header comment). Origin must be the kernel's
  // output frame; ts guards against replayed/stale signals.
  window.addEventListener('message', (e) => {
    let host = '';
    try { host = new URL(e.origin).hostname; } catch (err) {}
    if (!host.endsWith('colab.googleusercontent.com')) return;
    const d = e.data || {};
    if (d.type === 'oc-limit-test') { sayBadge('✅ test signal received from panel (no switch)'); return; }
    if (d.type === 'oc-limit-clear') { sayBadge('✅ panel reports requests working again'); return; }
    if (d.type === 'oc-limit-hit') {
      if (!AUTO_ON_LIMIT) { sayBadge('🔕 limit signal received but AUTO_ON_LIMIT is off'); return; }
      if (d.ts && Date.now() - d.ts > 120000) { sayBadge('⚠️ ignored stale limit signal'); return; }
      switchViaUnassign('postMessage from panel (' + (d.source || '?') + ')', d.test === true);
    }
  });

  // ---------------------------------------------------------------- phases
  async function main() {
    // Phase 2: we just reloaded after a delete -> connect to a fresh
    // runtime, then make sure the panel cell runs on it.
    let flag = null;
    try { flag = JSON.parse(sessionStorage.getItem(FLAG) || 'null'); } catch (e) {}
    if (flag && Date.now() - flag.ts < 600000) {
      sayBadge('🔄 page reloaded - waiting for the old runtime to disappear, then Ctrl+F9…');
      const beforeIds = flag.beforeIds || (flag.deletedId ? [flag.deletedId] : []);
      const got = await waitForNewAssignment(beforeIds);
      if (got) { sessionStorage.removeItem(FLAG); await ensurePanelStarted(); }
      return;
    }

    // Phase 1: idle - the postMessage listener above does the work.
    sayBadge(AUTO_ON_LIMIT ? '🔔 limit auto-switch: watching' : '🔔 limit auto-switch: manual only (badge click or __ocAutoSwitch.now())');
  }

  window.__ocAutoSwitch = {
    now: () => switchNow('manual', true),
    reset: () => { localStorage.removeItem(TIMES); sayBadge('🔔 loop-guard cleared - auto-switch watching again'); },
    debug: async () => {
      const records = await listRecords();
      const text = pageText();
      const info = records.map(r => ({ id: r[0], onThisPage: text.includes(r[0]) }));
      console.log('[auto-switch] assignments:', info);
      sayBadge('🔍 ' + records.length + ' assignment(s): ' + info.map(i => i.id + (i.onThisPage ? ' ← this page' : '')).join(', '));
      return info;
    },
    stop: () => { sayBadge('⏹️ auto-switch stopped for this page'); window.__ocAutoSwitch = null; },
  };
  main();
})();
