const test = require('node:test');
const assert = require('node:assert/strict');
const {
  normalize, matchesQuery, isTypingTarget, isOwnMutation,
  resolveTheme, nextThemePref, parseRgb, luminance, classifyBg, classifyFg, isLightBorder, hasLightBorder,
  parseAmount, formatAmount, countUp,
} = require('../moneyforward-me.user.js');

test('normalize: 全角英数・カンマ・連続空白をそろえる', () => {
  assert.equal(normalize('ＡＢＣ　１,２３４円'), 'abc 1234円');
  assert.equal(normalize('a \n\t b'), 'a b');
});

test('matchesQuery: 空の検索語はすべての行に当たる', () => {
  assert.equal(matchesQuery('セブンイレブン 食費 -540', ''), true);
  assert.equal(matchesQuery('セブンイレブン', '   '), true);
});

test('matchesQuery: 空白区切りの語はすべて含むときだけ当たる', () => {
  const row = '10/01(水) セブンイレブン -540 楽天カード 食費 食料品';
  assert.equal(matchesQuery(row, 'セブン 食費'), true);
  assert.equal(matchesQuery(row, 'セブン 交通費'), false);
});

test('matchesQuery: カンマ区切りの金額にカンマなしで当たる', () => {
  assert.equal(matchesQuery('家賃 -85,000', '85000'), true);
  assert.equal(matchesQuery('家賃 -85,000', '85,000'), true);
});

test('matchesQuery: 全角・大文字の検索語でも当たる', () => {
  assert.equal(matchesQuery('Amazon.co.jp -1,980', 'ＡＭＡＺＯＮ'), true);
});

test('matchesQuery: 全角空白で区切った語も AND になる', () => {
  const row = '10/01(水) セブンイレブン -540 楽天カード 食費 食料品';
  assert.equal(matchesQuery(row, 'セブン　食費'), true);
  assert.equal(matchesQuery(row, 'セブン　交通費'), false);
});

test('matchesQuery: 半角カナの検索語でも全角カナの行に当たる', () => {
  assert.equal(matchesQuery('セブンイレブン -540', 'ｾﾌﾞﾝ'), true);
});

test('matchesQuery: カンマだけの検索語は空とみなしてすべての行に当たる', () => {
  assert.equal(matchesQuery('家賃 -85,000', ','), true);
  assert.equal(matchesQuery('家賃 -85,000', ' , ,, '), true);
});

test('matchesQuery: 行側の改行・NBSP は区切りとして扱う', () => {
  assert.equal(matchesQuery('セブン\n\u00a0イレブン', 'セブン イレブン'), true);
});

test('isTypingTarget: 入力欄では月移動キーを奪わない', () => {
  assert.equal(isTypingTarget({ tagName: 'INPUT' }), true);
  assert.equal(isTypingTarget({ tagName: 'TEXTAREA' }), true);
  assert.equal(isTypingTarget({ tagName: 'SELECT' }), true);
  assert.equal(isTypingTarget({ tagName: 'DIV', isContentEditable: true }), true);
  assert.equal(isTypingTarget({ tagName: 'BODY', isContentEditable: false }), false);
  assert.equal(isTypingTarget(null), false);
});

// closest() を祖先方向にたどる最小の偽ノード
function fakeEl(className, parent = null) {
  return {
    className,
    parent,
    closest(sel) {
      for (let n = this; n; n = n.parent) if (n.className.split(' ').some((c) => sel === `.${c}`)) return n;
      return null;
    },
  };
}

