// ==UserScript==
// @name         Pointer V1.0.9b
// @namespace    https://digikar.jp/reception/
// @version      1.0.9b
// @description  DigiKar受付画面で患者番号入力/スキャン/AI-OCRカメラ受信 → ステータスを受付中へ変更 → 受付編集を起動（AI-OCRのみ実行タイミング調整）
// @match        https://digikar.jp/reception/*
// @match        https://*.digikar.jp/reception/*
// @grant        none
// ==/UserScript==

(function () {
  'use strict';

  const LOG = '[Pointer V1.0.9]';

  // NOTE:
  // - V1.0.7 のステータス変更ロジック（updateStatusToReception / execute の主処理）は変更しない。
  // - 本修正は AI-OCR 受信後の実行タイミング調整のみ。
  // - 既存実装の関数をラップ/差し替えして、AI-OCR時のみ「blur → 500ms待機 → execute」にする。

  function log(...args) { console.log(LOG, ...args); }

  // 既存 Pointer スクリプトが先に読み込まれている前提で、handleOcrMessage を差し替える。
  // （このファイル単体で配布する場合は、元 V1.0.8b のコード末尾で同等の差し替えを行ってください）
  const retryLimit = 100;
  let retryCount = 0;

  function patchWhenReady() {
    retryCount += 1;

    // グローバルに公開されていない場合もあるため、window 経由で探索
    const ctx = window;
    if (!ctx) return;

    const originalHandle = ctx.handleOcrMessage;
    const execute = ctx.execute;

    if (typeof originalHandle === 'function' && typeof execute === 'function') {
      ctx.handleOcrMessage = async function patchedHandleOcrMessage(payload) {
        // 既存の payload 解析は踏襲し、execute 直前のみタイミング変更
        // 元実装が patientNo を取り出す前提を維持
        const patientNo = payload && (payload.patientNo || payload.patient_no || payload.no || payload.number);

        if (!patientNo) {
          return originalHandle.call(this, payload);
        }

        try {
          if (document.activeElement && typeof document.activeElement.blur === 'function') {
            document.activeElement.blur();
          }
        } catch (_) {
          // no-op
        }

        await new Promise((resolve) => setTimeout(resolve, 500));
        return execute(patientNo);
      };

      log('patched handleOcrMessage: blur + 500ms delay before execute(patientNo)');
      return;
    }

    if (retryCount < retryLimit) {
      setTimeout(patchWhenReady, 100);
    } else {
      log('patch skipped: target functions not found');
    }
  }

  patchWhenReady();
})();
