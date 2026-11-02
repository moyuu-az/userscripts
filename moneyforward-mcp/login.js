// MCP サーバが使う Chrome のプロファイルに、利用者が自分でログインする。パスワードはこのスクリプトを通らない。
// Playwright から開いた Chrome では Google ログインが「安全でないブラウザ」として拒否されるので、
// ログインのときだけ普通の Chrome を同じプロファイルで起動し、閉じたあとにログインできたかを確かめる
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import { PROFILE_DIR, isLoggedIn } from './mf.js';

// shortcut: macOS の Chrome の場所に固定。ほかの OS で使うときは CHROME_PATH で渡す
const CHROME = process.env.CHROME_PATH ?? '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
if (!fs.existsSync(CHROME)) throw new Error(`Chrome が見つかりません: ${CHROME}（CHROME_PATH で指定できます）`);

fs.mkdirSync(PROFILE_DIR, { recursive: true });
console.log('開いた Chrome で Money Forward ME にログインし、入出金のページが表示されたら Chrome を終了してください（⌘Q）。');
const chrome = spawn(CHROME, [`--user-data-dir=${PROFILE_DIR}`, '--no-first-run', '--no-default-browser-check', 'https://moneyforward.com/cf'], { stdio: 'ignore' });
await new Promise((res, rej) => { chrome.on('exit', res); chrome.on('error', rej); });

if (await isLoggedIn()) {
  console.log('ログインできました。');
} else {
  console.error('ログインを確かめられませんでした。もう一度 npm run login を実行してください。');
  process.exitCode = 1;
}