test('isOwnMutation: 自分で足した要素（.mfx-own）の中の変化は無視し、それ以外には反応する', () => {
  const body = fakeEl('body');
  const box = fakeEl('mfx-filter-box mfx-own', body);
  const summaryValue = fakeEl('mfx-stat-value', fakeEl('mfx-stat', fakeEl('mfx-own', body)));
  const count = fakeEl('mfx-count', box);
  const tbody = fakeEl('tbody', fakeEl('table', body));
  // 件数表示の書き換え（target は span.mfx-count）を拾うと refresh が無限に回る
  assert.equal(isOwnMutation({ target: count }), true);
  assert.equal(isOwnMutation({ target: box }), true);
  // 月次収支のカードの数字の書き換えも同じ
  assert.equal(isOwnMutation({ target: summaryValue }), true);
  // 表の差し替えや、絞り込み欄の挿入（target は親）は拾う
  assert.equal(isOwnMutation({ target: tbody }), false);
  assert.equal(isOwnMutation({ target: body }), false);
  // closest を持たないノード（Document など）は自分の変化ではない
  assert.equal(isOwnMutation({ target: {} }), false);
});

test('resolveTheme: 手動の指定を優先し、自動なら OS の設定に従う', () => {
  assert.equal(resolveTheme('light', true), 'light');
  assert.equal(resolveTheme('dark', false), 'dark');
  assert.equal(resolveTheme('auto', true), 'dark');
  assert.equal(resolveTheme('auto', false), 'light');
  // 保存値が壊れていたら自動として扱う
  assert.equal(resolveTheme('purple', true), 'dark');
  assert.equal(resolveTheme(null, false), 'light');
});

test('nextThemePref: 自動 → ライト → ダーク → 自動 の順に回り、不明な値は自動に戻す', () => {
  assert.equal(nextThemePref('auto'), 'light');
  assert.equal(nextThemePref('light'), 'dark');
  assert.equal(nextThemePref('dark'), 'auto');
  assert.equal(nextThemePref(undefined), 'auto');
});

test('parseRgb: getComputedStyle の rgb()/rgba() を読み、それ以外は null', () => {
  assert.deepEqual(parseRgb('rgb(255, 255, 255)'), { r: 255, g: 255, b: 255, a: 1 });
  assert.deepEqual(parseRgb('rgba(0, 0, 0, 0)'), { r: 0, g: 0, b: 0, a: 0 });
  assert.deepEqual(parseRgb('rgb(10 20 30 / 0.5)'), { r: 10, g: 20, b: 30, a: 0.5 });
  assert.equal(parseRgb('transparent'), null);
  assert.equal(parseRgb(''), null);
  assert.equal(parseRgb(undefined), null);
  assert.equal(parseRgb('rgb(a, b, c)'), null);
});

test('luminance: 白は 1、黒は 0', () => {
  assert.equal(luminance({ r: 255, g: 255, b: 255 }), 1);
  assert.equal(luminance({ r: 0, g: 0, b: 0 }), 0);
});

test('classifyBg: 白は面の色、薄い灰色は一段明るい面、色付きの淡い背景は半透明の同じ色にする', () => {
  assert.deepEqual(classifyBg(parseRgb('rgb(255, 255, 255)')), { cls: 'mfx-dk-bg1' });
  assert.deepEqual(classifyBg(parseRgb('rgb(240, 240, 240)')), { cls: 'mfx-dk-bg2' });
  // カレンダーの前月・翌月のマス（#ddd）も明るい面として置き換える
  assert.deepEqual(classifyBg(parseRgb('rgb(221, 221, 221)')), { cls: 'mfx-dk-bg2' });
  // カレンダーの今日の欄（#fcf8e3）は色味を残す
  assert.deepEqual(classifyBg(parseRgb('rgb(252, 248, 227)')), { cls: 'mfx-dk-bgt', value: 'rgba(252, 248, 227, 0.16)' });
});

test('classifyBg: 透明・暗い色・濃い色の背景はそのまま', () => {
  assert.equal(classifyBg(parseRgb('rgba(0, 0, 0, 0)')), null);
  assert.equal(classifyBg(parseRgb('rgb(51, 51, 51)')), null);
  assert.equal(classifyBg(parseRgb('rgb(150, 150, 150)')), null);
  assert.equal(classifyBg(parseRgb('rgb(220, 38, 38)')), null); // 赤い「未分類」ボタン
  // 予算の進捗バー（#9edc6f）のように彩度の高い色は、明るくても意味のある色なので薄めない
  assert.equal(classifyBg(parseRgb('rgb(158, 220, 111)')), null);
  assert.equal(classifyBg(null), null);
});

