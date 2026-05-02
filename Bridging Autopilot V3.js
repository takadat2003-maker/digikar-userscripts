// ==UserScript==
// @name         Bridging Autopilot V3
// @namespace    https://digikar.jp/reception/
// @version      3.0.0
// @description  Bridge V3 パネル表示 + Autopilotでトップ3件を中待合待（中待合室/診察待）へ自動寄せ
// @match        https://digikar.jp/reception/*
// @match        https://*.digikar.jp/reception/*
// @run-at       document-idle
// @grant        none
// ==/UserScript==

(function () {
  'use strict';

  const CONFIG = {
    panelId: 'tm-bridge-autopilot-v3-panel',
    uiStorageKey: 'tmBridgeAutopilotUiStateV3',
    feedStorageKey: 'tmBridgeAutopilotFeedV1',

    tickMs: 1500,
    cooldownMs: 20000,
    maxTargets: 3,

    title: 'Bridge V3',

    headers: {
      patientNo: ['患者番号', '患者ID', 'ID'],
      patientName: ['患者氏名', '氏名', '患者名', '名前'],
      department: ['診療科'],
      status: ['ステータス']
    },

    middleDeptCandidates: ['中待合室', '中待合'],
    targetDepartment: '中待合室',
    targetStatus: '診察待'
  };

  let panelEl = null;
  let bodyEl = null;
  let frontEl = null;
  let middleEl = null;
  let returnEl = null;
  let autopilotBtnEl = null;
  let processing = false;
  const lastActionAt = new Map();

  function normalizeText(text) {
    return String(text || '').replace(/\s+/g, '').trim();
  }

  function sleep(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
  }

  function readUiState() {
    try {
      const raw = localStorage.getItem(CONFIG.uiStorageKey);
      const parsed = raw ? JSON.parse(raw) : {};
      return {
        top: typeof parsed.top === 'number' ? parsed.top : 16,
        left: typeof parsed.left === 'number' ? parsed.left : Math.max(16, window.innerWidth - 280),
        minimized: Boolean(parsed.minimized),
        autopilotEnabled: typeof parsed.autopilotEnabled === 'boolean' ? parsed.autopilotEnabled : false
      };
    } catch (_e) {
      return {
        top: 16,
        left: Math.max(16, window.innerWidth - 280),
        minimized: false,
        autopilotEnabled: false
      };
    }
  }

  function writeUiState(next) {
    try {
      localStorage.setItem(CONFIG.uiStorageKey, JSON.stringify(next));
    } catch (e) {
      console.warn('[Bridge V3] uiState save failed:', e);
    }
  }

  function loadBridgePayload() {
    try {
      const raw = localStorage.getItem(CONFIG.feedStorageKey);
      if (!raw) return null;
      const parsed = JSON.parse(raw);
      if (!parsed || typeof parsed !== 'object') return null;
      return parsed;
    } catch (e) {
      console.warn('[Bridge V3] feed parse failed:', e);
      return null;
    }
  }

  function escapeHtml(text) {
    return String(text || '')
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#39;');
  }

  function findTableByHeaders() {
    const tables = Array.from(document.querySelectorAll('table'));
    for (const table of tables) {
      const headerRow = table.querySelector('thead tr') || table.querySelector('tr');
      if (!headerRow) continue;
      const cells = Array.from(headerRow.querySelectorAll('th,td'));
      const normalized = cells.map(c => normalizeText(c.textContent));
      const hasPatientNo = CONFIG.headers.patientNo.some(name => normalized.includes(normalizeText(name)));
      const hasDepartment = CONFIG.headers.department.some(name => normalized.includes(normalizeText(name)));
      const hasStatus = CONFIG.headers.status.some(name => normalized.includes(normalizeText(name)));
      if (hasPatientNo && hasDepartment && hasStatus) return table;
    }
    return null;
  }

  function pickColumns(table) {
    const headerRow = table.querySelector('thead tr') || table.querySelector('tr');
    const cols = {
      patientNo: -1,
      patientName: -1,
      department: -1,
      status: -1
    };
    if (!headerRow) return cols;

    const cells = Array.from(headerRow.querySelectorAll('th,td'));
    cells.forEach((cell, index) => {
      const text = normalizeText(cell.textContent);
      if (cols.patientNo < 0 && CONFIG.headers.patientNo.some(x => normalizeText(x) === text)) cols.patientNo = index;
      if (cols.patientName < 0 && CONFIG.headers.patientName.some(x => normalizeText(x) === text)) cols.patientName = index;
      if (cols.department < 0 && CONFIG.headers.department.some(x => normalizeText(x) === text)) cols.department = index;
      if (cols.status < 0 && CONFIG.headers.status.some(x => normalizeText(x) === text)) cols.status = index;
    });

    return cols;
  }

  function getCell(row, index) {
    if (index < 0) return null;
    return row.querySelectorAll('td')[index] || null;
  }

  function getCellText(row, index) {
    const cell = getCell(row, index);
    return cell ? String(cell.textContent || '').trim() : '';
  }

  function findRowByPatientNo(patientNo) {
    if (!patientNo) return null;
    const table = findTableByHeaders();
    if (!table) return null;

    const cols = pickColumns(table);
    if (cols.patientNo < 0) return null;

    const rows = Array.from(table.querySelectorAll('tbody tr'));
    const key = normalizeText(patientNo);
    for (const row of rows) {
      const rowNo = normalizeText(getCellText(row, cols.patientNo));
      if (rowNo && rowNo === key) {
        return { row, cols };
      }
    }
    return null;
  }

  function isAlreadyMiddleWaiting(row, cols) {
    const dept = normalizeText(getCellText(row, cols.department));
    const status = normalizeText(getCellText(row, cols.status));
    const isMiddle = CONFIG.middleDeptCandidates.some(name => normalizeText(name) === dept);
    return isMiddle && status === normalizeText(CONFIG.targetStatus);
  }

  function isAlreadyMiddleWaitingPatient(patient) {
    if (!patient) return false;
    const dept = normalizeText(patient.department);
    const status = normalizeText(patient.status);
    const isMiddle = CONFIG.middleDeptCandidates.some(name => normalizeText(name) === dept);
    return isMiddle && status === normalizeText(CONFIG.targetStatus);
  }

  function getCandidatePatients(payload) {
    const front = Array.isArray(payload?.patients?.frontWaiting) ? payload.patients.frontWaiting : [];
    const middle = Array.isArray(payload?.patients?.middleWaiting) ? payload.patients.middleWaiting : [];

    const merged = [...front, ...middle];
    const uniq = [];
    const seen = new Set();

    for (const p of merged) {
      const patientNo = String(p?.patientNo || '').trim();
      if (!patientNo) continue;
      if (seen.has(patientNo)) continue;
      seen.add(patientNo);
      if (isAlreadyMiddleWaitingPatient(p)) continue;
      uniq.push({
        patientNo,
        patientName: String(p?.patientName || '').trim(),
        department: String(p?.department || '').trim(),
        status: String(p?.status || '').trim(),
        prevStatus: String(p?.prevStatus || '').trim(),
        situation: String(p?.situation || '').trim()
      });
      if (uniq.length >= CONFIG.maxTargets) break;
    }

    return uniq;
  }

  function trySetNativeSelect(cell, targetText) {
    const selects = Array.from(cell.querySelectorAll('select'));
    for (const select of selects) {
      const options = Array.from(select.options || []);
      const found = options.find(opt => normalizeText(opt.textContent) === normalizeText(targetText));
      if (!found) continue;
      select.value = found.value;
      select.dispatchEvent(new Event('input', { bubbles: true }));
      select.dispatchEvent(new Event('change', { bubbles: true }));
      return true;
    }
    return false;
  }

  function findClickableByText(text) {
    const targets = Array.from(document.querySelectorAll('li,button,a,span,div'));
    const norm = normalizeText(text);
    return targets.find(el => {
      if (!(el instanceof HTMLElement)) return false;
      if (!el.offsetParent) return false;
      const t = normalizeText(el.textContent || '');
      return t === norm || t.includes(norm);
    }) || null;
  }

  async function clickCellAndPick(cell, targetText) {
    if (!(cell instanceof HTMLElement)) return false;

    cell.dispatchEvent(new MouseEvent('mousedown', { bubbles: true }));
    cell.click();
    cell.dispatchEvent(new MouseEvent('mouseup', { bubbles: true }));
    await sleep(120);

    let optionEl = findClickableByText(targetText);
    if (!optionEl) {
      cell.dispatchEvent(new MouseEvent('dblclick', { bubbles: true }));
      await sleep(120);
      optionEl = findClickableByText(targetText);
    }

    if (optionEl) {
      optionEl.click();
      await sleep(120);
      return true;
    }

    return false;
  }

  async function updateDepartment(row, cols) {
    const deptCell = getCell(row, cols.department);
    if (!deptCell) {
      console.warn('[Bridge V3] department cell not found');
      return false;
    }

    const currentDept = getCellText(row, cols.department);
    if (CONFIG.middleDeptCandidates.some(name => normalizeText(name) === normalizeText(currentDept))) {
      return true;
    }

    if (trySetNativeSelect(deptCell, CONFIG.targetDepartment)) {
      await sleep(150);
      return true;
    }

    const ok = await clickCellAndPick(deptCell, CONFIG.targetDepartment);
    if (!ok) {
      console.warn('[Bridge V3] department update menu not opened or target not found');
      return false;
    }
    return true;
  }

  async function updateStatus(row, cols) {
    const statusCell = getCell(row, cols.status);
    if (!statusCell) {
      console.warn('[Bridge V3] status cell not found');
      return false;
    }

    const currentStatus = getCellText(row, cols.status);
    if (normalizeText(currentStatus) === normalizeText(CONFIG.targetStatus)) {
      return true;
    }

    if (trySetNativeSelect(statusCell, CONFIG.targetStatus)) {
      await sleep(150);
      return true;
    }

    const ok = await clickCellAndPick(statusCell, CONFIG.targetStatus);
    if (!ok) {
      console.warn('[Bridge V3] status update menu not opened or target not found');
      return false;
    }
    return true;
  }

  async function promotePatientToMiddleWaiting(target) {
    const found = findRowByPatientNo(target.patientNo);
    if (!found) {
      console.warn(`[Bridge V3] row not found: ${target.patientNo} ${target.patientName}`);
      return false;
    }

    const { row, cols } = found;

    if (isAlreadyMiddleWaiting(row, cols)) {
      return false;
    }

    const deptOk = await updateDepartment(row, cols);
    if (!deptOk) {
      console.warn(`[Bridge V3] dept update failed: ${target.patientNo} ${target.patientName}`);
      return false;
    }

    await sleep(220);

    const statusOk = await updateStatus(row, cols);
    if (!statusOk) {
      console.warn(`[Bridge V3] status update failed: ${target.patientNo} ${target.patientName}`);
      return false;
    }

    await sleep(200);

    if (!isAlreadyMiddleWaiting(row, cols)) {
      console.warn(`[Bridge V3] verification failed after update: ${target.patientNo} ${target.patientName}`);
      return false;
    }

    console.info(`[Bridge V3] promoted: ${target.patientNo} ${target.patientName}`);
    return true;
  }

  function inCooldown(patientNo) {
    const t = lastActionAt.get(patientNo);
    if (!t) return false;
    return Date.now() - t < CONFIG.cooldownMs;
  }

  async function runAutopilotTick() {
    const state = readUiState();
    if (!state.autopilotEnabled) return;
    if (processing) return;

    const payload = loadBridgePayload();
    if (!payload) return;

    const targets = getCandidatePatients(payload);
    if (!targets.length) return;

    processing = true;
    try {
      for (const p of targets) {
        if (inCooldown(p.patientNo)) continue;
        const success = await promotePatientToMiddleWaiting(p);
        if (success) {
          lastActionAt.set(p.patientNo, Date.now());
        }
      }
    } catch (e) {
      console.warn('[Bridge V3] autopilot tick error:', e);
    } finally {
      processing = false;
    }
  }

  function createPanel() {
    const existing = document.getElementById(CONFIG.panelId);
    if (existing) existing.remove();

    const state = readUiState();

    panelEl = document.createElement('div');
    panelEl.id = CONFIG.panelId;
    panelEl.style.cssText = [
      'position:fixed',
      `top:${state.top}px`,
      `left:${state.left}px`,
      'z-index:2147483647',
      'width:260px',
      'font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,"Hiragino Kaku Gothic ProN","Yu Gothic",sans-serif',
      'font-size:13px',
      'color:#0f172a',
      'background:rgba(255,255,255,0.97)',
      'border:1px solid #cbd5e1',
      'border-radius:10px',
      'box-shadow:0 12px 24px rgba(15,23,42,.2)',
      'user-select:none'
    ].join(';');

    const header = document.createElement('div');
    header.style.cssText = [
      'display:flex',
      'align-items:center',
      'justify-content:space-between',
      'gap:8px',
      'padding:8px 10px',
      'background:#1e3a8a',
      'color:#fff',
      'border-radius:10px 10px 0 0',
      'cursor:move'
    ].join(';');

    const title = document.createElement('div');
    title.textContent = CONFIG.title;
    title.style.fontWeight = '700';

    const right = document.createElement('div');
    right.style.cssText = 'display:flex;align-items:center;gap:6px;';

    autopilotBtnEl = document.createElement('button');
    autopilotBtnEl.type = 'button';
    autopilotBtnEl.style.cssText = 'border:none;border-radius:6px;padding:3px 8px;font-size:12px;cursor:pointer;';
    autopilotBtnEl.addEventListener('click', () => {
      const next = readUiState();
      next.autopilotEnabled = !next.autopilotEnabled;
      writeUiState(next);
      syncAutopilotButton(next.autopilotEnabled);
    });

    const minBtn = document.createElement('button');
    minBtn.type = 'button';
    minBtn.textContent = state.minimized ? '＋' : '－';
    minBtn.style.cssText = 'border:none;background:#fff;color:#1e3a8a;border-radius:6px;padding:2px 8px;font-weight:700;cursor:pointer;';
    minBtn.addEventListener('click', () => {
      const next = readUiState();
      next.minimized = !next.minimized;
      writeUiState(next);
      bodyEl.style.display = next.minimized ? 'none' : 'block';
      minBtn.textContent = next.minimized ? '＋' : '－';
    });

    right.appendChild(autopilotBtnEl);
    right.appendChild(minBtn);
    header.appendChild(title);
    header.appendChild(right);

    bodyEl = document.createElement('div');
    bodyEl.style.cssText = `padding:10px;display:${state.minimized ? 'none' : 'block'};`;

    frontEl = document.createElement('div');
    middleEl = document.createElement('div');
    returnEl = document.createElement('div');

    [frontEl, middleEl, returnEl].forEach(el => {
      el.style.cssText = 'padding:4px 0;line-height:1.4;';
      bodyEl.appendChild(el);
    });

    const tsEl = document.createElement('div');
    tsEl.id = `${CONFIG.panelId}-ts`;
    tsEl.style.cssText = 'margin-top:6px;font-size:11px;color:#475569;';
    bodyEl.appendChild(tsEl);

    panelEl.appendChild(header);
    panelEl.appendChild(bodyEl);
    document.body.appendChild(panelEl);

    makeDraggable(panelEl, header);
    syncAutopilotButton(state.autopilotEnabled);
  }

  function syncAutopilotButton(enabled) {
    if (!autopilotBtnEl) return;
    autopilotBtnEl.textContent = enabled ? 'Autopilot ON' : 'Autopilot OFF';
    autopilotBtnEl.style.background = enabled ? '#dcfce7' : '#e2e8f0';
    autopilotBtnEl.style.color = enabled ? '#166534' : '#334155';
  }

  function makeDraggable(panel, handle) {
    let dragging = false;
    let startX = 0;
    let startY = 0;
    let baseTop = 0;
    let baseLeft = 0;

    handle.addEventListener('mousedown', (e) => {
      if (e.button !== 0) return;
      dragging = true;
      startX = e.clientX;
      startY = e.clientY;

      const state = readUiState();
      baseTop = state.top;
      baseLeft = state.left;

      e.preventDefault();
    });

    window.addEventListener('mousemove', (e) => {
      if (!dragging) return;
      const dx = e.clientX - startX;
      const dy = e.clientY - startY;
      const top = Math.max(0, baseTop + dy);
      const left = Math.max(0, baseLeft + dx);
      panel.style.top = `${top}px`;
      panel.style.left = `${left}px`;
    });

    window.addEventListener('mouseup', () => {
      if (!dragging) return;
      dragging = false;
      const top = parseInt(panel.style.top, 10) || 0;
      const left = parseInt(panel.style.left, 10) || 0;
      const state = readUiState();
      writeUiState({ ...state, top, left });
    });
  }

  function renderPanel() {
    if (!panelEl) return;

    const payload = loadBridgePayload();
    const counts = payload?.counts || {};

    const frontWaiting = Number.isFinite(counts.frontWaiting) ? counts.frontWaiting : 0;
    const middleWaiting = Number.isFinite(counts.middleWaiting) ? counts.middleWaiting : 0;
    const returnGroup = Number.isFinite(counts.returnGroup) ? counts.returnGroup : 0;

    frontEl.textContent = `受付前待 ${frontWaiting}`;
    middleEl.textContent = `中待合待 ${middleWaiting}`;
    returnEl.textContent = `再帰群 ${returnGroup}`;

    const tsEl = document.getElementById(`${CONFIG.panelId}-ts`);
    if (tsEl) {
      tsEl.innerHTML = payload?.writtenAt
        ? `feed: ${escapeHtml(new Date(payload.writtenAt).toLocaleTimeString())}`
        : 'feed: (no data)';
    }
  }

  function startLoops() {
    setInterval(renderPanel, 1000);
    setInterval(() => {
      runAutopilotTick();
    }, CONFIG.tickMs);
  }

  function boot() {
    createPanel();
    renderPanel();
    startLoops();
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', boot, { once: true });
  } else {
    boot();
  }
})();
