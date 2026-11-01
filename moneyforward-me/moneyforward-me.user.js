// ==UserScript==
// @name         MoneyForward ME Tweaks
// @namespace    https://github.com/moyuu-az/userscripts
// @version      0.2.0
// @description  サイドバーとダークモードのある見た目に作り直し、入出金の絞り込み・未分類の強調・←→キーでの月移動を足す
// @match        https://moneyforward.com/*
// @grant        none
// @run-at       document-start
// @noframes
// ==/UserScript==

(function () {
  'use strict';

  const ROW_SELECTOR = '#cf-detail-table tbody tr';
  const THEME_KEY = 'mfx-theme';
  const CAL_KEY = 'mfx-calendar-open';
  const THEME_LABELS = { auto: '自動', light: 'ライト', dark: 'ダーク' };

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

  // 自分で足した要素（.mfx-own）の中の変化にも反応すると、件数表示などを書き換えるたびに refresh が回り続ける
  function isOwnMutation(record) {
    return record.target.closest?.('.mfx-own') != null;
  }

  function isTypingTarget(el) {
    if (!el) return false;
    return el.isContentEditable || ['INPUT', 'TEXTAREA', 'SELECT'].includes(el.tagName);
  }

  function resolveTheme(pref, prefersDark) {
    if (pref === 'light' || pref === 'dark') return pref;
    return prefersDark ? 'dark' : 'light';
  }

  function nextThemePref(pref) {
    return { auto: 'light', light: 'dark', dark: 'auto' }[pref] ?? 'auto';
  }

  // --- ダークモード用の色の判定 ---
  // MF の CSS は色を直書きした規則が多く、セレクタを個別に上書きしても塗り残しが出る。
  // そこで要素の実際の色を読み、明るい背景・暗い文字・明るい枠線だけを暗い配色の値に置き換える

  function parseRgb(value) {
    const m = /^rgba?\(([^)]+)\)$/.exec(value ?? '');
    if (!m) return null;
    const p = m[1].split(/[\s,/]+/).filter(Boolean).map(Number);
    if (p.length < 3 || p.some(Number.isNaN)) return null;
    return { r: p[0], g: p[1], b: p[2], a: p.length > 3 ? p[3] : 1 };
  }

  function luminance({ r, g, b }) {
    const f = (v) => {
      v /= 255;
      return v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4;
    };
    return 0.2126 * f(r) + 0.7152 * f(g) + 0.0722 * f(b);
  }

  function saturation({ r, g, b }) {
    const max = Math.max(r, g, b);
    return max === 0 ? 0 : (max - Math.min(r, g, b)) / max;
  }

  // 戻り値: null（そのまま）/ { cls } / { cls, value }（value は CSS 変数に入れる色）
  function classifyBg(c) {
    // 0.55 は #c3c3c3 あたり。カレンダーの前月・翌月のマス（#ddd、0.72）まで拾える値にしている
    if (!c || c.a === 0 || luminance(c) <= 0.55) return null;
    // 彩度の高い色（予算の進捗バーなど）は明るくても意味のある色なので残し、淡いパステル調の背景だけを薄める
    if (saturation(c) >= 0.35) return null;
    if (saturation(c) >= 0.08) return { cls: 'mfx-dk-bgt', value: `rgba(${c.r}, ${c.g}, ${c.b}, 0.16)` };
    return { cls: luminance(c) > 0.95 ? 'mfx-dk-bg1' : 'mfx-dk-bg2' };
  }

  function classifyFg(c) {
    if (!c || c.a === 0) return null;
    const lum = luminance(c);
    if (saturation(c) >= 0.2) {
      if (lum >= 0.25) return null;
      const lift = (v) => Math.round(v + (255 - v) * 0.45);
      return { cls: 'mfx-dk-fgt', value: `rgb(${lift(c.r)}, ${lift(c.g)}, ${lift(c.b)})` };
    }
    if (lum < 0.06) return { cls: 'mfx-dk-fg1' };
    if (lum < 0.4) return { cls: 'mfx-dk-fg2' };
    return null;
  }

  function isLightBorder(c) {
    return !!c && c.a > 0 && luminance(c) > 0.5;
  }

  // 幅のある辺の色だけを見る。幅 0 の辺の色は文字色（currentColor）なので、明るい文字の要素では
  // 見出しの左のアクセント線のような色付きの線まで灰色に塗り替えてしまう
  function hasLightBorder(cs) {
    return ['Top', 'Right', 'Bottom', 'Left'].some(
      (side) => parseFloat(cs[`border${side}Width`]) > 0 && isLightBorder(parseRgb(cs[`border${side}Color`])),
    );
  }

  // --- ページの処理 ---

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
    box.className = 'mfx-filter-box mfx-own';
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

  function setText(el, text) {
    if (el.textContent !== text) el.textContent = text;
  }

  function parseAmount(text) {
    const m = /^([-−]?)([\d,]+)円$/.exec(text.trim());
    return m ? (m[1] ? -1 : 1) * Number(m[2].replace(/,/g, '')) : null;
  }

  function formatAmount(n) {
    const r = Math.round(n);
    return `${r < 0 ? '-' : ''}${Math.abs(r).toLocaleString('ja-JP')}円`;
  }

  const reducedMotion = () => window.matchMedia('(prefers-reduced-motion: reduce)').matches;

  // 金額を今の表示からカウントアップ（ダウン）させる。refresh は DOM が変わるたびに呼ばれるので、
  // 同じ目標値なら動いている途中のアニメーションをそのまま続ける
  function countUp(el, text) {
    if (el.dataset.mfxTarget === text) return;
    el.dataset.mfxTarget = text;
    const to = parseAmount(text);
    const from = parseAmount(el.textContent) ?? 0;
    // 裏のタブでは requestAnimationFrame が止まり、表に出すまで数字が空のままになるので、すぐ入れる
    if (to === null || from === to || reducedMotion() || document.hidden) return setText(el, text);
    const start = performance.now();
    const step = (now) => {
      if (el.dataset.mfxTarget !== text) return; // 途中で月が変わった
      // rAF に渡る時刻はフレームの始まり（vsync）なので、読み込み直後の refresh など rAF の外から呼ぶと start より前になることがある。
      // 負のまま計算すると元の値の外に飛ぶ（0 から増やすときに一瞬マイナスが出る）
      const t = Math.min(Math.max((now - start) / 600, 0), 1);
      setText(el, t === 1 ? text : formatAmount(from + (to - from) * (1 - (1 - t) ** 3)));
      if (t < 1) requestAnimationFrame(step);
    };
    requestAnimationFrame(step);
  }

  // 月次収支の表（当月収入・支出・収支）を数字のカードにする。月を切り替えると MF が表を差し替えるので毎回読み直す
  function renderSummary() {
    const source = document.querySelector('#monthly_total_table_kakeibo');
    const calendar = document.querySelector('#kakeibo .mf-col-custom-body');
    if (!source || !calendar) return;
    document.documentElement.classList.add('mfx-cf');

    let summary = document.querySelector('#mfx-summary');
    if (!summary) {
      summary = document.createElement('div');
      summary.id = 'mfx-summary';
      summary.className = 'mfx-own';
      for (let i = 0; i < 3; i++) {
        const stat = document.createElement('div');
        stat.className = 'mfx-stat';
        stat.innerHTML = '<div class="mfx-stat-label"></div><div class="mfx-stat-value"></div>';
        summary.append(stat);
      }
      const toggle = document.createElement('button');
      toggle.type = 'button';
      toggle.id = 'mfx-cal-toggle';
      toggle.addEventListener('click', () => setCalendarOpen(!document.documentElement.classList.contains('mfx-cal-open')));
      summary.append(toggle);
      calendar.before(summary);
      setCalendarOpen(readStorage(CAL_KEY) === '1');
    }

    const labels = source.querySelectorAll('thead th');
    const cells = source.querySelectorAll('tbody td');
    summary.querySelectorAll('.mfx-stat').forEach((stat, i) => {
      const cell = cells[i * 2];
      setText(stat.firstChild, labels[i * 2]?.textContent.trim() ?? '');
      countUp(stat.lastChild, cell?.textContent.trim() ?? '');
      stat.lastChild.className = `mfx-stat-value ${cell?.className ?? ''}`;
    });
  }

  function setCalendarOpen(open) {
    document.documentElement.classList.toggle('mfx-cal-open', open);
    writeStorage(CAL_KEY, open ? '1' : '0');
    const toggle = document.querySelector('#mfx-cal-toggle');
    if (toggle) {
      toggle.textContent = open ? 'カレンダーを隠す' : 'カレンダーを表示';
      toggle.setAttribute('aria-expanded', String(open));
    }
    // 隠れている間に描画されたカレンダーは幅 0 で列幅を固定しているので、表示したら計算し直させる
    if (open) window.dispatchEvent(new Event('resize'));
  }

  function refresh() {
    renderSummary();
    const input = ensureFilterBox();
    if (!input) return;
    const { shown, total } = applyRows(input.value);
    setText(input.nextElementSibling, input.value ? `${shown} / ${total} 件` : '');
  }

  function clickMonthButton(direction) {
    const btn = document.querySelector(direction < 0 ? '.fc-button-prev' : '.fc-button-next');
    if (!btn) return false;
    btn.click();
    return true;
  }

  // localStorage は設定やブラウザによって例外を投げるので、使えないときは毎回既定値に戻るだけにする
  function readStorage(key) {
    try {
      return localStorage.getItem(key);
    } catch {
      return null;
    }
  }

  function writeStorage(key, value) {
    try {
      localStorage.setItem(key, value);
    } catch {
      // 保存できなくても表示は切り替わる
    }
  }

  const darkened = new WeakSet();

  // roots はまとめて渡す。月を切り替えると MF は表の行を 1 行ずつ足すので、行ごとに読み書きすると
  // そのたびにスタイルの再計算が走り、474 行の月で 700ms 近く止まった
  function darkify(roots) {
    // 足されてすぐ外された要素は getComputedStyle が空を返す。処理済みにすると付け直されたときに直せなくなる
    const targets = roots
      .filter((root) => root?.nodeType === 1 && root.isConnected)
      .flatMap((root) => [root, ...root.querySelectorAll('*')]);
    // 読み取りをまとめてから書き込み、書き込みのたびにスタイルの再計算が走らないようにする
    const plans = [];
    const sameAsParent = [];
    for (const el of targets) {
      if (darkened.has(el)) continue;
      darkened.add(el);
      if (/^(SCRIPT|STYLE|NOSCRIPT|IMG|CANVAS|IFRAME|BR|svg)$/i.test(el.tagName) || el.closest('svg, .mfx-own')) continue;
      const cs = getComputedStyle(el);
      const bg = classifyBg(parseRgb(cs.backgroundColor));
      // .btn の文字色はこのスクリプトの CSS が地の色に合わせて決めている。読むと、オレンジの地の上の濃い文字を
      // 「暗い文字」と見なして灰色に変えてしまう
      const fg = el.matches('.btn') ? null : classifyFg(parseRgb(cs.color));
      // 親と同じ文字色は受け継いだだけのことが多く、親を直せば変わる。全要素にクラスを付けると重いので後回しにする
      const inherited = fg && el.parentElement && getComputedStyle(el.parentElement).color === cs.color;
      if (inherited) sameAsParent.push(el);
      const bordered = hasLightBorder(cs);
      if (bg || (fg && !inherited) || bordered) plans.push({ el, bg, fg: inherited ? null : fg, bordered });
    }
    const apply = ({ el, bg, fg, bordered }) => {
      if (bg) {
        el.classList.add(bg.cls);
        if (bg.value) el.style.setProperty('--mfx-dk-bg', bg.value);
      }
      if (fg) {
        el.classList.add(fg.cls);
        if (fg.value) el.style.setProperty('--mfx-dk-fg', fg.value);
      }
      if (bordered) el.classList.add('mfx-dk-bd');
    };
    plans.forEach(apply);
    // 親を直したあとも暗いままの要素は、親と同じ色を自分でも指定していたもの（右上の「ログアウト」など）なので、改めて直す
    for (const el of sameAsParent) {
      const fg = classifyFg(parseRgb(getComputedStyle(el).color));
      if (fg) apply({ el, fg });
    }
  }

  const ICONS = {
    '/': 'M3 10.5 12 3l9 7.5V21h-6v-6H9v6H3z',
    '/cf': 'M5 3h11a3 3 0 0 1 3 3v15H8a3 3 0 0 1-3-3zM9 8h6M9 12h6M9 16h4',
    '/spending_summaries': 'M12 3v9h9M20.5 15A9 9 0 1 1 9 3.5',
    '/bs': 'M3 17l6-6 4 4 8-8M15 7h6v6',
    '/accounts': 'M3 10h18M5 10v8M10 10v8M14 10v8M19 10v8M3 21h18M12 3l9 5H3z',
    '/analysis': 'M6 3h9l4 4v14H6zM14 3v5h5M9 13h7M9 17h7',
    '/related_services': 'M4 4h7v7H4zM13 4h7v7h-7zM4 13h7v7H4zM13 13h7v7h-7z',
    '/profile': 'M12 8.5a3.5 3.5 0 1 1 0 7 3.5 3.5 0 0 1 0-7zM12 2v3M12 19v3M2 12h3M19 12h3M4.9 4.9 7 7M17 17l2.1 2.1M4.9 19.1 7 17M17 7l2.1-2.1',
    theme: 'M21 12.8A9 9 0 1 1 11.2 3a7 7 0 0 0 9.8 9.8z',
  };

  function icon(path) {
    return `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="${path}"/></svg>`;
  }

  function iconFor(href) {
    if (href === '/') return ICONS['/'];
    const key = Object.keys(ICONS).find((k) => k !== '/' && href.startsWith(k));
    return ICONS[key] ?? ICONS['/related_services'];
  }

  // MF の上部メニュー（.global-menu）から項目を読み、左のサイドバーを組み立てる。リンク先は MF のものをそのまま使う
  function buildSidebar() {
    const items = document.querySelectorAll('.global-menu > ul > li');
    if (!items.length || document.querySelector('#mfx-sidebar')) return;
    const path = location.pathname;

    const nav = document.createElement('nav');
    nav.id = 'mfx-sidebar';
    nav.className = 'mfx-own';
    nav.setAttribute('aria-label', 'メインメニュー');

    const brand = document.createElement('a');
    brand.className = 'mfx-brand';
    brand.href = '/';
    const logo = document.querySelector('h1.logo img');
    if (logo) brand.append(logo.cloneNode());
    else brand.textContent = 'Money Forward ME';
    nav.append(brand);

    const list = document.createElement('ul');
    list.className = 'mfx-nav';
    for (const li of items) {
      const top = li.querySelector(':scope > a');
      const href = top?.getAttribute('href');
      if (!href) continue;
      const subs = [...li.querySelectorAll('.dropdown-menu a')];
      const active = top.classList.contains('active') || subs.some((a) => a.getAttribute('href') === path);

      const item = document.createElement('li');
      if (active) item.className = 'is-active';
      const link = document.createElement('a');
      link.href = href;
      link.innerHTML = icon(iconFor(href));
      link.append(top.textContent.trim());
      // 子ページを開いているときの親項目は「今のページ」ではないので true にする（page は子のリンクに付く）
      if (active) link.setAttribute('aria-current', href === path ? 'page' : 'true');
      item.append(link);

      if (active && subs.length) {
        const sub = document.createElement('ul');
        sub.className = 'mfx-subnav';
        for (const a of subs) {
          const subItem = document.createElement('li');
          const subLink = document.createElement('a');
          subLink.href = a.getAttribute('href');
          subLink.textContent = a.textContent.trim();
          if (subLink.getAttribute('href') === path) {
            subLink.className = 'is-current';
            subLink.setAttribute('aria-current', 'page');
          }
          subItem.append(subLink);
          sub.append(subItem);
        }
        item.append(sub);
      }
      list.append(item);
    }
    nav.append(list);

    const foot = document.createElement('div');
    foot.className = 'mfx-sidebar-foot';
    const toggle = document.createElement('button');
    toggle.type = 'button';
    toggle.id = 'mfx-theme-toggle';
    toggle.addEventListener('click', () => {
      themePref = nextThemePref(readThemePref());
      writeStorage(THEME_KEY, themePref);
      // 色を CSS の transition で変えると、darkify が切り替え途中の色を読んで判定を誤るので、画面全体のクロスフェードにする
      if (document.startViewTransition && !reducedMotion()) document.startViewTransition(applyTheme);
      else applyTheme();
    });
    foot.append(toggle);
    nav.append(foot);

    document.body.prepend(nav);
    updateThemeToggle();
  }

  let darkQuery; // main() で設定する。テストで読み込むときは window がない
  // localStorage が使えない環境でも、ボタンで選んだ値をこのページを開いている間は保つ
  let themePref = null;

  function readThemePref() {
    const pref = readStorage(THEME_KEY) ?? themePref;
    return pref === 'light' || pref === 'dark' ? pref : 'auto';
  }

  function updateThemeToggle() {
    const toggle = document.querySelector('#mfx-theme-toggle');
    if (!toggle) return;
    const label = THEME_LABELS[readThemePref()];
    // 読み上げの名前は見えている文字と同じにする（aria-label で別の名前を付けると音声操作で呼べない）
    toggle.innerHTML = `${icon(ICONS.theme)}<span>テーマ: ${label}</span>`;
  }

  function applyTheme() {
    const theme = resolveTheme(readThemePref(), darkQuery.matches);
    document.documentElement.dataset.mfxTheme = theme;
    if (theme === 'dark' && document.body) darkify([document.body]);
    updateThemeToggle();
  }

  const STYLE = `
    :root {
      --mfx-sidebar-w: 232px;
      --mfx-bg: #f4f5f7;
      --mfx-surface: #fff;
      --mfx-surface-2: #f8f9fb;
      --mfx-hover: #f1f3f6;
      --mfx-border: #e6e8ec;
      --mfx-text: #1f2328;
      /* muted は hover 背景の上でも 4.5:1 を保つ濃さ。accent は白文字・淡い背景の上の文字には明るすぎるので、文字用に accent-text を分ける */
      --mfx-muted: #656c79;
      --mfx-accent: #f26b1d;
      --mfx-accent-soft: #fff1e8;
      --mfx-accent-text: #c2410c;
      --mfx-on-accent: #fff;
      --mfx-plus: #1d4ed8;
      --mfx-minus: #dc2626;
      --mfx-warn-bg: #fff7e6;
      --mfx-warn: #f59e0b;
      --mfx-radius: 14px;
      --mfx-shadow: 0 1px 2px rgba(16,24,40,.04), 0 4px 16px rgba(16,24,40,.06);
    }
    html[data-mfx-theme="dark"] {
      color-scheme: dark;
      --mfx-bg: #0e1015;
      --mfx-surface: #161920;
      --mfx-surface-2: #1c2028;
      --mfx-hover: #222733;
      --mfx-border: #2a303c;
      --mfx-text: #e6e8ec;
      --mfx-muted: #9aa3b2;
      --mfx-accent: #ff8a3d;
      --mfx-accent-soft: rgba(255,138,61,.14);
      --mfx-accent-text: #ff8a3d;
      --mfx-plus: #60a5fa;
      --mfx-minus: #f87171;
      --mfx-warn-bg: rgba(245,158,11,.14);
      --mfx-shadow: 0 1px 2px rgba(0,0,0,.4), 0 6px 20px rgba(0,0,0,.35);
    }
    body, input, select, textarea, button, .btn {
      font-family: system-ui, -apple-system, "Hiragino Sans", "Noto Sans JP", "Yu Gothic UI", Meiryo, sans-serif !important;
    }
    html, body { background: var(--mfx-bg) !important; }
    body { color: var(--mfx-text); -webkit-font-smoothing: antialiased; }
    #wrap, footer, footer * { background-color: transparent !important; }
    a { color: var(--mfx-plus); }

    /* サイドバー。上部メニューとロゴは隠し、右上の操作（グループ選択・お知らせ・ログアウト）だけを上に残す */
    body:has(.global-menu) #wrap, body:has(.global-menu) > footer { margin-left: var(--mfx-sidebar-w) !important; }
    .global-menu, #functions-menu-container, #header h1.logo { display: none !important; }
    #header-container { background: transparent !important; border: 0 !important; box-shadow: none !important; }
    .upper-contents { display: flex; justify-content: flex-end; align-items: center; min-height: 52px; }
    #mfx-sidebar {
      position: fixed; inset: 0 auto 0 0; width: var(--mfx-sidebar-w); z-index: 1030;
      display: flex; flex-direction: column; box-sizing: border-box; padding: 18px 12px; overflow-y: auto;
      background: var(--mfx-surface); border-right: 1px solid var(--mfx-border);
    }
    .mfx-brand { display: block; padding: 2px 10px 18px; }
    .mfx-brand img { width: 160px; height: auto; display: block; }
    html[data-mfx-theme="dark"] .mfx-brand img { filter: brightness(0) invert(.92); }
    .mfx-nav, .mfx-subnav { list-style: none; margin: 0; padding: 0; }
    .mfx-nav { display: flex; flex-direction: column; gap: 2px; }
    .mfx-nav a {
      display: flex; align-items: center; gap: 10px; padding: 9px 10px; border-radius: 9px;
      color: var(--mfx-text) !important; text-decoration: none !important; font-size: 14px; line-height: 1.3;
    }
    .mfx-nav a:hover { background: var(--mfx-hover); }
    .mfx-nav svg { width: 18px; height: 18px; flex: none; }
    .mfx-nav .is-active > a { background: var(--mfx-accent-soft); color: var(--mfx-accent-text) !important; font-weight: 600; }
    .mfx-subnav { margin: 4px 0 8px; padding-left: 28px; }
    .mfx-subnav a { padding: 6px 10px; font-size: 13px; color: var(--mfx-muted) !important; }
    .mfx-subnav a.is-current { color: var(--mfx-text) !important; font-weight: 600; background: var(--mfx-hover); }
    .mfx-sidebar-foot { margin-top: auto; padding-top: 12px; border-top: 1px solid var(--mfx-border); }
    #mfx-theme-toggle {
      display: flex; align-items: center; gap: 10px; width: 100%; padding: 9px 10px; border: 0; border-radius: 9px;
      background: transparent; color: var(--mfx-muted); font-size: 13px; cursor: pointer; text-align: left;
    }
    #mfx-theme-toggle:hover { background: var(--mfx-hover); color: var(--mfx-text); }
    #mfx-theme-toggle svg { width: 18px; height: 18px; flex: none; }

    /* 本文の幅を 1200px 固定から、サイドバーを除いた幅いっぱいに広げる */
    .container-large, .header-inner-container {
      width: auto !important; max-width: 1360px; margin-left: auto !important; margin-right: auto !important;
      padding-left: 24px; padding-right: 24px; box-sizing: border-box;
    }
    #main-container, .mf-col-custom-wrapper { width: auto !important; }

    /* 本文をカードにのせる */
    .container-large #main-container {
      background: var(--mfx-surface); border-radius: var(--mfx-radius); box-shadow: var(--mfx-shadow);
      padding: 24px; margin-top: 4px !important; margin-bottom: 32px; box-sizing: border-box;
    }
    .heading-normal {
      border: 0 !important; border-left: 4px solid var(--mfx-accent) !important;
      padding: 2px 0 2px 10px !important; font-weight: 700; background: none !important; color: var(--mfx-text) !important;
    }
    .plus-color { color: var(--mfx-plus) !important; }
    .minus-color { color: var(--mfx-minus) !important; }

    /* 表 */
    /* overflow: hidden で角を丸めると、セル内のカテゴリ選択メニューが切れて見出し行の固定も効かなくなるので、角のセルを丸める */
    .table { border-collapse: separate !important; border-spacing: 0; border: 1px solid var(--mfx-border) !important; border-radius: 10px; }
    .table thead tr:first-child th:first-child { border-top-left-radius: 10px; }
    .table thead tr:first-child th:last-child { border-top-right-radius: 10px; }
    .table th { background: var(--mfx-surface-2) !important; color: var(--mfx-muted) !important; font-weight: 600; border: 0 !important; border-bottom: 1px solid var(--mfx-border) !important; }
    .table td { border: 0 !important; border-top: 1px solid var(--mfx-border) !important; padding-top: 10px !important; padding-bottom: 10px !important; vertical-align: middle !important; }
    .table tbody tr:first-child td { border-top: 0 !important; }
    .table-hover tbody tr:hover td { background: var(--mfx-hover) !important; }
    .table td.amount, .table td.number { font-variant-numeric: tabular-nums; }

    /* ボタンと入力欄 */
    .btn {
      background-image: none !important; text-shadow: none !important; box-shadow: none !important;
      background-color: var(--mfx-surface) !important; color: var(--mfx-text) !important;
      border: 1px solid var(--mfx-border) !important; border-radius: 8px !important;
    }
    .btn:hover { border-color: var(--mfx-muted) !important; }
    /* 上の背景色の上書きで、ボタングループの選択中（.active）の見分けが消えるので付け直す */
    .btn.active { background-color: var(--mfx-accent-soft) !important; border-color: var(--mfx-accent) !important; color: var(--mfx-accent-text) !important; }
    /* .btn:hover の灰色の枠に負けないよう、.btn と重ねて詳細度を上げる */
    .btn.btn-warning, .btn.btn-primary { background-color: var(--mfx-accent) !important; border-color: var(--mfx-accent) !important; color: var(--mfx-on-accent) !important; }
    .btn.btn-success { background-color: #16a34a !important; border-color: #16a34a !important; color: #fff !important; }
    .btn.btn-danger { background-color: #dc2626 !important; border-color: #dc2626 !important; color: #fff !important; }
    .btn-warning:hover, .btn-primary:hover, .btn-success:hover, .btn-danger:hover { filter: brightness(.95); }
    /* ダークではオレンジのベタ塗りが浮くので、薄いオレンジの地にオレンジの文字と枠で控えめにする */
    html[data-mfx-theme="dark"] .btn.btn-warning, html[data-mfx-theme="dark"] .btn.btn-primary {
      background-color: var(--mfx-accent-soft) !important; border-color: rgba(255,138,61,.45) !important; color: var(--mfx-accent-text) !important;
    }
    html[data-mfx-theme="dark"] .btn.btn-warning:hover, html[data-mfx-theme="dark"] .btn.btn-primary:hover { background-color: rgba(255,138,61,.24) !important; filter: none; }
    /* 「集計期間を変更」「手入力」: 古いメモ帳の画像を隠し、MF がインラインで指定した幅と余白を上書きして高さをそろえる */
    .cf-new-btn img { display: none !important; }
    .cf-new-btn {
      box-sizing: border-box !important; height: 34px !important; width: auto !important; padding: 0 16px !important; line-height: 1 !important;
      display: inline-flex !important; align-items: center; justify-content: center; vertical-align: middle;
    }
    input[type="text"], input[type="search"], input[type="number"], input[type="password"], select, textarea {
      border-radius: 8px !important; border: 1px solid var(--mfx-border) !important; box-shadow: none !important;
      background-color: var(--mfx-surface) !important; color: var(--mfx-text) !important;
    }
    input:disabled, select:disabled, textarea:disabled { background-color: var(--mfx-surface-2) !important; color: var(--mfx-muted) !important; }
    input:focus, select:focus, textarea:focus, .btn:focus-visible, .mfx-own button:focus-visible, .mfx-own a:focus-visible {
      outline: 2px solid var(--mfx-accent) !important; outline-offset: 1px;
    }
    .dropdown-menu { border-radius: 10px !important; border: 1px solid var(--mfx-border) !important; box-shadow: var(--mfx-shadow) !important; background: var(--mfx-surface) !important; }
    .dropdown-menu a { color: var(--mfx-text) !important; }
    /* Bootstrap はサブメニューを開いている親項目・選択中の項目を青地に白文字にするので、上の文字色のままだと読みにくい */
    .dropdown-menu a:hover, .dropdown-menu a:focus, .dropdown-submenu:hover > a { background: var(--mfx-hover) !important; background-image: none !important; }
    .dropdown-menu .active > a { background: var(--mfx-accent-soft) !important; color: var(--mfx-accent-text) !important; }
    .dropdown-menu .disabled > a { color: var(--mfx-muted) !important; }

    /* 広告の列を消して本文を広げる */
    .mf-col-custom-ad, [class*="tag-manager-ad"], [id^="div-gpt-ad"], iframe[id^="google_ads"] { display: none !important; }
    .mf-col-custom-content-body { width: 100% !important; float: none !important; }

    /* 入出金ページ: 説明文と月次収支の表を数字のカードに置き換え、カレンダーは開閉式にして一覧を上に寄せる */
    #kakeibo p.explain, #in_out p.explain { display: none !important; }
    .mfx-cf #monthly_total { display: none !important; }
    .mfx-cf:not(.mfx-cal-open) #kakeibo .mf-col-custom-body { display: none !important; }
    #mfx-summary { display: grid; grid-template-columns: repeat(3, minmax(0, 1fr)) auto; gap: 12px; margin: 14px 0 22px; clear: both; }
    .mfx-stat { background: var(--mfx-surface-2); border: 1px solid var(--mfx-border); border-radius: 12px; padding: 12px 16px; }
    .mfx-stat-label { font-size: 12px; color: var(--mfx-muted); }
    .mfx-stat-value { font-size: 22px; font-weight: 700; font-variant-numeric: tabular-nums; margin-top: 2px; }
    #mfx-cal-toggle {
      align-self: center; padding: 8px 14px; border-radius: 9px; border: 1px solid var(--mfx-border);
      background: var(--mfx-surface); color: var(--mfx-text); font-size: 13px; cursor: pointer; white-space: nowrap;
    }
    #mfx-cal-toggle:hover { background: var(--mfx-hover); }
    #cf-detail-table thead th { position: sticky; top: 0; z-index: 2; padding: 8px !important; font-size: 12px; }
    #cf-detail-table td { padding: 6px 8px !important; font-size: 13px; }
    #cf-detail-table td.date { white-space: nowrap; color: var(--mfx-muted); }
    #cf-detail-table td.amount { text-align: right; font-weight: 600; white-space: nowrap; }
    #cf-detail-table .btn-small { padding: 2px 8px !important; font-size: 12px !important; }

    /* ホーム: 資産の列と中央の列を、カードを並べたダッシュボードにする。id が汎用的なので #home があるページに限る */
    body:has(#home) .container-large #main-container { background: transparent !important; box-shadow: none !important; padding: 0 !important; }
    body:has(#home) #js-content-body { display: grid !important; grid-template-columns: 300px minmax(0, 1fr); gap: 20px; align-items: start; }
    body:has(#home) :is(#js-content-body, #js-mf-main-content > div)::before, body:has(#home) :is(#js-content-body, #js-mf-main-content > div)::after { display: none !important; }
    body:has(#home) :is(.home-col-assets, .mf-col-custom-home) { float: none !important; width: auto !important; margin: 0 !important; padding: 0 !important; }
    body:has(#home) .home-col-assets .main-container-margin-top { margin: 0 !important; display: flex; flex-direction: column; gap: 20px; }
    body:has(#home) #js-mf-main-content > div { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 20px; }
    body:has(#home) :is(.home-col-assets #user-info, .home-col-assets section.accounts, #js-mf-main-content > div > *) {
      background: var(--mfx-surface) !important; border-radius: var(--mfx-radius); box-shadow: var(--mfx-shadow);
      padding: 20px !important; margin: 0 !important; box-sizing: border-box; min-width: 0;
    }
    body:has(#home) :is(#cf-info, #assets-info) { grid-column: 1 / -1; }

    /* グラフ（Highcharts）の文字と罫線を配色に合わせる */
    .highcharts-background { fill: transparent !important; }
    .highcharts-container text { fill: var(--mfx-muted) !important; color: var(--mfx-muted) !important; }
    .highcharts-grid-line, .highcharts-axis-line, .highcharts-tick { stroke: var(--mfx-border) !important; }

    /* ダークモード: 色を読んで付けたクラス（darkify）で置き換える */
    html[data-mfx-theme="dark"] .mfx-dk-bg1 { background-color: var(--mfx-surface) !important; }
    html[data-mfx-theme="dark"] .mfx-dk-bg2 { background-color: var(--mfx-surface-2) !important; }
    html[data-mfx-theme="dark"] .mfx-dk-bgt { background-color: var(--mfx-dk-bg) !important; }
    html[data-mfx-theme="dark"] .mfx-dk-fg1 { color: var(--mfx-text) !important; }
    html[data-mfx-theme="dark"] .mfx-dk-fg2 { color: var(--mfx-muted) !important; }
    html[data-mfx-theme="dark"] .mfx-dk-fgt { color: var(--mfx-dk-fg) !important; }
    html[data-mfx-theme="dark"] .mfx-dk-bd { border-color: var(--mfx-border) !important; }
    html[data-mfx-theme="dark"] .right-nav img[src*="icon_bell"] { filter: brightness(0) invert(.85); }
    /* グラフは canvas に描かれていて CSS で色を変えられないので、明暗だけを反転する（色相は 180 度回して元の色味に戻す） */
    html[data-mfx-theme="dark"] #wrap canvas { filter: invert(1) hue-rotate(180deg); }
    /* 予算の進捗バーの地は白い画像なので、色の判定では拾えない */
    html[data-mfx-theme="dark"] .progress { background-image: none !important; }

    /* このスクリプトが足す要素 */
    tr.mfx-hidden { display: none; }
    tr.mfx-uncategorized td { background: var(--mfx-warn-bg) !important; }
    tr.mfx-uncategorized td:first-child { box-shadow: inset 3px 0 0 var(--mfx-warn); }
    .mfx-filter-box { display: flex; gap: 12px; align-items: center; margin: 12px 0; }
    #mfx-filter { flex: 1; max-width: 480px; height: 36px; padding: 0 12px; font-size: 14px; background: var(--mfx-surface-2) !important; }
    #mfx-filter:focus { background: var(--mfx-surface) !important; }
    .mfx-count { color: var(--mfx-muted); font-variant-numeric: tabular-nums; }

    /* アニメーション。OS で「視差効果を減らす」を選んでいる人には動かさない。
       fill-mode は backwards にして、終わったら元の指定に戻す（both だと終わったあとも transform が残り、
       数字のカードの hover の浮き上がりが効かず、本文の中のモーダル（position: fixed）の基準もずれる） */
    @media (prefers-reduced-motion: no-preference) {
      @keyframes mfx-rise { from { opacity: 0; transform: translateY(10px); } to { opacity: 1; transform: none; } }
      @keyframes mfx-slide { from { opacity: 0; transform: translateX(-8px); } to { opacity: 1; transform: none; } }
      .container-large #main-container,
      /* :is() だと中の #user-info の詳細度になり、下の section.accounts の animation-delay が負けるので :where() にする */
      body:has(#home) :where(.home-col-assets #user-info, .home-col-assets section.accounts, #js-mf-main-content > div > *),
      .mfx-stat, .mfx-cal-open #kakeibo .mf-col-custom-body {
        animation: mfx-rise .5s cubic-bezier(.2, .7, .2, 1) backwards;
      }
      body:has(#home) #js-mf-main-content > div > :nth-child(2), .mfx-stat:nth-child(2) { animation-delay: .06s; }
      body:has(#home) #js-mf-main-content > div > :nth-child(3), .mfx-stat:nth-child(3) { animation-delay: .12s; }
      body:has(#home) #js-mf-main-content > div > :nth-child(4) { animation-delay: .18s; }
      body:has(#home) .home-col-assets section.accounts { animation-delay: .1s; }
      .mfx-nav > li { animation: mfx-slide .4s cubic-bezier(.2, .7, .2, 1) backwards; }
      .mfx-nav > li:nth-child(2) { animation-delay: .03s; }
      .mfx-nav > li:nth-child(3) { animation-delay: .06s; }
      .mfx-nav > li:nth-child(4) { animation-delay: .09s; }
      .mfx-nav > li:nth-child(5) { animation-delay: .12s; }
      .mfx-nav > li:nth-child(6) { animation-delay: .15s; }
      .mfx-nav > li:nth-child(7) { animation-delay: .18s; }
      .mfx-nav > li:nth-child(n+8) { animation-delay: .21s; }
      /* 自前の要素は darkify の対象外なので、色の transition を付けても判定を誤らない */
      .mfx-nav a, #mfx-theme-toggle, #mfx-cal-toggle { transition: background-color .15s, color .15s; }
      .mfx-nav svg { transition: transform .2s; }
      .mfx-nav a:hover svg { transform: scale(1.12); }
      /* 浮き上がるのは中にメニューを持たない数字のカードだけ。メニューを持つカードを浮かせると、開いたメニューが隣のカードの下に潜る */
      .mfx-stat { transition: transform .2s, box-shadow .2s; }
      .mfx-stat:hover { transform: translateY(-2px); box-shadow: var(--mfx-shadow); }
      #mfx-cal-toggle:active, #mfx-theme-toggle:active { transform: scale(.97); }
      ::view-transition-old(root), ::view-transition-new(root) { animation-duration: .3s; }
    }
  `;

  function onReady() {
    buildSidebar();
    applyTheme();

    document.addEventListener('keydown', (e) => {
      if (e.key !== 'ArrowLeft' && e.key !== 'ArrowRight') return;
      if (e.altKey || e.ctrlKey || e.metaKey || e.shiftKey || isTypingTarget(e.target)) return;
      if (clickMonthButton(e.key === 'ArrowLeft' ? -1 : 1)) e.preventDefault();
    });

    // 月の切り替えやカテゴリ編集で表が Ajax で差し替わるので、そのたびに付け直す。ダークモード中は足された要素の色も直す
    let scheduled = false;
    let added = [];
    new MutationObserver((records) => {
      const foreign = records.filter((r) => !isOwnMutation(r));
      if (!foreign.length) return;
      if (document.documentElement.dataset.mfxTheme === 'dark') {
        for (const r of foreign) for (const n of r.addedNodes) if (n.nodeType === 1) added.push(n);
      }
      if (scheduled) return;
      scheduled = true;
      requestAnimationFrame(() => {
        scheduled = false;
        refresh();
        const nodes = added;
        added = [];
        darkify(nodes);
      });
    }).observe(document.body, { childList: true, subtree: true });

    refresh();
  }

  function main() {
    // document-start で配色と骨組みの CSS を先に入れ、MF の画面が一瞬だけ白く出る（ダークモード時のちらつき）のを防ぐ
    const style = document.createElement('style');
    style.textContent = STYLE;
    (document.head ?? document.documentElement).append(style);
    darkQuery = window.matchMedia('(prefers-color-scheme: dark)');
    document.documentElement.dataset.mfxTheme = resolveTheme(readThemePref(), darkQuery.matches);
    darkQuery.addEventListener('change', () => {
      if (readThemePref() === 'auto') applyTheme();
    });

    if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', onReady, { once: true });
    else onReady();
  }

  if (typeof module !== 'undefined') {
    module.exports = {
      normalize, matchesQuery, isTypingTarget, isOwnMutation,
      resolveTheme, nextThemePref, parseRgb, luminance, classifyBg, classifyFg, isLightBorder, hasLightBorder,
      parseAmount, formatAmount, countUp,
    };
  } else {
    main();
  }
})();
