// ==UserScript==
// @name         Res.Prio.sys.V3.9.11
// @namespace    https://digikar.jp/reception/
// @version      3.9.11
// @description  診察順ナビ 上位表示パネル版。【V3.9.11】患者メモ/受付メモへの反応アルゴリズムのうち、安全語(urgentKeywords、+1000)・クレーム語(complaintKeywords2/3、💢絵文字、+10/20/30)・画像準備語(imagingKeywords、初診限定+3)の3種類を廃止。スコアは基礎スコア(base)＋待ち加点(waitScore)＋時間圧(timePressureScore)＋🟡待機治療群(+20)のみで構成される。🔴緊急対応群(受付メモタグによる無条件最上位固定)は別ロジックのため維持。V3.9.10のリスト表示サイズ復元、V3.9.9の再帰群(returnGroup)判定廃止、V3.9.8の検査中(examiningTest、科を問わず)カウント追加、V3.9.6の予約時刻フォールバック解析廃止、V3.9.5の🟡待機治療群タグ判定、V3.9.3のBridging Autopilot高さ追従修正、V3.9.0の端末間一致修正、V3.8.2のちらつき対策・Bridge V1互換・🍐予約なし診察希望対応は維持。
// @match        https://digikar.jp/reception/*
// @match        https://*.digikar.jp/reception/*
// @updateURL    https://raw.githubusercontent.com/takadat2003-maker/digikar-userscripts/main/reservation-priority-system-v3.9.user.js
// @downloadURL  https://raw.githubusercontent.com/takadat2003-maker/digikar-userscripts/main/reservation-priority-system-v3.9.user.js
// @run-at       document-start
// @grant        none
// ==/UserScript==


