// ==UserScript==
// @name         Pointer V1.0.8
// @namespace    https://digikar.jp/reception/
// @version      1.0.8
// @description  患者番号を受け取り、受付一覧から該当行のステータスを「受付中」に変更し、成功時のみ受付編集を開く（V1.0.7 DOM操作方式）
// @match        https://digikar.jp/reception/*
// @match        https://*.digikar.jp/reception/*
// @run-at       document-idle
// @grant        none
// ==/UserScript==

(function () {
  'use strict';

  const TARGET_STATUS = '受付中';
  const CHANGEABLE_STATUSES = ['受付済', '診察待', '再診待', '検査待', '検査戻り', '処置待'];
  const STATUS_LABELS = {
    '受付中': '受付中',
    '受付済': '受付済',
    '診察待': '診察待',
    '診察中': '診察中',
    '再診待': '再診待',
    '検査中': '検査中',
    '検査待': '検査待',
    '検査戻り': '検査戻り',
    '処置待': '処置待',
    '処置中': '処置中',
    '会計済': '会計済'
  };

  const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
  const normalizeText = (text) => String(text || '').replace(/\s+/g, ' ').trim();
  const normalizeLooseText = (text) => normalizeText(text).replace(/[：:]/g, '').replace(/[\u3000]/g, '');

  function findReceptionTable() {
    const tables = Array.from(document.querySelectorAll('table'));
    return tables.find((table) => normalizeLooseText(table.innerText).includes('ステータス') && normalizeLooseText(table.innerText).includes('患者')) || null;
  }

  function buildColumnMap(table) {
    const map = {};
    const ths = Array.from(table.querySelectorAll('thead th, tr th'));
    ths.forEach((th, idx) => {
      const text = normalizeLooseText(th.textContent);
      if (text.includes('患者番号') || text === 'id' || text.includes('患者id')) map.patientNo = idx;
      if (text.includes('ステータス')) map.status = idx;
    });
    return map;
  }

  function getBodyRows(table) {
    return Array.from(table.querySelectorAll('tbody tr')).filter((tr) => tr.querySelectorAll('td').length > 0);
  }

  function cellText(row, index) {
    const cell = row.querySelectorAll('td')[index];
    return normalizeText(cell ? cell.textContent : '');
  }

  function extractStatusFromText(text) {
    const src = normalizeLooseText(text);
    for (const key of Object.keys(STATUS_LABELS)) {
      if (src.includes(normalizeLooseText(key))) return STATUS_LABELS[key];
    }
    return '';
  }

  function extractRowInfo(row, columnMap) {
    const patientNo = cellText(row, columnMap.patientNo);
    const statusText = cellText(row, columnMap.status);
    return { row, patientNo, status: extractStatusFromText(statusText) || statusText };
  }

  function findRowsByPatientNo(rows, columnMap, patientNo) {
    const needle = normalizeLooseText(patientNo);
    return rows.map((row) => extractRowInfo(row, columnMap)).filter((info) => normalizeLooseText(info.patientNo) === needle);
  }

  function highlightRow(row) {
    row.style.outline = '2px solid #2563eb';
    row.style.backgroundColor = '#eff6ff';
    setTimeout(() => {
      row.style.outline = '';
      row.style.backgroundColor = '';
    }, 1500);
  }

  function dispatchClickSequence(el) {
    ['pointerdown', 'mousedown', 'mouseup', 'click'].forEach((type) => {
      el.dispatchEvent(new MouseEvent(type, { bubbles: true, cancelable: true, view: window }));
    });
  }

  function findStatusCell(row, columnMap) {
    return row.querySelectorAll('td')[columnMap.status] || null;
  }

  function isVisible(el) {
    if (!el) return false;
    const rect = el.getBoundingClientRect();
    const style = getComputedStyle(el);
    return rect.width > 0 && rect.height > 0 && style.visibility !== 'hidden' && style.display !== 'none';
  }

  function scoreStatusCandidate(el) {
    const text = normalizeLooseText(el.textContent);
    let score = 0;
    if (text.includes('ステータス')) score += 10;
    if (el.matches('button,[role="button"],.btn,.dropdown-toggle')) score += 5;
    if (isVisible(el)) score += 5;
    return score;
  }

  function findStatusButtonInRow(row, statusCell) {
    const candidates = Array.from((statusCell || row).querySelectorAll('button,[role="button"],a,span,div'))
      .filter((el) => isVisible(el) && /ステータス|受付|診察|検査|処置|▼|▾/.test(normalizeText(el.textContent)));
    if (candidates.length === 0) return statusCell;
    return candidates.sort((a, b) => scoreStatusCandidate(b) - scoreStatusCandidate(a))[0];
  }

  function findMenuRoots() {
    return Array.from(document.querySelectorAll('ul,div,[role="menu"],.dropdown-menu,.menu')).filter(isVisible);
  }

  function pickBestMenuRoot(roots) {
    return roots.sort((a, b) => b.getBoundingClientRect().width * b.getBoundingClientRect().height - a.getBoundingClientRect().width * a.getBoundingClientRect().height)[0] || null;
  }

  function findClickableMenuTarget(root, label) {
    const needle = normalizeLooseText(label);
    const items = Array.from(root.querySelectorAll('li,button,a,[role="menuitem"],div,span')).filter(isVisible);
    return items.find((el) => normalizeLooseText(el.textContent).includes(needle)) || null;
  }

  function findReceptionMenuItem(root) {
    return findClickableMenuTarget(root, TARGET_STATUS);
  }

  async function waitForMenuAndOption(timeoutMs = 2000) {
    const started = Date.now();
    while (Date.now() - started < timeoutMs) {
      const root = pickBestMenuRoot(findMenuRoots());
      if (root) {
        const option = findReceptionMenuItem(root);
        if (option) return { root, option };
      }
      await wait(80);
    }
    return null;
  }

  async function waitForInteractiveDom(timeoutMs = 2500) {
    const started = Date.now();
    while (Date.now() - started < timeoutMs) {
      if (document.body && document.querySelector('table')) return true;
      await wait(100);
    }
    return false;
  }

  function scrollAndReacquire(row) {
    row.scrollIntoView({ block: 'center', behavior: 'instant' });
    return row;
  }

  async function openStatusMenu(row, columnMap) {
    const statusCell = findStatusCell(row, columnMap);
    const btn = findStatusButtonInRow(row, statusCell);
    if (!btn) return { ok: false, reason: 'status_button_not_found' };
    dispatchClickSequence(btn);
    const menu = await waitForMenuAndOption();
    if (!menu) return { ok: false, reason: 'status_menu_not_found' };
    return { ok: true, ...menu };
  }

  async function updateStatusToReception(patientNo) {
    await waitForInteractiveDom();
    const table = findReceptionTable();
    if (!table) return { ok: false, reason: 'reception_table_not_found' };

    const colMap = buildColumnMap(table);
    if (typeof colMap.patientNo !== 'number' || typeof colMap.status !== 'number') {
      return { ok: false, reason: 'required_columns_not_found' };
    }

    const rows = getBodyRows(table);
    const matched = findRowsByPatientNo(rows, colMap, patientNo);
    if (matched.length === 0) return { ok: false, reason: 'patient_not_found' };

    const target = matched[0];
    highlightRow(target.row);
    scrollAndReacquire(target.row);

    const currentStatus = extractStatusFromText(target.status);
    if (currentStatus === TARGET_STATUS) {
      return { ok: true, reason: 'already_target_status' };
    }
    if (!CHANGEABLE_STATUSES.includes(currentStatus)) {
      return { ok: false, reason: `status_not_changeable:${currentStatus}` };
    }

    const opened = await openStatusMenu(target.row, colMap);
    if (!opened.ok) return opened;

    dispatchClickSequence(opened.option);
    await wait(250);

    const refreshedRows = getBodyRows(table);
    const refreshed = findRowsByPatientNo(refreshedRows, colMap, patientNo)[0];
    const afterStatus = refreshed ? extractStatusFromText(refreshed.status) : '';

    if (afterStatus === TARGET_STATUS) {
      return { ok: true, reason: 'status_changed', from: currentStatus, to: afterStatus };
    }
    return { ok: false, reason: `status_change_verify_failed:${afterStatus || 'unknown'}` };
  }

  function logStatusResult(patientNo, statusResult) {
    const boxId = 'pointer-v108-log';
    let box = document.getElementById(boxId);
    if (!box) {
      box = document.createElement('div');
      box.id = boxId;
      box.style.cssText = 'position:fixed;right:12px;bottom:12px;z-index:99999;background:#111827;color:#fff;padding:10px 12px;border-radius:8px;font-size:12px;max-width:420px;';
      document.body.appendChild(box);
    }
    const message = `[Pointer V1.0.8] patientNo=${patientNo} result=${statusResult.ok ? 'OK' : 'NG'} reason=${statusResult.reason}`;
    console.log(message, statusResult);
    box.textContent = message;
  }

  async function runPointerV108(patientNo, openReceptionEdit) {
    const statusResult = await updateStatusToReception(patientNo);
    logStatusResult(patientNo, statusResult);
    if (statusResult.ok === true) {
      return openReceptionEdit(patientNo);
    }
    return null;
  }

  window.PointerV108 = {
    TARGET_STATUS,
    CHANGEABLE_STATUSES,
    STATUS_LABELS,
    updateStatusToReception,
    runPointerV108
  };
})();
