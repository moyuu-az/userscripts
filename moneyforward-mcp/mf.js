// Money Forward ME の入出金と予算のページを、ログイン済みの Chrome（専用プロファイル）で操作する。
// MF ME には公式の API がないので、画面の作り（クラス名・フォーム）に依存する。画面が変わったらここを直す。
import { chromium } from 'playwright-core';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { accountRows, budgetDrift, budgetRows, budgetSettings, monthsAgo, parseHeaderMonth, pickCategory, planBudget } from './lib.js';

export const HOME = path.join(os.homedir(), '.moneyforward-mcp');
export const PROFILE_DIR = path.join(HOME, 'chrome-profile');
const AUDIT_LOG = path.join(HOME, 'audit.log');
const CF_URL = 'https://moneyforward.com/cf';
const BUDGET_URL = 'https://moneyforward.com/spending_summaries';
const BUDGET_EDIT_URL = 'https://moneyforward.com/spending_targets/edit';
const ACCOUNTS_URL = 'https://moneyforward.com/accounts';
// カレンダー用の .fc-header-title もあり、月を移る途中で一瞬空になるので、一覧側の見出しを読む
const HEADER = '.fc-header-title.in-out-header-title';
const ROW = '#cf-detail-table tr.transaction_list';

// MF はヘッドレスの Chrome を 403 で弾く。User-Agent を偽って通すことはせず、画面ありの Chrome を使う。
// ログインは普通の Chrome（login.js）でするので、その Cookie を読めるよう、Playwright 既定の仮のキーチェーンは使わない
export const launch = () => chromium.launchPersistentContext(PROFILE_DIR, {
  channel: 'chrome', headless: false, ignoreDefaultArgs: ['--use-mock-keychain'],
});

export async function isLoggedIn() {
  try { await openCf(); return true; } catch { return false; } finally { await close(); }
}

let ctxPromise = null;
async function getPage() {
  if (!ctxPromise) {
    const p = launch().then((ctx) => {
      // 利用者が Chrome を終了したら次の呼び出しで起動し直す。閉じた context を持ち続けると、サーバを再起動するまで全ツールが失敗する
      ctx.on('close', () => { if (ctxPromise === p) ctxPromise = null; });
      return ctx;
    }, (e) => {
      ctxPromise = null; // 失敗した起動を使い回さない（npm run login の画面が開いたままだとプロファイルが使えない）
      throw new Error(`Chrome を起動できません。npm run login のウィンドウが開いていたら閉じてください。(${e.message})`);
    });
    ctxPromise = p;
  }
  const ctx = await ctxPromise;
  return ctx.pages()[0] ?? ctx.newPage();
}

export async function close() {
  const p = ctxPromise;
  ctxPromise = null;
  if (p) await (await p.catch(() => null))?.close().catch(() => {});
}

async function open(target) {
  const page = await getPage();
  const res = await page.goto(target, { waitUntil: 'domcontentloaded' });
  if (res?.status() === 403) throw new Error('Money Forward ME にアクセスを拒否されました（403）。');
  const url = new URL(page.url());
  if (url.hostname !== 'moneyforward.com' || !url.pathname.startsWith(new URL(target).pathname)) {
    throw new Error('Money Forward ME にログインしていません。moneyforward-mcp で npm run login を実行してログインしてください。');
  }
  return page;
}

async function openCf() {
  const page = await open(CF_URL);
  // 見出しの要素は先にでき、期間の文字は後から JS で入る
  await page.waitForFunction((sel) => /\d{4}\/\d{1,2}\/\d{1,2}/.test(document.querySelector(sel)?.textContent ?? ''), HEADER);
  return page;
}

const currentMonth = async (page) => parseHeaderMonth(await page.textContent(HEADER));

async function gotoMonth(page, month) {
  for (let i = 0; i < 48; i++) {
    const cur = await currentMonth(page);
    if (!cur) throw new Error('入出金ページの期間が読めません。画面の作りが変わった可能性があります。');
    if (cur === month) {
      // 期間の見出しが先に変わり、表は後から差し替わることがあるので、表の日付がその月になるまで待つ
      await page.waitForFunction(({ sel, prefix }) => [...document.querySelectorAll(sel)]
        .every((tr) => (tr.querySelector('td.date')?.dataset.tableSortableValue ?? prefix).startsWith(prefix)),
      { sel: ROW, prefix: month.replace('-', '/') });
      return;
    }
    const before = await page.textContent(HEADER);
    await page.click(cur < month ? '.fc-button-next, #n_range' : '.fc-button-prev, #b_range');
    await page.waitForFunction(({ sel, before }) => {
      const t = document.querySelector(sel)?.textContent ?? '';
      return t !== before && /\d{4}\/\d{1,2}\/\d{1,2}/.test(t);
    }, { sel: HEADER, before });
  }
  throw new Error(`${month} に移れませんでした`);
}

