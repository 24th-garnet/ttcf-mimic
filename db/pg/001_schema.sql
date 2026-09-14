-- TTCF ミミック — Supabase(Postgres) 側のスキーマ
--
-- ■ この DB の役目は2つだけ
--
--   1. 移送元    起動時にここから全部読んで、インメモリ SQLite を組む
--   2. 複製ログ  インスタンス間で書き込みを配る（write_log）
--
-- **絞り込みも並びも集計も、Postgres では一切やらない。** それは db/query.mjs が
-- インメモリ SQLite の上でやる。だから「Postgres らしい形」に直す価値が無い。
-- 最優先は「移送の往復で値が1バイトも変わらないこと」であり、
-- そのための唯一確実な方法は **型変換を1つも入れないこと** である。
--
-- ■ 絶対に守る3つ
--
--   JSON は text。jsonb を使わない。
--     jsonb は鍵を並べ替え、重複鍵を落とし、空白を正規化し、数値を numeric に直す。
--     row.snap は「Airtable が返した正解」で、書き換えないことが前提。
--     1バイトでも変われば「100%一致」の主張の土台が崩れる。
--     Postgres 側で中を覗きたくなったら、式索引か生成列で (cells::jsonb) を足せばよい。
--
--   真偽は smallint の 0/1。boolean にしない。
--     JS 側は 0/1 を前提に truthy 判定している。false にすると
--     db/query.mjs の 値() の5層フォールバックの挙動が変わる。
--
--   日時は text(ISO8601)。timestamptz にしない。
--
--   数値型は「実データが本当に数値である列」にだけ使う。
--     SQLite は型が緩く、INTEGER 宣言の列に文字列が入る。実測で page.ord と bundle.ord が
--     Airtable の fractional index の文字列（"aK" "a0G"）だった。宣言を信じて integer にすると
--     COPY が `invalid input syntax for type integer: "aK"` で弾かれる。
--     tbl.ord / fld.ord / link.ord は本当に整数だったので、そのままにしてある。
--     app/ext/30-detail.mjs:231 の `WHERE at >= 起動` は**文字列比較**である。
--     型を変えると比較の意味が変わる。
--
-- ■ 名前を変えたもの（実行時のコードには影響しない）
--
--   row      → rec_row    row は PG の予約語。ROW(...) 構文との紛れと Studio での事故を避ける
--   .row     → row_id     requested / write_log / attach の列名も同じ理由
--   csv_file の日本語列名 → ASCII
--     行/列/一致列/見出し。PG は引用すれば通るが PostgREST と Studio で厄介。
--     **実行時に csv_file を読む箇所は 0**（app/ が見るのは csv_row だけ）なので安全。
--
--   戻すのは db/hydrate.mjs の仕事。インメモリ側は db/schema.sql のままにする
--   （スキーマが1文字でも違えば、それ自体が差分の入り口になる）。
--
-- ■ 外部キーと投入の順序
--
-- 元データで参照の欠けが無いことを確かめたうえで張っている（実測・全部 0）:
--   tbl.base→base / fld.tbl→tbl / viw.tbl→tbl / page.base→base /
--   bundle.base→base / elem.page→page / rule.fld→fld / rec_row.tbl→tbl
--
-- したがって投入は次の順でなければならない:
--   base → tbl → (fld, viw, page, bundle) → (elem, rule, rec_row) → 残り
--
-- **link には外部キーを張らない。** 元のスキーマが張っていないのは理由があり、
-- 実測で `link.dst_row` の **75,403 / 270,619（28%）が row に無い行を指している**
-- （行が取れている表が 42/76 しかないため）。張ると移送が弾かれる。
-- requested_partial・attach・counter・write_log も同じ方針で張らない。
--
-- ■ _rowid
--
-- SQLite の rowid の値を持ち出して、復元時に明示指定で戻す。
-- 「新しい順序列を足す」のではなく「元の値を保存する」。
-- ORDER BY rowid が9箇所あり、うち app/doc-mfg.mjs:235 の仕掛品の並びは
-- 実物8品と8/8一致していることが確認されている。順序は機能である。

-- ─────────── メタモデル ───────────

create table base (
  _rowid bigint not null,
  id     text primary key,
  tab    text not null,
  name   text not null,
  color  text
);

create table tbl (
  _rowid      bigint not null,
  id          text primary key,
  base        text not null references base(id),
  name        text not null,   -- 同じ名前の表がベース違いで7組ある。名前で引かない
  primary_fld text,
  row_unit    text,
  hidden      smallint not null default 0,
  synced      smallint not null default 0,
  sync_cfg    text,
  ord         integer
);
create index tbl_base on tbl(base);

create table fld (
  _rowid      bigint not null,
  id          text primary key,
  tbl         text not null references tbl(id),
  name        text,            -- 無名（"Field"）が633項目ある。名前で引かない
  type        text not null,
  is_primary  smallint not null default 0,
  is_computed smallint not null default 0,
  ord         integer,
  description text,
  formula     text,
  opts        text,            -- JSON（text のまま）
  synced      smallint not null default 0,
  writable    smallint not null default 0,
  from_page   smallint not null default 0
);
create index fld_tbl on fld(tbl);
create index fld_type on fld(type);

