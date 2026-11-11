# userscripts

userscript を 1 つずつ最上位のディレクトリに分けて置いています。使い方は各ディレクトリの README を見てください。

| ディレクトリ | 対象のサイト |
| --- | --- |
| [moneyforward-me](moneyforward-me/) | Money Forward ME（家計簿） |
| [moneyforward-mcp](moneyforward-mcp/) | Money Forward ME の入出金・予算・口座を読み、重複・カテゴリ・予算を直すローカルの MCP サーバ（userscript ではありません） |

## テスト

すべての userscript のテストをまとめて実行します。

```bash
node --test
```