// 画面の 1 行を取引にする。手入力の行は内容・口座の場所が違う
const extract = (sel) => [...document.querySelectorAll(sel)].map((tr) => {
  const q = (s) => tr.querySelector(s);
  const t = (s) => q(s)?.textContent.trim() ?? '';
  return {
    id: q('input[name="user_asset_act[id]"]')?.value ?? tr.id.replace('js-transaction-', ''),
    date: (q('td.date')?.dataset.tableSortableValue ?? '').split('-')[0],
    content: t('td.content span'),
    amount: Number((q('td.amount span')?.textContent ?? '').replace(/[^\d-]/g, '')),
    account: q('td.note.calc')?.dataset.originalTitle || t('td.sub_account_id_hash .noform span'),
    large: t('td.lctg'),
    middle: t('td.mctg'),
    memo: t('td.memo .noform span'),
    target: q('input[name="user_asset_act[is_target]"]')?.value ?? null,
    gray: tr.classList.contains('mf-grayout'),
    transfer: tr.textContent.includes('(振替)'),
  };
});

async function readMonth(page, month) {
  await gotoMonth(page, month);
  return (await page.evaluate(extract, ROW)).map((r) => ({ ...r, month }));
}

export async function listTransactions(months) {
  const page = await openCf();
  const rows = [];
  for (const m of months) rows.push(...await readMonth(page, m));
  return rows;
}

function audit(entry) {
  fs.mkdirSync(HOME, { recursive: true });
  fs.appendFileSync(AUDIT_LOG, `${JSON.stringify({ at: new Date().toISOString(), ...entry })}\n`);
}

// 行のフォームの値を書き換えて、MF の画面と同じ更新を送る。edits は id ごとの { 欄の名前: 値 }。null の id は送らない。
// 画面のアイコンやメニューをクリックすると応答のスクリプトが表全体を描き直して遅いので、応答は実行しない
const putRows = (page, edits) => page.evaluate(async (edits) => {
  const out = {};
  for (const [id, fields] of Object.entries(edits)) {
    const form = document.querySelector(`#js-transaction-${id} form`);
    if (!fields || !form?.querySelector('#user_asset_act_is_target')) { out[id] = 'not_found'; continue; }
    const $f = window.jQuery(form);
    for (const [name, value] of Object.entries(fields)) $f.find(`#user_asset_act_${name}`).val(value);
    out[id] = await new Promise((res) => {
      window.jQuery.put(form.getAttribute('action'), $f.serialize(), null, 'text')
        .done(() => res('sent')).fail((x) => res(`http_${x.status}`));
    });
  }
  return out;
}, edits);

// MF の「計算対象」アイコンと同じ更新を送る（switchTargetIcon と同じく大・中項目は空にして送ると、サーバは変えない）
export async function setCalcTarget(month, ids, target) {
  let page = await openCf();
  await gotoMonth(page, month);
  let sent;
  let after;
  try {
    sent = await putRows(page, Object.fromEntries(ids.map((id) => [id, { is_target: target ? 1 : 0, large_category_id: '', middle_category_id: '' }])));

    // 送れたかではなく、読み込み直して保存された値で判定する
    page = await openCf();
    after = new Map((await readMonth(page, month)).map((r) => [r.id, r]));
  } catch (e) {
    // 送信の途中や確認の前に止まると、一部だけ保存されていることがある。止まった時点を記録し、やり直せることを伝える
    audit({ op: 'set_calc_target', month, target, ids, sent, error: e.message });
    throw new Error(`計算対象の切り替えが途中で止まりました。一部だけ保存されたかもしれません。同じ指定でもう一度実行すれば、そろえて確かめ直します。(${e.message})`);
  }
  const want = target ? '1' : '0';
  const results = ids.map((id) => ({
    id,
    result: sent[id] !== 'sent' ? sent[id] : after.get(id)?.target === want ? 'ok' : 'not_saved',
  }));
  audit({ op: 'set_calc_target', month, target, results });
  return results;
}

