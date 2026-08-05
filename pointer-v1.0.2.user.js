// ==UserScript==
// @name         Pointer V1.0.2
// @namespace    https://digikar.jp/reception/
// @version      1.0.2
// @description  受付支援 Pointer。SCN+/手入力対応、患者検索結果表示、ステータスを予約済/会計済などから受付中へ変更。
// @match        https://digikar.jp/reception/*
// @match        https://*.digikar.jp/reception/*
// @grant        none
// ==/UserScript==

(function () {
  'use strict';

  const LOG_PREFIX = '[Pointer V1.0.2]';
  const TARGET_STATUS = '受付中';
  const PANEL_ID = 'tm-pointer-v102-panel';

  const state = {
    enabled: true,
    rawInput: '',
    normalized: '',
    result: '待機中',
    patientName: '-',
    department: '-',
    patientNo: '-',
    note: '-'
  };

  function log(...args) {
    console.log(LOG_PREFIX, ...args);
  }

  function wait(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
  }

  function normalizePatientNumber(raw) {
    const source = String(raw ?? '');
    const trimmed = source.trim();
    const removedPrefix = trimmed.replace(/^SCN\+/i, '');
    const digits = removedPrefix.match(/\d+/g);
    const normalized = digits ? digits.join('') : '';

    return {
      raw: source,
      trimmed,
      removedPrefix,
      normalized,
      valid: normalized.length > 0
    };
  }

  function normalizeHeaderText(text) {
    return String(text || '').replace(/\s+/g, '').trim();
  }

  function findReceptionTable() {
    const tables = Array.from(document.querySelectorAll('table'));
    let best = null;
    let bestScore = -1;

    for (const table of tables) {
      const headerCells = table.querySelectorAll('thead th, tr th');
      if (!headerCells.length) continue;

      const headers = Array.from(headerCells).map(th => normalizeHeaderText(th.textContent));
      const score =
        (headers.some(h => h.includes('患者番号') || h === 'ID') ? 3 : 0) +
        (headers.some(h => h.includes('患者氏名') || h.includes('氏名')) ? 2 : 0) +
        (headers.some(h => h.includes('診療科')) ? 2 : 0) +
        (headers.some(h => h.includes('ステータス')) ? 2 : 0);

      if (score > bestScore) {
        bestScore = score;
        best = table;
      }
    }

    return best;
  }

  function buildColumnMap(table) {
    const map = {
      patientNo: -1,
      patientName: -1,
      department: -1,
      status: -1
    };

    const headerRow = table.querySelector('thead tr') || table.querySelector('tr');
    if (!headerRow) return map;

    const headers = Array.from(headerRow.children).map(cell => normalizeHeaderText(cell.textContent));

    headers.forEach((h, i) => {
      if (map.patientNo < 0 && (h.includes('患者番号') || h === 'ID' || h.includes('患者ID'))) map.patientNo = i;
      if (map.patientName < 0 && (h.includes('患者氏名') || h.includes('氏名') || h.includes('患者名'))) map.patientName = i;
      if (map.department < 0 && h.includes('診療科')) map.department = i;
      if (map.status < 0 && h.includes('ステータス')) map.status = i;
    });

    return map;
  }

  function cellText(cells, idx) {
    if (idx < 0 || idx >= cells.length) return '';
    return String(cells[idx].textContent || '').trim();
  }

  function findStatusButtonInRow(row, statusColIdx) {
    const cells = row.querySelectorAll('td');
    const scoped = statusColIdx >= 0 && statusColIdx < cells.length ? cells[statusColIdx] : row;

    const candidates = Array.from(scoped.querySelectorAll('button,[role="button"],div[aria-haspopup="menu"],span[aria-haspopup="menu"]'));
    const prioritized = candidates.find(el => {
      const txt = String(el.textContent || '').trim();
      return /予約済|会計済|受付中|受付済|診察待|診察中/.test(txt);
    });

    if (prioritized) return prioritized;

    const menuButton = candidates.find(el => el.getAttribute('aria-haspopup') === 'menu');
    if (menuButton) return menuButton;

    return candidates[0] || null;
  }

  function dispatchClickSequence(el) {
    if (!el) return;
    const options = { bubbles: true, cancelable: true, composed: true, button: 0 };
    el.dispatchEvent(new PointerEvent('pointerdown', options));
    el.dispatchEvent(new MouseEvent('mousedown', options));
    el.dispatchEvent(new MouseEvent('mouseup', options));
    el.dispatchEvent(new MouseEvent('click', options));
  }

  async function openStatusMenu(button) {
    dispatchClickSequence(button);
    await wait(80);

    for (let i = 0; i < 12; i++) {
      const menuItem = findMenuItem(TARGET_STATUS);
      if (menuItem) {
        return true;
      }
      await wait(80);
    }
    return false;
  }

  function findMenuItem(label) {
    const selectors = [
      '[role="menuitem"]',
      '[data-radix-collection-item]',
      '[data-radix-menu-content] [tabindex]',
      '[aria-label]'
    ];

    for (const selector of selectors) {
      const items = Array.from(document.querySelectorAll(selector));
      const found = items.find(item => String(item.textContent || '').replace(/\s+/g, '').includes(label));
      if (found) return found;
    }

    const fallbackNodes = Array.from(document.querySelectorAll('div,button,span'));
    return fallbackNodes.find(node => {
      const txt = String(node.textContent || '').replace(/\s+/g, '');
      return txt === label || txt.endsWith(label);
    }) || null;
  }

  function rowStatusText(row, statusColIdx) {
    const cells = row.querySelectorAll('td');
    const txt = cellText(cells, statusColIdx);
    return txt || String(row.textContent || '').trim();
  }

  async function updateStatusToReceptionInProgress(target) {
    const beforeStatus = rowStatusText(target.row, target.colMap.status);
    log('変更前ステータス:', beforeStatus);

    const statusButton = findStatusButtonInRow(target.row, target.colMap.status);
    if (!statusButton) {
      return { ok: false, message: 'ステータスボタンが見つかりません', beforeStatus, afterStatus: beforeStatus, menuOpened: false, foundReceptionOption: false };
    }

    const menuOpened = await openStatusMenu(statusButton);
    log('メニューオープン:', menuOpened);

    if (!menuOpened) {
      return { ok: false, message: 'ステータスメニューを開けませんでした', beforeStatus, afterStatus: rowStatusText(target.row, target.colMap.status), menuOpened: false, foundReceptionOption: false };
    }

    const receptionItem = findMenuItem(TARGET_STATUS);
    const foundReceptionOption = Boolean(receptionItem);
    log('受付中メニュー検出:', foundReceptionOption);

    if (!receptionItem) {
      return { ok: false, message: 'メニュー内に「受付中」が見つかりません', beforeStatus, afterStatus: rowStatusText(target.row, target.colMap.status), menuOpened: true, foundReceptionOption: false };
    }

    dispatchClickSequence(receptionItem);
    await wait(300);

    let afterStatus = rowStatusText(target.row, target.colMap.status);
    for (let i = 0; i < 10 && !afterStatus.includes(TARGET_STATUS); i++) {
      await wait(150);
      afterStatus = rowStatusText(target.row, target.colMap.status);
    }

    log('変更後ステータス:', afterStatus);
    const ok = afterStatus.includes(TARGET_STATUS);

    return {
      ok,
      message: ok ? 'ステータスを受付中へ変更しました' : 'ステータス変更後の確認に失敗しました',
      beforeStatus,
      afterStatus,
      menuOpened,
      foundReceptionOption
    };
  }

  function findRowsByPatientNo(normalizedNo) {
    const table = findReceptionTable();
    if (!table) {
      return { table: null, colMap: null, matches: [] };
    }

    const colMap = buildColumnMap(table);
    const bodyRows = Array.from(table.querySelectorAll('tbody tr')).filter(row => row.querySelectorAll('td').length > 0);

    const matches = bodyRows
      .map(row => {
        const cells = row.querySelectorAll('td');
        const patientNoText = cellText(cells, colMap.patientNo);
        const extractedNo = (patientNoText.match(/\d+/g) || []).join('');

        return {
          row,
          colMap,
          patientNoText,
          extractedNo,
          patientName: cellText(cells, colMap.patientName) || '-',
          department: cellText(cells, colMap.department) || '-',
          status: cellText(cells, colMap.status) || '-'
        };
      })
      .filter(item => item.extractedNo === normalizedNo);

    return { table, colMap, matches };
  }

  function findReceptionEditButton(row) {
    const selectors = [
      'button',
      '[role="button"]',
      'a'
    ];

    for (const selector of selectors) {
      const elements = Array.from(row.querySelectorAll(selector));
      const found = elements.find(el => /受付編集|編集|受付/.test(String(el.textContent || '').trim()));
      if (found) return found;
    }

    return null;
  }

  async function proceedReceptionEdit(row) {
    const btn = findReceptionEditButton(row);
    if (!btn) {
      log('受付編集ボタン未検出。ステータス変更のみで終了します。');
      return { ok: false, message: '受付編集ボタン未検出（ステータス変更のみ実施）' };
    }

    dispatchClickSequence(btn);
    await wait(120);
    return { ok: true, message: '受付編集へ遷移しました' };
  }

  function setState(patch) {
    Object.assign(state, patch);
    renderState();
  }

  function makeButton(label, onClick, opts = {}) {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.textContent = label;
    btn.style.cssText = [
      'padding:8px 12px',
      'border:1px solid #111',
      'border-radius:8px',
      'background:#fff',
      'color:#000',
      'font-weight:700',
      'cursor:pointer',
      'min-width:80px'
    ].join(';');
    if (opts.id) btn.id = opts.id;
    btn.addEventListener('click', onClick);
    return btn;
  }

  function createPanel() {
    if (document.getElementById(PANEL_ID)) return;

    const panel = document.createElement('section');
    panel.id = PANEL_ID;
    panel.style.cssText = [
      'position:fixed',
      'right:16px',
      'bottom:16px',
      'z-index:999999',
      'width:360px',
      'background:#fff',
      'color:#000',
      'border:1px solid #333',
      'border-radius:12px',
      'box-shadow:0 8px 24px rgba(0,0,0,0.2)',
      'font-family:system-ui,-apple-system,Segoe UI,Roboto,sans-serif',
      'padding:12px'
    ].join(';');

    panel.innerHTML = `
      <div style="font-size:16px;font-weight:800;margin-bottom:8px;">Pointer V1.0.2</div>
      <label style="display:block;font-size:12px;margin-bottom:6px;">患者番号入力（SCN+ 互換 / 数字のみ可）</label>
      <input id="tm-pointer-input" type="text" autocomplete="off" placeholder="例: 10175 / SCN+10175" style="width:100%;box-sizing:border-box;padding:8px;border:1px solid #333;border-radius:8px;background:#fff;color:#000;margin-bottom:8px;" />
      <div id="tm-pointer-btns" style="display:flex;gap:8px;flex-wrap:wrap;margin-bottom:10px;"></div>
      <div id="tm-pointer-state" style="border:1px solid #333;border-radius:8px;padding:8px;background:#fff;color:#000;font-size:12px;line-height:1.6;"></div>
    `;

    document.body.appendChild(panel);

    const input = panel.querySelector('#tm-pointer-input');
    const btns = panel.querySelector('#tm-pointer-btns');

    const runBtn = makeButton('実行', () => runFromInput());
    const clearBtn = makeButton('クリア', () => {
      input.value = '';
      setState({
        rawInput: '',
        normalized: '',
        result: 'クリアしました',
        patientName: '-',
        department: '-',
        patientNo: '-',
        note: '-'
      });
      input.focus();
    });
    const onBtn = makeButton('ON', () => {
      state.enabled = !state.enabled;
      onBtn.textContent = state.enabled ? 'ON' : 'OFF';
      onBtn.style.opacity = state.enabled ? '1' : '0.6';
      setState({ note: state.enabled ? 'スキャナー入力待機ON' : 'スキャナー入力待機OFF' });
    });
    const manualBtn = makeButton('Manual', () => input.focus());

    btns.append(runBtn, clearBtn, onBtn, manualBtn);

    input.addEventListener('keydown', e => {
      if (e.key === 'Enter') {
        e.preventDefault();
        runFromInput();
      }
    });

    renderState();
  }

  function renderState() {
    const stateBox = document.querySelector('#tm-pointer-state');
    if (!stateBox) return;

    const isError = /失敗|エラー|なし|見つかりません|開けません/.test(state.result + state.note);

    stateBox.style.borderColor = isError ? '#c00' : '#333';
    stateBox.innerHTML = `
      <div><strong>読取文字:</strong> ${escapeHtml(state.rawInput || '-')}</div>
      <div><strong>正規化後:</strong> ${escapeHtml(state.normalized || '-')}</div>
      <div><strong>結果:</strong> ${escapeHtml(state.result || '-')}</div>
      <div><strong>患者氏名:</strong> ${escapeHtml(state.patientName || '-')}</div>
      <div><strong>診療科:</strong> ${escapeHtml(state.department || '-')}</div>
      <div><strong>患者番号:</strong> ${escapeHtml(state.patientNo || '-')}</div>
      <div><strong>補足:</strong> ${escapeHtml(state.note || '-')}</div>
    `;
  }

  function escapeHtml(text) {
    return String(text || '')
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#39;');
  }

  async function runFromInput(rawOverride) {
    const input = document.querySelector('#tm-pointer-input');
    const raw = typeof rawOverride === 'string' ? rawOverride : (input ? input.value : '');

    const normalized = normalizePatientNumber(raw);
    log('検索対象番号(raw):', raw, 'normalized:', normalized.normalized);

    setState({
      rawInput: raw,
      normalized: normalized.normalized || '-',
      result: '処理中...',
      patientName: '-',
      department: '-',
      patientNo: '-',
      note: `trim=${normalized.trimmed || '-'} / prefix除去=${normalized.removedPrefix || '-'}`
    });

    if (!normalized.valid) {
      const message = '数字を抽出できません（入力を確認してください）';
      log('実行失敗:', message);
      setState({ result: 'エラー', note: message });
      return;
    }

    const { table, matches } = findRowsByPatientNo(normalized.normalized);
    log('一致行の有無:', matches.length > 0, '件数:', matches.length);

    if (!table) {
      const message = '受付一覧テーブルが見つかりません';
      log('実行失敗:', message);
      setState({ result: 'エラー', note: message });
      return;
    }

    if (!matches.length) {
      const message = '該当患者なし';
      log('実行失敗:', message);
      setState({
        result: message,
        patientNo: normalized.normalized,
        note: '患者番号一致が見つかりませんでした'
      });
      return;
    }

    const target = matches[0];
    const multiMessage = matches.length > 1 ? `複数候補あり(${matches.length}件)。先頭候補を使用` : '1件一致';

    log('取得した患者氏名:', target.patientName);
    log('取得した診療科:', target.department);

    setState({
      result: `検索成功 (${multiMessage})`,
      patientName: target.patientName,
      department: target.department,
      patientNo: target.extractedNo || normalized.normalized,
      note: `現在ステータス: ${target.status || '-'} / ${multiMessage}`
    });

    const statusResult = await updateStatusToReceptionInProgress(target);
    log('ステータス更新結果:', statusResult);

    if (!statusResult.ok) {
      setState({
        result: 'ステータス変更失敗',
        note: `${statusResult.message}（前:${statusResult.beforeStatus || '-'} 後:${statusResult.afterStatus || '-'}）`
      });
      log('実行成否: 失敗');
      return;
    }

    const editResult = await proceedReceptionEdit(target.row);

    setState({
      result: '実行成功',
      note: `${statusResult.message} / ${editResult.message}`
    });

    log('変更前ステータス:', statusResult.beforeStatus);
    log('変更後ステータス:', statusResult.afterStatus);
    log('メニューが開いたか:', statusResult.menuOpened);
    log('「受付中」が見つかったか:', statusResult.foundReceptionOption);
    log('実行成否: 成功');
  }

  function setupScannerCompatibility() {
    let buffer = '';
    let timer = null;

    const flush = () => {
      if (!buffer) return;
      const value = buffer;
      buffer = '';
      runFromInput(value);
    };

    window.addEventListener('keydown', event => {
      if (!state.enabled) return;
      if (event.isComposing) return;

      if (event.key === 'Enter') {
        if (buffer) {
          event.preventDefault();
          flush();
        }
        return;
      }

      if (event.key.length === 1) {
        buffer += event.key;
        if (timer) clearTimeout(timer);
        timer = setTimeout(() => {
          if (buffer.startsWith('SCN+') || /^\d+$/.test(buffer)) {
            flush();
          } else {
            buffer = '';
          }
        }, 120);
      }
    }, true);
  }

  function init() {
    createPanel();
    setupScannerCompatibility();
    log('初期化完了');
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init, { once: true });
  } else {
    init();
  }
})();
