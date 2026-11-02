import test from 'node:test';
import assert from 'node:assert/strict';
import { findDuplicates, parseHeaderMonth, monthsBetween, createQueue } from '../lib.js';

let seq = 0;
const row = (o) => ({ id: String(++seq), month: o.date.slice(0, 7).replace('/', '-'), content: '', target: '1', gray: false, ...o });
const kinds = (rows) => findDuplicates(rows).map((d) => `${d.kind}:${d.id}${d.partnerId ? '>' + d.partnerId : ''}`);

test('parseHeaderMonth は開始日の月を返す', () => {
  assert.equal(parseHeaderMonth('2026/9/1 - 2026/9/30'), '2026-09');
  assert.equal(parseHeaderMonth('2026/12/25 - 2027/1/24'), '2026-12');
  assert.equal(parseHeaderMonth(''), null);
  assert.equal(parseHeaderMonth(undefined), null);
});

test('monthsBetween は年をまたいで数え、逆順は拒む', () => {
  assert.deepEqual(monthsBetween('2025-11', '2026-02'), ['2025-11', '2025-12', '2026-01', '2026-02']);
  assert.deepEqual(monthsBetween('2026-05', '2026-05'), ['2026-05']);
  assert.throws(() => monthsBetween('2026-05', '2026-04'));
});

test('createQueue は前の処理が失敗しても次を流し、順番を守る', async () => {
  const run = createQueue();
  const log = [];
  const a = run(async () => { await new Promise((r) => setTimeout(r, 20)); log.push('a'); throw new Error('x'); });
  const b = run(async () => { log.push('b'); return 'B'; });
  await assert.rejects(a);
  assert.equal(await b, 'B');
  assert.deepEqual(log, ['a', 'b']);
});

test('自分名義の振込: 名義・額が同じで 3 日以内なら振替の候補', () => {
  const out = row({ date: '2026/02/21', amount: -275000, account: '三菱UFJ銀行 大泉支店', content: '振込IB2 スギモト カズヒコ' });
  const inn = row({ date: '2026/02/24', amount: 275000, account: '三井住友銀行 オリーブ', content: '振込 スギモト カズヒコ' });
  const [d] = findDuplicates([out, inn]);
  assert.equal(d.action, 'transfer');
  assert.equal(d.id, out.id);
  assert.equal(d.partnerId, inn.id);
  assert.equal(d.partnerMonth, '2026-02');
});

test('自分名義の振込: 名義が違う・4 日離れる・同じ口座・計算対象外は候補にしない', () => {
  const base = { amount: -1000, account: 'A銀行', content: '振込 ヤマダ タロウ' };
  assert.deepEqual(kinds([row({ ...base, date: '2026/01/01' }), row({ date: '2026/01/01', amount: 1000, account: 'B銀行', content: '振込 スズキ ハナコ' })]), []);
  assert.deepEqual(kinds([row({ ...base, date: '2026/01/01' }), row({ date: '2026/01/05', amount: 1000, account: 'B銀行', content: '振込 ヤマダ タロウ' })]), []);
  assert.deepEqual(kinds([row({ ...base, date: '2026/01/01' }), row({ date: '2026/01/01', amount: 1000, account: 'A銀行', content: '振込 ヤマダ タロウ' })]), []);
  assert.deepEqual(kinds([row({ ...base, date: '2026/01/01', target: '0', gray: true }), row({ date: '2026/01/01', amount: 1000, account: 'B銀行', content: '振込 ヤマダ タロウ' })]), []);
  // 振込でない出金（ATM など）は対象外
  assert.deepEqual(kinds([row({ ...base, content: 'E-netATM', date: '2026/01/01' }), row({ date: '2026/01/01', amount: 1000, account: 'B銀行', content: 'E-netATM' })]), []);
});

test('自分名義の振込: 1 件の入金を 2 件の出金に使い回さない', () => {
  const o1 = row({ date: '2026/01/01', amount: -1000, account: 'A銀行', content: '振込 ヤマダ' });
  const o2 = row({ date: '2026/01/02', amount: -1000, account: 'A銀行', content: '振込 ヤマダ' });
  const i1 = row({ date: '2026/01/02', amount: 1000, account: 'B銀行', content: '振込 ヤマダ' });
  assert.deepEqual(kinds([o1, o2, i1]), [`own_transfer:${o1.id}>${i1.id}`]);
});

const suica = (acc, date, amount, content) => row({ date, amount, account: acc, content });
const JRE = 'モバイルSuica（JRE ID）'; const SID = 'モバイルSuica（モバイルSuica ID）';