// 行のカテゴリの選択肢は、ドロップダウンを開いたときに初めて作られる。開いて読み、閉じる
const readMenu = (page, id) => page.evaluate(async (id) => {
  const tr = document.querySelector(`#js-transaction-${id}`);
  const toggle = tr.querySelector('.v_l_ctg');
  toggle.click();
  let menu;
  for (let i = 0; i < 50 && !(menu = tr.querySelector('ul.main_menu')); i++) await new Promise((r) => setTimeout(r, 100));
  const out = [...(menu?.querySelectorAll(':scope > li > a.l_c_name') ?? [])].map((a) => ({
    id: a.id,
    name: a.textContent.trim(),
    middles: [...a.parentElement.querySelectorAll('a.m_c_name')].map((m) => ({ id: m.id, name: m.textContent.trim() })),
  }));
  toggle.click();
  return out;
}, id);

// 取引の大項目・中項目を変える。MF のメニューで中項目を選んだときと同じ更新を送る（計算対象は空にして送ると、サーバは変えない）
export async function setCategory(month, ids, large, middle) {
  let page = await openCf();
  const before = new Map((await readMonth(page, month)).map((r) => [r.id, r]));
  // 収入と支出では選べるカテゴリが違う。行の種類ごとに選択肢を読み、名前が合わない種類が 1 つでもあれば、何も送らずに止める。
  // 振替の行にはカテゴリの欄がないので、種類を null にして送らない
  const kinds = await page.evaluate((ids) => Object.fromEntries(ids.map((id) => {
    const tr = document.querySelector(`#js-transaction-${id}`);
    return [id, tr?.querySelector('.v_l_ctg') ? tr.querySelector('#user_asset_act_is_income')?.value ?? null : null];
  })), ids);
  const picked = {};
  for (const id of ids) {
    const k = kinds[id];
    if (k !== null && !(k in picked)) picked[k] = pickCategory(await readMenu(page, id), large, middle);
  }
  let sent;
  let after;
  try {
    sent = await putRows(page, Object.fromEntries(ids.map((id) => [id, kinds[id] === null ? null : {
      large_category_id: picked[kinds[id]].largeId, middle_category_id: picked[kinds[id]].middleId, is_target: '',
    }])));
    // 送れたかではなく、読み込み直して保存された値で判定する
    page = await openCf();
    after = new Map((await readMonth(page, month)).map((r) => [r.id, r]));
  } catch (e) {
    audit({ op: 'set_category', month, large, middle, ids, sent, error: e.message });
    throw new Error(`カテゴリの変更が途中で止まりました。一部だけ保存されたかもしれません。同じ指定でもう一度実行すれば、そろえて確かめ直します。(${e.message})`);
  }
  // before を残すので、この記録から元のカテゴリに戻せる
  const results = ids.map((id) => ({
    id,
    before: before.has(id) ? { large: before.get(id).large, middle: before.get(id).middle } : null,
    result: sent[id] !== 'sent' ? sent[id] : after.get(id)?.large === large && after.get(id)?.middle === middle ? 'ok' : 'not_saved',
  }));
  audit({ op: 'set_category', month, large, middle, results });
  return results;
}

// 振替先が決まっていない振替には「未設定」のリンクが出る。済んだかどうかの判定と、保存の確認の両方でこれを見る
const partnerUnset = async (page, id) => Boolean(await page.$(`#change_act_type_${id}`));

