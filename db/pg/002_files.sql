-- ═══════════════════════════════════════════════════════════════════
-- 実行時に読むファイルを Postgres に置く（2026-09-14 追加）
--
-- 2,822 経路の突き合わせで残った差 255 本は、すべて「ファイルを Vercel に
-- 載せていない」ことが原因だった。どちらもクライアントの業務データなので、
-- 私有リポジトリであっても GitHub には置けない。他の業務データと同じ場所へ移す。
--
--   bom_file   使用原材料の控え  12MB /   41件   → /doc/製造表/… 245本
--   artifact   帳票の実物       127MB / 1,057件 → /artifact/…  1,057本
--
-- **本文をそのまま持つ。** 読み取った後の解釈は 1 文字も変えない
-- （抽出して構造を変えると、そこが移植による漏れの出どころになる）。
-- ═══════════════════════════════════════════════════════════════════

-- ─────────── 使用原材料の控え（app/doc-mfg.mjs・db/actions.mjs） ───────────
--
-- 起動時に全部読んでメモリへ載せる（12MB）。元も「起動後に一度だけ読む」作り。
create table if not exists bom_file (
  name text primary key,          -- "rec….jsonl" か "index.json"
  body text not null
);

-- ─────────── 帳票の実物（app/ext/40-dash.mjs） ───────────
--
-- 127MB あるのでコールドスタートでは**名前だけ**読む。
-- 中身は /artifact/:名 が叩かれたときにその都度引く。
create table if not exists artifact (
  name  text primary key,         -- "<タブ>-<表>-<項目>__<行ID>__<元のファイル名>"
  ctype text not null,
  bytes bigint not null,
  body  bytea not null
);

create index if not exists artifact_name_only on artifact (name);
