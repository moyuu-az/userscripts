# moneyforward-me

Money Forward ME（家計簿）を使いやすくする userscript です。Tampermonkey や Violentmonkey に `moneyforward-me.user.js` を読み込んで使います。

- 入出金の一覧の上に検索欄を置き、内容・カテゴリ・金額・メモで行を絞り込む。空白で区切った語をすべて含む行だけが残り、`1000` で `1,000` にも当たる
- 大項目が「未分類」の行に色を付ける
- ← → キーで前月・次月に移る（入力欄にカーソルがあるときは動かない）
- 広告の列を隠し、本文を横いっぱいに広げる
- 背景、ヘッダー、表、ボタン、入力欄の見た目を整える

## テスト

```bash
node --test moneyforward-me/
```
