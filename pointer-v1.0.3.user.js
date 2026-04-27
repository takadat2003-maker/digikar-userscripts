// ==UserScript==
// @name         Pointer V1.0.3 (Bugfix)
// @namespace    https://digikar.jp/reception/
// @version      1.0.3
// @description  DigiKar受付画面で患者番号指定→ステータスを受付中に変更→受付編集を開く。最小化/復元UIと検出ロジックを強化。
// @match        https://digikar.jp/reception/*
// @match        https://*.digikar.jp/reception/*
// @grant        none
// ==/UserScript==

(function () {
  'use strict';

  const STORAGE_KEY = 'tmPointerV103State';
  const PANEL_ID = 'tm-pointer-v103-panel';
  const STATUS_LABELS = ['予約済', '会計済', '会計済み', '受付中', '診察待', '診察中', '検査中', '処置中'];
  const TARGET_STATUS = '受付中';
  const FORCE_UPDATE_STATUSES = ['予約済', '会計済', '会計済み'];

  const state = {
    enabled: true,
    manual: true,
    minimized: false,
    lastInputRaw: '',
    lastInputNormalized: '',
    statusView: {
      readText: '-',
      normalized: '-',
      result: '-',
      patientName: '-',
      department: '-',
      patientNo: '-',
      note: '-'
    }
  };

  function loadState() {
    try {
      const saved = JSON.parse(localStorage.getItem(STORAGE_KEY) || '{}');
      if (typeof saved.enabled === 'boolean') state.enabled = saved.enabled;
      if (typeof saved.manual === 'boolean') state.manual = saved.manual;
      if (typeof saved.minimized === 'boolean') state.minimized = saved.minimized;
    } catch (e) {
      console.warn('[Pointer V1.0.3] loadState failed', e);
    }
  }

  function saveState() {
    localStorage.setItem(STORAGE_KEY, JSON.stringify({
      enabled: state.enabled,
      manual: state.manual,
      minimized: state.minimized
    }));
  }

  function normalizeText(text) {
    return String(text || '').replace(/[\u200B-\u200D\uFEFF]/g, '').replace(/\s+/g, ' ').trim();
  }

  function normalizeCompare(text) {
    return normalizeText(text).replace(/\s+/g, '');
  }

  function wait(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
  }

  function dispatchClickSequence(el) {
    if (!el) return false;
    try {
      if (typeof el.focus === 'function') el.focus({ preventScroll: true });
      const rect = el.getBoundingClientRect();
      const x = rect.left + Math.max(1, Math.floor(rect.width / 2));
      const y = rect.top + Math.max(1, Math.floor(rect.height / 2));
      const common = { bubbles: true, cancelable: true, composed: true, view: window, clientX: x, clientY: y, button: 0, buttons: 1 };
      el.dispatchEvent(new PointerEvent('pointerdown', { ...common, pointerId: 1, pointerType: 'mouse', isPrimary: true }));
      el.dispatchEvent(new MouseEvent('mousedown', common));
      el.dispatchEvent(new PointerEvent('pointerup', { ...common, pointerId: 1, pointerType: 'mouse', isPrimary: true }));
      el.dispatchEvent(new MouseEvent('mouseup', common));
      el.dispatchEvent(new MouseEvent('click', common));
      return true;
    } catch (e) {
      console.warn('[Pointer V1.0.3] dispatchClickSequence failed, fallback click', e);
      try {
        el.click();
        return true;
      } catch {
        return false;
      }
    }
  }

  function getTableRows() {
    return Array.from(document.querySelectorAll('table tbody tr'));
  }

  function extractRowInfo(row) {
    const cells = Array.from(row.querySelectorAll('td'));
    const rowText = normalizeText(row.innerText || row.textContent || '');
    const patientNoCandidate = rowText.match(/\b\d{3,}\b/g) || [];
    const patientNo = patientNoCandidate.length ? patientNoCandidate[0] : '';

    let patientName = '';
    let department = '';
    let status = '';

    for (const cell of cells) {
      const t = normalizeText(cell.innerText || cell.textContent || '');
      if (!t) continue;
      if (!status && STATUS_LABELS.some(s => t.includes(s))) status = STATUS_LABELS.find(s => t.includes(s)) || status;
      if (!department && /科|外来|室|待合/.test(t) && t.length <= 30) department = t;
      if (!patientName && /[ぁ-んァ-ヶ一-龥]/.test(t) && !/科|外来|室|待合|会計|受付|診察|検査|処置/.test(t) && t.length <= 20) {
        patientName = t;
      }
    }

    return { cells, rowText, patientNo, patientName, department, status };
  }

  function findRowByPatientNo(patientNoNormalized) {
    const rows = getTableRows();
    const matched = [];
    for (const row of rows) {
      const info = extractRowInfo(row);
      const normalizedRowText = normalizeCompare(info.rowText);
      if (normalizedRowText.includes(patientNoNormalized)) {
        matched.push({ row, info });
      }
    }
    return matched;
  }

  function findStatusCell(row) {
    const cells = Array.from(row.querySelectorAll('td'));
    for (const cell of cells) {
      const text = normalizeText(cell.innerText || cell.textContent || '');
      if (STATUS_LABELS.some(s => text.includes(s))) return cell;
      if (cell.querySelector('[aria-haspopup="menu"], [role="button"], button')) return cell;
    }
    return null;
  }

  function findStatusButtonInRow(row) {
    const statusCell = findStatusCell(row);
    const candidates = [];

    if (statusCell) {
      candidates.push(...statusCell.querySelectorAll('button, [role="button"], [aria-haspopup="menu"]'));
    }

    if (!candidates.length) {
      candidates.push(...row.querySelectorAll('button, [role="button"], [aria-haspopup="menu"]'));
    }

    const scored = candidates.map(el => {
      const t = normalizeText(el.innerText || el.textContent || el.getAttribute('aria-label') || el.getAttribute('title') || '');
      let score = 0;
      if (STATUS_LABELS.some(s => t.includes(s))) score += 100;
      if (el.closest('td') === statusCell) score += 20;
      if (el.getAttribute('aria-haspopup') === 'menu') score += 30;
      return { el, score, text: t };
    }).sort((a, b) => b.score - a.score);

    return scored.length ? scored[0].el : null;
  }

  function findMenuRoot() {
    return document.querySelector('[role="menu"], [data-radix-menu-content], [data-radix-popper-content-wrapper] [role="menu"]');
  }

  function findReceptionMenuItem(menuRoot) {
    if (!menuRoot) return null;

    const menuItems = Array.from(menuRoot.querySelectorAll('[role="menuitem"]'));
    for (const item of menuItems) {
      const t = normalizeCompare(item.innerText || item.textContent || '');
      if (t.includes(normalizeCompare(TARGET_STATUS))) return item;
    }

    const all = Array.from(menuRoot.querySelectorAll('*'));
    for (const el of all) {
      const t = normalizeCompare(el.innerText || el.textContent || '');
      if (t.includes(normalizeCompare(TARGET_STATUS))) return el;
    }

    return null;
  }

  async function openStatusMenu(statusButton) {
    let menuOpened = false;
    let foundReceptionOption = false;

    for (let i = 0; i < 3; i += 1) {
      dispatchClickSequence(statusButton);
      await wait(120);
      const menuRoot = findMenuRoot();
      if (menuRoot) {
        menuOpened = true;
        if (findReceptionMenuItem(menuRoot)) {
          foundReceptionOption = true;
          break;
        }
      }
      if (typeof statusButton.dispatchEvent === 'function') {
        statusButton.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', code: 'Enter', bubbles: true }));
        statusButton.dispatchEvent(new KeyboardEvent('keyup', { key: 'Enter', code: 'Enter', bubbles: true }));
      }
      await wait(120);
    }

    return { menuOpened, foundReceptionOption };
  }

  async function updateStatusToReceptionInProgress(row) {
    const beforeStatus = extractRowInfo(row).status || '';
    let afterStatus = beforeStatus;

    if (normalizeCompare(beforeStatus) === normalizeCompare(TARGET_STATUS)) {
      return {
        ok: true,
        beforeStatus,
        afterStatus,
        menuOpened: true,
        foundReceptionOption: true,
        message: 'すでに受付中のため変更不要'
      };
    }

    if (!FORCE_UPDATE_STATUSES.includes(beforeStatus)) {
      console.warn('[Pointer V1.0.3] unexpected status, continue', { beforeStatus });
    }

    const statusButton = findStatusButtonInRow(row);
    if (!statusButton) {
      return {
        ok: false,
        beforeStatus,
        afterStatus,
        menuOpened: false,
        foundReceptionOption: false,
        message: 'ステータスボタン未検出'
      };
    }

    const openResult = await openStatusMenu(statusButton);
    if (!openResult.menuOpened) {
      return {
        ok: false,
        beforeStatus,
        afterStatus,
        menuOpened: false,
        foundReceptionOption: false,
        message: 'ステータスメニューを開けませんでした'
      };
    }

    const menuRoot = findMenuRoot();
    const receptionItem = findReceptionMenuItem(menuRoot);
    if (!receptionItem) {
      return {
        ok: false,
        beforeStatus,
        afterStatus,
        menuOpened: true,
        foundReceptionOption: false,
        message: 'メニュー内に受付中項目が見つかりません'
      };
    }

    dispatchClickSequence(receptionItem);
    await wait(120);

    if (document.activeElement) {
      document.activeElement.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', code: 'Enter', bubbles: true }));
      document.activeElement.dispatchEvent(new KeyboardEvent('keyup', { key: 'Enter', code: 'Enter', bubbles: true }));
    }

    const deadline = Date.now() + 3000;
    while (Date.now() < deadline) {
      await wait(200);
      afterStatus = extractRowInfo(row).status || '';
      if (normalizeCompare(afterStatus) === normalizeCompare(TARGET_STATUS)) {
        return {
          ok: true,
          beforeStatus,
          afterStatus,
          menuOpened: true,
          foundReceptionOption: true,
          message: '受付中へ変更成功'
        };
      }
    }

    return {
      ok: false,
      beforeStatus,
      afterStatus,
      menuOpened: true,
      foundReceptionOption: true,
      message: `受付中への変更確認失敗(現在:${afterStatus || '不明'})`
    };
  }

  function scoreEditCandidate(el) {
    if (!el) return -1;
    const t = normalizeText([
      el.innerText,
      el.textContent,
      el.getAttribute('aria-label'),
      el.getAttribute('title'),
      el.getAttribute('data-tooltip'),
      el.getAttribute('data-testid')
    ].filter(Boolean).join(' '));

    let score = 0;
    if (/受付編集/.test(t)) score += 150;
    if (/編集/.test(t)) score += 90;
    if (/受付/.test(t)) score += 50;
    if (el.querySelector('svg')) score += 15;
    const td = el.closest('td');
    if (td && td.cellIndex >= 0) score += td.cellIndex;
    return score;
  }

  function findReceptionEditButton(row) {
    const candidates = Array.from(row.querySelectorAll('button, a, [role="button"], [title], [aria-label], svg'))
      .map(el => (el.tagName.toLowerCase() === 'svg' ? el.closest('button, a, [role="button"], [title], [aria-label]') : el))
      .filter(Boolean);

    const uniq = Array.from(new Set(candidates));

    const scored = uniq.map(el => ({ el, score: scoreEditCandidate(el) })).sort((a, b) => b.score - a.score);
    if (scored.length && scored[0].score >= 50) return scored[0].el;

    const clickable = uniq.filter(el => {
      const style = getComputedStyle(el);
      return !el.disabled && style.pointerEvents !== 'none' && style.visibility !== 'hidden' && style.display !== 'none';
    });

    clickable.sort((a, b) => b.getBoundingClientRect().left - a.getBoundingClientRect().left);
    return clickable[0] || null;
  }

  async function proceedReceptionEdit(row) {
    const editBtn = findReceptionEditButton(row);
    if (!editBtn) {
      return { ok: false, found: false, message: '受付編集ボタン未検出' };
    }

    dispatchClickSequence(editBtn);
    await wait(150);

    const dialogOpened = !!document.querySelector('[role="dialog"], .modal, [data-state="open"]');
    if (!dialogOpened) {
      dispatchClickSequence(editBtn);
      await wait(180);
    }

    return { ok: true, found: true, message: '受付編集起動を試行しました' };
  }

  function updateStatusView(partial) {
    state.statusView = { ...state.statusView, ...partial };
    renderStateBox();
  }

  function parsePatientNo(input) {
    const normalized = normalizeCompare(input);
    const m = normalized.match(/\d{3,}/);
    return m ? m[0] : normalized;
  }

  async function execute() {
    if (!state.enabled) return;

    const inputEl = document.querySelector(`#${PANEL_ID} textarea`);
    const rawInput = inputEl ? inputEl.value : '';
    const normalizedInput = normalizeText(rawInput);
    const patientNo = parsePatientNo(rawInput);

    state.lastInputRaw = rawInput;
    state.lastInputNormalized = patientNo;

    console.log('[Pointer V1.0.3] raw input', rawInput);
    console.log('[Pointer V1.0.3] normalized input', patientNo);

    updateStatusView({ readText: rawInput || '-', normalized: patientNo || '-', result: '処理開始', note: '-' });

    if (!patientNo) {
      updateStatusView({ result: '患者番号を解釈できません', note: '入力を確認してください' });
      return;
    }

    const matchedRows = findRowByPatientNo(patientNo);
    console.log('[Pointer V1.0.3] matched rows', matchedRows.length);

    if (!matchedRows.length) {
      updateStatusView({
        patientNo,
        result: '対象行なし',
        note: '患者番号一致行が見つかりません'
      });
      return;
    }

    const target = matchedRows[0];
    const info = target.info;

    console.log('[Pointer V1.0.3] patient name', info.patientName || '-');
    console.log('[Pointer V1.0.3] department', info.department || '-');
    console.log('[Pointer V1.0.3] before status', info.status || '-');
    console.log('[Pointer V1.0.3] target status', TARGET_STATUS);

    updateStatusView({
      patientName: info.patientName || '-',
      department: info.department || '-',
      patientNo: info.patientNo || patientNo,
      note: `変更前ステータス: ${info.status || '不明'}`
    });

    const statusResult = await updateStatusToReceptionInProgress(target.row);

    console.log('[Pointer V1.0.3] menu opened?', statusResult.menuOpened);
    console.log('[Pointer V1.0.3] reception item found?', statusResult.foundReceptionOption);
    console.log('[Pointer V1.0.3] after status', statusResult.afterStatus || '-');

    updateStatusView({
      result: statusResult.ok ? 'ステータス変更成功' : 'ステータス変更失敗',
      note: `変更前: ${statusResult.beforeStatus || '不明'} / 変更後: ${statusResult.afterStatus || '不明'} / menuOpen:${statusResult.menuOpened} / option:${statusResult.foundReceptionOption} / ${statusResult.message}`
    });

    if (!statusResult.ok) {
      console.log('[Pointer V1.0.3] final result', 'status_update_failed');
      return;
    }

    const editResult = await proceedReceptionEdit(target.row);
    console.log('[Pointer V1.0.3] reception edit button found?', editResult.found);
    console.log('[Pointer V1.0.3] final result', editResult.ok ? 'success' : 'edit_open_failed');

    updateStatusView({
      result: editResult.ok ? '完了: 受付編集を起動' : '警告: 受付編集を開けませんでした',
      note: `${state.statusView.note} / 受付編集検出:${editResult.found} / ${editResult.message}`
    });
  }

  function createButton(label, onClick) {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.textContent = label;
    btn.style.background = '#fff';
    btn.style.color = '#000';
    btn.style.border = '1px solid #000';
    btn.style.borderRadius = '6px';
    btn.style.padding = '4px 8px';
    btn.style.cursor = 'pointer';
    btn.style.fontSize = '12px';
    btn.addEventListener('click', onClick);
    return btn;
  }

  function renderStateBox() {
    const panel = document.getElementById(PANEL_ID);
    if (!panel) return;
    const box = panel.querySelector('.tm-pointer-status-box');
    if (!box) return;

    const v = state.statusView;
    box.innerHTML = '';
    const items = [
      ['読取文字', v.readText],
      ['正規化後', v.normalized],
      ['結果', v.result],
      ['患者氏名', v.patientName],
      ['診療科', v.department],
      ['患者番号', v.patientNo],
      ['補足', v.note]
    ];

    for (const [k, val] of items) {
      const line = document.createElement('div');
      line.style.marginBottom = '2px';
      line.textContent = `${k}: ${val || '-'}`;
      box.appendChild(line);
    }
  }

  function renderPanel() {
    let panel = document.getElementById(PANEL_ID);
    if (panel) panel.remove();

    panel = document.createElement('div');
    panel.id = PANEL_ID;
    panel.style.position = 'fixed';
    panel.style.top = '84px';
    panel.style.right = '16px';
    panel.style.width = state.minimized ? '280px' : '380px';
    panel.style.background = '#fff';
    panel.style.border = '1px solid #000';
    panel.style.borderRadius = '10px';
    panel.style.boxShadow = '0 6px 20px rgba(0,0,0,0.2)';
    panel.style.color = '#000';
    panel.style.zIndex = '99999';
    panel.style.fontSize = '12px';

    const header = document.createElement('div');
    header.style.display = 'flex';
    header.style.justifyContent = 'space-between';
    header.style.alignItems = 'center';
    header.style.padding = '8px';
    header.style.borderBottom = '1px solid #000';

    const title = document.createElement('div');
    title.textContent = 'Pointer V1.0.3';
    title.style.fontWeight = '700';

    const headBtns = document.createElement('div');
    headBtns.style.display = 'flex';
    headBtns.style.gap = '6px';

    const minBtn = createButton('－', () => {
      state.minimized = true;
      saveState();
      renderPanel();
    });
    minBtn.title = '最小化';

    const maxBtn = createButton('□', () => {
      state.minimized = false;
      saveState();
      renderPanel();
    });
    maxBtn.title = state.minimized ? '復元' : '最大化/復元';

    headBtns.appendChild(minBtn);
    headBtns.appendChild(maxBtn);

    header.appendChild(title);
    header.appendChild(headBtns);
    panel.appendChild(header);

    const body = document.createElement('div');
    body.style.padding = '8px';
    body.style.display = state.minimized ? 'none' : 'block';

    const input = document.createElement('textarea');
    input.placeholder = '患者番号を入力（例: 12345）';
    input.style.width = '100%';
    input.style.height = '42px';
    input.style.border = '1px solid #000';
    input.style.borderRadius = '6px';
    input.style.padding = '6px';
    input.style.resize = 'vertical';

    const row = document.createElement('div');
    row.style.display = 'flex';
    row.style.flexWrap = 'wrap';
    row.style.gap = '6px';
    row.style.marginTop = '8px';

    row.appendChild(createButton('実行', () => execute()));
    row.appendChild(createButton('クリア', () => {
      input.value = '';
      updateStatusView({
        readText: '-', normalized: '-', result: 'クリア済', patientName: '-', department: '-', patientNo: '-', note: '-'
      });
    }));
    row.appendChild(createButton(state.enabled ? 'ON' : 'OFF', (ev) => {
      state.enabled = !state.enabled;
      ev.currentTarget.textContent = state.enabled ? 'ON' : 'OFF';
      saveState();
    }));
    row.appendChild(createButton(state.manual ? 'Manual' : 'Auto', (ev) => {
      state.manual = !state.manual;
      ev.currentTarget.textContent = state.manual ? 'Manual' : 'Auto';
      saveState();
    }));

    const statusBox = document.createElement('div');
    statusBox.className = 'tm-pointer-status-box';
    statusBox.style.marginTop = '8px';
    statusBox.style.border = '1px solid #000';
    statusBox.style.borderRadius = '6px';
    statusBox.style.padding = '6px';
    statusBox.style.background = '#fff';
    statusBox.style.maxHeight = '180px';
    statusBox.style.overflow = 'auto';

    body.appendChild(input);
    body.appendChild(row);
    body.appendChild(statusBox);
    panel.appendChild(body);

    document.body.appendChild(panel);
    renderStateBox();
  }

  function init() {
    loadState();
    renderPanel();
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init, { once: true });
  } else {
    init();
  }
})();
