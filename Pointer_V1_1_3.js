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

  const state = {
    enabled: true,
    scanMode: true,
    minimized: false,
    panelLeft: null,
    panelTop: 170,
    scannerBuffer: '',
    scannerTimer: null,
    scannerHooked: false,
    ocrChannelHooked: false,
    lastOcrTs: null,
  };

  const log = (...args) => console.log(LOG, ...args);
  const wait = (ms) => new Promise((r) => setTimeout(r, ms));
  const getInputEl = () => document.getElementById(INPUT_ID);

  function normalizePatientNo(raw) {
    return String(raw || '').replace(/^SCN[:+]/i, '').replace(/\D/g, '');
  }

  function findRowsByPatientNo(patientNo) {
    const norm = normalizePatientNo(patientNo);
    if (!norm) return [];
    const rows = Array.from(document.querySelectorAll('tr'));
    return rows.filter((tr) => normalizePatientNo(tr.textContent).includes(norm));
  }

  function findStatusButtonInRow(row) {
    if (!row) return null;
    const btns = Array.from(row.querySelectorAll('button,[role="button"],a,div,span'));
    return btns.find((el) => /予約済|会計済|受付中|診察待|診察中|検査中|処置中|会計待|再計待|不在|取消/.test((el.textContent || '').trim())) || null;
  }

  function dispatchClickSequence(el) {
    if (!el) return false;
    const events = ['pointerdown', 'mousedown', 'mouseup', 'click'];
    for (const t of events) {
      el.dispatchEvent(new MouseEvent(t, { bubbles: true, cancelable: true, view: window }));
    }
    return true;
  }

  function findReceptionMenuItem(menuRoot) {
    if (!menuRoot) return null;
    const cands = Array.from(menuRoot.querySelectorAll('li,button,a,div,[role="menuitem"]'));
    return cands.find((el) => (el.textContent || '').replace(/\s+/g, '').includes('受付中')) || null;
  }

  async function waitForMenuAndOption() {
    const started = Date.now();
    while (Date.now() - started < 3000) {
      const menu = document.querySelector('[role="menu"], .menu, .MuiMenu-paper, .ant-dropdown, .el-select-dropdown');
      const option = findReceptionMenuItem(menu || document.body);
      if (menu && option) return { menuRoot: menu, option };
      await wait(50);
    }
    return { menuRoot: null, option: null };
  }

  async function updateStatusToReception(row) {
    const statusButton = findStatusButtonInRow(row);
    const beforeStatus = (statusButton?.textContent || '').trim();
    if (!statusButton) return { ok: false, beforeStatus, afterStatus: beforeStatus };
    if (!CHANGEABLE_STATUSES.includes(beforeStatus) && beforeStatus !== TARGET_STATUS) {
      return { ok: false, beforeStatus, afterStatus: beforeStatus };
    }
    if (beforeStatus === TARGET_STATUS) return { ok: true, beforeStatus, afterStatus: beforeStatus };
    dispatchClickSequence(statusButton);
    const { option } = await waitForMenuAndOption();
    if (!option) return { ok: false, beforeStatus, afterStatus: beforeStatus };
    dispatchClickSequence(option);
    await wait(100);
    const afterStatus = (findStatusButtonInRow(row)?.textContent || '').trim();
    return { ok: true, beforeStatus, afterStatus };
  }

  async function openReceptionEdit(row) {
    const edit = Array.from(row.querySelectorAll('button,a,[role="button"],div,span')).find((el) => /受付編集|編集/.test((el.textContent || '').trim()));
    if (!edit) return { ok: false };
    dispatchClickSequence(edit);
    return { ok: true };
  }

  async function execute(rawOverride) {
    const rawInput = typeof rawOverride === 'string' ? rawOverride : (getInputEl()?.value || '');
    const normalized = normalizePatientNo(rawInput);
    log('raw input', rawInput);
    log('normalized input', normalized);
    const rows = findRowsByPatientNo(normalized);
    log('matched rows count', rows.length);

    if (!normalized || rows.length === 0) {
      log('final result', 'not found');
      return;
    }

    const row = rows[0];
    const upd = await updateStatusToReception(row);
    log('before status', upd.beforeStatus || '-');
    log('after status', upd.afterStatus || '-');
    const edit = await openReceptionEdit(row);
    log('final result', upd.ok && edit.ok ? 'success' : 'partial');
  }

  function handleOcrMessage(payload) {
    const ts = Date.now();
    if (state.lastOcrTs && ts - state.lastOcrTs < 120) return;
    state.lastOcrTs = ts;
    log('OCR受信', payload);
    const text = typeof payload === 'string' ? payload : (payload?.patientNo || payload?.text || payload?.value || payload?.number || '');
    const input = getInputEl();
    if (input) input.value = text;
    execute(text);
  }

  function ensureOcrChannelHook() {
    if (state.ocrChannelHooked) return;
    window.addEventListener('message', (event) => {
      const d = event?.data;
      if (!d) return;
      if (d.type === 'ai-ocr' || d.channel === 'ai-ocr' || d.source === 'ai-ocr-camera') {
        handleOcrMessage(d.payload ?? d);
      }
    }, true);
    state.ocrChannelHooked = true;
  }

  function mountPanel() {
    if (document.getElementById(PANEL_ID)) return;
    const panel = document.createElement('div');
    panel.id = PANEL_ID;
    panel.style.cssText = 'position:fixed;right:12px;top:170px;z-index:99999;background:#111;color:#fff;padding:8px;border-radius:8px;font-size:12px;';
    panel.innerHTML = `<div style="font-weight:700;margin-bottom:6px;">Pointer V1.1.3</div><input id="${INPUT_ID}" placeholder="患者番号" style="width:140px" /><button id="${INPUT_ID}-go">実行</button>`;
    document.body.appendChild(panel);
    panel.querySelector(`#${INPUT_ID}-go`).addEventListener('click', () => execute());
    panel.querySelector(`#${INPUT_ID}`).addEventListener('keydown', (e) => { if (e.key === 'Enter') execute(); });
  }

  function init() {
    mountPanel();
    ensureOcrChannelHook();
    log('ready');
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init, { once: true });
  else init();
})();
