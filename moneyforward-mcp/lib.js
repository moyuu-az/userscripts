// ブラウザに依存しない部分。重複の判定はここだけに置き、テストで守る。

const DAY = 864e5;
const days = (a, b) => (Date.parse(a.replaceAll('/', '-')) - Date.parse(b.replaceAll('/', '-'))) / DAY;
const isActive = (r) => r.target === '1' && !r.gray;

// "2026/9/1 - 2026/9/30" → "2026-09"。月の開始日を 1 日以外にしていると "2026/8/25 - …" になるので、開始日の月で数える
export function parseHeaderMonth(text) {
  const m = /(\d{4})\/(\d{1,2})\/\d{1,2}/.exec(text ?? '');
  return m ? `${m[1]}-${m[2].padStart(2, '0')}` : null;
}

export function monthsBetween(from, to) {
  if (from > to) throw new Error(`from (${from}) が to (${to}) より後です`);
  const out = [];
  let [y, m] = from.split('-').map(Number);
  for (;;) {
    const k = `${y}-${String(m).padStart(2, '0')}`;
    out.push(k);
    if (k === to) return out;
    if (++m > 12) { m = 1; y++; }
  }
}

// MF の画面は 1 枚なので、ツール呼び出しが重なっても操作は 1 つずつ流す
export function createQueue() {
  let tail = Promise.resolve();
  return (fn) => {
    const run = tail.then(fn);
    tail = run.catch(() => {});
    return run;
  };
}

// 自分名義の口座どうしの振込: 出金と入金が同じ名義・同じ額・3 日以内
const payee = (content) => content.replace(/^振込\S*\s*/, '').trim();

function ownTransfers(rows) {
  const banks = rows.filter((r) => isActive(r) && r.account.includes('銀行'));
  const used = new Set();
  const out = [];
  for (const o of banks) {
    if (o.amount >= 0 || !o.content.startsWith('振込')) continue;
    const name = payee(o.content);
    if (!name) continue;
    const i = banks.find((r) => r.amount === -o.amount && r.account !== o.account && !used.has(r.id)
      && payee(r.content) === name && Math.abs(days(r.date, o.date)) <= 3);
    if (!i) continue;
    used.add(i.id);
    out.push({
      kind: 'own_transfer', action: 'transfer', month: o.month, id: o.id, partnerMonth: i.month, partnerId: i.id,
      amount: o.amount, detail: `${o.date} ${o.account} → ${i.date} ${i.account}（${o.content}）`,
    });
  }
  return out;
}

// 同じ取引が 2 つの連携に入っている（例: モバイル Suica を 2 つの ID で連携）。
// 期間が重なる中で、一方の取引の 9 割以上がもう一方と日付・金額・内容まで一致したら、その連携を重複とみなす
const MIN_LINK_MATCHES = 3;
const LINK_RATIO = 0.9;

function duplicateLinks(rows) {
  const byAcc = new Map();
  for (const r of rows.filter(isActive)) {
    if (!byAcc.has(r.account)) byAcc.set(r.account, []);
    byAcc.get(r.account).push(r);
  }
  const key = (r) => `${r.date}|${r.amount}|${r.content}`;
  const accs = [...byAcc.keys()].sort();
  const out = [];
  for (let i = 0; i < accs.length; i++) {
    for (let j = i + 1; j < accs.length; j++) {
      const A = byAcc.get(accs[i]); const B = byAcc.get(accs[j]);
      const range = (xs) => [xs.reduce((m, r) => (r.date < m ? r.date : m), '9'), xs.reduce((m, r) => (r.date > m ? r.date : m), '0')];
      const [a0, a1] = range(A); const [b0, b1] = range(B);
      const lo = a0 > b0 ? a0 : b0; const hi = a1 < b1 ? a1 : b1;
      if (lo > hi) continue;
      const inA = A.filter((r) => r.date >= lo && r.date <= hi);
      const inB = B.filter((r) => r.date >= lo && r.date <= hi);
      const pool = new Map();
      for (const r of inB) pool.set(key(r), [...(pool.get(key(r)) ?? []), r]);
      const pairs = [];
      for (const r of inA) { const c = pool.get(key(r)); if (c?.length) pairs.push([r, c.pop()]); }
      const n = pairs.length;
      if (n < MIN_LINK_MATCHES || n / inA.length < LINK_RATIO || n / inB.length < LINK_RATIO) continue;
      // 両方ほぼ一致するなら、更新が先に止まった方（古い連携）を外す。同じなら件数の少ない方
      const dropA = a1 !== b1 ? a1 < b1 : A.length <= B.length;
      const drop = pairs.map((p) => (dropA ? p[0] : p[1]));
      const keepName = dropA ? accs[j] : accs[i];
      const dropName = dropA ? accs[i] : accs[j];
      for (const r of drop) {
        out.push({
          kind: 'duplicate_link', action: 'exclude', month: r.month, id: r.id, amount: r.amount,
          detail: `${r.date} ${r.content}（${dropName} と ${keepName} の両方にある）`,
        });
      }
    }
  }
  return out;
}

// 通販の購入履歴とカード明細の二重計上。カード側の 1 件が、購入履歴の数件（品物・送料・ポイント・クーポン）の合計と一致したら重複とみなす
const SHOPS = [
  { name: 'Amazon', shop: (r) => r.account.startsWith('Amazon'), card: (r) => /AMAZON/i.test(r.content) && !r.account.startsWith('Amazon') },
  {
    name: 'Yahoo!ショッピング',
    // ふるさと納税の口座は寄付の記録で、カード側は「Yahoo!ふるさと納税」として別に出るので照合に入れない
    shop: (r) => r.account.startsWith('Yahoo!ショッピング') && !r.account.includes('ふるさと'),
    card: (r) => /Yahoo!ショッピング|^ヤフー/.test(r.content) && !r.account.startsWith('Yahoo'),
  },
];
const MAX_CANDIDATES = 14; // 部分和を総当たりするので 2^14 で打ち切る

function shopVsCard(rows) {
  const active = rows.filter(isActive);
  const out = [];
  for (const s of SHOPS) {
    const shop = active.filter(s.shop);
    const used = new Set();
    for (const c of active.filter(s.card)) {
      const cand = shop.filter((r) => !used.has(r.id) && days(c.date, r.date) >= -1 && days(c.date, r.date) <= 10).slice(0, MAX_CANDIDATES);
      let hit = null;
      for (let mask = 1; mask < 1 << cand.length && !hit; mask++) {
        let sum = 0; const pick = [];
        for (let i = 0; i < cand.length; i++) if (mask >> i & 1) { sum += cand[i].amount; pick.push(cand[i]); }
        if (sum === c.amount && pick.some((p) => p.amount < 0)) hit = pick;
      }
      if (!hit) continue;
      for (const h of hit) used.add(h.id);
      out.push({
        kind: 'shop_card', action: 'exclude', month: c.month, id: c.id, amount: c.amount,
        detail: `${c.date} ${c.account} の「${c.content}」= ${s.name} の ${hit.map((h) => `${h.content.slice(0, 20)}(${h.amount})`).join(' + ')}`,
      });
    }
  }
  return out;
}

export function findDuplicates(rows) {
  return [...ownTransfers(rows), ...duplicateLinks(rows), ...shopVsCard(rows)];
}
