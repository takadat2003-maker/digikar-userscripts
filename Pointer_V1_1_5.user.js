// ==UserScript==
// @name         Pointer V1.1.5
// @namespace    https://digikar.jp/reception/
// @version      1.1.5
// @description  DigiKar受付画面で患者番号入力/スキャン/AI-OCR受信 → ステータスを受付中へ変更 → 受付編集を起動
// @match        https://digikar.jp/reception/*
// @match        https://*.digikar.jp/reception/*
// @grant        none
// ==/UserScript==

(function () {
  'use strict';

  const LOG = '[Pointer V1.1.5]';
  const PANEL_ID = 'tm-pointer-v115-panel';
  const STORAGE_KEY = 'tm-pointer-v115-state';
  const INPUT_ID = 'tm-pointer-v115-input';

  const TARGET_STATUS = '受付中';
  const CHANGEABLE_STATUSES = ['予約済', '会計済'];
  const STATUS_LABELS = ['予約済', '受付中', '診察待', '診察中', '検査中', '処置中', '会計待', '会計済', '再計待', '不在', '取消'];

  const state = {
    enabled: true,
    scanMode: true,
    minimized: false,
    panelLeft: null,
    panelTop: 170,
    scannerBuffer: '',
    scannerTimer: null,
    scannerHooked: false,
  };

  const log = (...args) => console.log(LOG, ...args);
  const warn = (...args) => console.warn(LOG, ...args);

  function wait(ms) { return new Promise(r => setTimeout(r, ms)); }
  function normalizeText(str) { return String(str || '').replace(/[\u200B-\u200D\uFEFF]/g, '').replace(/[ \t\r\n\u00A0\u3000]+/g, '').trim(); }

  function parsePatientNo(input) {
    const raw = String(input ?? '');
    const normalized = raw.replace(/\D+/g, '');
    return { raw, normalized };
  }

  function dispatchClickSequence(el) {
    if (!el) return false;
    ['pointerdown', 'mousedown', 'pointerup', 'mouseup', 'click'].forEach(type => {
      el.dispatchEvent(new MouseEvent(type, { bubbles: true, cancelable: true, view: window }));
    });
    return true;
  }

  function findReceptionTable() {
    const tables = Array.from(document.querySelectorAll('table'));
    return tables.find(t => normalizeText(t.innerText || '').includes('患者番号')) || null;
  }

  function findRowsByPatientNo(patientNo) {
    const table = findReceptionTable();
    if (!table) return [];
    const rows = Array.from(table.querySelectorAll('tbody tr, tr'));
    return rows.filter(row => normalizeText(row.innerText || '').replace(/\D+/g, '').includes(patientNo));
  }

  function findStatusButtonInRow(row) {
    const candidates = Array.from(row.querySelectorAll('button,[role="button"],span,div'));
    return candidates.find(el => STATUS_LABELS.includes(normalizeText(el.textContent || ''))) || null;
  }

  function findMenuRoots() {
    return Array.from(document.querySelectorAll('[role="menu"], .ant-dropdown, .el-select-dropdown, .MuiPopover-root, .MuiMenu-root'));
  }

  function pickBestMenuRoot(roots) {
    return roots.find(r => r.offsetParent !== null) || roots[0] || null;
  }

  function findReceptionMenuItem(root) {
    if (!root) return null;
    const nodes = Array.from(root.querySelectorAll('*'));
    return nodes.find(n => normalizeText(n.textContent || '') === TARGET_STATUS) || null;
  }

  async function openStatusMenu(statusButton) {
    if (!statusButton) return false;
    dispatchClickSequence(statusButton);
    await wait(120);
    return true;
  }

  async function updateStatusToReception(row, currentStatus) {
    if (currentStatus === TARGET_STATUS) return { ok: true, afterStatus: currentStatus, reason: 'already-target' };
    if (!CHANGEABLE_STATUSES.includes(currentStatus)) return { ok: false, afterStatus: currentStatus, reason: 'not-changeable' };

    const statusButton = findStatusButtonInRow(row);
    log('status button found?', !!statusButton);
    if (!statusButton) return { ok: false, afterStatus: currentStatus, reason: 'status-button-not-found' };

    const menuOpened = await openStatusMenu(statusButton);
    log('menu opened?', menuOpened);
    if (!menuOpened) return { ok: false, afterStatus: currentStatus, reason: 'menu-open-failed' };

    const menuRoot = pickBestMenuRoot(findMenuRoots());
    const item = findReceptionMenuItem(menuRoot);
    log('reception option found?', !!item);
    if (!item) return { ok: false, afterStatus: currentStatus, reason: 'reception-option-not-found' };

    dispatchClickSequence(item);
    await wait(250);

    const afterButton = findStatusButtonInRow(row);
    const afterStatus = normalizeText(afterButton?.textContent || currentStatus);
    return { ok: afterStatus === TARGET_STATUS, afterStatus, reason: afterStatus === TARGET_STATUS ? 'changed' : 'verify-failed' };
  }

  async function openReceptionEdit(row) {
    const editBtn = Array.from(row.querySelectorAll('button,a,[role="button"]')).find(el => /受付編集/.test(normalizeText(el.textContent || '')));
    if (!editBtn) return false;
    dispatchClickSequence(editBtn);
    return true;
  }

  async function execute(patientNoString) {
    log('current mode', state.scanMode ? 'scan' : 'manual');
    const { raw, normalized } = parsePatientNo(patientNoString);
    log('raw input', raw);
    log('normalized input', normalized);
    if (!normalized) { log('final result', 'invalid-input'); return false; }

    const rows = findRowsByPatientNo(normalized);
    log('matched rows count', rows.length);
    if (!rows.length) { log('final result', 'row-not-found'); return false; }

    const row = rows[0];
    const beforeStatus = normalizeText((findStatusButtonInRow(row)?.textContent) || '');
    log('before status', beforeStatus || '(unknown)');

    const update = await updateStatusToReception(row, beforeStatus);
    log('after status', update.afterStatus);
    if (!update.ok) { log('final result', `status-failed:${update.reason}`); return false; }

    const opened = await openReceptionEdit(row);
    log('final result', opened ? 'success' : 'edit-open-failed');
    return opened;
  }

  function loadState() {
    try {
      const saved = JSON.parse(localStorage.getItem(STORAGE_KEY) || '{}');
      Object.assign(state, saved || {});
    } catch (e) { warn('loadState failed', e); }
  }

  function saveState() {
    localStorage.setItem(STORAGE_KEY, JSON.stringify({ enabled: state.enabled, scanMode: state.scanMode, minimized: state.minimized, panelLeft: state.panelLeft, panelTop: state.panelTop }));
  }

  function setStatusLabel(text) {
    const el = document.querySelector(`#${PANEL_ID} .tm-pointer-status`);
    if (el) el.textContent = text;
  }

  function handleAiOcrPayload(payload) {
    const source = (typeof payload === 'string') ? payload : (payload?.patientNo ?? payload?.value ?? payload?.text ?? payload?.raw ?? payload?.number ?? '');
    const patientNo = String(source || '').replace(/\D+/g, '');
    log('AI-OCR received', payload);
    setStatusLabel('AI-OCR受信');
    if (patientNo) execute(patientNo);
  }

  function setupAiOcrReceiver() {
    window.addEventListener('message', (event) => {
      const data = event?.data;
      if (data == null) return;
      if (typeof data === 'string') return handleAiOcrPayload(data);
      if (typeof data === 'object') {
        const t = data.type;
        if (!t || t === 'POINTER_PATIENT_NO' || t === 'POINTER_AI_OCR' || data.patientNo || data.value || data.text || data.raw || data.number) {
          handleAiOcrPayload(data);
        }
      }
    });

    window.addEventListener('tm-pointer-ai-ocr', (event) => {
      const detail = event?.detail;
      handleAiOcrPayload(detail);
    });
  }

  function createPanel() {
    if (document.getElementById(PANEL_ID)) return;
    const panel = document.createElement('div');
    panel.id = PANEL_ID;
    panel.style.cssText = 'position:fixed;right:16px;top:170px;z-index:999999;background:#fff;border:1px solid #ccc;padding:8px;width:300px;font-size:12px;';
    panel.innerHTML = `
      <div style="font-weight:bold;margin-bottom:6px;">Pointer V1.1.5</div>
      <div style="display:flex;gap:6px;margin-bottom:6px;">
        <input id="${INPUT_ID}" type="text" placeholder="患者番号" style="flex:1;" />
        <button type="button" id="tm-pointer-run">実行</button>
      </div>
      <div class="tm-pointer-status">待機中</div>
    `;
    document.body.appendChild(panel);
    panel.querySelector('#tm-pointer-run').addEventListener('click', () => {
      const v = document.getElementById(INPUT_ID)?.value || '';
      execute(v);
    });
  }

  function setupScannerInput() {
    if (state.scannerHooked) return;
    state.scannerHooked = true;
    window.addEventListener('keydown', (e) => {
      if (!state.enabled || !state.scanMode) return;
      if (e.key === 'Enter') {
        const text = state.scannerBuffer;
        state.scannerBuffer = '';
        if (text) execute(text);
        return;
      }
      if (e.key.length === 1) state.scannerBuffer += e.key;
      clearTimeout(state.scannerTimer);
      state.scannerTimer = setTimeout(() => { state.scannerBuffer = ''; }, 120);
    }, true);
  }

  function init() {
    loadState();
    createPanel();
    setupScannerInput();
    setupAiOcrReceiver();
    saveState();
    log('initialized');
  }

  init();
})();