test('classifyFg: 黒に近い文字は本文色、灰色の文字は補助色、濃い色の文字は明るくする', () => {
  assert.deepEqual(classifyFg(parseRgb('rgb(51, 51, 51)')), { cls: 'mfx-dk-fg1' });
  assert.deepEqual(classifyFg(parseRgb('rgb(102, 102, 102)')), { cls: 'mfx-dk-fg2' });
  assert.deepEqual(classifyFg(parseRgb('rgb(0, 85, 170)')), { cls: 'mfx-dk-fgt', value: 'rgb(115, 162, 208)' });
});

test('classifyFg: 明るい文字（白い文字や明るい色）と透明はそのまま', () => {
  assert.equal(classifyFg(parseRgb('rgb(255, 255, 255)')), null);
  assert.equal(classifyFg(parseRgb('rgb(200, 200, 200)')), null);
  assert.equal(classifyFg(parseRgb('rgb(96, 165, 250)')), null);
  assert.equal(classifyFg(parseRgb('rgba(0, 0, 0, 0)')), null);
});

test('isLightBorder: 明るい枠線だけを置き換える', () => {
  assert.equal(isLightBorder(parseRgb('rgb(221, 221, 221)')), true);
  assert.equal(isLightBorder(parseRgb('rgb(51, 51, 51)')), false);
  assert.equal(isLightBorder(parseRgb('rgba(255, 255, 255, 0)')), false);
  assert.equal(isLightBorder(null), false);
});

// getComputedStyle の戻り値の代わり。指定しない辺は幅 0・色は文字色（currentColor）にする
function borders(sides, textColor = 'rgb(230, 232, 236)') {
  const cs = {};
  for (const side of ['Top', 'Right', 'Bottom', 'Left']) {
    cs[`border${side}Width`] = sides[side]?.[0] ?? '0px';
    cs[`border${side}Color`] = sides[side]?.[1] ?? textColor;
  }
  return cs;
}

test('hasLightBorder: 幅のある辺が明るい色なら置き換える。右の辺だけでも拾う', () => {
  assert.equal(hasLightBorder(borders({ Top: ['1px', 'rgb(221, 221, 221)'], Right: ['1px', 'rgb(221, 221, 221)'], Bottom: ['1px', 'rgb(221, 221, 221)'], Left: ['1px', 'rgb(221, 221, 221)'] })), true);
  assert.equal(hasLightBorder(borders({ Right: ['1px', 'rgb(221, 221, 221)'] }, 'rgb(51, 51, 51)')), true);
  assert.equal(hasLightBorder(borders({ Bottom: ['0.5px', 'rgb(221, 221, 221)'] }, 'rgb(51, 51, 51)')), true);
});

test('hasLightBorder: 幅 0 の辺の色（明るい文字色）では置き換えない', () => {
  // 見出しの左のアクセント線（border: 0 のあとに border-left だけ指定）。ダークモードでは文字色が明るい
  assert.equal(hasLightBorder(borders({ Left: ['4px', 'rgb(255, 138, 61)'] })), false);
  assert.equal(hasLightBorder(borders({ Bottom: ['1px', 'rgb(42, 48, 60)'] })), false);
  assert.equal(hasLightBorder(borders({})), false);
});

test('parseAmount: 月次収支の「1,234円」「-1,234円」を数にし、それ以外は null', () => {
  assert.equal(parseAmount('2,757,114円'), 2757114);
  assert.equal(parseAmount('-214,320円'), -214320);
  assert.equal(parseAmount('−214,320円'), -214320); // 全角のマイナス
  assert.equal(parseAmount(' 0円 '), 0);
  assert.equal(parseAmount(''), null);
  assert.equal(parseAmount('---'), null);
  assert.equal(parseAmount('1,234'), null);
});