// 取引を振替にし、振替先に相手側の入出金を結びつける。MF の画面の操作をそのままなぞる
export async function setTransfer(month, id, partnerMonth, partnerId) {
  let page = await openCf();
  const row = `#js-transaction-${id}`;
  const self = (await readMonth(page, month)).find((r) => r.id === id);
  if (!self) throw new Error(`取引 ${id} が ${month} にありません`);
  // 振替済みの行の切り替えアイコンは「振替を解除」なので、振替先まで決まっていたら何もしない（相手の行はまとめられて見えない）
  if (self.transfer && !await partnerUnset(page, id)) {
    audit({ op: 'set_transfer', month, id, partnerId, result: 'already' });
    return { id, partnerId, result: 'already' };
  }
  const partner = (await readMonth(page, partnerMonth)).find((r) => r.id === partnerId);
  if (!partner) throw new Error(`振替先の取引 ${partnerId} が ${partnerMonth} にありません`);
  // 取り違えた partnerId で、額の違う本物の入出金を一覧から消さないよう、同じ額の出金と入金に限る
  if (self.amount !== -partner.amount) throw new Error(`同じ額の出金と入金の組み合わせではありません（${self.amount} と ${partner.amount}）`);
  await gotoMonth(page, month);

  const step = async (label, fn) => {
    try { return await fn(); } catch (e) {
      audit({ op: 'set_transfer', month, id, partnerId, result: `failed_at_${label}`, error: e.message });
      throw new Error(`振替の設定が「${label}」で止まりました。MF の画面で ${self.date} ${self.content} を確かめてください。(${e.message})`);
    }
  };
  if (!self.transfer) {
    const link = await page.getAttribute(`${row} .js-switch-transfer`, 'data-link');
    if (!link?.includes('change_type=enable_transfer')) throw new Error(`取引 ${id} を振替に切り替えるアイコンがありません`);
    await step('振替に切り替え', async () => {
      await page.click(`${row} .js-switch-transfer`);
      const proceed = page.locator(`.js-transfer-switch-dialog-btn-proceed[href$="&id=${id}"]`);
      await Promise.all([page.waitForResponse((r) => r.url().includes('change_type=enable_transfer')), proceed.click()]);
    });
  }
  await step('振替先の入力欄', async () => {
    await page.click(`#change_act_type_${id}`);
    await page.waitForSelector('#user_asset_act_partner_account_id_hash', { state: 'visible' });
  });
  await step('振替先の金融機関', async () => {
    const options = await page.$$eval('#user_asset_act_partner_account_id_hash option', (os) => os.map((o) => ({ value: o.value, text: o.textContent.trim() })));
    const best = options.filter((o) => o.value && partner.account.startsWith(o.text)).sort((a, b) => b.text.length - a.text.length)[0];
    if (!best) throw new Error(`「${partner.account}」に当たる金融機関が選択肢にありません`);
    await page.selectOption('#user_asset_act_partner_account_id_hash', best.value);
    const sub = '#select-sub-account select';
    await page.waitForSelector(sub);
    const subs = await page.$$eval(`${sub} option`, (os) => os.map((o) => ({ value: o.value, text: o.textContent.trim() })));
    const subBest = subs.find((o) => o.value && partner.account.includes(o.text));
    if (subs.length > 1 && subBest) await page.selectOption(sub, subBest.value);
  });
  await step('振替先の入出金', async () => {
    await page.waitForSelector(`#user_asset_act_partner_act_id option[value="${partnerId}"]`, { state: 'attached' });
    await page.selectOption('#user_asset_act_partner_act_id', partnerId);
    await Promise.all([page.waitForResponse((r) => r.url().includes('/cf/update') && r.request().method() !== 'GET'), page.click('#submit-button_type')]);
  });

  // 振替にだけなって振替先が結べていないと、この取引は集計から消え、相手側だけが残る。ok と区別して返す
  const result = await step('保存の確認', async () => {
    page = await openCf();
    const after = await readMonth(page, month);
    if (!after.find((r) => r.id === id)?.transfer) return 'not_saved';
    if (await partnerUnset(page, id)) return 'partner_not_set';
    return partnerMonth !== month || !after.some((r) => r.id === partnerId) ? 'ok' : 'not_saved';
  });
  audit({ op: 'set_transfer', month, id, partnerMonth, partnerId, result });
  return { id, partnerId, result };
}

// ---- 予算 ----

const readProgress = (page) => page.evaluate(() => ({
  period: document.querySelector('.date_range .msg')?.textContent.trim() ?? '',
  rows: [...document.querySelectorAll('table.table tbody tr')].map((tr) => ({
    cls: tr.className,
    name: tr.querySelector('th')?.textContent.trim() ?? '',
    spent: tr.querySelector('td.amount span')?.textContent ?? '',
    remaining: tr.querySelector('td.remaining')?.textContent ?? '',
  })),
}));

const readSettings = async (page) => budgetSettings(await page.evaluate(() => ({
  income: document.querySelector('#spending_targets_income')?.value ?? null,
  categories: [...document.querySelectorAll('form.budget_form tr.large_category')].map((tr) => ({
    id: tr.dataset.id,
    name: tr.querySelector('th')?.textContent.trim() ?? '',
    type: tr.classList.contains('fixed') ? 'fixed' : 'variable',
    amount: tr.querySelector('input.large_category_amount')?.value ?? '',
    lastMonth: tr.querySelector('td.last_month')?.textContent ?? '',
  })),
})));

