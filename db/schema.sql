-- TTCF ミミックのローカルDB
--
-- ■ なぜ固定列にしないか
--
-- 現行は 76表 1,756項目、うち 969項目（55%）が計算項目。
-- しかも項目の追加・削除が日常的に起きている（式が参照する「もう無い項目」が9件残っている）。
-- 表ごとに固定列を切ると、項目が1つ増えるたびに移行が要る。追随できない。
--
-- だから **Airtable 自身の作りをそのまま写す。**
-- 表・項目・ビュー・画面・フォーム・規則を「データ」として持ち、行は JSON で持つ。
-- 速さが要る項目だけ、後から生成列と索引を足す（実測: 20万行で 75ms → 0ms）。
--
-- ■ 値の持ち方
--
--   row.cells  入力・同期・自動処理が書いた値      {項目ID: 値}
--   row.calc   式・rollup・lookup・count の結果   {項目ID: 値}
--
-- 2つに分ける理由は、**計算をやり直せるようにするため。**
-- 混ぜると「これは入力された値か、計算結果か」が区別できず、再計算で入力を壊す。
-- calc は deps.json の計算順序（1,765件・閉路0）に従って作り直す。
--
-- ■ 関連は別表に出す
--
-- rollup / lookup / count は関連をたどって集める。cells の JSON を毎回開くと
-- 176,446行では遅い。link 表に出して両方向に索引を張る。

PRAGMA journal_mode = WAL;
PRAGMA foreign_keys = ON;

-- ─────────── メタモデル ───────────

CREATE TABLE IF NOT EXISTS base (
  id    TEXT PRIMARY KEY,          -- appXXXXXXXXXXXXXX
  tab   TEXT NOT NULL,             -- 製造 / 販売 / 予実 / 在庫登録
  name  TEXT NOT NULL,
  color TEXT
);

CREATE TABLE IF NOT EXISTS tbl (
  id         TEXT PRIMARY KEY,     -- tblXXXXXXXXXXXXXX
  base       TEXT NOT NULL REFERENCES base(id),
  name       TEXT NOT NULL,        -- **同じ名前の表がベース違いで7組ある。名前で引かないこと**
  primary_fld TEXT,                -- 主項目の項目ID
  row_unit   TEXT,
  hidden     INTEGER NOT NULL DEFAULT 0,  -- 切替から隠す
  synced     INTEGER NOT NULL DEFAULT 0,  -- 外部同期で入ってくる表（19表）
  sync_cfg   TEXT,                 -- 同期の設定 JSON（同期元は当方から見えない）
  ord        INTEGER
);
CREATE INDEX IF NOT EXISTS tbl_base ON tbl(base);

CREATE TABLE IF NOT EXISTS fld (
  id          TEXT PRIMARY KEY,    -- fldXXXXXXXXXXXXXX（基底で一意。IDで引くこと）
  tbl         TEXT NOT NULL REFERENCES tbl(id),
  name        TEXT,                -- **無名（"Field"）の項目が多い。名前で引かないこと**
  type        TEXT NOT NULL,
  is_primary  INTEGER NOT NULL DEFAULT 0,
  is_computed INTEGER NOT NULL DEFAULT 0,
  ord         INTEGER,             -- meaningfulColumnOrder での位置
  description TEXT,
  formula     TEXT,                -- 式（formula / computation / rollup の集め方）
  opts        TEXT,                -- 選択肢・関連先・書式・書式桁など JSON
  synced      INTEGER NOT NULL DEFAULT 0,  -- 外部同期で埋まる項目（197項目）
  writable    INTEGER NOT NULL DEFAULT 0,  -- 画面かフォームから書ける経路がある
  from_page   INTEGER NOT NULL DEFAULT 0   -- ベース応答に無く画面応答から拾った（13項目）
);
CREATE INDEX IF NOT EXISTS fld_tbl ON fld(tbl);
CREATE INDEX IF NOT EXISTS fld_type ON fld(type);