create table viw (
  _rowid bigint not null,
  id     text primary key,
  tbl    text not null references tbl(id),
  name   text,
  type   text,
  spec   text                  -- JSON
);
create index viw_tbl on viw(tbl);

create table dep (
  _rowid bigint not null,
  fld    text not null,
  uses   text not null,
  primary key (fld, uses)
);
create index dep_uses on dep(uses);

create table calc_order (
  _rowid bigint not null,
  seq    integer primary key,  -- deps.json の並びをそのまま持つ（1,765件・閉路0）
  fld    text not null
);

-- ─────────── 画面 ───────────

create table page (
  _rowid      bigint not null,
  id          text primary key,
  base        text references base(id),
  tab         text,
  name        text,            -- 同じ名前で中身の違う画面がある
  type        text,
  tbl         text,
  bundle      text,
  in_nav      smallint not null default 1,
  layout_kind text,
  variant     text,
  -- ★ SQLite の宣言は INTEGER だが、実際に入っているのは **Airtable の fractional index の文字列**
  --   （"aK" "a9V" "Zz"）。実測 335 行のうち text 275・NULL 60 で、整数は 1 つも無い。
  --   SQLite は型が緩いので INTEGER 宣言のまま通っていた。integer にすると COPY が弾かれる。
  ord         text,
  has_layout  smallint not null default 0
);
create index page_base on page(base);

create table bundle (
  _rowid bigint not null,
  id     text primary key,
  base   text not null references base(id),
  name   text,
  icon   text,
  color  text,
  -- ★ page.ord と同じ。実測 8 行すべてが fractional index の文字列（"a0" "a04" …）
  ord    text
);

create table elem (
  _rowid       bigint not null,
  page         text not null references page(id),
  id           text not null,   -- 画面をまたいで再利用されるので単独では一意でない
  type         text not null,
  depth        integer,
  path         text,            -- JSON
  tbl          text,
  fld          text,
  label        text,
  read_only    smallint not null default 0,
  bar          text,
  visible_when text,            -- JSON
  spec         text,            -- JSON
  primary key (page, id)
);
create index elem_type on elem(type);
create index elem_fld on elem(fld);
create index elem_id on elem(id);

-- ─────────── 入力と規則 ───────────

-- share は主キーにならない。親フォームと子フォーム（明細）が同じ share を共有する。
-- share を主キーにすると30本が20本に潰れて子フォームが消える（実際に消えた）。
create table form (
  _rowid   bigint not null,
  share    text not null,
  tbl      text,
  button   text,
  is_child smallint not null default 0,
  place    text,
  access   text,
  "after"  text,                -- after は PG の予約語ではないが紛らわしいので引用
  success  text,
  webhook  text,                -- 外部を叩く設定 JSON。**URL は叩かない**
  spec     text,                -- JSON
  primary key (share, tbl, button)
);
create index form_share on form(share);

create table rule (
  _rowid   bigint not null,
  fld      text primary key references fld(id),
  tbl      text not null,
  messages text not null,       -- JSON（文言176件）
  formula  text not null,
  refs     text,                -- JSON
  shown_on text                 -- JSON
);

-- ─────────── 行 ───────────

-- row は PG の予約語なので rec_row。db/hydrate.mjs が row に戻す。
create table rec_row (
  _rowid  bigint not null,
  id      text primary key,
  tbl     text not null references tbl(id),
  cells   text not null default '{}',   -- 入力・同期・自動処理が書いた値
  calc    text not null default '{}',   -- こちらが作り直した計算結果
  snap    text not null default '{}',   -- **Airtable が返した正解。書き換えない**
  implied text not null default '{}',   -- 画面の所属から分かった値
  src     text,
  loaded  text                          -- ISO8601 の文字列。timestamptz にしない
);
create index rec_row_tbl on rec_row(tbl);
create index rec_row_rowid on rec_row(_rowid);

create table link (
  _rowid  bigint not null,
  src_row text not null,
  fld     text not null,
  dst_row text not null,
  ord     integer,              -- NULL と 0 を混同しないこと
  primary key (src_row, fld, dst_row)
);
create index link_dst on link(dst_row, fld);
create index link_fld on link(fld);

-- ─────────── 添付 ───────────

create table attach (
  _rowid   bigint not null,
  id       text primary key,
  row_id   text not null,       -- SQLite 側の列名は row
  fld      text not null,
  name     text,
  kind     text,
  bytes    bigint,
  path     text,                -- Storage のキーに読み替える
  producer text
);
create index attach_row on attach(row_id, fld);

-- ─────────── クライアント提供CSV ───────────

