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

server.registerTool('set_transfer', {
  title: '振替にする',
  description: '取引を振替にし、振替先として相手側の入出金（partnerId）を結びつける。MF の画面から振替を解除すれば元に戻せる。',
  inputSchema: { month, id, partnerMonth: month.optional(), partnerId: id },
  annotations: { destructiveHint: false, idempotentHint: true },
}, ({ month: m, id: i, partnerMonth, partnerId }) => run(async () => json(await mf.setTransfer(m, i, partnerMonth ?? m, partnerId))));

const shutdown = async () => { await mf.close(); process.exit(0); };
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
process.stdin.on('close', shutdown);

await server.connect(new StdioServerTransport());
console.error('moneyforward-mcp: started');
