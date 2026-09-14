/**
 * SQLite と Postgres の名前の対応。**書き出し（export-to-pg）と読み込み（hydrate）で共有する。**
 *
 * 片方だけ直すと、値は通るのに中身が入れ替わるという最悪の壊れ方をする。
 * 一箇所に置いて両方から読む。
 *
 * 並びは**投入の順序**でもある。外部キーがあるので、この順でなければ入らない。
 *   base → tbl → (fld, viw, page, bundle) → (elem, rule, rec_row) → 残り
 */

/** Postgres 側の表名 → SQLite 側の表名。列名が違うものは 列名 に書く。 */
export const 表の対応 = [
  { pg: "base", lite: "base" },
  { pg: "tbl", lite: "tbl" },
  { pg: "fld", lite: "fld" },
  { pg: "viw", lite: "viw" },
  { pg: "page", lite: "page" },
  { pg: "bundle", lite: "bundle" },
  { pg: "elem", lite: "elem" },
  { pg: "rule", lite: "rule" },
  // row は Postgres の予約語なので rec_row にしてある
  { pg: "rec_row", lite: "row" },
  { pg: "dep", lite: "dep" },
  { pg: "calc_order", lite: "calc_order" },
  { pg: "form", lite: "form" },
  { pg: "link", lite: "link" },
  { pg: "attach", lite: "attach", 列名: { row: "row_id" } },
  { pg: "csv_row", lite: "csv_row" },
  {
    pg: "csv_file", lite: "csv_file",
    // 日本語の列名は Postgres で扱いにくいので ASCII にしてある
    列名: { "行": "n_rows", "列": "n_cols", "一致列": "n_matched", "見出し": "headers" },
  },
  { pg: "counter", lite: "counter" },
  { pg: "write_log", lite: "write_log", 列名: { row: "row_id" } },
  { pg: "load_log", lite: "load_log" },
];

/** Postgres 側の列名 → SQLite 側の列名（上の 列名 の逆引き） */
export function 列を戻す(t) {
  const 逆 = {};
  for (const [lite, pgname] of Object.entries(t.列名 ?? {})) 逆[pgname] = lite;
  return (pg列) => 逆[pg列] ?? pg列;
}

/**
 * `requested` の扱い。**ここを間違えると一覧が全部空になる。**
 *
 * db/query.mjs:70-78 は `GROUP BY q.fld` の集計で「全行要求」と「一部要求」を分ける。
 * 素の表に一部要求ぶん（1,506,668 行）だけ入れると、全行要求の 423 項目は集計に 1 行も
 * 現れず、どちらにも入らない。すると 要求された() が常に false を返し、その項目を見る節が
 * null（判定できない）になって、**行が全部「怪しい」に落ちて一覧が空になる**
 * （実測: 全行要求 423 → 0）。
 *
 * だから実体を 2 つに分けて持ち、ビューを被せる。ビュー越しの総行数は 2,353,190 で元と同じ。
 * 検証済み: 全行要求 423 / 一部要求 287 が元の DB と一致する。
 *
 * 846,522 行ぶんをメモリに持たずに済むので、コールドスタートも軽くなる。
 */
export const requestedのビュー = `
CREATE TABLE IF NOT EXISTS requested_full (fld TEXT PRIMARY KEY);
CREATE VIEW IF NOT EXISTS requested AS
  SELECT fld, "row" FROM requested_partial
  UNION ALL
  SELECT rf.fld, r.id AS "row"
    FROM requested_full rf
    JOIN fld f ON f.id = rf.fld
    JOIN row r ON r.tbl = f.tbl;
`;

/**
 * db/schema.sql を、インメモリ側の形に直す。
 *
 * `db/schema.sql` そのものは**変えない**。手元の `data/ttcf.db` は `requested` を実表として
 * 持っており、そこにビューを作ろうとすると壊れるからである。
 * 直すのはこの 1 箇所だけで、他は 1 文字も変えない。
 */
export function インメモリ用のスキーマ(sql) {
  const 直した = sql
    .replace(/CREATE TABLE IF NOT EXISTS requested\b/i, "CREATE TABLE IF NOT EXISTS requested_partial")
    .replace(/CREATE INDEX IF NOT EXISTS requested_row ON requested\(row\);/i,
      'CREATE INDEX IF NOT EXISTS requested_row ON requested_partial("row");');
  if (直した === sql) throw new Error("schema.sql の requested を置き換えられませんでした");
  return 直した + "\n" + requestedのビュー;
}
