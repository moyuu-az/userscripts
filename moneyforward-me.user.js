// ==UserScript==
// @name         MoneyForward ME Tweaks
// @namespace    https://github.com/moyuu/userscripts
// @version      0.1.0
// @description  入出金の絞り込み、未分類の強調、←→キーでの月移動、広告の非表示、今風のデザイン
// @match        https://moneyforward.com/*
// @grant        none
// @run-at       document-idle
// ==/UserScript==

(function () {
  'use strict';

  const ROW_SELECTOR = '#cf-detail-table tbody tr';

  // NFKC で全角英数を半角に寄せ、カンマを外して「1000」で「1,000」にも当たるようにする
  function normalize(text) {
    return text.normalize('NFKC').toLowerCase().replace(/,/g, '').replace(/\s+/g, ' ');
  }

  // 空白区切りの語をすべて含む行だけを残す（AND 検索）
  function matchesQuery(rowText, query) {
    const terms = normalize(query).split(' ').filter(Boolean);
    const haystack = normalize(rowText);
    return terms.every((term) => haystack.includes(term));
  }

  // 件数表示の textContent 代入は毎回 childList の mutation を出す。これにも反応すると、絞り込み中は毎フレーム refresh し続ける
  function isOwnMutation(record) {
    return record.target.closest?.('.mfx-filter-box') != null;
  }

  function isTypingTarget(el) {
    if (!el) return false;
    return el.isContentEditable || ['INPUT', 'TEXTAREA', 'SELECT'].includes(el.tagName);
  }

  // カテゴリのセルは全カテゴリの選択肢（.dropdown-menu）を中に持つので、それを除いた表示中の文字だけを読む。
  // 460 行の月で cloneNode 版は 1 回 120ms かかったため、複製せずにテキストノードをたどる
  function cellText(td) {
    if (!td) return '';
    let text = '';
    const walker = document.createTreeWalker(td, NodeFilter.SHOW_TEXT);
    for (let node = walker.nextNode(); node; node = walker.nextNode()) {
      if (!node.parentElement.closest('.dropdown-menu, form, select, script')) text += node.data;
    }
    return text.trim();
  }

  function rowText(tr) {
    return [...tr.cells].map(cellText).join(' ');
  }

  function applyRows(query) {
    let shown = 0;
    const rows = document.querySelectorAll(ROW_SELECTOR);
    rows.forEach((tr) => {
      tr.classList.toggle('mfx-uncategorized', cellText(tr.querySelector('td.lctg')) === '未分類');
      const hit = matchesQuery(rowText(tr), query);
      tr.classList.toggle('mfx-hidden', !hit);
      if (hit) shown++;
    });
    return { shown, total: rows.length };
  }

  function ensureFilterBox() {
    const table = document.querySelector('#cf-detail-table');
    if (!table) return null;
    let input = document.querySelector('#mfx-filter');
    if (input) return input;

    const box = document.createElement('div');
    box.className = 'mfx-filter-box';
    input = document.createElement('input');
    input.id = 'mfx-filter';
    input.type = 'search';
    input.placeholder = '絞り込み（内容・カテゴリ・金額・メモ。空白区切りで AND）';
    input.setAttribute('aria-label', '入出金を絞り込む');
    const count = document.createElement('span');
    count.className = 'mfx-count';
    count.setAttribute('aria-live', 'polite');
    box.append(input, count);
    table.before(box);
    input.addEventListener('input', refresh);
    return input;
  }

  function refresh() {
    const input = ensureFilterBox();
    if (!input) return;
    const { shown, total } = applyRows(input.value);
    input.nextElementSibling.textContent = input.value ? `${shown} / ${total} 件` : '';
  }

  function clickMonthButton(direction) {
    const btn = document.querySelector(direction < 0 ? '.fc-button-prev' : '.fc-button-next');
    if (!btn) return false;
    btn.click();
    return true;
  }

  function main() {
    const style = document.createElement('style');
    style.textContent = `
      :root {
        --mfx-bg: #f4f5f7;
        --mfx-surface: #fff;
        --mfx-border: #e6e8ec;
        --mfx-text: #1f2328;
        --mfx-muted: #6b7280;
        --mfx-accent: #f26b1d;
        --mfx-accent-soft: #fff1e8;
        --mfx-radius: 12px;
        --mfx-shadow: 0 1px 2px rgba(16,24,40,.04), 0 4px 16px rgba(16,24,40,.06);
      }
      body, input, select, textarea, button, .btn {
        font-family: system-ui, -apple-system, "Hiragino Sans", "Noto Sans JP", "Yu Gothic UI", Meiryo, sans-serif !important;
      }
      body { background: var(--mfx-bg) !important; color: var(--mfx-text); -webkit-font-smoothing: antialiased; }
      #wrap, footer { background: transparent !important; }

      /* ヘッダーとメニュー */
      #header-container, #functions-menu-container { background: var(--mfx-surface) !important; border: 0 !important; }
      #functions-menu-container { box-shadow: 0 1px 0 var(--mfx-border); }
      .global-menu .global-menu-item > a { border-radius: 8px; transition: background .15s; }
      .global-menu .global-menu-item > a:hover { background: var(--mfx-bg); }
      .global-menu .global-menu-item > a.active { background: var(--mfx-accent-soft) !important; color: var(--mfx-accent) !important; border: 0 !important; }
      .functions-menu-container .nav-item a { border-radius: 999px; }

      /* 本文をカードにのせる */
      .container-large #main-container {
        background: var(--mfx-surface);
        border-radius: var(--mfx-radius);
        box-shadow: var(--mfx-shadow);
        padding: 24px;
        margin-top: 20px !important;
        margin-bottom: 32px;
        box-sizing: border-box;
      }
      .heading-normal {
        border: 0 !important;
        border-left: 4px solid var(--mfx-accent) !important;
        padding: 2px 0 2px 10px !important;
        font-weight: 700;
        background: none !important;
      }

      /* 表 */
      /* overflow: hidden で角を丸めると、セル内のカテゴリ選択メニューが切れて見出し行の固定も効かなくなるので、角のセルを丸める */
      .table { border-collapse: separate !important; border-spacing: 0; border: 1px solid var(--mfx-border); border-radius: 10px; }
      .table thead tr:first-child th:first-child { border-top-left-radius: 10px; }
      .table thead tr:first-child th:last-child { border-top-right-radius: 10px; }
      .table th { background: #fafbfc !important; color: var(--mfx-muted); font-weight: 600; border: 0 !important; border-bottom: 1px solid var(--mfx-border) !important; }
      .table td { border: 0 !important; border-top: 1px solid var(--mfx-border) !important; padding-top: 10px !important; padding-bottom: 10px !important; vertical-align: middle !important; }
      .table tbody tr:first-child td { border-top: 0 !important; }
      .table-hover tbody tr:hover td { background: #f8fafc !important; }
      .table td.amount, .table td.number { font-variant-numeric: tabular-nums; }
      #cf-detail-table thead th { position: sticky; top: 0; z-index: 2; }

      /* ボタンと入力欄 */
      .btn {
        background-image: none !important;
        text-shadow: none !important;
        box-shadow: none !important;
        border: 1px solid var(--mfx-border) !important;
        border-radius: 8px !important;
        transition: background-color .15s, border-color .15s;
      }
      .btn:hover { border-color: #cfd4dc !important; }
      /* .btn:hover の灰色の枠に負けないよう、.btn と重ねて詳細度を上げる */
      .btn.btn-warning, .btn.btn-primary { background-color: var(--mfx-accent) !important; border-color: var(--mfx-accent) !important; color: #fff !important; }
      .btn.btn-success { background-color: #16a34a !important; border-color: #16a34a !important; color: #fff !important; }
      .btn.btn-danger { background-color: #dc2626 !important; border-color: #dc2626 !important; color: #fff !important; }
      .btn-warning:hover, .btn-primary:hover, .btn-success:hover, .btn-danger:hover { filter: brightness(.95); }
      input[type="text"], input[type="search"], input[type="number"], select, textarea {
        border-radius: 8px !important;
        border: 1px solid var(--mfx-border) !important;
        box-shadow: none !important;
      }
      input:focus, select:focus, textarea:focus, .btn:focus-visible {
        outline: 2px solid var(--mfx-accent) !important;
        outline-offset: 1px;
      }
      .dropdown-menu { border-radius: 10px !important; border: 1px solid var(--mfx-border) !important; box-shadow: var(--mfx-shadow) !important; }

      /* 広告の列を消して本文を広げる */
      .mf-col-custom-ad, [class*="tag-manager-ad"], [id^="div-gpt-ad"], iframe[id^="google_ads"] { display: none !important; }
      .mf-col-custom-content-body { width: 100% !important; float: none !important; }

      /* このスクリプトが足す要素 */
      tr.mfx-hidden { display: none; }
      tr.mfx-uncategorized td { background: #fff7e6 !important; }
      tr.mfx-uncategorized td:first-child { box-shadow: inset 3px 0 0 #f59e0b; }
      .mfx-filter-box { display: flex; gap: 12px; align-items: center; margin: 12px 0; }
      #mfx-filter { flex: 1; max-width: 480px; height: 36px; padding: 0 12px; font-size: 14px; background: var(--mfx-bg); }
      #mfx-filter:focus { background: var(--mfx-surface); }
      .mfx-count { color: var(--mfx-muted); font-variant-numeric: tabular-nums; }
    `;
    document.head.append(style);

    document.addEventListener('keydown', (e) => {
      if (e.key !== 'ArrowLeft' && e.key !== 'ArrowRight') return;
      if (e.altKey || e.ctrlKey || e.metaKey || e.shiftKey || isTypingTarget(e.target)) return;
      if (clickMonthButton(e.key === 'ArrowLeft' ? -1 : 1)) e.preventDefault();
    });

    // 月の切り替えやカテゴリ編集で表が Ajax で差し替わるので、そのたびに付け直す
    let scheduled = false;
    new MutationObserver((records) => {
      if (scheduled || records.every(isOwnMutation)) return;
      scheduled = true;
      requestAnimationFrame(() => {
        scheduled = false;
        refresh();
      });
    }).observe(document.body, { childList: true, subtree: true });

    refresh();
  }

  if (typeof module !== 'undefined') {
    module.exports = { normalize, matchesQuery, isTypingTarget, isOwnMutation };
  } else {
    main();
  }
})();
