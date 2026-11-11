#!/usr/bin/env node
// stdio の MCP サーバ。stdout は MCP の通信に使うので、ログは stderr に出す
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';
import { createQueue, findDuplicates, monthsBetween } from './lib.js';
import * as mf from './mf.js';

const run = createQueue();
const json = (v) => ({ content: [{ type: 'text', text: JSON.stringify(v, null, 2) }] });
const month = z.string().regex(/^\d{4}-(0[1-9]|1[0-2])$/, 'YYYY-MM で指定してください');
// id は CSS セレクタに入るので数字だけを通す
const id = z.string().regex(/^\d{1,30}$/, '取引の id は数字です');
const range = (from, to) => {
  const months = monthsBetween(from, to);
  if (months.length > 24) throw new Error('一度に読めるのは 24 か月までです');
  return months;
};

const server = new McpServer({ name: 'moneyforward', version: '0.1.0' });

server.registerTool('list_transactions', {
  title: '入出金を読む',
  description: 'Money Forward ME の入出金を月単位で読む。target は "1" が計算対象、"0" が計算対象外。transfer は振替。',
  inputSchema: { from: month, to: month },
  annotations: { readOnlyHint: true },
}, ({ from, to }) => run(async () => json(await mf.listTransactions(range(from, to)))));

server.registerTool('find_duplicates', {
  title: '重複を探す',
  description: [
    '指定した期間の入出金から、二重に数えられている取引を探す。何も変更しない。',
    'own_transfer: 自分名義の口座どうしの振込（action=transfer。set_transfer に id・partnerId・partnerMonth を渡す）',
    'duplicate_link: 同じ取引が 2 つの連携に入っている（action=exclude）',
    'shop_card: 通販の購入履歴とカード明細の二重計上。カード側を外す（action=exclude）',
    '直す前に必ず一覧を利用者に見せて、了承を得ること。',
  ].join('\n'),
  inputSchema: { from: month, to: month },
  annotations: { readOnlyHint: true },
}, ({ from, to }) => run(async () => {
  const dups = findDuplicates(await mf.listTransactions(range(from, to)));
  const total = (k) => dups.filter((d) => d.kind === k).reduce((s, d) => s + d.amount, 0);
  return json({
    summary: Object.fromEntries(['own_transfer', 'duplicate_link', 'shop_card'].map((k) => [k, { count: dups.filter((d) => d.kind === k).length, amount: total(k) }])),
    duplicates: dups,
  });
}));

server.registerTool('set_calc_target', {
  title: '計算対象を切り替える',
  description: '取引を計算対象外（target=false）または計算対象（target=true）にする。元に戻せる。結果は読み込み直して確かめた値で返す（ok / not_saved / not_found）。',
  inputSchema: { month, ids: z.array(id).min(1).max(300), target: z.boolean() },
  annotations: { destructiveHint: false, idempotentHint: true },
}, ({ month: m, ids, target }) => run(async () => json(await mf.setCalcTarget(m, [...new Set(ids)], target))));

const categoryName = z.string().min(1).max(50);
server.registerTool('set_category', {
  title: 'カテゴリを変える',
  description: [
    '取引の大項目（large）と中項目（middle）を変える。名前は list_transactions の large・middle と同じもの。ない名前を指定すると、何も変えずに、指定できる名前をエラーで返す。',
    '収入と支出では選べるカテゴリが違う。振替の取引はカテゴリを持たないので not_found になる。',
    '結果は読み込み直して確かめた値で返す（ok / not_saved / not_found）。before が変更前のカテゴリで、同じツールで before を指定すれば元に戻せる。',
  ].join('\n'),
  inputSchema: { month, ids: z.array(id).min(1).max(300), large: categoryName, middle: categoryName },
  annotations: { destructiveHint: false, idempotentHint: true },
}, ({ month: m, ids, large, middle }) => run(async () => json(await mf.setCategory(m, [...new Set(ids)], large, middle))));

server.registerTool('set_transfer', {
  title: '振替にする',
  description: [
    '取引を振替にし、振替先として相手側の入出金（partnerId）を結びつける。MF の画面から振替を解除すれば元に戻せる。',
    '結果は読み込み直して確かめた値で返す（ok / already / not_saved / partner_not_set）。',
    'partner_not_set は振替にはなったが振替先が結べていない状態で、相手側の取引だけが集計に残っている。同じ指定でもう一度実行すると続きから設定する。',
  ].join('\n'),
  inputSchema: { month, id, partnerMonth: month.optional(), partnerId: id },
  annotations: { destructiveHint: false, idempotentHint: true },
}, ({ month: m, id: i, partnerMonth, partnerId }) => run(async () => json(await mf.setTransfer(m, i, partnerMonth ?? m, partnerId))));

server.registerTool('get_budget', {
  title: '予算を読む',
  description: [
    '予算の実績と設定を読む。month を省くと今月。',
    'progress: その月の行ごとの予算（budget）・使った金額（spent）・残り（remaining）。level は total が支出全体、group が変動費・固定費の小計、category が大項目。',
    'settings: 毎月の予算の設定。income は毎月の手取り収入、categories は大項目ごとの予算（amount）と先月の実績（lastMonth）。設定は全部の月に共通で、月ごとには持てない。',
  ].join('\n'),
  inputSchema: { month: month.optional() },
  annotations: { readOnlyHint: true },
}, ({ month: m }) => run(async () => json(await mf.getBudget(m))));

const amount = z.number().int().min(0).max(99_999_999);
server.registerTool('set_budget', {
  title: '予算を変える',
  description: [
    '毎月の予算の設定を変える。income は毎月の手取り収入、budgets は大項目の名前（get_budget の settings.categories の name）と新しい額（円）。指定しなかった項目は変えない。',
    '設定は全部の月に共通なので、過去の月の「残り」も変わる。変える前に、変更前後の額を利用者に見せて了承を得ること。',
    '結果は読み込み直して確かめた値で返す（ok / not_saved / unchanged）。before が変更前の額で、同じツールで before の額を指定すれば元に戻せる。',
  ].join('\n'),
  inputSchema: {
    income: amount.optional(),
    budgets: z.array(z.object({ category: z.string().min(1).max(50), amount })).max(50).optional(),
  },
  annotations: { destructiveHint: false, idempotentHint: true },
}, (change) => run(async () => json(await mf.setBudget(change))));

server.registerTool('get_accounts', {
  title: '口座を読む',
  description: '連携している口座（金融機関）ごとの残高（balance。残高の出ない口座は null）・登録日（registered）・最終取得日（lastFetched）・更新状態（status）を読む。status が「正常」でない口座は更新が止まっていて、lastFetched より後の取引は入出金に入っていない。',
  annotations: { readOnlyHint: true },
}, () => run(async () => json(await mf.getAccounts())));

const shutdown = async () => { await mf.close(); process.exit(0); };
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
process.stdin.on('close', shutdown);

await server.connect(new StdioServerTransport());
console.error('moneyforward-mcp: started');
