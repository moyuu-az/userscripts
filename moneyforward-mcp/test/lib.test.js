import test from 'node:test';
import assert from 'node:assert/strict';
import { findDuplicates, parseHeaderMonth, monthsBetween, createQueue, yen, monthsAgo, budgetRows, budgetSettings, planBudget, budgetDrift } from '../lib.js';

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

test('二重の連携: 98% 未満の一致（家族の Suica が同じ区間を通る程度）は外さない', () => {
  const rows = [];
  for (let i = 1; i <= 20; i++) {
    const date = `2026/06/${String(i).padStart(2, '0')}`;
    rows.push(suica(SID, date, -253, '入 立川 出 東小金井'));
    // 20 件中 1 件だけ違う（95%）
    rows.push(suica(JRE, date, i === 10 ? -300 : -253, i === 10 ? '入 立川 出 新宿' : '入 立川 出 東小金井'));
  }
  assert.deepEqual(kinds(rows), []);
  // 全件一致なら重複とみなす
  rows[19] = suica(JRE, '2026/06/10', -253, '入 立川 出 東小金井');
  assert.equal(findDuplicates(rows).length, 20);
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

// ---- 予算 ----

test('yen は桁区切りと負の額を読み、読めないときは null を返す', () => {
  assert.equal(yen('154,688円'), 154688);
  assert.equal(yen('\n -9,591円 '), -9591);
  assert.equal(yen('0円'), 0);
  assert.equal(yen('350000'), 350000);
  assert.equal(yen('円'), null);
  assert.equal(yen(''), null);
  assert.equal(yen(undefined), null);
});

test('monthsAgo は今月を 0 とし、年をまたいで数える。先の月は負になる', () => {
  const now = new Date(2026, 10, 11); // 2026-11
  assert.equal(monthsAgo('2026-11', now), 0);
  assert.equal(monthsAgo('2026-10', now), 1);
  assert.equal(monthsAgo('2025-12', now), 11);
  assert.equal(monthsAgo('2024-11', now), 24);
  assert.equal(monthsAgo('2026-12', now), -1);
  assert.equal(monthsAgo('2027-01', now), -2);
  assert.equal(monthsAgo('2026-01', new Date(2026, 0, 1)), 0);
});

const rawRow = (cls, name, spent, remaining) => ({ cls, name, spent, remaining });

test('budgetRows は予算を「使った金額 + 残り」で求め、行の種類を分ける', () => {
  assert.deepEqual(budgetRows([
    rawRow('total_expense', '支出全体', '154,688円', '176,916円'),
    rawRow('budget_type_total_expense variable_type', '手元で管理するお金', '108,159円', '-9,591円'),
    rawRow('large_category_expense', 'その他', '11,000円', '-7,432円'),
    rawRow('large_category_expense', '保険', '0円', '0円'),
  ]), [
    { level: 'total', name: '支出全体', budget: 331604, spent: 154688, remaining: 176916 },
    { level: 'group', name: '手元で管理するお金', budget: 98568, spent: 108159, remaining: -9591 },
    { level: 'category', name: 'その他', budget: 3568, spent: 11000, remaining: -7432 },
    { level: 'category', name: '保険', budget: 0, spent: 0, remaining: 0 },
  ]);
});

test('budgetRows は表が空・知らない行・読めない額のときに止まる（0 円として返さない）', () => {
  assert.throws(() => budgetRows([]), /画面の作り/);
  assert.throws(() => budgetRows([rawRow('something_new', '食費', '1円', '1円')]), /食費/);
  assert.throws(() => budgetRows([rawRow('large_category_expense', '食費', '', '1円')]), /食費/);
  assert.throws(() => budgetRows([rawRow('large_category_expense', '食費', '1円', '円')]), /食費/);
  assert.throws(() => budgetRows([rawRow('large_category_expense', '', '1円', '1円')]), /画面の作り/);
});

const rawSettings = () => ({
  income: '350000',
  categories: [
    { id: '11', name: '食費', type: 'variable', amount: '40000', lastMonth: '164,485円' },
    { id: '4', name: '住宅', type: 'fixed', amount: '71,536', lastMonth: '112,027円' },
    { id: '8', name: '保険', type: 'fixed', amount: '0', lastMonth: '' },
  ],
});

test('budgetSettings はフォームの値を数値にする', () => {
  assert.deepEqual(budgetSettings(rawSettings()), {
    income: 350000,
    categories: [
      { id: '11', name: '食費', type: 'variable', amount: 40000, lastMonth: 164485 },
      { id: '4', name: '住宅', type: 'fixed', amount: 71536, lastMonth: 112027 },
      { id: '8', name: '保険', type: 'fixed', amount: 0, lastMonth: null },
    ],
  });
});

test('budgetSettings は収入・大項目・額・id のどれかが読めないと止まる', () => {
  const broken = (f) => { const s = rawSettings(); f(s); return () => budgetSettings(s); };
  assert.throws(broken((s) => { s.income = null; }), /画面の作り/);
  assert.throws(broken((s) => { s.income = ''; }), /画面の作り/);
  assert.throws(broken((s) => { s.categories = []; }), /画面の作り/);
  assert.throws(broken((s) => { s.categories[1].amount = ''; }), /住宅/);
  assert.throws(broken((s) => { s.categories[1].id = undefined; }), /住宅/);
  assert.throws(broken((s) => { s.categories[1].id = '4"]'; }), /住宅/);
  assert.throws(broken((s) => { s.categories[1].name = ''; }), /画面の作り/);
});

test('planBudget は名前で大項目を選び、変更前の額を添える', () => {
  const s = budgetSettings(rawSettings());
  assert.deepEqual(planBudget(s, { income: 400000, budgets: [{ category: '住宅', amount: 80000 }, { category: '保険', amount: 0 }] }), [
    { id: null, name: '毎月の手取り収入', before: 350000, amount: 400000 },
    { id: '4', name: '住宅', before: 71536, amount: 80000 },
    { id: '8', name: '保険', before: 0, amount: 0 },
  ]);
  assert.deepEqual(planBudget(s, { income: 0 }), [{ id: null, name: '毎月の手取り収入', before: 350000, amount: 0 }]);
  assert.deepEqual(planBudget(s, { budgets: [{ category: '食費', amount: 1 }] }), [{ id: '11', name: '食費', before: 40000, amount: 1 }]);
});

test('planBudget は知らない大項目・重複・空の指定を拒む', () => {
  const s = budgetSettings(rawSettings());
  assert.throws(() => planBudget(s, { budgets: [{ category: '食費', amount: 1 }, { category: '外食', amount: 1 }] }), /「外食」.*食費、住宅、保険/);
  assert.throws(() => planBudget(s, { budgets: [{ category: '食 費', amount: 1 }] }), /ありません/);
  assert.throws(() => planBudget(s, { budgets: [{ category: '食費', amount: 1 }, { category: '食費', amount: 2 }] }), /2 回/);
  assert.throws(() => planBudget(s, {}), /指定されていません/);
  assert.throws(() => planBudget(s, { budgets: [] }), /指定されていません/);
});

test('monthsAgo で、開いた期間の月から offset を合わせ直せる（月の開始日が 1 日でない設定）', () => {
  // 開始日 25 日・今日 11/11 だと今の期間は 10/25 - 11/24 で、10 月と数える。2026-10 を求めて offset 1 を開くと 2026-09 が出る
  const offset = monthsAgo('2026-10', new Date(2026, 10, 11));
  assert.equal(offset + monthsAgo('2026-10', new Date(2026, 8)), 0);
  // 年をまたぐ: 2026-01 を求めて 2025-12 が出たら、1 つ新しい側に戻す
  assert.equal(monthsAgo('2026-01', new Date(2025, 11)), -1);
  // 今の期間が 10 月と数えられているときに 2026-11 を求めると、合わせ直した offset は負（まだ来ていない）
  assert.equal(monthsAgo('2026-11', new Date(2026, 10, 11)) + monthsAgo('2026-11', new Date(2026, 9)), -1);
});

test('budgetDrift は指定どおりに入り、指定外が変わっていなければ空を返す', () => {
  const before = budgetSettings(rawSettings());
  const plan = planBudget(before, { budgets: [{ category: '住宅', amount: 80000 }] });
  const after = structuredClone(before);
  after.categories[1].amount = 80000;
  assert.deepEqual(budgetDrift(before, after, plan), []);
  const incomePlan = planBudget(before, { income: 0 });
  assert.deepEqual(budgetDrift(before, { ...before, income: 0 }, incomePlan), []);
});

test('budgetDrift は指定外の欄が書き換わった・指定の額が入っていない・大項目が消えたときに項目名を返す', () => {
  const before = budgetSettings(rawSettings());
  const plan = planBudget(before, { income: 400000 });
  // 収入を変えたら画面の JS が大項目の予算まで配り直した
  const recalculated = structuredClone(before);
  recalculated.income = 400000;
  recalculated.categories[0].amount = 45000;
  assert.deepEqual(budgetDrift(before, recalculated, plan), ['食費']);
  // 指定した額が入っていない（収入）
  assert.deepEqual(budgetDrift(before, before, plan), ['毎月の手取り収入']);
  // 指定外の大項目が読み直しで見つからない
  const missing = structuredClone(before);
  missing.income = 400000;
  missing.categories.pop();
  assert.deepEqual(budgetDrift(before, missing, plan), ['保険']);
  // 0 円の予算が 0 のままなら変わっていない（0 を「値なし」と取り違えない）
  const zero = planBudget(before, { budgets: [{ category: '保険', amount: 0 }, { category: '食費', amount: 1 }] });
  const filled = structuredClone(before);
  filled.categories[0].amount = 1;
  assert.deepEqual(budgetDrift(before, filled, zero), []);
});
