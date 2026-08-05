// ==UserScript==
// @name         Pointer V1 全文差し替え版
// @namespace    http://tampermonkey.net/
// @version      1.1.0
// @description  デジカル受付画面で SCN+患者番号 を読み取り、予約患者一覧から完全一致検索してステータスを受付中へ変更後に鉛筆ボタンを押す。手入力/スキャナー切替、ON/OFF、ドラッグ移動、最小化、読取表示つき。
// @match        https://digikar.jp/reception/*
// @match        https://*.digikar.jp/reception/*
// @grant        none
// ==/UserScript==

/*
 * 変更点 (v1.1.0)
 * - 患者一致後の処理を「鉛筆クリック」から
 *   「ステータスを受付中に変更 → 変更確認 → 鉛筆クリック」に変更。
 * - statusChanger.js の fireOpenLike / fireMenuPick を流用し、
 *   updateStatusDirectly(row, "受付中") を Pointer V1 に統合。
 * - ステータス確認を row 内 button の textContent 監視で実装
 *   （最大3秒 / 300ms間隔ポーリング）。
 * - 変更失敗時は鉛筆クリックを行わず「変更失敗」を表示して停止。
 */

(function () {
  'use strict';

  /******************************************************************
   * 設定
   ******************************************************************/
  const PREFIX = 'SCN+';
  const DUPLICATE_GUARD_MS = 2000;
  const SEARCH_DELAY_MS = 150;
  const STATUS_POLL_INTERVAL_MS = 300;
  const STATUS_POLL_TIMEOUT_MS = 3000;
  const TARGET_STATUS = '受付中';

  const ROW_SELECTORS = [
    'tr',
    '[role="row"]'
  ];

  const EDIT_BUTTON_SELECTORS = [
    'button[title*="保険"]',
    'button[aria-label*="保険"]',
    '.fa-pencil',
    '.fa-pen',
    '.glyphicon-pencil',
    '[class*="pencil"]',
    '[class*="edit"]',
    'button'
  ];

  const STATUS_WORDS = [
    '予約済', '受付中', '診察待', '診察中', '検査中', '処置中', '会計待', '会計済', '再計待', '不在', '取消'
  ];

  /******************************************************************
   * 状態
   ******************************************************************/
  let isEnabled = true;
  let inputMode = 'scanner';
  let isProcessing = false;
  let lastScannedId = '';
  let lastScanAt = 0;
  let buffer = '';

  /******************************************************************
   * UI
   ******************************************************************/
  const panel = document.createElement('div');
  panel.id = 'pointer-v1-panel';
  panel.style.position = 'fixed';
  panel.style.top = '60px';
  panel.style.right = '20px';
  panel.style.width = '320px';
  panel.style.background = '#ffffff';
  panel.style.color = '#000000';
  panel.style.border = '1px solid #000000';
  panel.style.borderRadius = '8px';
  panel.style.boxShadow = '0 4px 10px rgba(0,0,0,0.2)';
  panel.style.zIndex = '2147483647';
  panel.style.fontSize = '12px';
  panel.style.fontFamily = 'Arial, sans-serif';
  panel.style.userSelect = 'none';

  panel.innerHTML = `
    <div id="pointer-v1-header" style="cursor:move;display:flex;justify-content:space-between;align-items:center;padding:8px 10px;background:#111827;color:#fff;border-radius:8px 8px 0 0;">
      <div style="font-weight:bold;">Pointer V1</div>
      <div style="display:flex;gap:6px;align-items:center;">
        <button id="pointer-v1-toggle" style="border:none;padding:2px 8px;border-radius:4px;cursor:pointer;">ON</button>
        <button id="pointer-v1-mode" style="border:none;padding:2px 8px;border-radius:4px;cursor:pointer;">Scanner</button>
        <button id="pointer-v1-minimize" style="border:none;padding:2px 8px;border-radius:4px;cursor:pointer;">－</button>
      </div>
    </div>
    <div id="pointer-v1-body" style="padding:10px;">
      <div style="display:flex;gap:6px;margin-bottom:8px;">
        <input id="pointer-v1-input" type="text" style="flex:1;padding:6px;border:1px solid #ccc;border-radius:4px;" placeholder="Scanner待機中" />
        <button id="pointer-v1-exec" style="padding:6px 10px;border:1px solid #111;border-radius:4px;background:#fff;cursor:pointer;">実行</button>
        <button id="pointer-v1-clear" style="padding:6px 10px;border:1px solid #111;border-radius:4px;background:#fff;cursor:pointer;">クリア</button>
      </div>

      <div style="line-height:1.7;">
        <div><b>読取文字</b>：<span id="pointer-v1-raw">-</span></div>
        <div><b>正規化後</b>：<span id="pointer-v1-normalized">-</span></div>
        <div><b>結果</b>：<span id="pointer-v1-result">待機中</span></div>
        <div><b>補足</b>：<span id="pointer-v1-detail">-</span></div>
      </div>
    </div>
  `;

  document.body.appendChild(panel);

  const elHeader = document.getElementById('pointer-v1-header');
  const elBody = document.getElementById('pointer-v1-body');
  const elToggle = document.getElementById('pointer-v1-toggle');
  const elMode = document.getElementById('pointer-v1-mode');
  const elMin = document.getElementById('pointer-v1-minimize');
  const elInput = document.getElementById('pointer-v1-input');
  const elExec = document.getElementById('pointer-v1-exec');
  const elClear = document.getElementById('pointer-v1-clear');
  const elRaw = document.getElementById('pointer-v1-raw');
  const elNormalized = document.getElementById('pointer-v1-normalized');
  const elResult = document.getElementById('pointer-v1-result');
  const elDetail = document.getElementById('pointer-v1-detail');

  /******************************************************************
   * UI補助
   ******************************************************************/
  function setResult(text) {
    elResult.textContent = text;
    console.log('[Pointer V1][RESULT]', text);
  }

  function setDetail(text) {
    elDetail.textContent = text;
    console.log('[Pointer V1][DETAIL]', text);
  }

  function setRaw(text) {
    elRaw.textContent = text || '-';
  }

  function setNormalized(text) {
    elNormalized.textContent = text || '-';
  }

  function syncModeUI() {
    elMode.textContent = inputMode === 'scanner' ? 'Scanner' : 'Manual';
    elInput.readOnly = inputMode === 'scanner';
    elInput.placeholder = inputMode === 'scanner' ? 'Scanner待機中' : 'SCN+110020';
    if (inputMode === 'scanner') {
      elInput.value = buffer;
    }
  }

  function syncToggleUI() {
    elToggle.textContent = isEnabled ? 'ON' : 'OFF';
  }

  /******************************************************************
   * 正規化 / 入力解析
   ******************************************************************/
  function normalizeScanText(text) {
    return String(text ?? '')
      .trim()
      .replace(/＋/g, '+')
      .replace(/\s+/g, '')
      .toUpperCase();
  }

  function parseInput(rawText) {
    const normalized = normalizeScanText(rawText);
    setRaw(String(rawText ?? ''));
    setNormalized(normalized);

    if (!normalized.startsWith(PREFIX)) {
      return { ok: false, reason: 'prefix_error', normalized };
    }

    const patientId = normalized.slice(PREFIX.length);
    if (!/^\d+$/.test(patientId)) {
      return { ok: false, reason: 'id_error', normalized };
    }

    return { ok: true, patientId, normalized };
  }

  /******************************************************************
   * 患者行検索
   ******************************************************************/
  function getAllCandidateRows() {
    const rows = [];
    const seen = new Set();

    for (const selector of ROW_SELECTORS) {
      document.querySelectorAll(selector).forEach((node) => {
        const text = (node.innerText || '').trim();
        if (!text) return;
        if (seen.has(node)) return;
        seen.add(node);
        rows.push(node);
      });
    }

    return rows;
  }

  function isExactPatientIdMatch(text, patientId) {
    const normalizedText = String(text ?? '').replace(/\s+/g, ' ');
    const escaped = patientId.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const re = new RegExp(`(^|\\D)${escaped}(\\D|$)`);
    return re.test(normalizedText);
  }

  function findMatchingRows(patientId) {
    const allRows = getAllCandidateRows();
    const matches = [];

    allRows.forEach((row) => {
      const text = row.innerText || '';
      if (isExactPatientIdMatch(text, patientId)) {
        matches.push(row);
      }
    });

    return { allRows, matches };
  }

  /******************************************************************
   * 鉛筆ボタン
   ******************************************************************/
  function findEditButton(row) {
    for (const selector of EDIT_BUTTON_SELECTORS) {
      const found = row.querySelector(selector);
      if (found) return found;
    }
    return null;
  }

  function clickMatchedRowEdit(row) {
    const btn = findEditButton(row);
    if (!btn) {
      setDetail('鉛筆ボタン未検出');
      return false;
    }

    btn.click();
    setDetail('鉛筆ボタンをクリックしました');
    return true;
  }

  /******************************************************************
   * statusChanger.js 由来イベント処理
   ******************************************************************/
  function fireOpenLike(el) {
    if (!el) return;
    const opt = { bubbles: true, cancelable: true, view: window };
    el.dispatchEvent(new PointerEvent('pointerdown', opt));
    el.dispatchEvent(new MouseEvent('mousedown', opt));
    el.dispatchEvent(new PointerEvent('pointerup', opt));
    el.dispatchEvent(new MouseEvent('mouseup', opt));
    el.dispatchEvent(new MouseEvent('click', opt));
  }

  function fireMenuPick(el) {
    if (!el) return;
    const inner = el.querySelector('span, div, p') || el;
    const optP = { bubbles: true, cancelable: true, view: window, pointerId: 1, pointerType: 'mouse', isPrimary: true };
    const optM = { bubbles: true, cancelable: true, view: window };

    inner.dispatchEvent(new MouseEvent('mousemove', optM));
    inner.dispatchEvent(new MouseEvent('mouseenter', optM));
    inner.dispatchEvent(new PointerEvent('pointermove', optP));
    inner.dispatchEvent(new PointerEvent('pointerenter', optP));
    inner.dispatchEvent(new PointerEvent('pointerover', optP));
    inner.dispatchEvent(new MouseEvent('mouseover', optM));

    inner.dispatchEvent(new PointerEvent('pointerdown', optP));
    inner.dispatchEvent(new MouseEvent('mousedown', optM));
    inner.dispatchEvent(new PointerEvent('pointerup', optP));
    inner.dispatchEvent(new MouseEvent('mouseup', optM));
    inner.dispatchEvent(new MouseEvent('click', optM));

    inner.dispatchEvent(new KeyboardEvent('keydown', { bubbles: true, cancelable: true, key: 'Enter', code: 'Enter' }));
    inner.dispatchEvent(new KeyboardEvent('keyup', { bubbles: true, cancelable: true, key: 'Enter', code: 'Enter' }));
  }

  function sleep(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }

  function getStatusButtonInRow(row) {
    return Array.from(row.querySelectorAll('button'))
      .find((b) => STATUS_WORDS.some((t) => ((b.textContent || '').trim()).includes(t)));
  }

  async function waitForStatusInRow(row, statusText) {
    const deadline = Date.now() + STATUS_POLL_TIMEOUT_MS;

    while (Date.now() < deadline) {
      const statusBtn = Array.from(row.querySelectorAll('button'))
        .find((b) => (b.textContent || '').includes(statusText));

      if (statusBtn) {
        return true;
      }

      await sleep(STATUS_POLL_INTERVAL_MS);
    }

    return false;
  }

  async function updateStatusDirectly(row, statusText) {
    if (!row) return false;

    const statusBtn = getStatusButtonInRow(row);
    if (!statusBtn) {
      setDetail('ステータスボタン未検出');
      return false;
    }

    fireOpenLike(statusBtn);
    await sleep(250);

    const menu = document.querySelector('[role="menu"]');
    if (!menu) {
      setDetail('ステータスメニュー未検出');
      return false;
    }

    const menuItems = Array.from(menu.querySelectorAll('[role="menuitem"]'));
    let target = menuItems.find((el) => (el.innerText || '').replace(/\s+/g, '').includes(statusText));

    if (!target) {
      target = Array.from(menu.querySelectorAll('*'))
        .find((el) => (el.innerText || '').replace(/\s+/g, '').includes(statusText));
    }

    if (!target) {
      setDetail(`メニューに「${statusText}」なし`);
      return false;
    }

    const clickable = (target.querySelector('span, div') || target).closest('[role="menuitem"]') || target.closest('[role="menuitem"]') || target;
    fireMenuPick(clickable);

    return true;
  }

  /******************************************************************
   * メイン検索処理
   ******************************************************************/
  async function searchAndSelect(patientId) {
    const { allRows, matches } = findMatchingRows(patientId);
    setDetail(`走査行数: ${allRows.length}`);

    if (matches.length === 0) {
      setResult('0件ヒット');
      setDetail('受付画面に該当患者なし → 予約なし候補（デジスマへ）');
      return;
    }

    setResult(`${matches.length}件ヒット`);

    if (matches.length === 1) {
      const row = matches[0];

      setResult('ステータス変更中');
      const changed = await updateStatusDirectly(row, TARGET_STATUS);
      if (!changed) {
        setResult('変更失敗');
        setDetail('ステータス変更失敗');
        return;
      }

      const confirmed = await waitForStatusInRow(row, TARGET_STATUS);
      if (!confirmed) {
        setResult('変更失敗');
        setDetail('ステータス変更失敗');
        return;
      }

      setResult('受付中に変更完了');
      const ok = clickMatchedRowEdit(row);
      if (ok) {
        setResult('1件ヒット → 受付中変更後に選択');
      } else {
        setResult('1件ヒット → 鉛筆未検出');
      }
      return;
    }

    setDetail('複数候補ありのため自動選択停止');
  }

  /******************************************************************
   * 実行処理
   ******************************************************************/
  function processScan(rawText) {
    if (!isEnabled) {
      setResult('OFFのため停止中');
      return;
    }

    if (isProcessing) {
      setResult('処理中のため待機');
      return;
    }

    const parsed = parseInput(rawText);
    if (!parsed.ok) {
      if (parsed.reason === 'prefix_error') {
        setResult('プレフィックスエラー');
        setDetail(`期待値: ${PREFIX}`);
      } else if (parsed.reason === 'id_error') {
        setResult('IDエラー');
        setDetail('プレフィックス以後は数字のみ');
      } else {
        setResult('入力エラー');
        setDetail('-');
      }
      return;
    }

    const { patientId } = parsed;

    if (lastScannedId === patientId && Date.now() - lastScanAt < DUPLICATE_GUARD_MS) {
      setResult('二重送信防止');
      setDetail(`同一ID ${patientId} を ${DUPLICATE_GUARD_MS}ms 以内に再読取`);
      return;
    }

    lastScannedId = patientId;
    lastScanAt = Date.now();

    isProcessing = true;
    setResult(`検索中: ${patientId}`);
    setDetail('受付画面を走査しています');

    window.setTimeout(async () => {
      try {
        await searchAndSelect(patientId);
      } catch (err) {
        console.error('[Pointer V1][ERROR]', err);
        setResult('検索エラー');
        setDetail(err && err.message ? err.message : String(err));
      } finally {
        isProcessing = false;
      }
    }, SEARCH_DELAY_MS);
  }

  /******************************************************************
   * スキャナー入力
   ******************************************************************/
  document.addEventListener('keydown', (e) => {
    if (!isEnabled) return;
    if (inputMode !== 'scanner') return;

    const ignoreKeys = new Set([
      'Shift', 'Control', 'Alt', 'Meta', 'CapsLock', 'Tab', 'Escape',
      'ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight'
    ]);
    if (ignoreKeys.has(e.key)) return;

    if (e.key === 'Enter') {
      const current = buffer;
      processScan(current);
      buffer = '';
      elInput.value = '';
      return;
    }

    if (e.key === 'Backspace') {
      buffer = buffer.slice(0, -1);
      elInput.value = buffer;
      return;
    }

    if (e.key.length === 1) {
      buffer += e.key;
      elInput.value = buffer;
    }
  }, true);

  /******************************************************************
   * Manual入力欄のリアルタイム表示
   ******************************************************************/
  elInput.addEventListener('input', () => {
    if (inputMode !== 'manual') return;
    setRaw(elInput.value);
    setNormalized(normalizeScanText(elInput.value));
  });

  /******************************************************************
   * ボタン操作
   ******************************************************************/
  elExec.addEventListener('click', () => {
    const text = elInput.value;
    processScan(text);
  });

  elClear.addEventListener('click', () => {
    buffer = '';
    elInput.value = '';
    setRaw('-');
    setNormalized('-');
    setResult('待機中');
    setDetail('-');
  });

  elToggle.addEventListener('click', () => {
    isEnabled = !isEnabled;
    syncToggleUI();
    setResult(isEnabled ? '機能ON' : '機能OFF');
  });

  elMode.addEventListener('click', () => {
    inputMode = inputMode === 'scanner' ? 'manual' : 'scanner';
    buffer = '';
    elInput.value = '';
    syncModeUI();
    setResult(`入力モード: ${inputMode === 'scanner' ? 'Scanner' : 'Manual'}`);
    setDetail('-');
  });

  elMin.addEventListener('click', () => {
    const isHidden = elBody.style.display === 'none';
    elBody.style.display = isHidden ? 'block' : 'none';
    elMin.textContent = isHidden ? '－' : '＋';
  });

  /******************************************************************
   * ドラッグ移動
   ******************************************************************/
  let dragging = false;
  let offsetX = 0;
  let offsetY = 0;

  elHeader.addEventListener('mousedown', (e) => {
    dragging = true;
    const rect = panel.getBoundingClientRect();
    offsetX = e.clientX - rect.left;
    offsetY = e.clientY - rect.top;
    panel.style.right = 'auto';
  });

  document.addEventListener('mousemove', (e) => {
    if (!dragging) return;
    panel.style.left = `${e.clientX - offsetX}px`;
    panel.style.top = `${e.clientY - offsetY}px`;
  });

  document.addEventListener('mouseup', () => {
    dragging = false;
  });

  /******************************************************************
   * 初期化
   ******************************************************************/
  syncToggleUI();
  syncModeUI();
  setResult('待機中');
  setDetail('Scanner / Manual を選択してください');
})();
