// ==UserScript==
// @name         Pointer V1.1.6
// @namespace    https://digikar.jp/reception/
// @version      1.1.6
// @description  DigiKar受付画面で患者番号入力/スキャン/AI-OCR連携 → ステータスを受付中へ変更 → 受付編集を起動
// @match        https://digikar.jp/reception/*
// @match        https://*.digikar.jp/reception/*
// @grant        none
// ==/UserScript==

(function () {
  'use strict';

  const LOG = '[Pointer V1.1.6]';
  const PANEL_ID = 'tm-pointer-v116-panel';
  const STORAGE_KEY = 'tm-pointer-v116-state';
  const INPUT_ID = 'tm-pointer-v116-input';
  const TARGET_STATUS = '受付中';
  const CHANGEABLE_STATUSES = ['予約済', '会計済'];

  const state = {
    enabled: true, scanMode: true, minimized: false, panelLeft: null, panelTop: 170,
    scannerBuffer: '', scannerTimer: null, scannerHooked: false,
    statusView: { readText: '-', normalized: '-', result: '-', note: '-' }
  };

  const log = (...a) => console.log(LOG, ...a);

  function wait(ms) { return new Promise(r => setTimeout(r, ms)); }
  function normalizeText(str) { return String(str || '').replace(/[^0-9]/g, ''); }
  function parsePatientNo(raw) { const n = normalizeText(raw); return n || null; }
  function getInputEl() { return document.getElementById(INPUT_ID); }

  function updateStatusView(patch) {
    state.statusView = { ...state.statusView, ...patch };
    const box = document.querySelector(`#${PANEL_ID} .tm-pointer-status-box`);
    if (!box) return;
    box.textContent = `読取文字: ${state.statusView.readText}\n正規化後: ${state.statusView.normalized}\n結果: ${state.statusView.result}\n補足: ${state.statusView.note}`;
  }

  function dispatchClickSequence(el) {
    if (!el) return false;
    ['pointerdown', 'mousedown', 'pointerup', 'mouseup', 'click'].forEach(type => {
      el.dispatchEvent(new MouseEvent(type, { bubbles: true, cancelable: true, view: window }));
    });
    return true;
  }

  function findReceptionTable() { return document.querySelector('table'); }

  function findRowsByPatientNo(patientNo) {
    const table = findReceptionTable(); if (!table) return [];
    return [...table.querySelectorAll('tbody tr, tr')].filter(row => normalizeText(row.textContent).includes(patientNo));
  }

  function findStatusButtonInRow(row) {
    return [...row.querySelectorAll('button, [role="button"], td, div')].find(el => {
      const t = (el.textContent || '').trim();
      return t.includes('予約済') || t.includes('会計済') || t.includes('受付中');
    }) || null;
  }

  function findMenuRoots() { return [...document.querySelectorAll('[role="menu"], .ant-dropdown, .MuiPopover-root')]; }
  function pickBestMenuRoot(roots) { return roots[roots.length - 1] || null; }
  function findReceptionMenuItem(root) {
    if (!root) return null;
    return [...root.querySelectorAll('[role="menuitem"], li, button, div')].find(el => (el.textContent || '').includes(TARGET_STATUS)) || null;
  }

  async function openStatusMenu(statusButton) { return dispatchClickSequence(statusButton); }

  async function updateStatusToReception(row) {
    const statusButton = findStatusButtonInRow(row);
    log('status button found?', !!statusButton);
    if (!statusButton) return { ok: false, reason: 'status button not found' };
    const before = (statusButton.textContent || '').trim();
    log('before status', before);
    if (before.includes(TARGET_STATUS)) return { ok: true, already: true };
    if (!CHANGEABLE_STATUSES.some(s => before.includes(s))) return { ok: false, reason: `unsupported status: ${before}` };

    const opened = await openStatusMenu(statusButton);
    log('menu opened?', opened);
    await wait(120);
    const item = findReceptionMenuItem(pickBestMenuRoot(findMenuRoots()));
    log('reception option found?', !!item);
    if (!item) return { ok: false, reason: 'reception option not found' };
    dispatchClickSequence(item);
    await wait(220);
    const after = (findStatusButtonInRow(row)?.textContent || '').trim();
    log('after status', after);
    return { ok: after.includes(TARGET_STATUS), before, after };
  }

  async function openReceptionEdit(row) {
    const btn = [...row.querySelectorAll('button,[role="button"],a,div')].find(el => (el.textContent || '').includes('受付編集'));
    if (!btn) return false;
    dispatchClickSequence(btn); return true;
  }

  async function execute(rawInput) {
    log('current mode', state.scanMode ? 'scan' : 'manual');
    log('raw input', rawInput);
    const patientNo = parsePatientNo(rawInput);
    log('normalized input', patientNo);
    if (!patientNo) { updateStatusView({ result: '失敗', note: '患者番号なし' }); return false; }

    const rows = findRowsByPatientNo(patientNo);
    log('matched rows count', rows.length);
    if (!rows.length) { updateStatusView({ readText: rawInput, normalized: patientNo, result: '失敗', note: '対象行なし' }); return false; }

    const statusRes = await updateStatusToReception(rows[0]);
    if (!statusRes.ok) { updateStatusView({ readText: rawInput, normalized: patientNo, result: '失敗', note: statusRes.reason || 'ステータス変更失敗' }); log('final result', 'failed'); return false; }
    const edited = await openReceptionEdit(rows[0]);
    updateStatusView({ readText: rawInput, normalized: patientNo, result: edited ? '成功' : '一部成功', note: edited ? '受付編集を起動' : '受付編集ボタンなし' });
    log('final result', edited ? 'success' : 'partial');
    return true;
  }

  function onScannerKeydown(e) {
    if (!state.enabled || !state.scanMode) return;
    if (e.key === 'Enter') {
      const value = state.scannerBuffer;
      state.scannerBuffer = '';
      if (value) execute(value);
      return;
    }
    if (/^[0-9]$/.test(e.key)) state.scannerBuffer += e.key;
    clearTimeout(state.scannerTimer);
    state.scannerTimer = setTimeout(() => { state.scannerBuffer = ''; }, 300);
  }

  function extractAiPatientNo(payload) {
    if (payload == null) return null;
    if (typeof payload === 'string' || typeof payload === 'number') return parsePatientNo(String(payload));
    const c = [payload.patientNo, payload.value, payload.text, payload.raw, payload.number];
    return parsePatientNo(c.find(v => v != null) || '');
  }

  function handleAiPayload(payload) {
    const no = extractAiPatientNo(payload);
    if (!no) return;
    log('AI-OCR received', payload);
    updateStatusView({ note: 'AI-OCR受信' });
    execute(no);
  }

  function hookAiOcrListeners() {
    window.addEventListener('message', ev => handleAiPayload(ev.data));
    window.addEventListener('tm-pointer-ai-ocr', ev => handleAiPayload(ev.detail));
  }

  function renderPanel() {
    const prev = document.getElementById(PANEL_ID); if (prev) prev.remove();
    const panel = document.createElement('div'); panel.id = PANEL_ID;
    panel.style.cssText = 'position:fixed;top:170px;right:8px;z-index:2147483646;background:#fff;border:1px solid #ccc;padding:8px;width:280px;font-size:12px;';
    panel.innerHTML = `
      <div style="font-weight:bold;cursor:move;">Pointer V1.1.6</div>
      <textarea id="${INPUT_ID}" rows="2" style="width:100%;margin-top:6px;" placeholder="患者番号"></textarea>
      <div style="display:flex;gap:4px;margin-top:6px;flex-wrap:wrap;">
        <button class="run">実行</button><button class="clear">クリア</button><button class="toggle">ON/OFF</button><button class="mode">Scan/Manual</button><button class="rerender">再描画</button>
      </div>
      <pre class="tm-pointer-status-box" style="white-space:pre-wrap;background:#f8f8f8;padding:6px;margin-top:6px;">-</pre>`;
    document.body.appendChild(panel);

    panel.querySelector('.run').addEventListener('click', () => execute(getInputEl()?.value || ''));
    panel.querySelector('.clear').addEventListener('click', () => { if (getInputEl()) getInputEl().value = ''; });
    panel.querySelector('.toggle').addEventListener('click', () => { state.enabled = !state.enabled; });
    panel.querySelector('.mode').addEventListener('click', () => { state.scanMode = !state.scanMode; });
    panel.querySelector('.rerender').addEventListener('click', renderPanel);
    getInputEl()?.addEventListener('keydown', e => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); execute(getInputEl().value); } });

    let drag = null;
    panel.firstElementChild.addEventListener('mousedown', e => { drag = { x: e.clientX - panel.offsetLeft, y: e.clientY - panel.offsetTop }; });
    window.addEventListener('mousemove', e => { if (!drag) return; panel.style.left = `${e.clientX - drag.x}px`; panel.style.top = `${e.clientY - drag.y}px`; panel.style.right = 'auto'; });
    window.addEventListener('mouseup', () => { drag = null; });
    updateStatusView({});
  }

  function init() {
    log('initialized');
    renderPanel();
    if (!state.scannerHooked) {
      document.addEventListener('keydown', onScannerKeydown, true);
      state.scannerHooked = true;
    }
    hookAiOcrListeners();
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init); else init();
})();
