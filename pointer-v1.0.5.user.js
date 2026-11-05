// ==UserScript==
// @name         Pointer V1.0.5
// @namespace    https://digikar.jp/reception/
// @version      1.0.5
// @description  患者番号入力/スキャンで対象患者を検出し、ステータスを受付中へ変更して受付編集を開く（DOM再取得・再試行強化版）
// @match        https://digikar.jp/reception/*
// @match        https://*.digikar.jp/reception/*
// @grant        none
// ==/UserScript==

(function () {
  'use strict';

  const SCRIPT_NAME = 'Pointer V1.0.5';
  const LOG_PREFIX = '[Pointer V1.0.5]';

  const STORAGE_KEY = 'pointer_v1_0_5_state';
  const PANEL_ID = 'pointer-v105-panel';
  const TEXTAREA_ID = 'pointer-v105-input';

  const STATUS_TARGET = '受付中';
  const STATUS_CHANGEABLE = ['予約済', '会計済'];
  const STATUS_HINTS = ['予約済', '会計済', '受付中', '診察待', '診察中', '検査中', '処置中'];

  const DEFAULT_STATE = {
    enabled: true,
    mode: 'scan', // 'manual' | 'scan'
    minimized: false,
  };

  let state = loadState();
  let ui = null;
  let executeLock = false;

  let scanner = {
    bound: false,
    buffer: '',
    timer: null,
    lastTime: 0,
    timeoutMs: 200,
  };

  function log(...args) {
    console.log(LOG_PREFIX, ...args);
  }

  function warn(...args) {
    console.warn(LOG_PREFIX, ...args);
  }

  function error(...args) {
    console.error(LOG_PREFIX, ...args);
  }

  function sleep(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }

  function normalizeText(text) {
    return String(text || '').replace(/\s+/g, '').trim();
  }

  function loadState() {
    try {
      const raw = localStorage.getItem(STORAGE_KEY);
      if (!raw) return { ...DEFAULT_STATE };
      const parsed = JSON.parse(raw);
      return {
        enabled: typeof parsed.enabled === 'boolean' ? parsed.enabled : DEFAULT_STATE.enabled,
        mode: parsed.mode === 'manual' ? 'manual' : 'scan',
        minimized: typeof parsed.minimized === 'boolean' ? parsed.minimized : DEFAULT_STATE.minimized,
      };
    } catch (e) {
      warn('state load failed', e);
      return { ...DEFAULT_STATE };
    }
  }

  function saveState() {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(state));
  }

  function setStatusView(patch = {}) {
    if (!ui) return;
    const merged = {
      raw: patch.raw ?? ui.statusData.raw ?? '-',
      normalized: patch.normalized ?? ui.statusData.normalized ?? '-',
      result: patch.result ?? ui.statusData.result ?? '-',
      patientName: patch.patientName ?? ui.statusData.patientName ?? '-',
      department: patch.department ?? ui.statusData.department ?? '-',
      patientNo: patch.patientNo ?? ui.statusData.patientNo ?? '-',
      note: patch.note ?? ui.statusData.note ?? '-',
    };
    ui.statusData = merged;
    ui.statusRaw.textContent = merged.raw;
    ui.statusNormalized.textContent = merged.normalized;
    ui.statusResult.textContent = merged.result;
    ui.statusPatientName.textContent = merged.patientName;
    ui.statusDepartment.textContent = merged.department;
    ui.statusPatientNo.textContent = merged.patientNo;
    ui.statusNote.textContent = merged.note;
  }

  function resetStatusView(note = '-') {
    setStatusView({
      raw: '-',
      normalized: '-',
      result: '-',
      patientName: '-',
      department: '-',
      patientNo: '-',
      note,
    });
  }

  function parsePatientNumber(rawInput) {
    const raw = String(rawInput || '').trim();
    const match = raw.match(/(\d{2,})/g);
    if (!match || !match.length) {
      return { ok: false, raw, normalized: '', message: '患者番号の数字を抽出できません' };
    }
    const normalized = match[match.length - 1];
    return { ok: true, raw, normalized, message: '' };
  }

  function clickSequence(el) {
    if (!el) return false;
    const events = ['pointerdown', 'mousedown', 'pointerup', 'mouseup', 'click'];
    try {
      el.focus?.({ preventScroll: true });
    } catch (_) {}
    for (const type of events) {
      const evt = new MouseEvent(type, {
        bubbles: true,
        cancelable: true,
        view: window,
      });
      el.dispatchEvent(evt);
    }
    return true;
  }

  function enterKey(el) {
    if (!el) return;
    for (const type of ['keydown', 'keyup']) {
      const evt = new KeyboardEvent(type, {
        key: 'Enter',
        code: 'Enter',
        bubbles: true,
      });
      el.dispatchEvent(evt);
    }
  }

  function getAllRows() {
    return Array.from(document.querySelectorAll('table tbody tr'));
  }

  function extractRowInfo(row) {
    const cells = Array.from(row.querySelectorAll('td'));
    const texts = cells.map((c) => c.textContent || '');
    const rowText = texts.join(' | ');

    let patientNo = '';
    for (const t of texts) {
      const m = t.replace(/\s+/g, '').match(/\b(\d{2,})\b/);
      if (m) {
        patientNo = m[1];
        break;
      }
    }
    if (!patientNo) {
      const m = rowText.replace(/\s+/g, '').match(/\b(\d{2,})\b/);
      if (m) patientNo = m[1];
    }

    let status = '';
    for (const t of texts) {
      const compact = normalizeText(t);
      if (STATUS_HINTS.some((s) => compact.includes(s))) {
        const hit = STATUS_HINTS.find((s) => compact.includes(s));
        status = hit || status;
      }
    }

    const patientName = texts.find((t) => /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}]{2,}/u.test(t) && !STATUS_HINTS.some((s) => t.includes(s)))?.trim() || '';
    const department = texts.find((t) => t.includes('科') || t.includes('外来') || t.includes('処置'))?.trim() || '';

    return {
      row,
      patientNo,
      patientName,
      department,
      status,
      rowText,
    };
  }

  function findMatchedRows(patientNo) {
    const rows = getAllRows();
    const infos = rows.map(extractRowInfo);
    return infos.filter((info) => info.patientNo === patientNo || normalizeText(info.rowText).includes(patientNo));
  }

  async function reacquireRowByPatientNo(patientNo, waitMs = 0) {
    if (waitMs > 0) await sleep(waitMs);
    const matches = findMatchedRows(patientNo);
    return matches.length ? matches[0] : null;
  }

  function waitForElementWithin(root, selector, timeoutMs = 1500) {
    return new Promise((resolve) => {
      const foundNow = root.querySelector(selector);
      if (foundNow) {
        resolve(foundNow);
        return;
      }

      const timer = setTimeout(() => {
        observer.disconnect();
        resolve(null);
      }, timeoutMs);

      const observer = new MutationObserver(() => {
        const found = root.querySelector(selector);
        if (found) {
          clearTimeout(timer);
          observer.disconnect();
          resolve(found);
        }
      });

      observer.observe(root, { childList: true, subtree: true });
    });
  }

  function scoreStatusButton(el) {
    const txt = normalizeText(el.textContent || el.getAttribute('aria-label') || el.getAttribute('title') || '');
    let score = 0;
    if (el.matches('[aria-haspopup="menu"]')) score += 10;
    if (el.matches('[role="button"],button')) score += 8;
    for (const s of STATUS_HINTS) {
      if (txt.includes(s)) score += 20;
    }
    return score;
  }

  async function findStatusButtonWithRetry(patientNo, rowInfo) {
    let latest = rowInfo;
    for (let i = 1; i <= 3; i += 1) {
      if (!latest) latest = await reacquireRowByPatientNo(patientNo, i === 3 ? 300 : 0);
      if (latest) {
        let buttonCandidates = [];
        const cells = Array.from(latest.row.querySelectorAll('td'));
        const statusCell = cells.find((td) => STATUS_HINTS.some((s) => normalizeText(td.textContent).includes(s)));
        const searchRoot = statusCell || latest.row;
        buttonCandidates = Array.from(searchRoot.querySelectorAll('button,[role="button"],[aria-haspopup="menu"]'));

        if (!buttonCandidates.length) {
          await waitForElementWithin(latest.row, 'button,[role="button"],[aria-haspopup="menu"]', 500);
          buttonCandidates = Array.from(searchRoot.querySelectorAll('button,[role="button"],[aria-haspopup="menu"]'));
        }

        if (buttonCandidates.length) {
          buttonCandidates.sort((a, b) => scoreStatusButton(b) - scoreStatusButton(a));
          return { button: buttonCandidates[0], latest, attempt: i, found: true };
        }
      }

      if (latest?.row) {
        latest.row.scrollIntoView({ behavior: 'auto', block: 'center' });
      }
      await sleep(i === 1 ? 350 : 450);
      latest = await reacquireRowByPatientNo(patientNo, 0);
    }

    return { button: null, latest, attempt: 3, found: false };
  }

  async function findOpenedMenu(timeoutMs = 1200) {
    const direct = document.querySelector('[role="menu"], [data-radix-popper-content-wrapper], [data-state="open"]');
    if (direct) return direct;
    return waitForElementWithin(document.body, '[role="menu"], [data-radix-popper-content-wrapper], [data-state="open"]', timeoutMs);
  }

  function findReceptionOption(menuRoot) {
    if (!menuRoot) return null;
    const items = Array.from(menuRoot.querySelectorAll('[role="menuitem"],button,div,span,a'));
    return items.find((el) => normalizeText(el.textContent).includes(STATUS_TARGET)) || null;
  }

  async function getCurrentStatusFromRow(patientNo, fallback) {
    const latest = await reacquireRowByPatientNo(patientNo, 0);
    if (!latest) return fallback || '';
    return latest.status || fallback || '';
  }

  async function changeStatusToReception(patientNo, rowInfo) {
    const result = {
      beforeStatus: rowInfo.status || '',
      afterStatus: rowInfo.status || '',
      menuOpened: false,
      foundReceptionOption: false,
      ok: false,
      message: '',
    };

    if (result.beforeStatus === STATUS_TARGET) {
      result.ok = true;
      result.message = 'すでに受付中です';
      return result;
    }

    if (!STATUS_CHANGEABLE.includes(result.beforeStatus)) {
      result.message = `ステータス変更対象外: ${result.beforeStatus || '不明'}`;
      return result;
    }

    const statusButtonResult = await findStatusButtonWithRetry(patientNo, rowInfo);
    log('status button found?', !!statusButtonResult.button, 'attempt', statusButtonResult.attempt);

    if (!statusButtonResult.button) {
      result.message = '対象患者は検索一致したが、操作DOMが未描画の可能性';
      return result;
    }

    clickSequence(statusButtonResult.button);
    await sleep(120);
    let menu = await findOpenedMenu(800);
    if (!menu) {
      enterKey(statusButtonResult.button);
      await sleep(120);
      menu = await findOpenedMenu(1200);
    }

    result.menuOpened = !!menu;
    if (!menu) {
      result.message = 'ステータスメニューを開けませんでした';
      return result;
    }

    const option = findReceptionOption(menu);
    result.foundReceptionOption = !!option;
    if (!option) {
      result.message = 'メニュー内に「受付中」が見つかりませんでした';
      return result;
    }

    clickSequence(option);
    await sleep(200);

    const started = Date.now();
    while (Date.now() - started < 3000) {
      const current = await getCurrentStatusFromRow(patientNo, result.beforeStatus);
      result.afterStatus = current;
      if (current === STATUS_TARGET) {
        result.ok = true;
        result.message = '受付中へ変更しました';
        return result;
      }
      await sleep(200);
    }

    result.message = 'ステータス変更後の確認で受付中を検出できませんでした';
    return result;
  }

  function scoreReceptionEditCandidate(el) {
    const text = normalizeText(`${el.textContent || ''} ${el.getAttribute('title') || ''} ${el.getAttribute('aria-label') || ''}`);
    let score = 0;
    if (/受付編集/.test(text)) score += 80;
    if (/編集/.test(text)) score += 40;
    if (/受付/.test(text)) score += 25;
    if (el.matches('button,[role="button"]')) score += 8;
    if (el.closest('td:last-child')) score += 6;
    return score;
  }

  function getClickableSvgParents(root) {
    const svgs = Array.from(root.querySelectorAll('svg'));
    const out = [];
    for (const svg of svgs) {
      const p = svg.closest('button,a,[role="button"],div,span');
      if (p) out.push(p);
    }
    return out;
  }

  async function findReceptionEditButtonWithRetry(patientNo, rowInfo) {
    let latest = rowInfo;

    for (let i = 1; i <= 3; i += 1) {
      if (!latest) latest = await reacquireRowByPatientNo(patientNo, i === 3 ? 250 : 0);
      if (latest) {
        const candidates = Array.from(latest.row.querySelectorAll('button,a,[role="button"],[title],[aria-label]'));
        candidates.push(...getClickableSvgParents(latest.row));

        if (!candidates.length) {
          await waitForElementWithin(latest.row, 'button,a,[role="button"],[title],[aria-label],svg', 500);
        }

        const all = Array.from(new Set([...candidates, ...getClickableSvgParents(latest.row)]));
        if (all.length) {
          all.sort((a, b) => scoreReceptionEditCandidate(b) - scoreReceptionEditCandidate(a));
          const best = all[0];
          if (scoreReceptionEditCandidate(best) > 0) {
            return { found: true, button: best, latest, attempt: i };
          }
        }
      }

      if (latest?.row) latest.row.scrollIntoView({ behavior: 'auto', block: 'center' });
      await sleep(i === 1 ? 300 : 450);
      latest = await reacquireRowByPatientNo(patientNo, 0);
    }

    return { found: false, button: null, latest, attempt: 3 };
  }

  async function openReceptionEdit(patientNo, rowInfo) {
    for (let i = 1; i <= 2; i += 1) {
      const found = await findReceptionEditButtonWithRetry(patientNo, rowInfo);
      log('reception edit button found?', found.found, 'attempt', found.attempt);
      if (!found.button) {
        if (i === 2) {
          return { ok: false, message: '受付編集ボタンが見つかりませんでした', found: false };
        }
        await sleep(300);
        continue;
      }

      clickSequence(found.button);
      await sleep(200);

      const opened = !!document.querySelector('[role="dialog"], .modal, [data-state="open"], [aria-modal="true"]');
      if (opened || i === 2) {
        return {
          ok: true,
          message: opened ? '受付編集を開きました' : '受付編集クリックを実行しました',
          found: true,
        };
      }

      await sleep(300);
    }

    return { ok: false, message: '受付編集起動に失敗しました', found: false };
  }

  function getTextarea() {
    return document.getElementById(TEXTAREA_ID);
  }

  function getRawInput(rawOverride) {
    if (typeof rawOverride === 'string') return rawOverride;
    const ta = getTextarea();
    return ta ? ta.value : '';
  }

  function setTextareaValue(value) {
    const ta = getTextarea();
    if (!ta) return;
    ta.value = value;
  }

  async function execute(rawOverride, meta = { source: 'manual' }) {
    if (executeLock) {
      warn('execute skipped: locked');
      return;
    }
    if (!state.enabled) {
      setStatusView({ result: '停止中', note: 'ON/OFF が OFF のため実行しません' });
      return;
    }

    executeLock = true;
    try {
      const rawInput = getRawInput(rawOverride);
      const normalizedResult = parsePatientNumber(rawInput);

      log('current mode', state.mode);
      log('raw input', rawInput);
      log('normalized input', normalizedResult.normalized || '(none)');

      setStatusView({
        raw: rawInput || '-',
        normalized: normalizedResult.normalized || '-',
        result: '処理中',
        patientName: '-',
        department: '-',
        patientNo: '-',
        note: meta.source === 'scan' ? `スキャン受信: ${rawInput}` : '-',
      });

      if (!normalizedResult.ok) {
        setStatusView({ result: '失敗', note: normalizedResult.message });
        warn(normalizedResult.message);
        return;
      }

      const patientNo = normalizedResult.normalized;
      let matches = findMatchedRows(patientNo);
      log('matched rows count', matches.length);

      if (!matches.length) {
        setStatusView({
          result: '失敗',
          patientNo,
          note: '対象患者が見つかりません',
        });
        return;
      }

      if (matches.length > 1) {
        warn('複数候補あり', matches.length);
      }

      let rowInfo = matches[0];
      rowInfo.row.scrollIntoView({ behavior: 'auto', block: 'center' });
      log('row scrolled?', true);
      await sleep(400);

      const reacquired = await reacquireRowByPatientNo(patientNo, 0);
      log('latest row reacquired?', !!reacquired);
      if (reacquired) rowInfo = reacquired;

      const beforeStatus = rowInfo.status || '';
      log('patient name', rowInfo.patientName || '(unknown)');
      log('department', rowInfo.department || '(unknown)');
      log('before status', beforeStatus || '(unknown)');
      log('target status = 受付中');

      setStatusView({
        patientName: rowInfo.patientName || '-',
        department: rowInfo.department || '-',
        patientNo,
        note: matches.length > 1 ? '複数候補あり' : '-',
      });

      const statusResult = await changeStatusToReception(patientNo, rowInfo);
      log('menu opened?', statusResult.menuOpened);
      log('reception option found?', statusResult.foundReceptionOption);
      log('after status', statusResult.afterStatus || '(unknown)');

      let note = `変更前: ${statusResult.beforeStatus || '-'} / 変更後: ${statusResult.afterStatus || '-'}`;
      note += ` / menuOpen:${statusResult.menuOpened} / option:${statusResult.foundReceptionOption}`;

      if (!statusResult.ok) {
        const domMissing = statusResult.message.includes('操作DOMが未描画の可能性');
        if (domMissing) {
          error('対象患者は検索一致したが、操作DOMが未描画の可能性');
        }
        setStatusView({
          result: '失敗',
          note: domMissing ? '対象患者は検索一致したが、操作DOMが未描画の可能性' : `${note} / ${statusResult.message}`,
        });
        log('final result', 'failed', statusResult.message);
        return;
      }

      const editResult = await openReceptionEdit(patientNo, rowInfo);
      const finalNote = `${note} / 受付編集検出:${editResult.found}`;
      if (!editResult.ok) {
        setStatusView({
          result: '一部成功',
          note: `${finalNote} / ${editResult.message}`,
        });
        log('final result', 'partial', editResult.message);
        return;
      }

      setStatusView({
        result: '成功',
        note: finalNote,
      });
      log('final result', 'success');
    } catch (e) {
      error('execute error', e);
      setStatusView({ result: '失敗', note: `例外: ${e.message || e}` });
    } finally {
      executeLock = false;
    }
  }

  function clearInputAndStatus(note = '-') {
    setTextareaValue('');
    resetStatusView(note);
  }

  function updateModeIndicator() {
    if (!ui) return;
    ui.toggleEnabled.textContent = state.enabled ? 'ON' : 'OFF';
    ui.toggleMode.textContent = state.mode === 'scan' ? 'Scan' : 'Manual';
    ui.body.style.display = state.minimized ? 'none' : 'block';
  }

  function handleModeChange(nextMode) {
    state.mode = nextMode;
    saveState();
    clearInputAndStatus(nextMode === 'manual' ? 'Manual に切替' : 'Scan に切替');
    updateModeIndicator();
    setupScannerListener();
    log('current mode', state.mode);
  }

  function onManualTextareaKeydown(e) {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      execute();
    }
  }

  function flushScannerBuffer(reason = 'timeout') {
    if (!scanner.buffer) return;
    const raw = scanner.buffer;
    scanner.buffer = '';
    clearTimeout(scanner.timer);
    scanner.timer = null;

    log('scanner flush', reason, raw);

    setTextareaValue(raw);
    setStatusView({ note: `スキャン受信: ${raw}` });
    execute(raw, { source: 'scan' });
  }

  function handleGlobalKeydown(e) {
    if (!state.enabled || state.mode !== 'scan') return;
    if (e.isComposing) return;

    const active = document.activeElement;
    const editable = active && (
      active.tagName === 'INPUT' ||
      active.tagName === 'TEXTAREA' ||
      active.isContentEditable
    );

    if (editable && active.id !== TEXTAREA_ID) {
      return;
    }

    if (e.key === 'Enter') {
      if (scanner.buffer) {
        e.preventDefault();
        flushScannerBuffer('enter');
      }
      return;
    }

    if (e.key.length === 1) {
      const now = Date.now();
      if (now - scanner.lastTime > 300) {
        scanner.buffer = '';
      }
      scanner.lastTime = now;
      scanner.buffer += e.key;
      log('scanner buffer', scanner.buffer);

      clearTimeout(scanner.timer);
      scanner.timer = setTimeout(() => flushScannerBuffer('timeout'), scanner.timeoutMs);
    }
  }

  function setupScannerListener() {
    if (state.enabled && state.mode === 'scan') {
      if (!scanner.bound) {
        window.addEventListener('keydown', handleGlobalKeydown, true);
        scanner.bound = true;
      }
      return;
    }

    if (scanner.bound) {
      window.removeEventListener('keydown', handleGlobalKeydown, true);
      scanner.bound = false;
    }
    scanner.buffer = '';
    clearTimeout(scanner.timer);
    scanner.timer = null;
  }

  function createButton(text) {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.textContent = text;
    btn.style.background = '#fff';
    btn.style.color = '#111';
    btn.style.border = '1px solid #333';
    btn.style.borderRadius = '6px';
    btn.style.padding = '6px 10px';
    btn.style.cursor = 'pointer';
    btn.style.fontSize = '12px';
    btn.style.fontWeight = '600';
    return btn;
  }

  function createStatusRow(label, valueEl) {
    const row = document.createElement('div');
    row.style.display = 'grid';
    row.style.gridTemplateColumns = '88px 1fr';
    row.style.columnGap = '8px';

    const l = document.createElement('div');
    l.textContent = label;
    l.style.color = '#333';
    l.style.fontSize = '12px';
    l.style.fontWeight = '700';

    valueEl.style.color = '#111';
    valueEl.style.fontSize = '12px';
    valueEl.style.wordBreak = 'break-all';

    row.appendChild(l);
    row.appendChild(valueEl);
    return row;
  }

  function buildPanel() {
    const old = document.getElementById(PANEL_ID);
    if (old) old.remove();

    const panel = document.createElement('div');
    panel.id = PANEL_ID;
    panel.style.position = 'fixed';
    panel.style.top = '16px';
    panel.style.right = '16px';
    panel.style.zIndex = '99999';
    panel.style.width = '360px';
    panel.style.background = '#fff';
    panel.style.border = '1px solid #222';
    panel.style.borderRadius = '10px';
    panel.style.boxShadow = '0 6px 18px rgba(0,0,0,0.2)';
    panel.style.fontFamily = 'sans-serif';

    const header = document.createElement('div');
    header.style.display = 'flex';
    header.style.alignItems = 'center';
    header.style.justifyContent = 'space-between';
    header.style.padding = '8px 10px';
    header.style.borderBottom = '1px solid #ddd';

    const title = document.createElement('div');
    title.textContent = SCRIPT_NAME;
    title.style.fontWeight = '700';
    title.style.fontSize = '13px';

    const headButtons = document.createElement('div');
    headButtons.style.display = 'flex';
    headButtons.style.gap = '6px';

    const btnMin = createButton('－');
    const btnRestore = createButton('□');
    btnMin.style.padding = '2px 8px';
    btnRestore.style.padding = '2px 8px';

    headButtons.appendChild(btnMin);
    headButtons.appendChild(btnRestore);

    header.appendChild(title);
    header.appendChild(headButtons);

    const body = document.createElement('div');
    body.style.padding = '10px';

    const textarea = document.createElement('textarea');
    textarea.id = TEXTAREA_ID;
    textarea.placeholder = '患者番号を入力（例: 10381 または SCN+10381）';
    textarea.style.width = '100%';
    textarea.style.minHeight = '64px';
    textarea.style.boxSizing = 'border-box';
    textarea.style.border = '1px solid #333';
    textarea.style.borderRadius = '8px';
    textarea.style.padding = '8px';
    textarea.style.fontSize = '13px';
    textarea.addEventListener('keydown', onManualTextareaKeydown);

    const buttons = document.createElement('div');
    buttons.style.display = 'grid';
    buttons.style.gridTemplateColumns = 'repeat(5, minmax(0,1fr))';
    buttons.style.gap = '6px';
    buttons.style.marginTop = '8px';

    const btnExecute = createButton('実行');
    const btnClear = createButton('クリア');
    const btnPower = createButton(state.enabled ? 'ON' : 'OFF');
    const btnMode = createButton(state.mode === 'scan' ? 'Scan' : 'Manual');
    const btnDummy = createButton('再描画');

    buttons.appendChild(btnExecute);
    buttons.appendChild(btnClear);
    buttons.appendChild(btnPower);
    buttons.appendChild(btnMode);
    buttons.appendChild(btnDummy);

    const statusBox = document.createElement('div');
    statusBox.style.marginTop = '10px';
    statusBox.style.border = '1px solid #333';
    statusBox.style.borderRadius = '8px';
    statusBox.style.padding = '8px';
    statusBox.style.display = 'grid';
    statusBox.style.rowGap = '4px';

    const vRaw = document.createElement('div');
    const vNorm = document.createElement('div');
    const vRes = document.createElement('div');
    const vName = document.createElement('div');
    const vDept = document.createElement('div');
    const vNo = document.createElement('div');
    const vNote = document.createElement('div');

    statusBox.appendChild(createStatusRow('読取文字', vRaw));
    statusBox.appendChild(createStatusRow('正規化後', vNorm));
    statusBox.appendChild(createStatusRow('結果', vRes));
    statusBox.appendChild(createStatusRow('患者氏名', vName));
    statusBox.appendChild(createStatusRow('診療科', vDept));
    statusBox.appendChild(createStatusRow('患者番号', vNo));
    statusBox.appendChild(createStatusRow('補足', vNote));

    body.appendChild(textarea);
    body.appendChild(buttons);
    body.appendChild(statusBox);

    panel.appendChild(header);
    panel.appendChild(body);
    document.body.appendChild(panel);

    ui = {
      panel,
      body,
      textarea,
      toggleEnabled: btnPower,
      toggleMode: btnMode,
      statusRaw: vRaw,
      statusNormalized: vNorm,
      statusResult: vRes,
      statusPatientName: vName,
      statusDepartment: vDept,
      statusPatientNo: vNo,
      statusNote: vNote,
      statusData: {},
    };

    btnExecute.addEventListener('click', () => execute());
    btnClear.addEventListener('click', () => clearInputAndStatus('クリア'));

    btnPower.addEventListener('click', () => {
      state.enabled = !state.enabled;
      saveState();
      if (!state.enabled) {
        clearInputAndStatus('OFF のため停止中');
      }
      updateModeIndicator();
      setupScannerListener();
    });

    btnMode.addEventListener('click', () => {
      const next = state.mode === 'scan' ? 'manual' : 'scan';
      handleModeChange(next);
    });

    btnDummy.addEventListener('click', () => {
      buildPanel();
      updateModeIndicator();
      resetStatusView('再描画しました');
      setupScannerListener();
    });

    btnMin.addEventListener('click', () => {
      state.minimized = true;
      saveState();
      updateModeIndicator();
    });

    btnRestore.addEventListener('click', () => {
      state.minimized = false;
      saveState();
      updateModeIndicator();
    });

    updateModeIndicator();
    resetStatusView('-');
  }

  function init() {
    if (!/\/reception/.test(location.pathname)) return;
    buildPanel();
    setupScannerListener();
    log('initialized');
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init, { once: true });
  } else {
    init();
  }
})();
