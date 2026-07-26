// ==UserScript==
// @name         Pointer V1.0.4
// @namespace    https://digikar.jp/reception/
// @version      1.0.4
// @description  DigiKar受付用 Pointer。Manual/Scan切替、グローバルスキャナー受信、画面外患者へのscroll再探索を強化。
// @match        https://digikar.jp/reception/*
// @match        https://*.digikar.jp/reception/*
// @run-at       document-idle
// @grant        none
// ==/UserScript==

(function () {
  'use strict';

  const STORAGE_KEY = 'tmPointerV104State';
  const PANEL_ID = 'tm-pointer-v104-panel';
  const SCAN_TIMEOUT_MS = 120;

  const state = {
    scanMode: false,
    minimized: false,
    scannerBuffer: '',
    scannerTimer: null,
    lastScanRaw: ''
  };

  const ui = {
    panel: null,
    modeBtn: null,
    textarea: null,
    statusView: null,
    body: null,
    minBtn: null
  };

  function sleep(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
  }

  function log(label, payload) {
    if (typeof payload === 'undefined') {
      console.log(`[Pointer V1.0.4] ${label}`);
    } else {
      console.log(`[Pointer V1.0.4] ${label}`, payload);
    }
  }

  function loadState() {
    try {
      const saved = JSON.parse(localStorage.getItem(STORAGE_KEY) || '{}');
      state.scanMode = Boolean(saved.scanMode);
      state.minimized = Boolean(saved.minimized);
    } catch (e) {
      log('loadState failed', e);
    }
  }

  function saveState() {
    localStorage.setItem(STORAGE_KEY, JSON.stringify({
      scanMode: state.scanMode,
      minimized: state.minimized
    }));
  }

  function resetStatusView(resultText, noteText) {
    ui.statusView.innerHTML = [
      `読取文字: -`,
      `正規化後: -`,
      `結果: ${resultText}`,
      `患者氏名: -`,
      `診療科: -`,
      `患者番号: -`,
      `補足: ${noteText}`
    ].join('<br>');
  }

  function setStatusView(data) {
    ui.statusView.innerHTML = [
      `読取文字: ${data.raw || '-'}`,
      `正規化後: ${data.normalized || '-'}`,
      `結果: ${data.result || '-'}`,
      `患者氏名: ${data.patientName || '-'}`,
      `診療科: ${data.department || '-'}`,
      `患者番号: ${data.patientNo || '-'}`,
      `補足: ${data.note || '-'}`
    ].join('<br>');
  }

  function updateModeUI() {
    ui.modeBtn.textContent = state.scanMode ? 'Scan' : 'Manual';
    ui.modeBtn.title = state.scanMode ? 'Scan モード' : 'Manual モード';
    log('current mode', state.scanMode ? 'Scan' : 'Manual');
  }

  function setMode(scanMode) {
    state.scanMode = Boolean(scanMode);
    state.scannerBuffer = '';
    clearTimeout(state.scannerTimer);
    state.scannerTimer = null;

    ui.textarea.value = '';
    if (state.scanMode) {
      resetStatusView('モード切替', 'Scan に切替');
    } else {
      resetStatusView('モード切替', 'Manual に切替');
    }

    updateModeUI();
    saveState();

    if (state.scanMode) {
      log('scanner flush', { reason: 'mode-change', buffer: '' });
      setStatusView({
        raw: '-',
        normalized: '-',
        result: '待機中',
        patientName: '-',
        department: '-',
        patientNo: '-',
        note: 'Scan受信待機中'
      });
    }
  }

  function normalizeInput(raw) {
    const source = String(raw || '').trim();
    const removed = source.replace(/^SCN\+/i, '').trim();
    const strictDigits = removed.match(/^(\d+)$/);
    if (strictDigits) return strictDigits[1];
    const digits = removed.match(/(\d{3,})/);
    return digits ? digits[1] : removed;
  }

  function getText(el) {
    return (el && el.textContent ? el.textContent : '').trim();
  }

  function findPatientRows(normalizedInput) {
    const rows = Array.from(document.querySelectorAll('tr'));
    return rows.filter(row => {
      const text = getText(row).replace(/\s+/g, ' ');
      return normalizedInput && text.includes(normalizedInput);
    });
  }

  function findStatusInRow(row) {
    const statusCell = row.querySelector('td[data-label*="ステータス"], td[class*="status"], td:nth-last-child(2)');
    return getText(statusCell);
  }

  function findDepartmentInRow(row) {
    const depCell = row.querySelector('td[data-label*="診療科"], td[class*="department"]');
    return getText(depCell);
  }

  function findNameInRow(row) {
    const nameCell = row.querySelector('td[data-label*="氏名"], td[data-label*="患者"], td[class*="name"]');
    return getText(nameCell);
  }

  function findStatusButton(row) {
    const selectors = [
      'td[data-label*="ステータス"] button',
      'button[aria-label*="ステータス"]',
      'button[class*="status"]',
      'button'
    ];
    for (const sel of selectors) {
      const btn = row.querySelector(sel);
      if (btn) return btn;
    }
    return null;
  }

  function findMenuRoot() {
    return document.querySelector('[role="menu"], [role="listbox"], .el-select-dropdown, .v-menu__content, .menuable__content__active, .el-popover');
  }

  function findReceptionItem(root) {
    if (!root) return null;
    const candidates = Array.from(root.querySelectorAll('li, button, [role="option"], [role="menuitem"], .el-dropdown-menu__item, .v-list-item'));
    return candidates.find(el => /受付/.test(getText(el))) || null;
  }

  function findReceptionEditButton(row) {
    const candidates = Array.from(row.querySelectorAll('button, a'));
    return candidates.find(el => /受付編集|編集/.test(getText(el))) || null;
  }

  async function withRowRetries(row, label, finder) {
    let el = finder();
    if (el) {
      log(`${label} found`, true);
      return el;
    }

    for (let i = 0; i < 2; i += 1) {
      row.scrollIntoView({ block: 'center' });
      log('target row scrolled?', { attempt: i + 2, success: true });
      await sleep(i === 0 ? 260 : 360);
      el = finder();
      if (el) {
        log(`${label} found`, true);
        return el;
      }
    }

    log(`${label} found`, false);
    return null;
  }

  async function updatePatientStatus(row) {
    const beforeStatus = findStatusInRow(row) || '-';
    log('before status', beforeStatus);

    const statusButton = await withRowRetries(row, 'status button', () => findStatusButton(row));
    if (!statusButton) {
      return {
        ok: false,
        note: '対象患者は検索一致したが、操作DOMが未描画の可能性',
        afterStatus: beforeStatus,
        menuOpened: false,
        receptionItemFound: false,
        editFound: false
      };
    }

    statusButton.click();
    await sleep(180);
    const menu = findMenuRoot();
    const menuOpened = Boolean(menu);
    log('menu opened?', menuOpened);

    let receptionItem = null;
    if (menu) {
      receptionItem = findReceptionItem(menu);
    }

    if (!receptionItem) {
      row.scrollIntoView({ block: 'center' });
      log('target row scrolled?', { attempt: 'menu-retry', success: true });
      await sleep(260);
      const menu2 = findMenuRoot();
      receptionItem = findReceptionItem(menu2);
    }

    const receptionItemFound = Boolean(receptionItem);
    log('reception item found?', receptionItemFound);

    if (receptionItem) {
      receptionItem.click();
      await sleep(220);
    }

    const editBtn = await withRowRetries(row, 'reception edit button', () => findReceptionEditButton(row));
    const editFound = Boolean(editBtn);
    log('reception edit button found?', editFound);

    if (editBtn) {
      editBtn.click();
      await sleep(180);
    }

    const afterStatus = findStatusInRow(row) || '-';
    log('after status', afterStatus);

    return {
      ok: receptionItemFound || editFound,
      note: receptionItemFound || editFound ? 'ステータス変更を試行しました' : '対象患者は検索一致したが、操作DOMが未描画の可能性',
      afterStatus,
      menuOpened,
      receptionItemFound,
      editFound
    };
  }

  async function execute(rawInputOverride) {
    const raw = typeof rawInputOverride === 'string'
      ? rawInputOverride
      : (ui.textarea.value || '');

    const normalized = normalizeInput(raw);
    log('raw input', raw);
    log('normalized input', normalized);

    if (!normalized) {
      setStatusView({ raw, normalized: '-', result: '入力エラー', note: '患者番号を認識できません' });
      log('final result', '入力エラー');
      return;
    }

    const matchedRows = findPatientRows(normalized);
    log('matched rows', matchedRows.length);

    if (!matchedRows.length) {
      setStatusView({
        raw,
        normalized,
        result: '対象なし',
        patientNo: normalized,
        note: '対象患者は検索一致したが、操作DOMが未描画の可能性'
      });
      log('final result', '対象行が見つかりません');
      return;
    }

    const row = matchedRows[0];
    const patientName = findNameInRow(row) || '-';
    const department = findDepartmentInRow(row) || '-';

    const result = await updatePatientStatus(row);

    setStatusView({
      raw,
      normalized,
      result: result.ok ? '実行完了' : '実行失敗',
      patientName,
      department,
      patientNo: normalized,
      note: result.note
    });

    log('final result', result);
  }

  function flushScanner(reason) {
    const raw = state.scannerBuffer.trim();
    log('scanner flush', { reason, buffer: raw });
    if (!raw) return;

    state.lastScanRaw = raw;
    ui.textarea.value = raw;
    setStatusView({
      raw,
      normalized: normalizeInput(raw),
      result: '受信完了',
      patientName: '-',
      department: '-',
      patientNo: '-',
      note: `スキャン受信: ${raw}`
    });

    state.scannerBuffer = '';
    execute(raw);
  }

  function handleGlobalKeydown(e) {
    if (!state.scanMode) return;

    if (e.ctrlKey || e.altKey || e.metaKey) return;

    if (e.key === 'Enter') {
      if (state.scannerBuffer) {
        e.preventDefault();
        flushScanner('enter');
      }
      return;
    }

    if (e.key.length === 1) {
      state.scannerBuffer += e.key;
      log('scanner buffer', state.scannerBuffer);

      clearTimeout(state.scannerTimer);
      state.scannerTimer = setTimeout(() => {
        flushScanner('timeout');
      }, SCAN_TIMEOUT_MS);
    }
  }

  function buildPanel() {
    const panel = document.createElement('div');
    panel.id = PANEL_ID;
    panel.style.cssText = [
      'position: fixed',
      'right: 12px',
      'top: 12px',
      'width: 340px',
      'z-index: 2147483646',
      'background: #fff',
      'color: #000',
      'border: 1px solid #000',
      'border-radius: 8px',
      'box-shadow: 0 8px 20px rgba(0,0,0,0.2)',
      'font-size: 12px',
      'line-height: 1.5'
    ].join(';');

    const header = document.createElement('div');
    header.style.cssText = 'display:flex;align-items:center;justify-content:space-between;padding:8px;border-bottom:1px solid #000;font-weight:700;';
    header.textContent = 'Pointer V1.0.4';

    const minBtn = document.createElement('button');
    minBtn.type = 'button';
    minBtn.textContent = state.minimized ? '復元' : '最小化';
    minBtn.style.cssText = 'background:#fff;color:#000;border:1px solid #000;border-radius:4px;padding:2px 8px;cursor:pointer;margin-left:auto;';
    header.appendChild(minBtn);

    const body = document.createElement('div');
    body.style.cssText = 'padding:8px;display:flex;flex-direction:column;gap:8px;';

    const row = document.createElement('div');
    row.style.cssText = 'display:flex;gap:8px;';

    const modeBtn = document.createElement('button');
    modeBtn.type = 'button';
    modeBtn.style.cssText = 'flex:1;background:#fff;color:#000;border:1px solid #000;border-radius:4px;padding:6px;cursor:pointer;font-weight:700;';

    const execBtn = document.createElement('button');
    execBtn.type = 'button';
    execBtn.textContent = 'Execute';
    execBtn.style.cssText = 'flex:1;background:#fff;color:#000;border:1px solid #000;border-radius:4px;padding:6px;cursor:pointer;font-weight:700;';

    row.appendChild(modeBtn);
    row.appendChild(execBtn);

    const textarea = document.createElement('textarea');
    textarea.style.cssText = 'width:100%;height:64px;background:#fff;color:#000;border:1px solid #000;border-radius:4px;padding:6px;resize:vertical;';
    textarea.placeholder = '患者番号 / SCN+患者番号';

    const statusView = document.createElement('div');
    statusView.style.cssText = 'border:1px solid #000;border-radius:4px;padding:6px;white-space:pre-line;min-height:110px;background:#fff;color:#000;';

    body.appendChild(row);
    body.appendChild(textarea);
    body.appendChild(statusView);

    panel.appendChild(header);
    panel.appendChild(body);
    document.body.appendChild(panel);

    ui.panel = panel;
    ui.modeBtn = modeBtn;
    ui.textarea = textarea;
    ui.statusView = statusView;
    ui.body = body;
    ui.minBtn = minBtn;

    modeBtn.addEventListener('click', () => setMode(!state.scanMode));
    execBtn.addEventListener('click', () => execute());
    minBtn.addEventListener('click', () => {
      state.minimized = !state.minimized;
      ui.body.style.display = state.minimized ? 'none' : 'flex';
      minBtn.textContent = state.minimized ? '復元' : '最小化';
      saveState();
    });

    ui.body.style.display = state.minimized ? 'none' : 'flex';
    minBtn.textContent = state.minimized ? '復元' : '最小化';
    updateModeUI();

    if (state.scanMode) {
      setStatusView({ raw: '-', normalized: '-', result: '待機中', patientName: '-', department: '-', patientNo: '-', note: 'Scan受信待機中' });
    } else {
      resetStatusView('待機中', 'Manual に切替');
    }
  }

  function init() {
    if (document.getElementById(PANEL_ID)) return;
    loadState();
    buildPanel();
    window.addEventListener('keydown', handleGlobalKeydown, true);
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init, { once: true });
  } else {
    init();
  }
})();