(function () {
  'use strict';

  const CONFIG = {
    refreshIntervalMs: 1000,
    tableScanDebounceMs: 200,
    initialRetryIntervalMs: 300,
    initialRetryMax: 30,
    // V3.8.2: ユーザー操作直後はソートを延期する猶予時間(ms)
    userActivityIdleMs: 700,
    // V3.8.2: 操作中で延期したソートを再試行する間隔(ms)
    deferredSortRetryMs: 250,
    renderClass: 'tm-priority-score-block-v36',

    // V3.9.0: 患者状態の localStorage 保存は廃止
    // storagePrefixBase / staleStateTtlMs / globalGcIntervalMs は不要に

    uiStorageKey: 'tmPriorityUiStateV36',
    panelId: 'tm-priority-floating-panel-v36',
    panelTopN: 8,

    // V3.9.1: パネル高さをBridging Autopilot V4.2cの実表示高さに合わせる
    bridgePanelId: 'tm-bridging-autopilot-v4',
    panelBodyMaxHeightFallback: '70vh',

    urgentTopTag: '🔴緊急対応群',
    bridgeStorageKey: 'tmBridgeAutopilotFeedV1',

    headers: {
      reservation: '予約',
      arrival: '時間',
      status: 'ステータス',
      patientNo: ['患者番号', '患者ID', 'ID'],
      patientName: ['患者氏名', '氏名', '患者名', '名前'],
      patientMemo: '患者メモ',
      receptionMemo: '受付メモ',
      department: '診療科',
      doctor: '医師',
      initial: '初'
    },

    waitingStatuses: ['診察待'],
    visibleStatuses: ['受付中', '受付済', '診察待', '診察中', '再診待', '検査中', '検査待', '検査戻り', '処置待', '処置中'],
    inactiveStatusKeywords: ['会計', '帰宅', '完了', '中止', '取消', 'キャンセル'],

    targetDepartments: [
      '整形外科（1診）',
      '整形外科（2診）',
      '脊椎外来（1診）',
      'リハあり診察',
      '中待合室',
      '中待合',
      'ワクチン・採血・薬他（処置室）',
      '予約なし診察（受付前待ち）'
    ],

    // V3.9.6: doctorTimeRegex(受付メモ内のドクター担当枠表記からの予約時刻フォールバック解析)は誤検知のため廃止
    anyTimeRegex: /(\d{1,2})\s*:\s*(\d{2})/,

    score: {
      sameSlotReserved: 40,
      nextSlotReserved: 35,
      overdueReserved: 42,
      futureReserved: 24,
      walkInRevisit: 20,
      walkInInitial: 10,
      waitPerMinute: 0.8,
      overduePerMinute: 0.6,
      sameSlotSoonBonus: 10,
      nextSlotSoonBonus: 5,
      waitingTreatmentGroupBonus: 20
    },

    waitingTreatmentGroupTag: '🟡待機治療群',

    // V3.9.11: 安全語(urgentKeywords/safetyUrgent)・クレーム語(complaintKeywords2/3/complaint1-3)・
    // 画像準備語(imagingKeywords/imagingReadyBonus)によるメモ反応スコアリングを廃止したため、
    // 該当キーワードリストと得点定数を削除。
    noAppointmentExamTags: ['🍐予約無し診察希望', '🍐予約なし診察希望'],

    colors: {
      top1: '#b91c1c',
      top2: '#c2410c',
      top3: '#92400e',
      normal: '#1d4ed8',
      waitingStatus: '#2563eb',
      waitingRoom: '#2563eb',
      examiningStatus: '#0f8b8d',
      border: '#d1d5db',
      bg: '#f8fafc',
      waitingBg: '#eef6ff',
      activeBg: '#f8fafc',
      urgentTopBg: '#fee2e2',
      urgentTopBorder: '#dc2626',
      rankBadgeBg1: '#fee2e2',
      rankBadgeBg2: '#ffedd5',
      rankBadgeBg3: '#fef3c7',
      rankBadgeBg: '#dbeafe',
      panelHeader: '#1e3a8a',
      panelBg: 'rgba(255,255,255,0.97)',
      panelShadow: '0 12px 28px rgba(0,0,0,0.18)',
      sortOn: '#166534',
      sortOnBg: '#dcfce7',
      sortOff: '#6b7280',
      sortOffBg: '#f3f4f6',
      navOn: '#7c2d12',
      navOnBg: '#ffedd5',
      navOff: '#6b7280',
      navOffBg: '#f3f4f6'
    }
  };

  // ===== V3.9.0: 患者状態の localStorage 関連関数を全て廃止 =====
  // getTodayKey, getStoragePrefix, getStorageKey,
  // loadState, saveState, deleteState,
  // updateTransitionState, cleanupMissingRows, cleanupOldDatePrefixes
  // → 全て削除。待ち時間はテーブルの到着時刻カラムのみで計算。

  function normalizeHeaderText(text) {
    return String(text || '').replace(/\s+/g, '').trim();
  }

  function normalizeCompareText(text) {
    return String(text || '').replace(/\s+/g, '').trim();
  }

  function escapeHtml(text) {
    return String(text || '')
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#39;');
  }

  function round1(n) {
    return Math.round(n * 10) / 10;
  }

  function formatScore(score) {
    return round1(score).toFixed(1);
  }

  function formatDuration(ms) {
    const totalSec = Math.max(0, Math.floor(ms / 1000));
    const mm = Math.floor(totalSec / 60);
    const ss = totalSec % 60;
    return `${String(mm)}:${String(ss).padStart(2, '0')}`;
  }

  function parseHHMM(text) {
    const m = String(text || '').match(CONFIG.anyTimeRegex);
    if (!m) return null;
    const hh = Number(m[1]);
    const mm = Number(m[2]);
    if (!Number.isFinite(hh) || !Number.isFinite(mm)) return null;
    return { hh, mm };
  }

  function todayAt(hh, mm) {
    const d = new Date();
    d.setHours(hh, mm, 0, 0);
    return d;
  }

  function includesAny(text, keywords) {
    return keywords.some(keyword => String(text || '').includes(keyword));
  }

  function isInitialVisit(initialText) {
    return String(initialText || '').trim() !== '';
  }

  function isTargetDepartment(departmentText) {
    const normalized = normalizeCompareText(departmentText);
    return CONFIG.targetDepartments.some(dep => normalizeCompareText(dep) === normalized);
  }

  function isWaitingStatus(statusText) {
    return normalizeCompareText(statusText) === normalizeCompareText('診察待');
  }

  function isExaminingStatus(statusText) {
    return normalizeCompareText(statusText) === normalizeCompareText('診察中');
  }

  // V3.9.8: 「検査中」は診察中（1診/2診で医師が診察中）とは別概念。
  // Bridging Autopilotの目標人数判定に合算するため、科を問わず全行から拾えるようにする。
  function isExaminingTestStatus(statusText) {
    return normalizeCompareText(statusText) === normalizeCompareText('検査中');
  }

  function getPatientSituation(departmentText, statusText) {
    const dep = normalizeCompareText(departmentText);
    const st = normalizeCompareText(statusText);

    if (dep === normalizeCompareText('整形外科（1診）') && st === normalizeCompareText('診察待')) return '受付前で待機';
    if (dep === normalizeCompareText('整形外科（2診）') && st === normalizeCompareText('診察待')) return '受付前で待機';
    if (dep === normalizeCompareText('予約なし診察（受付前待ち）') && st === normalizeCompareText('診察待')) return '受付前で待機';
    if (dep === normalizeCompareText('リハあり診察') && st === normalizeCompareText('診察待')) return '受付前で待機';
    if (dep === normalizeCompareText('脊椎外来（1診）') && st === normalizeCompareText('診察待')) return '受付前で待機';
    if ((dep === normalizeCompareText('中待合') || dep === normalizeCompareText('中待合室')) && st === normalizeCompareText('診察待')) return '中待合で待機';
    if (dep === normalizeCompareText('整形外科（1診）') && st === normalizeCompareText('診察中')) return '1診で診察中';
    if (dep === normalizeCompareText('整形外科（2診）') && st === normalizeCompareText('診察中')) return '2診で診察中';
    return '';
  }

  function getSituationColor(departmentText, statusText, isUrgentTop) {
    const dep = normalizeCompareText(departmentText);
    const st = normalizeCompareText(statusText);

    if (isUrgentTop) return CONFIG.colors.urgentTopBorder;
    if (st === normalizeCompareText('診察中')) return CONFIG.colors.examiningStatus;
    if ((dep === normalizeCompareText('中待合') || dep === normalizeCompareText('中待合室')) && st === normalizeCompareText('診察待')) {
      return CONFIG.colors.waitingStatus;
    }
    return CONFIG.colors.top1;
  }

  function shouldRender(statusText) {
    return isWaitingStatus(statusText) || isExaminingStatus(statusText);
  }

  // ===== UI状態の localStorage は端末固有設定なので維持 =====

  function getDefaultUiState() {
    return {
      top: 16,
      left: Math.max(8, window.innerWidth - 430),
      minimized: false,
      sortEnabled: false,
      navEnabled: true
    };
  }

  function loadUiState() {
    try {
      const raw = localStorage.getItem(CONFIG.uiStorageKey);
      return Object.assign({}, getDefaultUiState(), raw ? JSON.parse(raw) : {});
    } catch (e) {
      return getDefaultUiState();
    }
  }

  function saveUiState(state) {
    try {
      localStorage.setItem(CONFIG.uiStorageKey, JSON.stringify(state));
    } catch (e) {}
  }

  function updateUiState(patch) {
    const next = Object.assign({}, loadUiState(), patch || {});
    if (!next.navEnabled) next.sortEnabled = false;
    saveUiState(next);
    return next;
  }

  function clampPanelPosition(state, panelEl) {
    const width = panelEl ? panelEl.offsetWidth : 273;
    const headerHeight = 26;
    const maxLeft = Math.max(0, window.innerWidth - width - 4);
    const maxTop = Math.max(0, window.innerHeight - headerHeight - 4);

    return {
      top: Math.min(Math.max(0, Number(state.top) || 0), maxTop),
      left: Math.min(Math.max(0, Number(state.left) || 0), maxLeft),
      minimized: !!state.minimized,
      sortEnabled: !!state.sortEnabled && !!state.navEnabled,
      navEnabled: !!state.navEnabled
    };
  }

  // V3.9.1: パネル全体の高さを Bridging Autopilot V4.2c パネルの実測高さに追従させる。
  // 両スクリプトは同一ページ上で同時に動作するため、対象パネルの getBoundingClientRect()
  // をそのまま基準にすれば、環境依存のフォント/UAスタイル差を気にせず正確に一致させられる。
  // 対象パネルが見つからない場合（未導入・未起動時）は従来の70vh上限にフォールバックする。
  function syncPanelBodyHeightWithBridge(panel) {
    if (!panel) return;
    const header = panel.querySelector('.tm-panel-header');
    const body = panel.querySelector('.tm-panel-body');
    if (!header || !body) return;

    const bridgeEl = document.getElementById(CONFIG.bridgePanelId);
    const bridgeHeight = bridgeEl ? bridgeEl.getBoundingClientRect().height : 0;

    if (bridgeEl && bridgeHeight > 0) {
      const headerHeight = header.getBoundingClientRect().height;
      const targetBodyHeight = Math.max(0, Math.round(bridgeHeight - headerHeight));
      const targetPx = `${targetBodyHeight}px`;
      // V3.9.3: max-height はコンテンツが短いと縮んでしまう「上限」でしかないため、
      // 常に同じ高さになるよう height を固定値として指定する（コンテンツが少ない時は余白ができる）。
      if (body.style.height !== targetPx) {
        body.style.maxHeight = 'none';
        body.style.height = targetPx;
        body.style.overflowY = 'auto';
      }
    } else if (body.style.maxHeight !== CONFIG.panelBodyMaxHeightFallback) {
      body.style.height = 'auto';
      body.style.maxHeight = CONFIG.panelBodyMaxHeightFallback;
      body.style.overflowY = 'auto';
    }
  }

  function findMainTable() {
    const tables = Array.from(document.querySelectorAll('table'));
    let best = null;
    let bestScore = -Infinity;

    for (const table of tables) {
      const rows = table.querySelectorAll('tbody tr').length;
      if (!rows) continue;

      const text = table.innerText || '';
      let score = rows;
      if (text.includes(CONFIG.headers.patientMemo)) score += 80;
      if (text.includes(CONFIG.headers.receptionMemo)) score += 40;
      if (text.includes(CONFIG.headers.status)) score += 30;
      if (text.includes(CONFIG.headers.arrival)) score += 20;
      if (text.includes(CONFIG.headers.reservation)) score += 20;
      if (text.includes(CONFIG.headers.patientNo[0])) score += 10;

      if (score > bestScore) {
        bestScore = score;
        best = table;
      }
    }
    return best;
  }

  function getHeaderCells(table) {
    const thead = table.querySelector('thead');
    if (thead) return Array.from(thead.querySelectorAll('th,td'));
    const firstRow = table.querySelector('tr');
    return firstRow ? Array.from(firstRow.querySelectorAll('th,td')) : [];
  }

  function findColumnIndex(table, header) {
    const target = normalizeHeaderText(header);
    const cells = getHeaderCells(table);
    for (let i = 0; i < cells.length; i += 1) {
      const cellText = normalizeHeaderText(cells[i].textContent || '');
      if (cellText === target) return i;
    }
    return -1;
  }

  function findColumnIndexFromList(table, headers) {
    for (const header of headers) {
      const idx = findColumnIndex(table, header);
      if (idx >= 0) return idx;
    }
    return -1;
  }

  function pickColumns(table) {
    return {
      reservation: findColumnIndex(table, CONFIG.headers.reservation),
      arrival: findColumnIndex(table, CONFIG.headers.arrival),
      status: findColumnIndex(table, CONFIG.headers.status),
      patientNo: findColumnIndexFromList(table, CONFIG.headers.patientNo),
      patientName: findColumnIndexFromList(table, CONFIG.headers.patientName),
      patientMemo: findColumnIndex(table, CONFIG.headers.patientMemo),
      receptionMemo: findColumnIndex(table, CONFIG.headers.receptionMemo),
      department: findColumnIndex(table, CONFIG.headers.department),
      doctor: findColumnIndex(table, CONFIG.headers.doctor),
      initial: findColumnIndex(table, CONFIG.headers.initial)
    };
  }

  function getCellText(tds, idx) {
    if (idx < 0 || !tds[idx]) return '';
    return String(tds[idx].textContent || '').replace(/\u00a0/g, ' ').trim();
  }

  // V3.9.6: 受付メモ/患者メモに書かれた「整形外科（院長11:30）」等はドクターの担当枠の
  // 注記であり患者個人の予約時刻ではないため、メモ文からの時刻フォールバック解析を廃止。
  // 予約時刻は「予約」列の値のみを正とする（無ければ予約なし=予約外として扱う）。
  function parseReservedTime(reservationText) {
    return parseHHMM(reservationText);
  }

  function removeRender(cell) {
    if (!cell) return;
    const old = cell.querySelector(`.${CONFIG.renderClass}`);
    if (old) old.remove();
  }

  function ensureRender(cell) {
    let el = cell.querySelector(`.${CONFIG.renderClass}`);
    if (!el) {
      el = document.createElement('div');
      el.className = CONFIG.renderClass;
      el.style.marginTop = '4px';
      el.style.padding = '4px 6px';
      el.style.border = `1px solid ${CONFIG.colors.border}`;
      el.style.borderRadius = '6px';
      el.style.background = CONFIG.colors.bg;
      el.style.whiteSpace = 'normal';
      el.style.lineHeight = '1.28';
      el.style.fontSize = '12px';
      cell.appendChild(el);
    }
    return el;
  }

  function updateRenderElement(el, html, title, stylePatch, signature) {
    if (!el) return;
    const sig = String(signature || '');

    if (el.dataset.renderSignature !== sig) {
      el.innerHTML = html;
      el.dataset.renderSignature = sig;
    }

    if (el.title !== title) {
      el.title = title;
    }

    if (stylePatch) {
      if (el.dataset.color !== String(stylePatch.color || '')) {
        el.style.color = stylePatch.color || '';
        el.dataset.color = String(stylePatch.color || '');
      }
      if (el.dataset.fontWeight !== String(stylePatch.fontWeight || '')) {
        el.style.fontWeight = stylePatch.fontWeight || '';
        el.dataset.fontWeight = String(stylePatch.fontWeight || '');
      }
      if (el.dataset.borderColor !== String(stylePatch.borderColor || '')) {
        el.style.borderColor = stylePatch.borderColor || '';
        el.dataset.borderColor = String(stylePatch.borderColor || '');
      }
      if (el.dataset.background !== String(stylePatch.background || '')) {
        el.style.background = stylePatch.background || '';
        el.dataset.background = String(stylePatch.background || '');
      }
    }
  }

  function clearAllOldRenders(table, cols) {
    if (!table) return;
    table.querySelectorAll('tbody tr').forEach(row => {
      const tds = row.querySelectorAll('td');
      if (!tds.length) return;
      const patientMemoCell = cols.patientMemo >= 0 ? tds[cols.patientMemo] : null;
      const receptionMemoCell = cols.receptionMemo >= 0 ? tds[cols.receptionMemo] : null;
      removeRender(patientMemoCell);
      if (receptionMemoCell !== patientMemoCell) removeRender(receptionMemoCell);
    });
  }

  // ===== V3.9.0: buildRowData — localStorage 不使用版 =====
  // 待ち時間はテーブルの「時間」カラム（到着時刻）のみで計算。
  // totalWaitMs = currentWaitMs = now - arrivalAt（到着時刻ベース統一）
  // 到着時刻が取得できない場合はスコア計算上 waitMs = 0 とし、
  // 端末間で乖離する Date.now() フォールバックを排除。
  function buildRowData(row, cols, now) {
    const tds = row.querySelectorAll('td');
    if (!tds || !tds.length) return null;

    const statusText = getCellText(tds, cols.status);
    const patientMemoText = getCellText(tds, cols.patientMemo);
    const receptionMemoText = getCellText(tds, cols.receptionMemo);
    const reservationText = getCellText(tds, cols.reservation);
    const arrivalText = getCellText(tds, cols.arrival);
    const patientNoText = getCellText(tds, cols.patientNo);
    const patientNameText = getCellText(tds, cols.patientName);
    const departmentText = getCellText(tds, cols.department);
    const doctorText = getCellText(tds, cols.doctor);
    const initialText = getCellText(tds, cols.initial);

    const displayCell = cols.patientMemo >= 0 ? tds[cols.patientMemo] : (cols.receptionMemo >= 0 ? tds[cols.receptionMemo] : null);
    if (!displayCell) return null;

    const targetDept = isTargetDepartment(departmentText);
    const waitingNow = isWaitingStatus(statusText);
    const examiningNow = isExaminingStatus(statusText);

    const isUrgentTop = waitingNow && String(receptionMemoText || '').includes(CONFIG.urgentTopTag);
    const situationText = getPatientSituation(departmentText, statusText);
    const situationColor = getSituationColor(departmentText, statusText, isUrgentTop);

    if (!targetDept) {
      removeRender(displayCell);
      return null;
    }

    if (patientNoText && CONFIG.inactiveStatusKeywords.some(keyword => String(statusText).includes(keyword))) {
      removeRender(displayCell);
      return null;
    }

    const arrivalParsed = parseHHMM(arrivalText);
    const memoTextForTags = `${patientMemoText}\n${receptionMemoText}`;
    const hasNoAppointmentExamTag = includesAny(memoTextForTags, CONFIG.noAppointmentExamTags);
    const reservedParsed = hasNoAppointmentExamTag ? null : parseReservedTime(reservationText);
    const arrivalAt = arrivalParsed ? todayAt(arrivalParsed.hh, arrivalParsed.mm) : null;
    const reservedAt = reservedParsed ? todayAt(reservedParsed.hh, reservedParsed.mm) : null;
    const nowMs = now.getTime();

    if (!shouldRender(statusText)) {
      removeRender(displayCell);
      return null;
    }

    if (examiningNow) {
      return {
        mode: 'examining',
        row,
        displayCell,
        patientNoText,
        patientNameText,
        departmentText,
        doctorText,
        statusText,
        situationText,
        situationColor,
        receptionMemoText
      };
    }

    // ===== V3.9.0: 待ち時間計算 — 到着時刻ベース統一 =====
    // arrivalAt が null の場合は waitMs = 0（端末差異を生むフォールバックを排除）
    const waitMs = arrivalAt ? Math.max(0, nowMs - arrivalAt.getTime()) : 0;

    const waitMin = waitMs / 60000;
    const initial = isInitialVisit(initialText);
    // V3.9.11: 安全語・クレーム語・画像準備語によるjoinedMemo反応スコアリングは廃止したため、
    // memoTextForTagsは🍐タグ判定(hasNoAppointmentExamTag)専用として残す。
    // V3.9.4: 短時間ボーナス(強/弱キーワード)を廃止し、「🟡待機治療群」タグ判定に置き換え
    // V3.9.5: 実運用でこのタグは受付メモ欄に入力されるため、判定対象を患者メモ→受付メモに変更
    const hasWaitingTreatmentGroupTag = String(receptionMemoText || '').includes(CONFIG.waitingTreatmentGroupTag);

    const slotMin = initial ? 10 : 5;
    const untilReservedMin = reservedAt ? (reservedAt.getTime() - nowMs) / 60000 : null;
    const overdueReservedMin = reservedAt ? Math.max(0, (nowMs - reservedAt.getTime()) / 60000) : 0;

    let base = 0;
    let baseLabel = '';

    if (reservedAt) {
      if (untilReservedMin < 0) {
        base = CONFIG.score.overdueReserved;
        baseLabel = '予約超過';
      } else if (untilReservedMin <= slotMin) {
        base = CONFIG.score.sameSlotReserved;
        baseLabel = '同枠予約';
      } else if (untilReservedMin <= slotMin * 2) {
        base = CONFIG.score.nextSlotReserved;
        baseLabel = '次枠予約';
      } else {
        base = CONFIG.score.futureReserved;
        baseLabel = '将来枠予約';
      }
    } else {
      base = initial ? CONFIG.score.walkInInitial : CONFIG.score.walkInRevisit;
      baseLabel = initial ? '予約外初診' : '予約外再診';
    }

    const waitScore = round1(waitMin * CONFIG.score.waitPerMinute);

    let timePressureScore = 0;
    if (reservedAt) {
      if (untilReservedMin < 0) {
        timePressureScore = round1(Math.min(30, overdueReservedMin * CONFIG.score.overduePerMinute));
      } else if (untilReservedMin <= 5) {
        timePressureScore = CONFIG.score.sameSlotSoonBonus;
      } else if (untilReservedMin <= 10) {
        timePressureScore = CONFIG.score.nextSlotSoonBonus;
      }
    }

    const waitingTreatmentGroupBonus = hasWaitingTreatmentGroupTag ? CONFIG.score.waitingTreatmentGroupBonus : 0;

    const totalScore = base + waitScore + timePressureScore + waitingTreatmentGroupBonus;

    const detailParts = [];
    if (isUrgentTop) detailParts.push('緊急対応群=無条件最優先');
    detailParts.push(`${baseLabel}+${formatScore(base)}`);
    detailParts.push(`待ち+${formatScore(waitScore)}`);
    if (timePressureScore) detailParts.push(`圧+${formatScore(timePressureScore)}`);
    if (waitingTreatmentGroupBonus) detailParts.push(`🟡待機治療+${formatScore(waitingTreatmentGroupBonus)}`);

    return {
      mode: 'waiting',
      row,
      displayCell,
      patientNoText,
      patientNameText,
      departmentText,
      doctorText,
      statusText,
      reservationText,
      receptionMemoText,
      hasNoAppointmentExamTag,
      hasReturnMemoText: String(receptionMemoText || '').includes('再帰あり'),
      patientMemoText,
      // V3.9.0: totalWaitMs と currentWaitMs を統合 → waitMs（到着時刻ベース）
      waitMs,
      score: totalScore,
      detailText: detailParts.join(' / '),
      situationText,
      situationColor,
      isUrgentTop,
      sortReservedAt: reservedAt ? reservedAt.getTime() : Number.MAX_SAFE_INTEGER,
      sortArrivalAt: arrivalAt ? arrivalAt.getTime() : Number.MAX_SAFE_INTEGER
    };
  }

  function compareRows(a, b) {
    if (a.isUrgentTop && !b.isUrgentTop) return -1;
    if (!a.isUrgentTop && b.isUrgentTop) return 1;

    if (a.isUrgentTop && b.isUrgentTop) {
      if (b.waitMs !== a.waitMs) return b.waitMs - a.waitMs;
      if (a.sortReservedAt !== b.sortReservedAt) return a.sortReservedAt - b.sortReservedAt;
      if (a.sortArrivalAt !== b.sortArrivalAt) return a.sortArrivalAt - b.sortArrivalAt;
      return String(a.patientNoText || '').localeCompare(String(b.patientNoText || ''), 'ja');
    }

    if (b.score !== a.score) return b.score - a.score;
    if (a.sortReservedAt !== b.sortReservedAt) return a.sortReservedAt - b.sortReservedAt;
    if (a.sortArrivalAt !== b.sortArrivalAt) return a.sortArrivalAt - b.sortArrivalAt;
    return String(a.patientNoText || '').localeCompare(String(b.patientNoText || ''), 'ja');
  }

  function getRankColor(rank, isUrgentTop) {
    if (isUrgentTop) return CONFIG.colors.urgentTopBorder;
    if (rank === 1) return CONFIG.colors.top1;
    if (rank === 2) return CONFIG.colors.top2;
    if (rank === 3) return CONFIG.colors.top3;
    return CONFIG.colors.normal;
  }

  function getRankBadgeBg(rank, isUrgentTop) {
    if (isUrgentTop) return CONFIG.colors.urgentTopBg;
    if (rank === 1) return CONFIG.colors.rankBadgeBg1;
    if (rank === 2) return CONFIG.colors.rankBadgeBg2;
    if (rank === 3) return CONFIG.colors.rankBadgeBg3;
    return CONFIG.colors.rankBadgeBg;
  }

  // V3.9.0: renderWaitingRow — waitMs 統一版
  function renderWaitingRow(item, rank) {
    const el = ensureRender(item.displayCell);

    const rankColor = getRankColor(rank, item.isUrgentTop);
    const rankBadgeBg = getRankBadgeBg(rank, item.isUrgentTop);
    const reservedStr = item.hasNoAppointmentExamTag
      ? '予約外'
      : (item.reservationText && item.reservationText !== '-' ? item.reservationText : '予約外');
    const waitStr = formatDuration(item.waitMs);
    const situation = escapeHtml(item.situationText || '');
    const rankLabel = item.isUrgentTop ? '緊急1位' : `診察順${rank}位`;
    const scoreLabel = item.isUrgentTop ? '無条件最優先' : `${escapeHtml(formatScore(item.score))}点`;

    const html =
      `<div style="display:flex;align-items:center;gap:6px;flex-wrap:wrap;">` +
        `<span style="display:inline-block;padding:1px 6px;border-radius:999px;background:${rankBadgeBg};color:${rankColor};font-weight:900;font-size:13px;letter-spacing:0.2px;">${escapeHtml(rankLabel)}</span>` +
        `<span style="color:${rankColor};font-weight:900;font-size:13px;">${scoreLabel}</span>` +
        `<span style="color:${item.situationColor};font-weight:800;">ー${situation}ー</span>` +
      `</div>` +
      `<div style="margin-top:2px;font-weight:700;color:#dc2626;">` +
      `<span style="color:#7c3aed;">⌚待ち${escapeHtml(waitStr)}</span>` +
      `<span style="margin-left:8px;color:#111827;">予${escapeHtml(reservedStr)}</span></div>`;

    const title =
      `${item.detailText}\n` +
      `状態:${item.statusText}\n` +
      `診療科:${item.departmentText}\n` +
      `医師:${item.doctorText}` +
      (item.situationText ? `\n状況:${item.situationText}` : '') +
      (item.receptionMemoText ? `\n受付メモ:${item.receptionMemoText}` : '');

    const signature = [
      'waiting',
      rank,
      item.isUrgentTop ? '1' : '0',
      formatDuration(item.waitMs),
      reservedStr,
      formatScore(item.score),
      item.situationText,
      item.situationColor,
      item.statusText,
      item.departmentText,
      item.doctorText,
      item.detailText,
      item.receptionMemoText
    ].join('|');

    updateRenderElement(
      el,
      html,
      title,
      {
        color: '#111827',
        fontWeight: '700',
        borderColor: rankColor,
        background: item.isUrgentTop ? CONFIG.colors.urgentTopBg : CONFIG.colors.waitingBg
      },
      signature
    );
  }

  function renderExaminingRow(item) {
    const el = ensureRender(item.displayCell);
    const text = escapeHtml(item.situationText || '診察中');
    const html = `<div style="color:${item.situationColor};font-weight:800;">ー${text}ー</div>`;

    const title =
      `状態:${item.statusText}\n` +
      `診療科:${item.departmentText}\n` +
      `医師:${item.doctorText}` +
      (item.situationText ? `\n状況:${item.situationText}` : '');

    const signature = [
      'examining',
      item.statusText,
      item.departmentText,
      item.doctorText,
      item.situationText,
      item.situationColor
    ].join('|');

    updateRenderElement(
      el,
      html,
      title,
      {
        color: item.situationColor,
        fontWeight: '800',
        borderColor: item.situationColor,
        background: CONFIG.colors.activeBg
      },
      signature
    );
  }

  function createPanel() {
    let panel = document.getElementById(CONFIG.panelId);
    if (panel) return panel;

    panel = document.createElement('div');
    panel.id = CONFIG.panelId;
    panel.style.position = 'fixed';
    panel.style.zIndex = '999999';
    panel.style.width = '273px';
    panel.style.maxWidth = 'calc(100vw - 8px)';
    panel.style.background = CONFIG.colors.panelBg;
    panel.style.border = `1px solid ${CONFIG.colors.border}`;
    panel.style.borderRadius = '8px';
    panel.style.boxShadow = CONFIG.colors.panelShadow;
    panel.style.backdropFilter = 'blur(3px)';
    panel.style.overflow = 'hidden';
    panel.style.fontFamily = 'system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif';

    panel.innerHTML = `
      <div class="tm-panel-header" style="display:flex;align-items:center;justify-content:space-between;padding:4px 7px;background:${CONFIG.colors.panelHeader};color:#fff;cursor:move;user-select:none;">
        <div style="display:flex;align-items:center;gap:5px;min-width:0;">
          <span style="font-size:12px;font-weight:900;white-space:nowrap;">診察順ナビ V3.9.11</span>
        </div>
        <div style="display:flex;gap:3px;align-items:center;">
          <button type="button" class="tm-panel-nav-btn" title="ナビON/OFF" style="border:none;border-radius:5px;padding:1px 5px;background:rgba(255,255,255,0.18);color:#fff;font-size:10px;font-weight:800;cursor:pointer;line-height:1.5;">NAV ON</button>
          <button type="button" class="tm-panel-sort-btn" title="ソートON/OFF" style="border:none;border-radius:5px;padding:1px 5px;background:rgba(255,255,255,0.18);color:#fff;font-size:10px;font-weight:800;cursor:pointer;line-height:1.5;">SORT OFF</button>
          <button type="button" class="tm-panel-min-btn" title="最小化/展開" style="border:none;border-radius:5px;padding:1px 5px;background:rgba(255,255,255,0.18);color:#fff;font-size:10px;font-weight:700;cursor:pointer;line-height:1.5;">−</button>
        </div>
      </div>
      <div class="tm-panel-body" style="padding:10px 10px 12px 10px;max-height:${CONFIG.panelBodyMaxHeightFallback};overflow:auto;background:${CONFIG.colors.panelBg};">
        <div class="tm-panel-summary" style="font-size:12px;color:#374151;margin-bottom:8px;">診察待の上位患者を表示</div>
        <div class="tm-panel-list"></div>
      </div>
    `;

    document.body.appendChild(panel);
    installPanelBehavior(panel);
    applyUiStateToPanel(panel, loadUiState());

    return panel;
  }

  function applyUiStateToPanel(panel, state) {
    const safe = clampPanelPosition(state, panel);
    panel.style.left = `${safe.left}px`;
    panel.style.top = `${safe.top}px`;

    const body = panel.querySelector('.tm-panel-body');
    const minBtn = panel.querySelector('.tm-panel-min-btn');
    const sortBtn = panel.querySelector('.tm-panel-sort-btn');
    const navBtn = panel.querySelector('.tm-panel-nav-btn');

    if (safe.minimized) {
      body.style.display = 'none';
      minBtn.textContent = '□';
      minBtn.title = '展開';
    } else {
      body.style.display = '';
      minBtn.textContent = '−';
      minBtn.title = '最小化';
    }

    if (safe.navEnabled) {
      navBtn.textContent = 'NAV ON';
      navBtn.title = 'ナビON';
      navBtn.style.background = CONFIG.colors.navOnBg;
      navBtn.style.color = CONFIG.colors.navOn;
    } else {
      navBtn.textContent = 'NAV OFF';
      navBtn.title = 'ナビOFF';
      navBtn.style.background = CONFIG.colors.navOffBg;
      navBtn.style.color = CONFIG.colors.navOff;
    }

    if (safe.sortEnabled && safe.navEnabled) {
      sortBtn.textContent = 'SORT ON';
      sortBtn.title = 'ソートON';
      sortBtn.style.background = CONFIG.colors.sortOnBg;
      sortBtn.style.color = CONFIG.colors.sortOn;
      sortBtn.style.opacity = '1';
      sortBtn.disabled = false;
      sortBtn.style.cursor = 'pointer';
    } else {
      sortBtn.textContent = 'SORT OFF';
      sortBtn.title = safe.navEnabled ? 'ソートOFF' : 'ナビOFF中';
      sortBtn.style.background = CONFIG.colors.sortOffBg;
      sortBtn.style.color = CONFIG.colors.sortOff;
      sortBtn.style.opacity = safe.navEnabled ? '1' : '0.55';
      sortBtn.disabled = !safe.navEnabled;
      sortBtn.style.cursor = safe.navEnabled ? 'pointer' : 'not-allowed';
    }

    saveUiState(safe);
  }

  function installPanelBehavior(panel) {
    const header = panel.querySelector('.tm-panel-header');
    const minBtn = panel.querySelector('.tm-panel-min-btn');
    const sortBtn = panel.querySelector('.tm-panel-sort-btn');
    const navBtn = panel.querySelector('.tm-panel-nav-btn');

    minBtn.addEventListener('click', function (ev) {
      ev.stopPropagation();
      const state = loadUiState();
      state.minimized = !state.minimized;
      state.top = parseInt(panel.style.top || '0', 10) || 0;
      state.left = parseInt(panel.style.left || '0', 10) || 0;
      applyUiStateToPanel(panel, state);
    });

    sortBtn.addEventListener('click', function (ev) {
      ev.stopPropagation();
      const state = loadUiState();
      if (!state.navEnabled) return;
      state.sortEnabled = !state.sortEnabled;
      state.top = parseInt(panel.style.top || '0', 10) || 0;
      state.left = parseInt(panel.style.left || '0', 10) || 0;
      applyUiStateToPanel(panel, state);
      scheduleUpdate();
    });

    navBtn.addEventListener('click', function (ev) {
      ev.stopPropagation();
      const state = loadUiState();
      state.navEnabled = !state.navEnabled;
      if (!state.navEnabled) state.sortEnabled = false;
      state.top = parseInt(panel.style.top || '0', 10) || 0;
      state.left = parseInt(panel.style.left || '0', 10) || 0;
      applyUiStateToPanel(panel, state);
      scheduleUpdate();
    });

    let dragging = false;
    let startX = 0;
    let startY = 0;
    let panelLeft = 0;
    let panelTop = 0;

    function onMove(ev) {
      if (!dragging) return;
      const currentX = ev.clientX;
      const currentY = ev.clientY;
      const nextLeft = panelLeft + (currentX - startX);
      const nextTop = panelTop + (currentY - startY);
      const state = clampPanelPosition({
        left: nextLeft,
        top: nextTop,
        minimized: loadUiState().minimized,
        sortEnabled: loadUiState().sortEnabled,
        navEnabled: loadUiState().navEnabled
      }, panel);
      panel.style.left = `${state.left}px`;
      panel.style.top = `${state.top}px`;
    }

    function onUp() {
      if (!dragging) return;
      dragging = false;
      document.removeEventListener('pointermove', onMove);
      document.removeEventListener('pointerup', onUp);
      document.body.style.userSelect = '';

      updateUiState({
        left: parseInt(panel.style.left || '0', 10) || 0,
        top: parseInt(panel.style.top || '0', 10) || 0
      });
    }

    header.addEventListener('pointerdown', function (ev) {
      if (ev.target && ev.target.closest('button')) return;
      dragging = true;
      startX = ev.clientX;
      startY = ev.clientY;
      panelLeft = parseInt(panel.style.left || '0', 10) || 0;
      panelTop = parseInt(panel.style.top || '0', 10) || 0;

      document.addEventListener('pointermove', onMove);
      document.addEventListener('pointerup', onUp);
      document.body.style.userSelect = 'none';
    });

    window.addEventListener('resize', function () {
      applyUiStateToPanel(panel, loadUiState());
      syncPanelBodyHeightWithBridge(panel);
    });
  }

  // V3.9.0: renderPanel — waitMs 統一版
  function renderPanel(waitingItems, examiningItems, examiningTestItems) {
    const panel = createPanel();
    syncPanelBodyHeightWithBridge(panel);
    const listEl = panel.querySelector('.tm-panel-list');
    const summaryEl = panel.querySelector('.tm-panel-summary');
    if (!listEl || !summaryEl) return;

    const uiState = loadUiState();

    if (!uiState.navEnabled) {
      summaryEl.innerHTML =
        `<span style="font-weight:700;color:${CONFIG.colors.navOff};">診察順ナビ停止中</span>`;
      listEl.innerHTML = `
        <div style="padding:14px 10px;border:1px dashed ${CONFIG.colors.border};border-radius:10px;background:#fff;color:#6b7280;font-size:13px;">
          NAV OFF のため、診察順表示・患者メモ欄表示・本表ソートを停止しています。
        </div>
      `;
      return;
    }

    const topItems = waitingItems.slice(0, CONFIG.panelTopN);
    const examCount = examiningItems.length;
    const examTestCount = (examiningTestItems || []).length;
    const urgentCount = waitingItems.filter(item => item.isUrgentTop).length;

    summaryEl.innerHTML =
      `<span style="color:${CONFIG.colors.examiningStatus};font-weight:800;">診察中${examCount}名</span>` +
      `　<span style="color:#7c3aed;font-weight:800;">検査中${examTestCount}名</span>` +
      `　診察待 <b>${topItems.length}</b>/<b>${waitingItems.length}</b>名` +
      (urgentCount ? `　<span style="color:${CONFIG.colors.urgentTopBorder};font-weight:800;">緊急${urgentCount}名</span>` : '') +
      `　<span style="font-weight:700;color:${uiState.sortEnabled ? CONFIG.colors.sortOn : CONFIG.colors.sortOff};">${uiState.sortEnabled ? 'ソート中' : '通常順'}</span>`;

    let html = '';

    if (examiningItems.length) {
      html += examiningItems.map((item) => {
        const name = item.patientNameText || `患者番号 ${item.patientNoText || ''}`;
        return `
          <div
            title="${escapeHtml(`状態:${item.statusText}\n診療科:${item.departmentText}\n医師:${item.doctorText}`)}"
            style="margin-bottom:8px;padding:10px;border:1px solid ${item.situationColor};border-radius:10px;background:${CONFIG.colors.activeBg};">
            <div style="display:flex;align-items:center;gap:6px;flex-wrap:wrap;">
              <span style="display:inline-block;padding:2px 7px;border-radius:999px;background:#ccfbf1;color:${item.situationColor};font-weight:900;font-size:12px;">診察中</span>
              <span style="font-weight:800;color:#111827;">${escapeHtml(name)}</span>
            </div>
            <div style="margin-top:4px;font-size:12px;color:${item.situationColor};font-weight:800;">ー${escapeHtml(item.situationText || '診察中')}ー</div>
            <div style="margin-top:4px;font-size:12px;color:#111827;">${escapeHtml(item.departmentText || '')}</div>
            ${item.patientNoText ? `<div style="margin-top:4px;font-size:12px;color:#374151;">ID:${escapeHtml(item.patientNoText)}</div>` : ''}
          </div>
        `;
      }).join('');
    }

    if (!topItems.length && !examiningItems.length) {
      listEl.innerHTML = `
        <div style="padding:14px 10px;border:1px dashed ${CONFIG.colors.border};border-radius:10px;background:#fff;color:#6b7280;font-size:13px;">
          対象患者はいません
        </div>
      `;
      return;
    }

    html += topItems.map((item, idx) => {
      const rank = idx + 1;
      const rankColor = getRankColor(rank, item.isUrgentTop);
      const rankBg = getRankBadgeBg(rank, item.isUrgentTop);
      const reservedStr = item.hasNoAppointmentExamTag
        ? '予約外'
        : (item.reservationText && item.reservationText !== '-' ? item.reservationText : '予約外');
      const name = item.patientNameText || `患者番号 ${item.patientNoText || ''}`;
      const waitStr = formatDuration(item.waitMs);
      const rankLabel = item.isUrgentTop ? '緊急1位' : `${rank}位`;
      const scoreLabel = item.isUrgentTop ? '無条件最優先' : `${escapeHtml(formatScore(item.score))}点`;

      return `
        <div title="${escapeHtml(item.detailText)}"
             style="margin-bottom:8px;padding:10px;border:1px solid ${rankColor};border-radius:10px;background:${item.isUrgentTop ? CONFIG.colors.urgentTopBg : '#fff'};">
          <div style="display:flex;align-items:center;gap:6px;flex-wrap:wrap;">
            <span style="display:inline-block;padding:2px 7px;border-radius:999px;background:${rankBg};color:${rankColor};font-weight:900;font-size:12px;">${escapeHtml(rankLabel)}</span>
            <span style="color:${rankColor};font-weight:900;font-size:13px;">${scoreLabel}</span>
            <span style="font-weight:800;color:#111827;">${escapeHtml(name)}</span>
          </div>
          <div style="margin-top:4px;font-size:12px;color:${item.situationColor};font-weight:800;">ー${escapeHtml(item.situationText || '')}ー</div>
          <div style="margin-top:4px;font-size:12px;color:#111827;">${escapeHtml(item.departmentText || '')}</div>
          <div style="margin-top:4px;font-size:12px;color:#374151;">
            <span style="color:#7c3aed;font-weight:700;">⌚${escapeHtml(waitStr)}</span>
            <span style="margin-left:8px;">予${escapeHtml(reservedStr)}</span>
            ${item.patientNoText ? `<span style="margin-left:8px;">ID:${escapeHtml(item.patientNoText)}</span>` : ''}
          </div>
        </div>
      `;
    }).join('');

    listEl.innerHTML = html;
  }

  // V3.8.2: 直近のユーザー操作時刻（ちらつき対策の中核）
  let lastUserActivityAt = 0;
  // V3.8.2: 自前 DOM 操作中は MutationObserver の発火を抑制
  let isApplyingDom = false;
  // V3.8.2: 操作中で延期されたソートがあるか
  let pendingDeferredSort = false;

  function markUserActivity() {
    lastUserActivityAt = Date.now();
  }

  function userIsInteracting() {
    return (Date.now() - lastUserActivityAt) < CONFIG.userActivityIdleMs;
  }

  // 行を含むスクロール可能な祖先要素を返す
  function findScrollContainer(el) {
    let cur = el && el.parentElement;
    while (cur && cur !== document.body) {
      const style = window.getComputedStyle(cur);
      const oy = style.overflowY;
      if ((oy === 'auto' || oy === 'scroll') && cur.scrollHeight > cur.clientHeight) {
        return cur;
      }
      cur = cur.parentElement;
    }
    return null;
  }

  function applySortToTable(table, waitingItems, examiningItems) {
    if (!table) return;
    const tbody = table.querySelector('tbody');
    if (!tbody) return;

    const uiState = loadUiState();
    if (!uiState.navEnabled || !uiState.sortEnabled) return;

    const allRows = Array.from(tbody.querySelectorAll(':scope > tr'));
    if (!allRows.length) return;

    const waitingRowSet = new Set(waitingItems.map(item => item.row));
    const examiningRowSet = new Set(examiningItems.map(item => item.row));

    const waitingSortedRows = waitingItems.map(item => item.row);
    const examiningRows = examiningItems.map(item => item.row);

    const untouchedRows = allRows.filter(row => {
      return !waitingRowSet.has(row) && !examiningRowSet.has(row);
    });

    const finalRows = [];
    let inserted = false;

    for (const row of untouchedRows) {
      if (!inserted) {
        finalRows.push(...examiningRows);
        finalRows.push(...waitingSortedRows);
        inserted = true;
      }
      finalRows.push(row);
    }

    if (!inserted) {
      finalRows.push(...examiningRows);
      finalRows.push(...waitingSortedRows);
    }

    // 重複排除
    const seen = new Set();
    const uniqueFinal = [];
    for (const r of finalRows) {
      if (!r || seen.has(r)) continue;
      seen.add(r);
      uniqueFinal.push(r);
    }

    // ===== V3.8.2 追加: 差分チェック =====
    if (allRows.length === uniqueFinal.length) {
      let same = true;
      for (let i = 0; i < allRows.length; i++) {
        if (allRows[i] !== uniqueFinal[i]) { same = false; break; }
      }
      if (same) return;
    }

    // ===== V3.8.2 追加: ユーザー操作中はソート延期 =====
    if (userIsInteracting()) {
      if (!pendingDeferredSort) {
        pendingDeferredSort = true;
        window.setTimeout(() => {
          pendingDeferredSort = false;
          updateOnce();
        }, CONFIG.deferredSortRetryMs);
      }
      return;
    }

    // ===== V3.8.2 追加: フォーカス & スクロール保持 =====
    const activeEl = document.activeElement;
    const activeInTable = activeEl && tbody.contains(activeEl) ? activeEl : null;
    let savedSelStart = null, savedSelEnd = null;
    if (activeInTable) {
      try {
        if ('selectionStart' in activeInTable) savedSelStart = activeInTable.selectionStart;
        if ('selectionEnd' in activeInTable) savedSelEnd = activeInTable.selectionEnd;
      } catch (e) { /* 無視 */ }
    }
    const scrollContainer = findScrollContainer(tbody) || document.scrollingElement || document.documentElement;
    const savedScrollTop = scrollContainer ? scrollContainer.scrollTop : 0;
    const savedScrollLeft = scrollContainer ? scrollContainer.scrollLeft : 0;

    // ===== V3.8.2 追加: DocumentFragment でまとめて移動 =====
    isApplyingDom = true;
    try {
      const frag = document.createDocumentFragment();
      uniqueFinal.forEach(r => frag.appendChild(r));
      tbody.appendChild(frag);
    } finally {
      window.requestAnimationFrame(() => { isApplyingDom = false; });
    }

    // フォーカス復元
    if (activeInTable && document.activeElement !== activeInTable) {
      try {
        activeInTable.focus({ preventScroll: true });
        if (savedSelStart != null && typeof activeInTable.setSelectionRange === 'function') {
          activeInTable.setSelectionRange(savedSelStart, savedSelEnd != null ? savedSelEnd : savedSelStart);
        }
      } catch (e) { /* 無視 */ }
    }
    // スクロール位置復元
    if (scrollContainer) {
      if (scrollContainer.scrollTop !== savedScrollTop) scrollContainer.scrollTop = savedScrollTop;
      if (scrollContainer.scrollLeft !== savedScrollLeft) scrollContainer.scrollLeft = savedScrollLeft;
    }
  }

  function isBridgeFrontWaitingItem(item) {
    return item &&
      item.mode === 'waiting' &&
      normalizeCompareText(item.situationText) === normalizeCompareText('受付前で待機');
  }

  function isBridgeMiddleWaitingItem(item) {
    return item &&
      item.mode === 'waiting' &&
      normalizeCompareText(item.situationText) === normalizeCompareText('中待合で待機');
  }

  // V3.9.9: 再帰群(isBridgeReturnGroupItem)は「中待合department」の判定条件が
  // 中待合waitingItem(中待合+診察待)と重複しており、Bridging Autopilot側の表示が
  // 二重カウントに見えて紛らわしいため廃止。Bridge payloadからも削除する。

  function buildBridgePayload(waitingItems, examiningItems, examiningTestItems) {
    const frontWaitingItems = waitingItems.filter(isBridgeFrontWaitingItem);
    const middleWaitingItems = waitingItems.filter(isBridgeMiddleWaitingItem);
    const examTestItems = examiningTestItems || [];

    return {
      version: '1.3.0',
      source: 'Res.Prio.sys.V3.9.11',
      writtenAt: new Date().toISOString(),
      counts: {
        frontWaiting: frontWaitingItems.length,
        frontWaitingTarget: 6,
        middleWaiting: middleWaitingItems.length,
        middleWaitingTarget: 3,
        // V3.9.8: 検査中（科を問わず）の人数。Bridging AutopilotがmiddleWaitingと合算して目標人数判定に使う
        examiningTest: examTestItems.length,
        examining: examiningItems.length,
        waitingTotal: waitingItems.length
      },
      patients: {
        frontWaiting: frontWaitingItems.map(item => ({
          patientNo: item.patientNoText || '',
          patientName: item.patientNameText || '',
          department: item.departmentText || '',
          status: item.statusText || '',
          situation: item.situationText || ''
        })),
        middleWaiting: middleWaitingItems.map(item => ({
          patientNo: item.patientNoText || '',
          patientName: item.patientNameText || '',
          department: item.departmentText || '',
          status: item.statusText || '',
          situation: item.situationText || ''
        })),
        // V3.9.8: 検査中は科を問わないため situation は付与しない
        examiningTest: examTestItems.map(item => ({
          patientNo: item.patientNoText || '',
          patientName: item.patientNameText || '',
          department: item.departmentText || '',
          status: item.statusText || ''
        }))
      }
    };
  }

  function writeBridgePayload(payload) {
    try {
      localStorage.setItem(CONFIG.bridgeStorageKey, JSON.stringify(payload));
    } catch (e) {
      console.warn('Bridge payload write failed:', e);
    }
  }

  function updateOnce() {
    const table = findMainTable();
    if (!table) return false;

    const cols = pickColumns(table);
    if (cols.status < 0 || (cols.patientMemo < 0 && cols.receptionMemo < 0) || cols.patientNo < 0 || cols.department < 0) return false;

    const now = new Date();
    const waitingItems = [];
    const examiningItems = [];
    // V3.9.8: 検査中は科を問わず全行から拾う（中待合の判定とは独立の集計）
    const examiningTestItems = [];
    const uiState = loadUiState();

    table.querySelectorAll('tbody tr').forEach(row => {
      const tds = row.querySelectorAll('td');
      if (!tds || !tds.length) return;

      const statusTextForTest = getCellText(tds, cols.status);
      if (isExaminingTestStatus(statusTextForTest) &&
          !CONFIG.inactiveStatusKeywords.some(keyword => String(statusTextForTest).includes(keyword))) {
        examiningTestItems.push({
          patientNoText: getCellText(tds, cols.patientNo),
          patientNameText: getCellText(tds, cols.patientName),
          departmentText: getCellText(tds, cols.department),
          statusText: statusTextForTest
        });
      }

      const item = buildRowData(row, cols, now);
      if (!item) return;

      if (item.mode === 'waiting') waitingItems.push(item);
      if (item.mode === 'examining') examiningItems.push(item);
    });

    waitingItems.sort(compareRows);

    if (uiState.navEnabled) {
      applySortToTable(table, waitingItems, examiningItems);

      waitingItems.forEach((item, idx) => {
        renderWaitingRow(item, idx + 1);
      });

      examiningItems.forEach(item => {
        renderExaminingRow(item);
      });
    } else {
      clearAllOldRenders(table, cols);
    }

    const bridgePayload = buildBridgePayload(waitingItems, examiningItems, examiningTestItems);
    writeBridgePayload(bridgePayload);

    renderPanel(waitingItems, examiningItems, examiningTestItems);
    return true;
  }

  let scheduled = false;
  let initCompleted = false;

  function scheduleUpdate() {
    if (scheduled) return;
    scheduled = true;
    window.setTimeout(() => {
      scheduled = false;
      // V3.8.2: 描画タイミングをブラウザの paint cycle に合わせる
      window.requestAnimationFrame(() => updateOnce());
    }, CONFIG.tableScanDebounceMs);
  }

  function waitForTableAndInit(retry = 0) {
    const ok = updateOnce();
    if (ok) {
      initCompleted = true;
      return;
    }
    if (retry < CONFIG.initialRetryMax) {
      window.setTimeout(() => waitForTableAndInit(retry + 1), CONFIG.initialRetryIntervalMs);
    }
  }

  // V3.9.0: 初回起動時に旧バージョンの患者状態 localStorage を一括クリーンアップ
  function cleanupLegacyPatientStorage() {
    const legacyPrefix = 'tmPriorityStateV36::';
    const removeKeys = [];
    try {
      for (let i = 0; i < localStorage.length; i++) {
        const k = localStorage.key(i);
        if (k && k.startsWith(legacyPrefix)) {
          removeKeys.push(k);
        }
      }
      removeKeys.forEach(k => {
        try { localStorage.removeItem(k); } catch (e) {}
      });
      if (removeKeys.length) {
        console.log(`[Res.Prio.sys V3.9.0] 旧バージョンの患者状態データ ${removeKeys.length} 件を削除しました`);
      }
    } catch (e) {}
  }

  function startObserversWhenReady() {
    const start = () => {
      // V3.9.0: 旧バージョンの localStorage データをクリーンアップ
      cleanupLegacyPatientStorage();

      // ===== V3.8.2: ユーザー操作トラッカー =====
      const activityEvents = ['mousedown', 'mouseup', 'click', 'dblclick', 'keydown', 'keyup', 'wheel', 'touchstart', 'touchmove', 'focusin', 'dragstart'];
      activityEvents.forEach(ev => {
        document.addEventListener(ev, markUserActivity, { capture: true, passive: true });
      });

      // ===== V3.8.2: Observer のフィードバックループ抑制 =====
      const observer = new MutationObserver((mutations) => {
        if (isApplyingDom) return;
        const allOurs = mutations.every(m => {
          const checkNode = (n) => {
            if (!n || n.nodeType !== 1) return false;
            const cls = n.classList;
            if (cls && cls.contains(CONFIG.renderClass)) return true;
            if (n.id === CONFIG.panelId) return true;
            if (n.closest && n.closest(`.${CONFIG.renderClass}, #${CONFIG.panelId}`)) return true;
            return false;
          };
          for (const n of m.addedNodes) { if (!checkNode(n)) return false; }
          for (const n of m.removedNodes) { if (!checkNode(n)) return false; }
          if (m.type === 'attributes' || m.type === 'characterData') {
            return checkNode(m.target);
          }
          return true;
        });
        if (allOurs) return;
        scheduleUpdate();
      });
      observer.observe(document.body, { childList: true, subtree: true });

      createPanel();
      waitForTableAndInit();

      window.setInterval(() => {
        // V3.8.2: 操作中は定期更新もスキップ
        if (userIsInteracting()) return;
        updateOnce();
      }, CONFIG.refreshIntervalMs);
    };

    if (document.readyState === 'loading') {
      document.addEventListener('DOMContentLoaded', start, { once: true });
    } else {
      start();
    }
  }

  startObserversWhenReady();
})();