// 月ごとの実績（使った金額・残り）と、毎月の予算の設定を読む。設定は月ごとには持てず、全部の月に共通
export async function getBudget(month) {
  let offset = month ? monthsAgo(month) : 0;
  let page;
  let progress;
  // 期間は開始日の月で数えるので、月の開始日が 1 日でないと、暦の月から求めた offset_month が 1 か月ずれることがある。
  // 開いた期間の月から 1 度だけ合わせ直し、それでも違えば止める（違う月の実績を黙って返さない）
  for (let retry = false; ; retry = true) {
    if (offset < 0) throw new Error(`${month} はまだ来ていないので、予算の実績がありません`);
    page = await open(`${BUDGET_URL}?offset_month=${offset}`);
    progress = await readProgress(page);
    const got = parseHeaderMonth(progress.period);
    if (!month || got === month) break;
    if (retry || !got) throw new Error(`${month} の予算を開けませんでした（開いたのは ${progress.period || '期間が読めないページ'}）`);
    const [y, m] = got.split('-').map(Number);
    offset += monthsAgo(month, new Date(y, m - 1));
  }
  const rows = budgetRows(progress.rows);
  page = await open(BUDGET_EDIT_URL);
  return { period: progress.period, progress: rows, settings: await readSettings(page) };
}

// 「予算の設定」のフォームに額を入れて保存する。指定しなかった大項目は、画面に出ている今の額のまま送られる
export async function setBudget(change) {
  let page = await open(BUDGET_EDIT_URL);
  const settings = await readSettings(page);
  const plan = planBudget(settings, change);
  const result = (after) => plan.map(({ id, ...p }) => {
    const saved = id === null ? after.income : after.categories.find((c) => c.id === id)?.amount;
    return { ...p, result: saved === p.amount ? 'ok' : 'not_saved' };
  });
  // 何も変わらない指定では保存しない（同じ指定をもう一度流しても書き込まない）
  if (plan.every((p) => p.before === p.amount)) return plan.map(({ id, ...p }) => ({ ...p, result: 'unchanged' }));
  for (const p of plan) await page.fill(p.id === null ? '#spending_targets_income' : `#spending_targets_amount_${p.id}`, String(p.amount));
  // 送る前に、フォームに入っている値が指定どおりで、指定外の欄がそのままかを確かめる。ここで止めれば何も保存されない。
  // change のハンドラは欄を離れたときに動くので、先に入力欄からフォーカスを外す（送信ボタンを押したときと同じ状態にする）
  await page.evaluate(() => document.activeElement?.blur());
  const drift = budgetDrift(settings, await readSettings(page), plan);
  if (drift.length) throw new Error(`入力すると「${drift.join('、')}」が指定と違う額になったので、保存していません。画面の作りが変わった可能性があります。`);
  let results;
  try {
    await Promise.all([
      page.waitForResponse((r) => new URL(r.url()).pathname === '/spending_targets' && r.request().method() !== 'GET'),
      page.click('form.budget_form input[name="commit"]'),
    ]);
    // 送れたかではなく、読み込み直して保存された値で判定する
    page = await open(BUDGET_EDIT_URL);
    results = result(await readSettings(page));
  } catch (e) {
    audit({ op: 'set_budget', plan, error: e.message });
    throw new Error(`予算の変更が途中で止まりました。保存されたかどうかは get_budget で確かめてください。(${e.message})`);
  }
  // before を残すので、この記録から元の額に戻せる
  audit({ op: 'set_budget', results });
  return results;
}

// ---- 口座 ----

// 連携している口座の残高と、更新の状態を読む。更新が止まっている口座の取引は入出金に入ってこない
export async function getAccounts() {
  const page = await open(ACCOUNTS_URL);
  return accountRows(await page.evaluate(() => [...document.querySelectorAll('#account-table tr[id]')].map((tr) => ({
    name: tr.querySelector('td.service a')?.textContent.trim() ?? '',
    balance: tr.querySelector('td.number')?.textContent ?? '',
    dates: [...tr.querySelectorAll('td.created p')].map((p) => p.textContent.trim()),
    // 更新中だけ出す「更新中」の文字が隠れて入っているので、見えている文字だけを読む
    status: tr.children[3]?.innerText.trim() ?? '',
  }))));
}
