const test = require('node:test');
const assert = require('node:assert/strict');
const { normalize, matchesQuery, isTypingTarget } = require('../moneyforward-me.user.js');

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

test('isTypingTarget: 入力欄では月移動キーを奪わない', () => {
  assert.equal(isTypingTarget({ tagName: 'INPUT' }), true);
  assert.equal(isTypingTarget({ tagName: 'TEXTAREA' }), true);
  assert.equal(isTypingTarget({ tagName: 'SELECT' }), true);
  assert.equal(isTypingTarget({ tagName: 'DIV', isContentEditable: true }), true);
  assert.equal(isTypingTarget({ tagName: 'BODY', isContentEditable: false }), false);
  assert.equal(isTypingTarget(null), false);
});