CREATE TABLE IF NOT EXISTS viw (
  id    TEXT PRIMARY KEY,
  tbl   TEXT NOT NULL REFERENCES tbl(id),
  name  TEXT,
  type  TEXT,
  spec  TEXT                       -- 絞り込み・並び・グループ・見せる列 JSON
);
CREATE INDEX IF NOT EXISTS viw_tbl ON viw(tbl);

-- 項目の依存。計算の順序を決めるのに使う
CREATE TABLE IF NOT EXISTS dep (
  fld  TEXT NOT NULL,              -- この項目が
  uses TEXT NOT NULL,              -- この項目を参照している
  PRIMARY KEY (fld, uses)
);
CREATE INDEX IF NOT EXISTS dep_uses ON dep(uses);

-- 計算の順序。deps.json の並びをそのまま持つ（閉路0で確定済み）
CREATE TABLE IF NOT EXISTS calc_order (
  seq INTEGER PRIMARY KEY,
  fld TEXT NOT NULL
);

-- ─────────── 画面 ───────────

CREATE TABLE IF NOT EXISTS page (
  id        TEXT PRIMARY KEY,      -- pagXXXXXXXXXXXXXX
  base      TEXT REFERENCES base(id),
  tab       TEXT,
  name      TEXT,                  -- **同じ名前で中身の違う画面がある（6売上入力→一覧）**
  type      TEXT,                  -- entry / row
  tbl       TEXT,                  -- 見せている表
  bundle    TEXT,                  -- 束（サイドバーの群）
  in_nav    INTEGER NOT NULL DEFAULT 1,
  layout_kind TEXT,                -- queryContainer / recordContainer / dashboard
  variant   TEXT,                  -- sidesheet / page
  ord       INTEGER,
  has_layout INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS page_base ON page(base);

CREATE TABLE IF NOT EXISTS bundle (
  id     TEXT PRIMARY KEY,
  base   TEXT NOT NULL REFERENCES base(id),
  name   TEXT,
  icon   TEXT,
  color  TEXT,
  ord    INTEGER
);

-- 画面の要素。木の形は parent で持つ
CREATE TABLE IF NOT EXISTS elem (
  page      TEXT NOT NULL REFERENCES page(id),
  id        TEXT NOT NULL,         -- pelXXXXXXXXXXXXXX（**画面をまたいで再利用される**）
  type      TEXT NOT NULL,
  depth     INTEGER,
  path      TEXT,                  -- 親からの経路 JSON
  tbl       TEXT,
  fld       TEXT,
  label     TEXT,
  read_only INTEGER NOT NULL DEFAULT 0,
  bar       TEXT,                  -- 横棒の位置（top / bottom）
  visible_when TEXT,               -- 親から継承した見せる条件 JSON
  spec      TEXT,                  -- 種類ごとの設定（列幅・並び・母集団・確認ダイアログなど）JSON
  PRIMARY KEY (page, id)
);
CREATE INDEX IF NOT EXISTS elem_type ON elem(type);
CREATE INDEX IF NOT EXISTS elem_fld ON elem(fld);
CREATE INDEX IF NOT EXISTS elem_id ON elem(id);

-- ─────────── 入力と規則 ───────────

-- miniExtensions のフォーム。
-- **shareId は主キーにならない。** 親フォームと子フォーム（明細）が同じ shareId を共有する。
-- 実測: LQAP1DJHxu8phMWufBOs に4定義（発注書=親／発注明細・Table・氏名表=子）。
-- shareId を主キーにすると30本が20本に潰れて子フォームが消える（実際に消えた）。
CREATE TABLE IF NOT EXISTS form (
  share     TEXT NOT NULL,         -- miniExtensions の shareId（親子で共有）
  tbl       TEXT,
  button    TEXT,                  -- 保存ボタンの文字
  is_child  INTEGER NOT NULL DEFAULT 0,  -- 子フォーム（明細）か
  place     TEXT,                  -- どのボタンから開くか
  access    TEXT,                  -- 入る行の取り方
  after     TEXT,                  -- 保存後（close / redirect / readonly / stay）
  success   TEXT,                  -- 成功時の文言
  webhook   TEXT,                  -- 外部を叩く設定 JSON（**URLは叩かない**）
  spec      TEXT,                  -- 項目ごとの必須・読み取り専用・検証 JSON
  PRIMARY KEY (share, tbl, button)
);
CREATE INDEX IF NOT EXISTS form_share ON form(share);

CREATE TABLE IF NOT EXISTS rule (
  fld      TEXT PRIMARY KEY REFERENCES fld(id),
  tbl      TEXT NOT NULL,
  messages TEXT NOT NULL,          -- 出す文言の配列 JSON（176件）
  formula  TEXT NOT NULL,
  refs     TEXT,                   -- 参照している項目 JSON
  shown_on TEXT                    -- 出る画面 JSON
);

-- ─────────── 行 ───────────

CREATE TABLE IF NOT EXISTS row (
  id      TEXT PRIMARY KEY,        -- recXXXXXXXXXXXXXX
  tbl     TEXT NOT NULL REFERENCES tbl(id),
  cells   TEXT NOT NULL DEFAULT '{}',  -- 入力・同期・自動処理が書いた値
  calc    TEXT NOT NULL DEFAULT '{}',  -- 計算結果（こちらが作り直した値）
  -- Airtable が返した計算結果。**答え合わせの正解。書き換えない。**
  -- calc と分けないと、再計算が正解を自分の計算で上書きしてしまい
  -- 「100%一致」が自己参照になる（実際にそうなっていた）。
  snap    TEXT NOT NULL DEFAULT '{}',
  -- 画面の所属から分かった値。**値そのものは来ていないが真偽が決まるもの**。
  -- 例: 受注一覧は「受注登録=true ∧ 月3あり」で絞る → そこに出た行の 受注登録 は true。
  -- 入力 → 計算 → 正解 → 含意 の順で引く（db/calc.mjs の 値()）。db/16-implied.mjs が作る。
  implied TEXT NOT NULL DEFAULT '{}',
  src     TEXT,                    -- どこから入れたか（画面ID / CSV名 / 手入力）
  loaded  TEXT                     -- 取り込んだ時刻
);
CREATE INDEX IF NOT EXISTS row_tbl ON row(tbl);

-- 関連。cells から出して両方向に索引を張る
CREATE TABLE IF NOT EXISTS link (
  src_row TEXT NOT NULL,
  fld     TEXT NOT NULL,
  dst_row TEXT NOT NULL,
  ord     INTEGER,
  PRIMARY KEY (src_row, fld, dst_row)
);
CREATE INDEX IF NOT EXISTS link_dst ON link(dst_row, fld);
CREATE INDEX IF NOT EXISTS link_fld ON link(fld);

-- ─────────── 添付 ───────────

CREATE TABLE IF NOT EXISTS attach (
  id       TEXT PRIMARY KEY,       -- 添付ID
  row      TEXT NOT NULL,
  fld      TEXT NOT NULL,
  name     TEXT,
  kind     TEXT,                   -- 帳票の種類
  bytes    INTEGER,
  path     TEXT,                   -- 手元の実物の場所
  producer TEXT                    -- 生成元（Skia/PDF m1xx = ヘッドレスChromium / PrinceXML）
);
CREATE INDEX IF NOT EXISTS attach_row ON attach(row, fld);

-- ─────────── クライアント提供CSV ───────────
--
-- 2026-09-06 にクライアントが**オーナー権限で書き出した**ビューの出力。46本・135,534行。
-- `row` とは別に持つ。**CSVには行ID（recXXXX）が無い**ので、ID で突き合わせられない。
-- 混ぜると「どちらの情報源の値か」が分からなくなる。
--
-- 価値は3つ。
--  1. **取得できなかった画面のデータ。** 販売/出庫は CSV に 36,855行あるが
--     こちらの取得は1,548行（出庫一覧の画面が取れなかった）。
--  2. 画面が要求しなかった列の値。
--  3. 絞り込みで見えなかった行（別のビューなので別の集合）。
--
-- 限界: ビューの出力なので**そのビューの列だけ**。関連項目は表示名で出るので行IDが無い。
-- 日付・数値は表示形。
CREATE TABLE IF NOT EXISTS csv_row (
  file  TEXT NOT NULL,             -- 元のCSV
  seq   INTEGER NOT NULL,          -- ファイル内の行番号
  tbl   TEXT,                      -- 推定した表（見出しの一致数で決める）
  cells TEXT NOT NULL,             -- {項目ID: 値}。見出しが項目名に一致した分だけ
  extra TEXT,                      -- 項目に対応付けられなかった列 {見出し: 値}
  PRIMARY KEY (file, seq)
);
CREATE INDEX IF NOT EXISTS csv_row_tbl ON csv_row(tbl);

CREATE TABLE IF NOT EXISTS csv_file (
  file    TEXT PRIMARY KEY,
  tbl     TEXT,
  行      INTEGER,
  列      INTEGER,
  一致列  INTEGER,
  見出し  TEXT                     -- 元の見出しの並び JSON
);

-- ─────────── どの行にどの列を要求したか ───────────
--
-- 応答の `preloadPageQueryResults.querySlices` は {tableId, columnIds, rowIds} を持つ。
-- **「値が無い」と「要求していない」は別物。** これを持たないと、
-- 取ってこなかった列を「空」と数えてしまう
-- （実測: 売上の得意先を「空2/19,557」と数えたが、正しくは要求19,555・空0）。
CREATE TABLE IF NOT EXISTS requested (
  fld   TEXT NOT NULL,
  row   TEXT NOT NULL,
  PRIMARY KEY (fld, row)
) WITHOUT ROWID;
CREATE INDEX IF NOT EXISTS requested_row ON requested(row);

-- ─────────── 採番 ───────────
--
-- autoNumber は17件（17の別々の表に1件ずつ）。現行の `maxUsedAutoNumber` を種にする。
--
-- **売上のカウンタは1本で、海外と国内が分け合っている。**
-- 実測19,557行で 4系（12,498個）と 6系（7,059個）の重なりが0、和集合は119..20564。
-- 接頭辞は「どちらの種類が消費したか」の記録にすぎない。
-- だから表ごとに1本持てばよく、種類ごとに分けてはいけない。
--
-- 欠番は詰めない。削除しても番号は戻らない（実測で欠番889個）。
CREATE TABLE IF NOT EXISTS counter (
  fld  TEXT PRIMARY KEY,
  next INTEGER NOT NULL
);

-- ─────────── 書き込みの記録 ───────────
--
-- 誰が何をしたかを残す。現行の自動処理の中身が読めないので、
-- **こちら側が何を書いたかは全部辿れるようにしておく。**
CREATE TABLE IF NOT EXISTS write_log (
  seq     INTEGER PRIMARY KEY AUTOINCREMENT,
  at      TEXT NOT NULL,
  action  TEXT NOT NULL,          -- createRow / updateRow / deleteRow / triggerWorkflow
  tbl     TEXT,
  row     TEXT,
  origin  TEXT,                   -- どの画面のどの要素から
  before  TEXT,                   -- 変更前の値 JSON
  after   TEXT,                   -- 変更後の値 JSON
  note    TEXT
);
CREATE INDEX IF NOT EXISTS write_log_row ON write_log(row);

-- ─────────── 取り込みの記録 ───────────

CREATE TABLE IF NOT EXISTS load_log (
  seq   INTEGER PRIMARY KEY AUTOINCREMENT,
  at    TEXT NOT NULL,
  what  TEXT NOT NULL,
  n     INTEGER,
  note  TEXT
);
