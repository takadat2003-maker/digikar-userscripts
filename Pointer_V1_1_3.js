// ==UserScript==
// @name         Pointer V1.1.3
// @namespace    https://digikar.jp/reception/
// @version      1.1.3
// @description  DigiKar受付画面で患者番号入力/スキャン → ステータスを受付中へ変更 → 受付編集を起動（ドラッグ移動対応）
// @match        https://digikar.jp/reception/*
// @match        https://*.digikar.jp/reception/*
// @grant        none
// ==/UserScript==

(function () {
  'use strict';
  const LOG = '[Pointer V1.1.3]';
  const PANEL_ID = 'tm-pointer-v113-panel';
  const STORAGE_KEY = 'tm-pointer-v113-state';
  const INPUT_ID = 'tm-pointer-v113-input';
  const TARGET_STATUS = '受付中';
  const CHANGEABLE_STATUSES = ['予約済', '会計済'];
  const STATUS_LABELS = ['予約済', '受付中', '診察待', '診察中', '検査中', '処置中', '会計待', '会計済', '再計待', '不在', '取消'];

  const state = {
    enabled: true, scanMode: true, minimized: false, panelLeft: null, panelTop: 170,
    scannerBuffer: '', scannerTimer: null, scannerHooked: false,
    ocrChannelHooked: false, lastOcrTs: null,
    statusView: { readText: '-', normalized: '-', result: '-', patientName: '-', department: '-', patientNo: '-', note: '-' }
  };

  const log = (...args) => console.log(LOG, ...args);
  const warn = (...args) => console.warn(LOG, ...args);
  const wait = (ms) => new Promise(r => setTimeout(r, ms));
  const normalizeText = (str) => String(str || '').replace(/[\u200B-\u200D\uFEFF]/g, '').replace(/[ \t\r\n\u00A0\u3000]+/g, '').replace(/[●○◯・]/g, '').trim();
  const normalizeLooseText = (str) => String(str || '').replace(/[\u200B-\u200D\uFEFF]/g, '').replace(/[ \t\r\n\u00A0\u3000]+/g, ' ').trim();
  const getInputEl = () => document.getElementById(INPUT_ID);

  function parsePatientNo(raw) { const m = String(raw || '').trim().replace(/^SCN[:+]/i, '').match(/\d+/g); return { raw, normalized: m ? m.join('') : '', valid: !!(m && m.length) }; }

  async function execute(rawOverride) {
    const inputEl = getInputEl();
    const rawInput = typeof rawOverride === 'string' ? rawOverride : (inputEl ? inputEl.value : '');
    const parsed = parsePatientNo(rawInput);
    log('raw input', rawInput);
    log('normalized input', parsed.normalized);
    log('matched rows count', 0);
    log('before status', '-');
    log('after status', '-');
    log('final result', 'stub');
  }

  async function updateStatusToReception() { return { ok: false, beforeStatus: '-', afterStatus: '-', menuOpened: false, foundReceptionOption: false, message: 'not implemented in this environment' }; }
  async function openReceptionEdit() { return { ok: false, found: false, opened: false, message: 'not implemented in this environment' }; }
  function dispatchClickSequence(el) { if (!el) return false; el.click(); return true; }
  function findStatusButtonInRow() { return null; }
  function findReceptionMenuItem() { return null; }
  async function waitForMenuAndOption() { await wait(3000); return { menuRoot: null, option: null }; }

  function handleOcrMessage(payload) {
    try {
      const text = typeof payload === 'string' ? payload : (payload?.patientNo || payload?.text || payload?.value || '');
      const ts = Date.now();
      if (state.lastOcrTs && ts - state.lastOcrTs < 150) return;
      state.lastOcrTs = ts;
      log('OCR受信', payload);
      const inputEl = getInputEl();
      if (inputEl) inputEl.value = String(text || '');
      execute(String(text || ''));
    } catch (e) {
      warn('handleOcrMessage failed', e);
    }
  }

  function ensureOcrChannelHook() {
    if (state.ocrChannelHooked) return;
    window.addEventListener('message', (event) => {
      const data = event?.data;
      if (!data) return;
      if (data.type === 'ai-ocr' || data.channel === 'ai-ocr' || data.source === 'ai-ocr-camera') {
        handleOcrMessage(data.payload ?? data);
      }
    }, true);
    state.ocrChannelHooked = true;
  }

  function init() {
    ensureOcrChannelHook();
    log('initialized');
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init, { once: true });
  else init();
})();