test('formatAmount: カウントアップの途中の値を MF と同じ書式にする', () => {
  assert.equal(formatAmount(2757114), '2,757,114円');
  assert.equal(formatAmount(-214320), '-214,320円');
  assert.equal(formatAmount(1234.6), '1,235円');
  assert.equal(formatAmount(-0.4), '0円');
});

// countUp はブラウザの API を呼ぶので、使う分だけを差し替えて、フレームを手で進める
function animationEnv(t, { reduced = false, hidden = false } = {}) {
  const frames = [];
  globalThis.window = { matchMedia: () => ({ matches: reduced }) };
  globalThis.document = { hidden };
  globalThis.requestAnimationFrame = (cb) => frames.push(cb);
  t.after(() => {
    delete globalThis.window;
    delete globalThis.document;
    delete globalThis.requestAnimationFrame;
  });
  const start = performance.now();
  // ms は countUp を呼んだ時点からの経過時間。負の値は、フレームの時刻が呼んだ時点より前になる場合
  const tick = (ms) => frames.splice(0).forEach((cb) => cb(start + ms));
  return { frames, tick };
}

const amountEl = (text = '') => ({ dataset: {}, textContent: text });

test('countUp: 今の表示から目標の値まで動かし、最後は MF の文字そのものにする', (t) => {
  const { frames, tick } = animationEnv(t);
  const el = amountEl('');
  countUp(el, '1,000,000円');
  assert.equal(el.textContent, '');
  tick(300);
  const mid = parseAmount(el.textContent);
  assert.ok(mid > 0 && mid < 1000000, el.textContent);
  tick(10000);
  assert.equal(el.textContent, '1,000,000円');
  assert.equal(frames.length, 0);
});

test('countUp: フレームの時刻が呼んだ時点より前でも、元の値の外へ飛び出さない', (t) => {
  // rAF に渡る時刻はフレームの始まりなので、rAF の外（読み込み直後の refresh）から呼ぶと、最初のフレームの時刻が呼んだ時点より前になる。Chrome で最大 8ms ほど前になった
  const { tick } = animationEnv(t);
  const el = amountEl('');
  countUp(el, '1,000,000円');
  tick(-8);
  assert.equal(el.textContent, '0円');
});

test('countUp: 同じ目標値で呼び直しても、動いている途中のアニメーションを始め直さない', (t) => {
  const { frames, tick } = animationEnv(t);
  const el = amountEl('');
  countUp(el, '1,000,000円');
  tick(300);
  const mid = el.textContent;
  countUp(el, '1,000,000円');
  assert.equal(el.textContent, mid);
  assert.equal(frames.length, 1);
});

test('countUp: 途中で目標値が変わったら古いアニメーションを止め、新しい値で終わる', (t) => {
  const { frames, tick } = animationEnv(t);
  const el = amountEl('');
  countUp(el, '1,000,000円');
  tick(300);
  const mid = parseAmount(el.textContent);
  countUp(el, '-500円');
  assert.equal(frames.length, 2);
  tick(300);
  assert.equal(frames.length, 1); // 古いほうは止まり、次のフレームを頼まない
  const now = parseAmount(el.textContent);
  assert.ok(now < mid && now > -500, el.textContent);
  tick(10000);
  assert.equal(el.textContent, '-500円');
});

test('countUp: 動きを減らす設定・裏のタブ・金額でない文字・同じ値のときは、すぐ入れる', (t) => {
  for (const opts of [{ reduced: true }, { hidden: true }]) {
    const { frames } = animationEnv(t, opts);
    const el = amountEl('');
    countUp(el, '1,000円');
    assert.equal(el.textContent, '1,000円');
    assert.equal(frames.length, 0);
  }
  const { frames } = animationEnv(t);
  const el = amountEl('1,000円');
  countUp(el, '---');
  assert.equal(el.textContent, '---');
  countUp(el, '1,000円');
  assert.equal(frames.length, 1); // 「---」は 0 として、そこから動かす
  const same = amountEl('1,000円');
  countUp(same, '1,000円');
  assert.equal(frames.length, 1);
});
