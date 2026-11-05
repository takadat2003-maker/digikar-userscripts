// ==UserScript==
// @name         Bridging Autopilot V2
// @namespace    https://digikar.jp/reception/
// @version      2.0.0
// @description  Res.Prio.sys.V3.6rrr-bridgeV2 が localStorage に書き出す bridge payload を引用表示する受信専用パネル。
// @match        https://digikar.jp/reception/*
// @match        https://*.digikar.jp/reception/*
// @run-at       document-start
// @grant        none
// ==/UserScript==

(function () {
  'use strict';

  const CONFIG = {
    storageKey: 'tmBridgeAutopilotFeedV2',
    panelId: 'tm-bridging-autopilot-v2-panel',
    uiStorageKey: 'tmBridgeAutopilotUiV2',
    refreshIntervalMs: 1000
  };

  const DEFAULT_UI_STATE = {
    top: 72,
    right: 20,
    minimized: false
  };

  function safeJsonParse(text) {
    try {
      return JSON.parse(text);
    } catch (_err) {
      return null;
    }
  }

  function loadUiState() {
    const parsed = safeJsonParse(localStorage.getItem(CONFIG.uiStorageKey));
    if (!parsed || typeof parsed !== 'object') return { ...DEFAULT_UI_STATE };

    const top = Number(parsed.top);
    const right = Number(parsed.right);
    const minimized = Boolean(parsed.minimized);

    return {
      top: Number.isFinite(top) ? top : DEFAULT_UI_STATE.top,
      right: Number.isFinite(right) ? right : DEFAULT_UI_STATE.right,
      minimized
    };
  }

  function saveUiState(state) {
    try {
      localStorage.setItem(CONFIG.uiStorageKey, JSON.stringify(state));
    } catch (_err) {
      // no-op
    }
  }

  function readBridgePayload() {
    const raw = localStorage.getItem(CONFIG.storageKey);
    if (!raw) return null;

    const payload = safeJsonParse(raw);
    if (!payload || typeof payload !== 'object') return null;
    if (!payload.counts || typeof payload.counts !== 'object') return null;

    return payload;
  }

  function createPanel() {
    if (document.getElementById(CONFIG.panelId)) {
      return document.getElementById(CONFIG.panelId);
    }

    const uiState = loadUiState();

    const panel = document.createElement('div');
    panel.id = CONFIG.panelId;
    panel.style.position = 'fixed';
    panel.style.zIndex = '999999';
    panel.style.top = `${uiState.top}px`;
    panel.style.right = `${uiState.right}px`;
    panel.style.width = '248px';
    panel.style.background = 'rgba(255,255,255,0.97)';
    panel.style.border = '1px solid #d1d5db';
    panel.style.borderRadius = '10px';
    panel.style.boxShadow = '0 8px 20px rgba(0,0,0,0.18)';
    panel.style.fontFamily = "'Meiryo', 'Hiragino Kaku Gothic ProN', sans-serif";
    panel.style.color = '#111827';

    const header = document.createElement('div');
    header.style.display = 'flex';
    header.style.alignItems = 'center';
    header.style.justifyContent = 'space-between';
    header.style.gap = '8px';
    header.style.padding = '8px 10px';
    header.style.borderBottom = '1px solid #e5e7eb';
    header.style.background = '#1e3a8a';
    header.style.color = '#ffffff';
    header.style.borderRadius = '10px 10px 0 0';
    header.style.cursor = 'move';

    const title = document.createElement('div');
    title.textContent = 'Bridge V2';
    title.style.fontWeight = '700';
    title.style.fontSize = '13px';
    title.style.lineHeight = '1.3';

    const buttons = document.createElement('div');
    buttons.style.display = 'flex';
    buttons.style.alignItems = 'center';
    buttons.style.gap = '6px';

    const minimizeButton = document.createElement('button');
    minimizeButton.type = 'button';
    minimizeButton.textContent = uiState.minimized ? '＋' : '－';
    minimizeButton.style.width = '24px';
    minimizeButton.style.height = '24px';
    minimizeButton.style.padding = '0';
    minimizeButton.style.border = '1px solid rgba(255,255,255,0.5)';
    minimizeButton.style.borderRadius = '6px';
    minimizeButton.style.background = 'transparent';
    minimizeButton.style.color = '#ffffff';
    minimizeButton.style.cursor = 'pointer';
    minimizeButton.title = '最小化/復帰';

    const body = document.createElement('div');
    body.style.padding = '10px';
    body.style.display = uiState.minimized ? 'none' : 'block';

    const status = document.createElement('div');
    status.style.fontSize = '11px';
    status.style.color = '#6b7280';
    status.style.marginBottom = '8px';

    const line1 = document.createElement('div');
    const line2 = document.createElement('div');
    const line3 = document.createElement('div');
    const line4 = document.createElement('div');
    const line5 = document.createElement('div');

    [line1, line2, line3, line4, line5].forEach((line, index) => {
      line.style.fontSize = '13px';
      line.style.fontWeight = index < 2 ? '700' : '600';
      line.style.lineHeight = '1.5';
      line.style.marginBottom = index === 4 ? '0' : '3px';
      body.appendChild(line);
    });

    header.appendChild(title);
    buttons.appendChild(minimizeButton);
    header.appendChild(buttons);

    panel.appendChild(header);
    panel.appendChild(body);
    body.insertBefore(status, body.firstChild);

    panel._bridgeRefs = {
      title,
      status,
      line1,
      line2,
      line3,
      line4,
      line5,
      body,
      minimizeButton
    };

    let dragging = false;
    let dragOffsetX = 0;
    let dragOffsetY = 0;

    function onPointerDown(event) {
      if (event.button !== 0) return;
      if (event.target === minimizeButton) return;

      dragging = true;
      panel.style.right = 'auto';
      const rect = panel.getBoundingClientRect();
      dragOffsetX = event.clientX - rect.left;
      dragOffsetY = event.clientY - rect.top;

      window.addEventListener('pointermove', onPointerMove);
      window.addEventListener('pointerup', onPointerUp);
      event.preventDefault();
    }

    function onPointerMove(event) {
      if (!dragging) return;

      const nextLeft = Math.max(0, Math.min(window.innerWidth - panel.offsetWidth, event.clientX - dragOffsetX));
      const nextTop = Math.max(0, Math.min(window.innerHeight - 40, event.clientY - dragOffsetY));

      panel.style.left = `${nextLeft}px`;
      panel.style.top = `${nextTop}px`;
    }

    function onPointerUp() {
      if (!dragging) return;
      dragging = false;
      window.removeEventListener('pointermove', onPointerMove);
      window.removeEventListener('pointerup', onPointerUp);

      const rect = panel.getBoundingClientRect();
      const nextRight = Math.max(0, Math.round(window.innerWidth - rect.right));
      const nextTop = Math.max(0, Math.round(rect.top));

      panel.style.left = 'auto';
      panel.style.right = `${nextRight}px`;

      const latest = loadUiState();
      saveUiState({ ...latest, right: nextRight, top: nextTop });
    }

    header.addEventListener('pointerdown', onPointerDown);

    minimizeButton.addEventListener('click', () => {
      const latest = loadUiState();
      const minimized = !latest.minimized;

      body.style.display = minimized ? 'none' : 'block';
      minimizeButton.textContent = minimized ? '＋' : '－';

      saveUiState({ ...latest, minimized });
    });

    document.documentElement.appendChild(panel);
    return panel;
  }

  function setWaitingState(panel) {
    const { title, status, line1, line2, line3, line4, line5 } = panel._bridgeRefs;

    title.textContent = 'Bridge V2';
    panel.title = 'Res.Prio.sys.V3.6rrr-bridgeV2 からのデータ待ち';
    status.textContent = '受信状態: waiting';

    line1.textContent = '受付前待 --/6';
    line2.textContent = '中待合待 --/3';
    line3.textContent = '再帰群：--';
    line4.textContent = '診察中：--';
    line5.textContent = '診察待総数：--';
  }

  function renderBridgePanel(panel, payload) {
    if (!panel || !panel._bridgeRefs) return;

    if (!payload || !payload.counts || typeof payload.counts !== 'object') {
      setWaitingState(panel);
      return;
    }

    const frontWaiting = Number(payload.counts.frontWaiting || 0);
    const frontWaitingTarget = Number(payload.counts.frontWaitingTarget || 6);

    const middleWaiting = Number(payload.counts.middleWaiting || 0);
    const middleWaitingTarget = Number(payload.counts.middleWaitingTarget || 3);

    const returnGroup = Number(payload.counts.returnGroup || 0);
    const examining = Number(payload.counts.examining || 0);
    const waitingTotal = Number(payload.counts.waitingTotal || 0);

    const { title, status, line1, line2, line3, line4, line5 } = panel._bridgeRefs;

    title.textContent = 'Bridge V2';

    const updatedAt = payload.generatedAt || payload.timestamp || null;
    const sourceLabel = payload.source || 'Res.Prio.sys.V3.6rrr-bridgeV2';

    panel.title = `${sourceLabel} の bridge payload を表示中`;
    status.textContent = updatedAt ? `受信状態: ok (${updatedAt})` : '受信状態: ok';

    line1.textContent = `受付前待 ${frontWaiting}/${frontWaitingTarget}`;
    line2.textContent = `中待合待 ${middleWaiting}/${middleWaitingTarget}`;
    line3.textContent = `再帰群：${returnGroup}`;
    line4.textContent = `診察中：${examining}`;
    line5.textContent = `診察待総数：${waitingTotal}`;
  }

  function refresh(panel) {
    const payload = readBridgePayload();
    renderBridgePanel(panel, payload);
  }

  function bootstrap() {
    const panel = createPanel();
    setWaitingState(panel);
    refresh(panel);

    window.addEventListener('storage', (event) => {
      if (event.key && event.key !== CONFIG.storageKey) return;
      refresh(panel);
    });

    setInterval(() => {
      refresh(panel);
    }, CONFIG.refreshIntervalMs);
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', bootstrap, { once: true });
  } else {
    bootstrap();
  }
})();
