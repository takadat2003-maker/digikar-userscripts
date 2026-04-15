// ==UserScript==
// @name         Bridging Autopilot V3
// @namespace    http://tampermonkey.net/
// @version      3.1.0
// @description  Bridge payload を参照して Autopilot 状態を表示・制御する（frontWaiting 検出フォールバック対応版）
// @match        *://*/*
// @grant        none
// ==/UserScript==

(function () {
  'use strict';

  const CONFIG = {
    storageKey: 'tmBridgeAutopilotFeedV1',
    uiStateKey: 'tmBridgeAutopilotV3UiState',
    autopilotStateKey: 'tmBridgeAutopilotV3Enabled',
    pollIntervalMs: 1200
  };

  let panelEl = null;
  let lines = null;
  let minimized = false;
  let autopilotEnabled = loadAutopilotEnabled();

  function loadAutopilotEnabled() {
    try {
      return localStorage.getItem(CONFIG.autopilotStateKey) === '1';
    } catch (_e) {
      return false;
    }
  }

  function saveAutopilotEnabled(value) {
    autopilotEnabled = !!value;
    try {
      localStorage.setItem(CONFIG.autopilotStateKey, autopilotEnabled ? '1' : '0');
    } catch (_e) {
      // noop
    }
  }

  function readBridgePayload() {
    const raw = localStorage.getItem(CONFIG.storageKey);
    if (!raw) {
      return null;
    }

    try {
      return JSON.parse(raw);
    } catch (e) {
      console.warn('[Bridge V3] payload parse failed', e);
      return null;
    }
  }

  function resolveCounts(payload) {
    const frontWaitingFromCounts = Number(payload?.counts?.frontWaiting || 0);
    const middleWaitingFromCounts = Number(payload?.counts?.middleWaiting || 0);
    const returnGroup = Number(payload?.counts?.returnGroup || 0);

    const frontWaitingFallback = Array.isArray(payload?.patients?.frontWaiting)
      ? payload.patients.frontWaiting.length
      : 0;

    const middleWaitingFallback = Array.isArray(payload?.patients?.middleWaiting)
      ? payload.patients.middleWaiting.length
      : 0;

    const frontWaiting = frontWaitingFromCounts > 0 ? frontWaitingFromCounts : frontWaitingFallback;
    const middleWaiting = middleWaitingFromCounts > 0 ? middleWaitingFromCounts : middleWaitingFallback;

    console.log('[Bridge V3 payload]', payload);
    console.log('[Bridge V3 counts]', { frontWaiting, middleWaiting, returnGroup });
    if (!payload || !payload.counts) {
      console.warn('[Bridge V3] payload missing or invalid');
    }

    return {
      frontWaiting,
      middleWaiting,
      returnGroup,
      frontWaitingFromCounts,
      middleWaitingFromCounts,
      frontWaitingFallback,
      middleWaitingFallback
    };
  }

  function loadUiState() {
    const defaults = {
      top: 24,
      right: 24,
      minimized: false
    };

    try {
      const raw = localStorage.getItem(CONFIG.uiStateKey);
      if (!raw) return defaults;
      const parsed = JSON.parse(raw);
      return {
        top: Number.isFinite(parsed.top) ? parsed.top : defaults.top,
        right: Number.isFinite(parsed.right) ? parsed.right : defaults.right,
        minimized: !!parsed.minimized
      };
    } catch (_e) {
      return defaults;
    }
  }

  function saveUiState(state) {
    try {
      localStorage.setItem(CONFIG.uiStateKey, JSON.stringify(state));
    } catch (_e) {
      // noop
    }
  }

  function buildPanel() {
    const state = loadUiState();
    minimized = state.minimized;

    panelEl = document.createElement('div');
    panelEl.id = 'tm-bridge-autopilot-v3-panel';
    panelEl.style.position = 'fixed';
    panelEl.style.top = `${state.top}px`;
    panelEl.style.right = `${state.right}px`;
    panelEl.style.zIndex = '2147483647';
    panelEl.style.background = 'rgba(20,20,20,.9)';
    panelEl.style.color = '#fff';
    panelEl.style.padding = '8px';
    panelEl.style.borderRadius = '8px';
    panelEl.style.minWidth = '220px';
    panelEl.style.fontSize = '12px';
    panelEl.style.fontFamily = 'system-ui, sans-serif';
    panelEl.style.boxShadow = '0 2px 10px rgba(0,0,0,.25)';

    const header = document.createElement('div');
    header.style.display = 'flex';
    header.style.alignItems = 'center';
    header.style.justifyContent = 'space-between';
    header.style.gap = '6px';
    header.style.cursor = 'move';

    const title = document.createElement('strong');
    title.textContent = 'Bridging Autopilot V3';

    const btnWrap = document.createElement('div');
    btnWrap.style.display = 'flex';
    btnWrap.style.gap = '6px';

    const toggleBtn = document.createElement('button');
    toggleBtn.type = 'button';
    toggleBtn.style.fontSize = '11px';
    toggleBtn.style.cursor = 'pointer';

    const minimizeBtn = document.createElement('button');
    minimizeBtn.type = 'button';
    minimizeBtn.textContent = minimized ? '＋' : '−';
    minimizeBtn.style.fontSize = '11px';
    minimizeBtn.style.cursor = 'pointer';

    btnWrap.appendChild(toggleBtn);
    btnWrap.appendChild(minimizeBtn);
    header.appendChild(title);
    header.appendChild(btnWrap);

    const body = document.createElement('div');
    body.style.marginTop = '8px';
    body.style.display = minimized ? 'none' : 'block';

    const l1 = document.createElement('div');
    const l2 = document.createElement('div');
    const l3 = document.createElement('div');

    body.appendChild(l1);
    body.appendChild(l2);
    body.appendChild(l3);

    panelEl.appendChild(header);
    panelEl.appendChild(body);
    document.body.appendChild(panelEl);

    function updateToggleLabel() {
      toggleBtn.textContent = autopilotEnabled ? 'Autopilot ON' : 'Autopilot OFF';
    }

    toggleBtn.addEventListener('click', (ev) => {
      ev.stopPropagation();
      saveAutopilotEnabled(!autopilotEnabled);
      updateToggleLabel();
    });

    minimizeBtn.addEventListener('click', (ev) => {
      ev.stopPropagation();
      minimized = !minimized;
      body.style.display = minimized ? 'none' : 'block';
      minimizeBtn.textContent = minimized ? '＋' : '−';
      const rect = panelEl.getBoundingClientRect();
      saveUiState({
        top: Math.max(0, Math.round(rect.top)),
        right: Math.max(0, Math.round(window.innerWidth - rect.right)),
        minimized
      });
    });

    enableDrag(header);
    updateToggleLabel();

    lines = { l1, l2, l3 };
  }

  function enableDrag(handle) {
    let dragging = false;
    let startX = 0;
    let startY = 0;
    let startTop = 0;
    let startLeft = 0;

    handle.addEventListener('mousedown', (ev) => {
      if (ev.button !== 0) return;
      dragging = true;
      const rect = panelEl.getBoundingClientRect();
      startX = ev.clientX;
      startY = ev.clientY;
      startTop = rect.top;
      startLeft = rect.left;
      panelEl.style.right = 'auto';
      panelEl.style.left = `${startLeft}px`;
      ev.preventDefault();
    });

    window.addEventListener('mousemove', (ev) => {
      if (!dragging) return;
      const nextLeft = startLeft + (ev.clientX - startX);
      const nextTop = startTop + (ev.clientY - startY);
      panelEl.style.left = `${Math.max(0, nextLeft)}px`;
      panelEl.style.top = `${Math.max(0, nextTop)}px`;
    });

    window.addEventListener('mouseup', () => {
      if (!dragging) return;
      dragging = false;
      const rect = panelEl.getBoundingClientRect();
      const right = Math.max(0, Math.round(window.innerWidth - rect.right));
      saveUiState({
        top: Math.max(0, Math.round(rect.top)),
        right,
        minimized
      });
      panelEl.style.right = `${right}px`;
      panelEl.style.left = 'auto';
    });
  }

  function renderCounts(resolved) {
    if (!lines) return;
    lines.l1.textContent = `受付前待 ${resolved.frontWaiting}`;
    lines.l2.textContent = `中待合待 ${resolved.middleWaiting}`;
    lines.l3.textContent = `再帰群 ${resolved.returnGroup}`;
  }

  function runAutopilotCycle(resolved) {
    if (!autopilotEnabled) return;
    // 既存の自動移動ロジックを壊さないため、この版では判定入力のみ更新し、
    // 実際の移動処理は別実装へ委譲する想定。
    void resolved;
  }

  function tick() {
    const payload = readBridgePayload();
    const resolved = resolveCounts(payload);
    renderCounts(resolved);
    runAutopilotCycle(resolved);
  }

  function init() {
    buildPanel();
    tick();
    setInterval(tick, CONFIG.pollIntervalMs);
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init, { once: true });
  } else {
    init();
  }
})();
