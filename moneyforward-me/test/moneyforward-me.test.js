const test = require('node:test');
const assert = require('node:assert/strict');
const {
  normalize, matchesQuery, isTypingTarget, isOwnMutation,
  resolveTheme, nextThemePref, parseRgb, luminance, classifyBg, classifyFg, isLightBorder, hasLightBorder,
  parseAmount, formatAmount, countUp, institutionOptions, spendLevels,
  ratiosToMax, formatYenCompact, shortDateLabel, parseColor, seriesColor, isStackTop, netSeries,
  keyAction, isModalOpen, wrapBesideBars, styleChart,
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

test('classifyBg: 月次の合計行は、彩度がやや高い淡い色でも半透明にして文字を読めるようにする', () => {
  // 支出合計の行（#ffcea3、彩度 0.36）を残すと、明るくした文字と重なって読めなくなる
  assert.deepEqual(classifyBg(parseRgb('rgb(255, 206, 163)')), { cls: 'mfx-dk-bgt', value: 'rgba(255, 206, 163, 0.16)' });
  // 収入合計の行（#c8e8f7）
  assert.deepEqual(classifyBg(parseRgb('rgb(200, 232, 247)')), { cls: 'mfx-dk-bgt', value: 'rgba(200, 232, 247, 0.16)' });
});

test('classifyBg: 明るい背景は彩度 0.45 以上なら残し、それ未満なら半透明にする', () => {
  // どちらも輝度 0.8 前後の明るい色なので、輝度ではなく彩度のしきい値だけで分かれる
  assert.equal(classifyBg(parseRgb('rgb(240, 240, 132)')), null); // 彩度 0.45 ちょうど
  assert.deepEqual(classifyBg(parseRgb('rgb(240, 240, 133)')), { cls: 'mfx-dk-bgt', value: 'rgba(240, 240, 133, 0.16)' }); // 0.446
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

// darkify は .btn の文字色も読むので、ダークのボタンの文字色が暗いと灰色に変えられる（以前の #1f2328 がそうだった）
test('classifyFg: ダークのボタンの文字色（本文色・アクセント・白）はそのまま', () => {
  assert.equal(classifyFg(parseRgb('rgb(230, 232, 236)')), null);
  assert.equal(classifyFg(parseRgb('rgb(255, 138, 61)')), null);
  assert.equal(classifyFg(parseRgb('rgb(255, 255, 255)')), null);
  assert.equal(classifyFg(parseRgb('rgb(31, 35, 40)'))?.cls, 'mfx-dk-fgt');
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

test('parseAmount: 月次収支の「1,234円」とカレンダーの「-1,234」を数にし、それ以外は null', () => {
  assert.equal(parseAmount('2,757,114円'), 2757114);
  assert.equal(parseAmount('-214,320円'), -214320);
  assert.equal(parseAmount('−214,320円'), -214320); // 全角のマイナス
  assert.equal(parseAmount(' 0円 '), 0);
  assert.equal(parseAmount(''), null);
  assert.equal(parseAmount('---'), null);
  assert.equal(parseAmount('-7,400'), -7400);
  assert.equal(parseAmount('1,234'), 1234);
  assert.equal(parseAmount('+90'), null); // 収入の「+」は読まない（カレンダーで読むのは支出だけ）
  assert.equal(parseAmount('1,234円円'), null);
});

test('parseAmount: 数字を含まないカンマだけの文字は 0 と読まず null にする', () => {
  assert.equal(parseAmount(','), null);
  assert.equal(parseAmount('-,'), null);
  assert.equal(parseAmount(',円'), null);
  assert.equal(parseAmount('0'), 0);
});

test('institutionOptions: 件数の多い順に並べ、同数は名前順。空の名前は数えない', () => {
  assert.deepEqual(institutionOptions(['B銀行', 'Aカード', 'B銀行', '', 'C銀行']), [
    { name: 'B銀行', count: 2 },
    { name: 'Aカード', count: 1 },
    { name: 'C銀行', count: 1 },
  ]);
  assert.deepEqual(institutionOptions([]), []);
  assert.deepEqual(institutionOptions(['']), []);
});

test('spendLevels: 最も多い日を 1 にし、平方根で縮める', () => {
  assert.deepEqual(spendLevels([400, 100, 0]), [1, 0.5, 0]);
});

test('spendLevels: 支出のない月は全部 0（0 で割らない）', () => {
  assert.deepEqual(spendLevels([0, 0]), [0, 0]);
  assert.deepEqual(spendLevels([]), []);
});

test('spendLevels: 負の値（返金で差し引きがマイナス）は 0 にする', () => {
  assert.deepEqual(spendLevels([-100, 100]), [0, 1]);
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

test('ratiosToMax: 最大を 1 にした比。0 と負は 0、全部 0 でも 0 で割らない', () => {
  assert.deepEqual(ratiosToMax([12.14, 6.07, 0]), [1, 0.5, 0]);
  assert.deepEqual(ratiosToMax([0, 0]), [0, 0]);
  assert.deepEqual(ratiosToMax([-1, 2]), [0, 1]);
  assert.deepEqual(ratiosToMax([]), []);
});

test('formatYenCompact: 1 万未満は桁区切り、万・億は小数 1 桁で丸める', () => {
  assert.equal(formatYenCompact(0), '0');
  assert.equal(formatYenCompact(9999), '9,999');
  assert.equal(formatYenCompact(10000), '1万');
  assert.equal(formatYenCompact(15000), '1.5万');
  assert.equal(formatYenCompact(1234567), '123.5万');
  assert.equal(formatYenCompact(-50000), '-5万');
  assert.equal(formatYenCompact(120000000), '1.2億');
});

test('shortDateLabel: 日付は「月/日」、月次の「〜」付きは「N月」、それ以外はそのまま', () => {
  assert.equal(shortDateLabel('2026/10/01'), '10/1');
  assert.equal(shortDateLabel('2026-10-02'), '10/2');
  assert.equal(shortDateLabel('2026/05/01〜'), '5月');
  assert.equal(shortDateLabel('食費'), '食費');
  assert.equal(shortDateLabel(3), 3);
});

test('parseColor: #rgb・#rrggbb・rgb()・rgba() を読み、読めなければ null', () => {
  assert.deepEqual(parseColor('#DF4C52'), { r: 223, g: 76, b: 82, a: 1 });
  assert.deepEqual(parseColor('#fff'), { r: 255, g: 255, b: 255, a: 1 });
  assert.deepEqual(parseColor('rgba(40,129,215,0.9)'), { r: 40, g: 129, b: 215, a: 0.9 });
  assert.deepEqual(parseColor('rgb(255, 127, 133)'), { r: 255, g: 127, b: 133, a: 1 });
  assert.equal(parseColor('red'), null);
  assert.equal(parseColor(undefined), null);
});

test('seriesColor: ダークでは暗い色だけを白へ寄せ、明るい色とライトはそのまま。透明度を指定できる', () => {
  assert.equal(seriesColor('#DF4C52', false), 'rgba(223, 76, 82, 1)');
  assert.equal(seriesColor('#DF4C52', true), 'rgba(223, 76, 82, 1)');
  assert.equal(seriesColor('#4B4560', false), 'rgba(75, 69, 96, 1)');
  assert.equal(seriesColor('#4B4560', true), 'rgba(147, 143, 160, 1)');
  assert.equal(seriesColor('rgba(40,129,215,0.9)', false, 0.22), 'rgba(40, 129, 215, 0.22)');
  assert.equal(seriesColor('red', true), 'red'); // 読めない色は触らない
});

test('isStackTop: 同じ積み上げの後ろに 0 でない見えている系列があれば一番上ではない', () => {
  const ds = [
    { stack: 'outgo', data: [1, 1] },
    { stack: 'outgo', data: [2, 0] },
    { stack: 'income', data: [5, 5] },
  ];
  assert.equal(isStackTop(ds, 0, 0), false); // 後ろの outgo が 2
  assert.equal(isStackTop(ds, 0, 1), true); // 後ろの outgo が 0
  assert.equal(isStackTop(ds, 1, 0), true);
  assert.equal(isStackTop(ds, 2, 0), true); // 別の積み上げは見ない
  assert.equal(isStackTop(ds, 0, 0, (j) => j !== 1), true); // 凡例で隠した系列は数えない
  assert.equal(isStackTop([...ds, { stack: 'outgo', data: [9, 9], mfxNet: true }], 1, 0), true); // 収支の線は数えない
});

test('netSeries: 収入から支出の積み上げを引く。どちらかがなければ null', () => {
  const ds = [
    { stack: 'outgo', data: [100, 200] },
    { stack: 'outgo', data: [50, null] },
    { stack: 'income', data: [300, 100] },
    { stack: 'mfx-net', data: [0, 0], mfxNet: true },
  ];
  assert.deepEqual(netSeries(ds), [150, -100]);
  assert.equal(netSeries([{ stack: 'outgo', data: [1] }]), null);
  assert.equal(netSeries([{ data: [1] }, { data: [2] }]), null); // 資産推移などの積み上げではない棒
});

test('keyAction: ← → は月移動、/ は検索欄へ。入力中・修飾キー・IME の変換中は何もしない', () => {
  const body = { tagName: 'BODY' };
  const other = { tagName: 'INPUT' };
  const filter = { tagName: 'INPUT', value: '' };
  const key = (k, extra = {}) => keyAction({ key: k, target: body, ...extra }, filter);
  assert.equal(key('ArrowLeft'), 'prev');
  assert.equal(key('ArrowRight'), 'next');
  assert.equal(key('ArrowLeft', { shiftKey: true }), null); // Shift+← は選択の操作
  assert.equal(key('ArrowLeft', { metaKey: true }), null);
  assert.equal(key('ArrowLeft', { target: other }), null);
  assert.equal(key('/'), 'focus');
  assert.equal(key('/', { shiftKey: true }), 'focus'); // 「/」に Shift が要る配列
  assert.equal(key('/', { ctrlKey: true }), null);
  assert.equal(key('/', { target: other }), null);
  assert.equal(keyAction({ key: '/', target: body }, null), null); // 検索欄のないページ
  assert.equal(key('a'), null);
  assert.equal(key('constructor'), null);
});

test('keyAction: 検索欄の Esc は語を消し、空なら抜ける。IME の変換を取り消す Esc では消さない', () => {
  const filter = { tagName: 'INPUT', value: '食費' };
  const esc = (extra = {}) => keyAction({ key: 'Escape', target: filter, ...extra }, filter);
  assert.equal(esc(), 'clear');
  assert.equal(esc({ shiftKey: true }), 'clear');
  assert.equal(esc({ isComposing: true }), null);
  assert.equal(esc({ keyCode: 229 }), null); // Safari は確定の直後の keydown が isComposing: false で 229
  assert.equal(esc({ altKey: true }), null);
  filter.value = '';
  assert.equal(esc(), 'blur');
  assert.equal(keyAction({ key: 'Escape', target: { tagName: 'BODY' } }, filter), null); // 欄の外の Esc は MF に任せる
});

test('keyAction: MF のダイアログが開いている間は ← → / を奪わない。検索欄の Esc はそのまま', () => {
  const body = { tagName: 'BODY' };
  const filter = { tagName: 'INPUT', value: '食費' };
  const key = (k, target = body) => keyAction({ key: k, target }, filter, true);
  assert.equal(key('ArrowLeft'), null);
  assert.equal(key('ArrowRight'), null);
  assert.equal(key('/'), null);
  assert.equal(key('Escape', filter), 'clear');
  filter.value = '';
  assert.equal(key('Escape', filter), 'blur');
  assert.equal(keyAction({ key: 'ArrowLeft', target: body }, filter, false), 'prev');
});

test('isModalOpen: 表示中の .modal か .modal-backdrop があるときだけ真。in クラスの有無は見ない', (t) => {
  let modals = [];
  let backdrops = [];
  globalThis.document = {
    querySelectorAll: (sel) => (sel === '.modal, .modal-backdrop' ? [...modals, ...backdrops] : []),
  };
  globalThis.getComputedStyle = (el) => ({ display: el.display });
  t.after(() => {
    delete globalThis.document;
    delete globalThis.getComputedStyle;
  });
  assert.equal(isModalOpen(), false); // ダイアログのないページ
  modals = [{ display: 'none' }, { display: 'none' }];
  assert.equal(isModalOpen(), false); // 閉じたダイアログは DOM に残っている
  modals = [{ display: 'none' }, { display: 'block' }]; // #modal_change_act_type は in なしで display: block になる
  assert.equal(isModalOpen(), true);
  // 開き始め: 幕だけが出ていて、.modal はまだ display: none
  modals = [{ display: 'none' }];
  backdrops = [{ display: 'block' }];
  assert.equal(isModalOpen(), true);
});

test('wrapBesideBars: 幅のない要素（線の点）を除いて MF の位置決めに渡す。一度だけ包み、なければ何もしない', () => {
  const calls = [];
  const original = function (items, pos) {
    calls.push({ self: this, items, pos });
    return { x: 1, y: 2 };
  };
  const positioners = { besideBars: original };
  wrapBesideBars(positioners);
  const once = positioners.besideBars;
  assert.notEqual(once, original);
  wrapBesideBars(positioners);
  assert.equal(positioners.besideBars, once); // 二重に包まない

  const bar = { element: { width: 20 } };
  const point = { element: { x: 5 } };
  const self = {};
  assert.deepEqual(once.call(self, [bar, point], { x: 0 }), { x: 1, y: 2 });
  assert.deepEqual(calls[0].items, [bar]);
  assert.equal(calls[0].self, self); // MF の関数はツールチップを this で読む
  assert.deepEqual(calls[0].pos, { x: 0 });

  // MF が後から besideBars を定義し直したら、新しいほうを包む
  const redefined = () => 'new';
  positioners.besideBars = redefined;
  wrapBesideBars(positioners);
  assert.equal(positioners.besideBars([point]), 'new');
  assert.notEqual(positioners.besideBars, redefined);

  assert.doesNotThrow(() => wrapBesideBars(undefined));
  assert.doesNotThrow(() => wrapBesideBars({}));
});

// styleChart は画面の配色（CSS 変数）とテーマを読むので、その分だけを差し替える
function chartEnv(t, { dark = false } = {}) {
  const vars = { '--mfx-text': '#111', '--mfx-muted': '#666', '--mfx-border': '#ddd', '--mfx-surface': '#fff', '--mfx-plus': '#00f', '--mfx-minus': '#f00' };
  globalThis.window = { matchMedia: () => ({ matches: false }) };
  globalThis.document = { documentElement: { dataset: { mfxTheme: dark ? 'dark' : 'light' } } };
  globalThis.getComputedStyle = () => ({ getPropertyValue: (name) => vars[name] ?? '' });
  t.after(() => {
    delete globalThis.window;
    delete globalThis.document;
    delete globalThis.getComputedStyle;
  });
}

const monthlyChart = () => ({
  config: {
    type: 'bar',
    options: { scales: { x: { stacked: true }, y: { stacked: true } } },
    data: {
      labels: ['2026/04/01〜', '2026/05/01〜'],
      datasets: [
        { label: '食費', stack: 'outgo', data: [100, 200], backgroundColor: '#4B4560' },
        { label: '給与', stack: 'income', data: [300, 100], backgroundColor: '#2881D7' },
      ],
    },
  },
});

test('styleChart: 何度呼んでも収支の線は 1 本で、色は MF の元の色から作り直す', (t) => {
  chartEnv(t, { dark: true });
  const chart = monthlyChart();
  styleChart(chart);
  const first = chart.config.data.datasets.map((ds) => ds.backgroundColor);
  styleChart(chart);
  styleChart(chart);
  const { datasets } = chart.config.data;
  assert.equal(datasets.filter((ds) => ds.mfxNet).length, 1);
  assert.deepEqual(datasets.find((ds) => ds.mfxNet).data, [200, -100]);
  assert.deepEqual(datasets.map((ds) => ds.backgroundColor), first);
  assert.equal(datasets[0].mfxBg, '#4B4560');
  assert.equal(datasets[0].backgroundColor, 'rgba(147, 143, 160, 1)'); // ダークで持ち上げた色。重ねて持ち上げない
});

test('styleChart: MF が月の切り替えで値や系列を差し替えても、収支の線を作り直す', (t) => {
  chartEnv(t);
  const chart = monthlyChart();
  styleChart(chart);
  const { data } = chart.config;
  data.datasets[0].data = [500, 0];
  styleChart(chart);
  assert.deepEqual(data.datasets.find((ds) => ds.mfxNet).data, [-200, 100]);

  data.datasets = [{ label: '食費', stack: 'outgo', data: [10] }, { label: '給与', stack: 'income', data: [30] }];
  styleChart(chart);
  assert.deepEqual(data.datasets.filter((ds) => ds.mfxNet).map((ds) => ds.data), [[20]]);

  data.datasets = data.datasets.filter((ds) => ds.stack !== 'income'); // 収入のない月
  styleChart(chart);
  assert.deepEqual(data.datasets.find((ds) => ds.mfxNet).data, []);
});

test('styleChart: 収入・支出の 2 本の棒は、収支の線を足しても画面の青と赤にそろえる', (t) => {
  chartEnv(t);
  const chart = monthlyChart();
  const [outgo, income] = chart.config.data.datasets;
  outgo.label = '支出';
  income.label = '収入';
  styleChart(chart);
  styleChart(chart);
  assert.equal(chart.config.data.datasets.length, 3);
  assert.equal(outgo.backgroundColor, 'rgba(255, 0, 0, 1)');
  assert.equal(income.backgroundColor, 'rgba(0, 0, 255, 1)');
});

test('styleChart: 円グラフはドーナツにし、MF の系列ごとの cutout: 0 を外す。2 重なら穴を小さめに', (t) => {
  chartEnv(t);
  const chart = {
    config: {
      type: 'pie',
      options: { plugins: { pieDataLabels: { enabled: true }, centerText: { text: '3円' } } },
      data: { datasets: [{ data: [1, 2], backgroundColor: ['#fff', '#000'] }, { data: [3], cutout: 0, backgroundColor: ['#f00'] }] },
    },
  };
  styleChart(chart);
  styleChart(chart);
  const { options, data } = chart.config;
  assert.equal(options.cutout, '42%');
  assert.equal('cutout' in data.datasets[1], false);
  assert.equal(options.plugins.pieDataLabels.enabled, false);
  assert.equal(options.plugins.centerText, false); // 穴の合計と重ならないよう、MF の中央の文字は止める
  assert.deepEqual(data.datasets[0].backgroundColor, ['rgba(255, 255, 255, 1)', 'rgba(0, 0, 0, 1)']);
  assert.equal(data.datasets.some((ds) => ds.mfxNet), false);
});
