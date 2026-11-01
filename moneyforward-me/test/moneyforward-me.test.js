const test = require('node:test');
const assert = require('node:assert/strict');
const { normalize, matchesQuery, isTypingTarget, isOwnMutation } = require('../moneyforward-me.user.js');

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
      for (let n = this; n; n = n.parent) if (sel === `.${n.className}`) return n;
      return null;
    },
  };
}

test('isOwnMutation: 絞り込み欄の中の変化は無視し、それ以外には反応する', () => {
  const body = fakeEl('body');
  const box = fakeEl('mfx-filter-box', body);
  const count = fakeEl('mfx-count', box);
  const tbody = fakeEl('tbody', fakeEl('table', body));
  // 件数表示の書き換え（target は span.mfx-count）を拾うと refresh が無限に回る
  assert.equal(isOwnMutation({ target: count }), true);
  assert.equal(isOwnMutation({ target: box }), true);
  // 表の差し替えや、絞り込み欄の挿入（target は親）は拾う
  assert.equal(isOwnMutation({ target: tbody }), false);
  assert.equal(isOwnMutation({ target: body }), false);
  // closest を持たないノード（Document など）は自分の変化ではない
  assert.equal(isOwnMutation({ target: {} }), false);
});
