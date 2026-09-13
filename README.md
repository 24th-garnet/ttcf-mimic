# TTCF ミミック — 配信用の枝

現行 Airtable（社内呼称 SM／SCANMAN）の複製を、**動かすのに要るものだけ**にした枝。
解析・クロールの成果物は入っていない。開発は別の枝で行う。

## 置いてあるもの

| | |
|---|---|
| `app/` | HTTP 層。`serve.mjs` が本体、`ext/*.mjs` が拡張6本、`doc-*.mjs` が帳票 |
| `db/` | データ層。`query`（クエリエンジン）・`calc`（計算器）・`formula`（式の評価器）・`write`・`actions`（動作28本） |
| `db/schema.sql` | 実行時の器（インメモリ SQLite）の定義 |
| `db/pg/001_schema.sql` | Supabase 側の定義。**移送元としてだけ使う** |
| `crawl/lib/airmsg.mjs` | 生レイアウトの復号。`app/ext/20,30,40` が使う |
| `spec/gates.json` | 入力を止める門の一覧 |
| `tools/export-to-pg.mjs` | SQLite → Postgres の書き出しと往復照合 |

## 置いていないもの

**業務のデータは1件も入っていない。** 行データ（656MB）も、実物の帳票 1,057 件も、
クライアント提供の CSV も、この枝には無い。

- 記録の本体 … Supabase（東京）
- 実物のファイル … Supabase Storage

## 外へは繋がない

このアプリは外向きの通信を一切持たない（`app/` に `fetch(` は 0 件）。
**現行 Airtable にも Make にも miniExtensions にも繋がらない。**
現行はクライアントが実務で使っている本番環境なので、この性質は変えないこと。

## 動かし方

```bash
# 手元（常駐サーバ）
node app/serve.mjs            # 既定 :8787。data/ttcf.db を開く

# Vercel
# ルートの server.mjs が Supabase から読んでインメモリ SQLite を組み、
# そのあと app/serve.mjs を import する。listen() を Vercel が検出する
```

`app/serve.mjs` は**手元と Vercel で同じものを実行する**。
比較検証の前提なので、片方だけを書き換えないこと。