test('二重の連携: 更新が先に止まった方の一致分だけを外す', () => {
  const rows = [
    suica(SID, '2026/01/10', -200, '物販'), // 重なる期間より前 → 残す
    suica(SID, '2026/04/07', -253, '入 立川 出 東小金井'), suica(JRE, '2026/04/07', -253, '入 立川 出 東小金井'),
    suica(SID, '2026/04/08', -160, '物販'), suica(JRE, '2026/04/08', -160, '物販'),
    suica(SID, '2026/04/08', -160, '物販'), suica(JRE, '2026/04/08', -160, '物販'), // 同じ日に同じ額が 2 回
    suica(JRE, '2026/10/30', -500, '物販'), // SID の更新が止まった後 → 重なる期間の外
  ];
  const d = findDuplicates(rows);
  assert.equal(d.length, 3);
  assert.ok(d.every((x) => x.kind === 'duplicate_link' && rows.find((r) => r.id === x.id).account === SID));
  assert.ok(!d.some((x) => x.id === rows[0].id));
});

test('二重の連携: 一致が 3 件未満、または 9 割未満なら別の口座とみなす', () => {
  const two = [suica(SID, '2026/04/07', -100, '物販'), suica(JRE, '2026/04/07', -100, '物販'), suica(SID, '2026/04/08', -100, '物販'), suica(JRE, '2026/04/08', -100, '物販')];
  assert.deepEqual(kinds(two), []);
  const card = 'カードA'; const other = 'カードB';
  const rows = [];
  for (let i = 1; i <= 5; i++) rows.push(row({ date: `2026/05/0${i}`, amount: -100, account: card, content: 'コンビニ' }), row({ date: `2026/05/0${i}`, amount: -100, account: other, content: 'コンビニ' }));
  for (let i = 1; i <= 5; i++) rows.push(row({ date: `2026/05/0${i}`, amount: -999 - i, account: card, content: `店${i}` }));
  assert.deepEqual(kinds(rows), []);
});

test('通販とカード: 品物・ポイント・クーポンの合計がカードの 1 件と一致したらカード側を外す', () => {
  const y = 'Yahoo!ショッピング Yahoo!ショッピング';
  const item = row({ date: '2026/09/12', amount: -15400, account: y, content: 'リカバリーウェア' });
  const pt = row({ date: '2026/09/12', amount: 981, account: y, content: '獲得ポイント等今すぐ利用' });
  const cp = row({ date: '2026/09/12', amount: 3080, account: y, content: 'クーポン利用' });
  const card = row({ date: '2026/09/14', amount: -11339, account: 'PayPayカード', content: 'Yahoo!ショッピング' });
  assert.deepEqual(kinds([item, pt, cp, card]), [`shop_card:${card.id}`]);
});

test('通販とカード: 11 日以上あと・ふるさと納税の口座・合計が合わないものは外さない', () => {
  const a = row({ date: '2026/10/01', amount: -3999, account: 'Amazon.co.jp', content: 'モニターアーム' });
  const late = row({ date: '2026/10/12', amount: -3999, account: '三井住友カード', content: 'AMAZON.CO.JP' });
  assert.deepEqual(kinds([a, late]), []);
  const furu = row({ date: '2026/09/30', amount: -12000, account: 'Yahoo!ショッピング Yahoo!ショッピング(ふるさと納税)', content: 'ふるさと納税 青森市' });
  const card = row({ date: '2026/10/01', amount: -12000, account: 'PayPayカード', content: 'Yahoo!ショッピング' });
  assert.deepEqual(kinds([furu, card]), []);
  const b = row({ date: '2026/10/01', amount: -1000, account: 'Amazon.co.jp', content: '本' });
  const c = row({ date: '2026/10/02', amount: -1200, account: '三井住友カード', content: 'AMAZON.CO.JP' });
  assert.deepEqual(kinds([b, c]), []);
});

test('通販とカード: 購入履歴の 1 件を 2 件のカード明細に使い回さない', () => {
  const a = row({ date: '2026/10/12', amount: -3999, account: 'Amazon.co.jp', content: 'モニターアーム' });
  const c1 = row({ date: '2026/10/12', amount: -3999, account: '三井住友カード', content: 'AMAZON.CO.JP' });
  const c2 = row({ date: '2026/10/13', amount: -3999, account: '三井住友カード', content: 'AMAZON.CO.JP' });
  assert.deepEqual(kinds([a, c1, c2]), [`shop_card:${c1.id}`]);
});

test('すでに直した後は何も出さない（2 回流しても同じ操作を提案しない）', () => {
  const out = row({ date: '2026/01/25', amount: -353000, account: 'PayPay銀行', content: '振込 スギモト カズヒコ', target: '0', gray: true });
  const card = row({ date: '2026/10/12', amount: -3999, account: '三井住友カード', content: 'AMAZON.CO.JP', target: '0', gray: true });
  const a = row({ date: '2026/10/12', amount: -3999, account: 'Amazon.co.jp', content: 'モニターアーム' });
  assert.deepEqual(kinds([out, card, a]), []);
});