create table csv_row (
  _rowid bigint not null,
  file   text not null,
  seq    integer not null,
  tbl    text,
  cells  text not null,         -- JSON
  extra  text,                  -- JSON
  primary key (file, seq)
);
create index csv_row_tbl on csv_row(tbl);

-- 日本語の列名を ASCII に。実行時に読む箇所は 0 なので安全。
create table csv_file (
  _rowid    bigint not null,
  file      text primary key,
  tbl       text,
  n_rows    integer,            -- 行
  n_cols    integer,            -- 列
  n_matched integer,            -- 一致列
  headers   text                -- 見出し（JSON）
);

-- ─────────── どの行にどの列を要求したか ───────────
--
-- 「値が無い」と「要求していない」は別物。
--
-- ★ここが移植で一番危ない。
--   db/query.mjs:70-78 は GROUP BY q.fld の集計で「全行要求」と「一部要求」を分ける。
--   一部要求ぶん（1,506,668行）だけを素の表に入れると、全行要求の423項目は
--   集計に1行も現れず、どちらにも入らない。すると 要求された() が常に false を返し、
--   その項目を見る節が null（判定できない）になって、**行が全部「怪しい」に落ちて
--   一覧が空になる**（実測: 全行要求 423 → 0）。
--
--   だから2つに分けて持ち、インメモリ側で UNION ALL のビューを被せる。
--   ビュー越しの総行数は 2,353,190 で元と同じになる（検証済み）。
-- SQLite 側は WITHOUT ROWID なので **保存すべき rowid が無い**（_rowid を持たない唯一の表）。
-- 順序も主キー (fld,row) で決まるため、移送で失われるものは無い。
create table requested_partial (
  fld    text not null,
  row_id text not null,         -- SQLite 側の列名は row
  primary key (fld, row_id)
);
create index requested_partial_fld on requested_partial(fld);

create table requested_full (
  fld text primary key          -- 表の全行が要求された項目（423件）
);

-- ─────────── 採番 ───────────
--
-- 売上のカウンタは1本で、海外と国内が分け合っている（実測: 4系と6系の重なり0）。
-- 表ごとに1本持てばよく、種類ごとに分けてはいけない。欠番は詰めない。
--
-- ★Postgres をこの表の唯一の権威にする。
--   UPDATE counter SET next=next+1 WHERE fld=$1 RETURNING next-1
--   単一文なので原子的。SQLite 側の SELECT→UPDATE（db/write.mjs:121-126）は
--   BEGIN より前にあり、複数インスタンスでは必ず衝突する。
create table counter (
  _rowid bigint not null,
  fld    text primary key,
  next   bigint not null
);

-- ─────────── 書き込みの記録（＝複製ログ） ───────────
--
-- ★既存の write_log は「意図の記録」であって「効果の記録」ではない。
--   そのまま別インスタンスで再生すると壊れる:
--     ・採番の値が載っていない（after は cells だけ）→ 再生で別の番号が出る
--     ・link の変更が載っていない（消す の before にしかない）
--     ・再計算の結果が載っていない（COMMIT の外で UPDATE している）
--     ・再生が 作る/更新/消す の再実行になるので冪等でない（検証() が走る）
--     ・行ID が "rec"+乱英数() なので再生側で変わる
--
--   だから effect に「適用に要る全部」を入れる。再生側はこれを UPSERT/DELETE
--   として当てるだけで、検証() も 採る() も 乱英数() も走らない。
create table write_log (
  -- seq は SQLite 側で INTEGER PRIMARY KEY AUTOINCREMENT ＝ rowid そのものだが、
  -- 移送は全表で同じ形にしておく（_rowid を必ず運ぶ）。値は seq と同じになる。
  _rowid bigint not null,
  seq    bigint generated by default as identity primary key,
  at     text not null,          -- ISO8601 の文字列
  action text not null,          -- createRow / updateRow / deleteRow / triggerWorkflow / batch_end
  tbl    text,
  row_id text,
  origin text,
  before text,                   -- JSON
  after  text,                   -- JSON
  note   text,
  effect text,                   -- ★新設。{rows:[…], links:{消す,入れる}, 消した:[…]}
  batch  uuid                    -- ★新設。手順を走らせる() の束。batch_end まで適用しない
);
create index write_log_row on write_log(row_id);
create index write_log_batch on write_log(batch);

create table load_log (
  _rowid bigint not null,
  seq    bigint generated by default as identity primary key,
  at   text not null,
  what text not null,
  n    integer,
  note text
);

-- ─────────── 焼き固め断面の台帳（採る場合のみ） ───────────
--
-- Postgres から機械的に焼いた .db を Storage に置き、コールドスタートを縮める案。
-- 「Supabase が正」は崩さない。断面は Postgres から焼き、sha256 で同一性を示す。
create table snapshot (
  id           bigint generated by default as identity primary key,
  built_at     timestamptz not null default now(),
  storage_path text not null,
  sha256       text not null,
  bytes        bigint not null,
  through_seq  bigint not null   -- この断面が write_log のどこまでを含むか
);
