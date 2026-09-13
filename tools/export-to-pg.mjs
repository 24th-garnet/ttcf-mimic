#!/usr/bin/env node
/**
 * SQLite の断面を Postgres(Supabase) へ移すための書き出し。
 *
 *   node tools/export-to-pg.mjs --元 data/ttcf.db --先 db/pg/data
 *   node tools/export-to-pg.mjs --確かめる db/pg/data        書き出した中身を読み直して照合する
 *
 * **直接つながない。** PostgreSQL の COPY 形式（text）のファイルを書き出すだけにする。
 * 理由は3つ:
 *   ・資格情報が要らないので、アカウントができる前に作って試せる
 *   ・`\copy` で流せるので psql 以外の依存が増えない
 *   ・書き出した中身をこちらで読み直して、元と突き合わせられる（後述の 確かめる）
 *
 * ■ 名前の対応（db/pg/001_schema.sql の方針に合わせる）
 *   row → rec_row ／ requested → requested_partial + requested_full
 *   列 row → row_id ／ csv_file の 行/列/一致列/見出し → n_rows/n_cols/n_matched/headers
 *
 * ■ rowid を持ち出す
 *   ORDER BY rowid が9箇所あり、順序は機能である（仕掛品の並びは実物8品と8/8一致）。
 *   すべての表で rowid を _rowid として書き出し、戻すときに明示指定する。
 *
 * ■ requested を2つに割る理由
 *   素の表に「一部要求」だけ入れると、db/query.mjs:70-78 の GROUP BY に
 *   全行要求の423項目が現れず、要求された() が常に false になって
 *   行が全部「怪しい」に落ちる（実測: 全行要求 423 → 0）。
 *   だから「一部要求の実体」と「全行要求の項目一覧」に分けて持ち、
 *   インメモリ側で UNION ALL のビューを被せる。
 */
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { DatabaseSync } from "node:sqlite";

const 引数 = process.argv.slice(2);
const 取る = (名, 既定) => { const i = 引数.indexOf(名); return i >= 0 ? 引数[i + 1] : 既定; };

/** PostgreSQL の COPY text 形式。区切りはタブ、NULL は \N、
 *  バックスラッシュ・タブ・改行・復帰だけを逃がす。順序を変えてはいけない
 *  （\ を最初に逃がさないと、後から足した \t の \ をまた逃がしてしまう）。 */
function 逃がす(v) {
  if (v === null || v === undefined) return "\\N";
  if (typeof v === "number") return String(v);
  return String(v)
    .replaceAll("\\", "\\\\")
    .replaceAll("\t", "\\t")
    .replaceAll("\n", "\\n")
    .replaceAll("\r", "\\r");
}
/** 読み直す側。逃がした順の逆に戻す。 */
function 戻す(s) {
  if (s === "\\N") return null;
  let out = "";
  for (let i = 0; i < s.length; i++) {
    if (s[i] !== "\\") { out += s[i]; continue; }
    const c = s[++i];
    out += c === "t" ? "\t" : c === "n" ? "\n" : c === "r" ? "\r" : c === "\\" ? "\\" : c;
  }
  return out;
}

/** 表ごとの: SQLite 側の名前 → Postgres 側の名前と列の対応。投入の順序でもある。 */
const 対応 = [
  { pg: "base",   lite: "base" },
  { pg: "tbl",    lite: "tbl" },
  { pg: "fld",    lite: "fld" },
  { pg: "viw",    lite: "viw" },
  { pg: "page",   lite: "page" },
  { pg: "bundle", lite: "bundle" },
  { pg: "elem",   lite: "elem" },
  { pg: "rule",   lite: "rule" },
  { pg: "rec_row", lite: "row" },                                   // row は PG の予約語
  { pg: "dep",    lite: "dep" },
  { pg: "calc_order", lite: "calc_order" },
  { pg: "form",   lite: "form" },
  { pg: "link",   lite: "link" },
  { pg: "attach", lite: "attach", 列名: { row: "row_id" } },
  { pg: "csv_row", lite: "csv_row" },
  { pg: "csv_file", lite: "csv_file",
    列名: { "行": "n_rows", "列": "n_cols", "一致列": "n_matched", "見出し": "headers" } },
  { pg: "counter", lite: "counter" },
  { pg: "write_log", lite: "write_log", 列名: { row: "row_id" } },
  { pg: "load_log", lite: "load_log" },
];

function 書き出す(元, 先) {
  fs.mkdirSync(先, { recursive: true });
  const db = new DatabaseSync(元, { readOnly: true });
  const 台帳 = [];

  for (const t of 対応) {
    const 列 = db.prepare("SELECT name FROM pragma_table_info(?)").all(t.lite).map((r) => r.name);
    const pg列 = ["_rowid", ...列.map((c) => t.列名?.[c] ?? c)];
    const sql = `SELECT rowid AS _rowid, ${列.map((c) => `"${c}"`).join(",")} FROM "${t.lite}" ORDER BY rowid`;
    const out = fs.createWriteStream(path.join(先, `${t.pg}.copy`));
    const h = crypto.createHash("sha256");
    let n = 0;
    for (const r of db.prepare(sql).iterate()) {
      const 行 = [逃がす(r._rowid), ...列.map((c) => 逃がす(r[c]))].join("\t") + "\n";
      out.write(行); h.update(行); n++;
    }
    out.end();
    台帳.push({ 表: t.pg, 元の表: t.lite, 列: pg列, 行数: n, sha256: h.digest("hex") });
    console.log(`  ${t.pg.padEnd(18)} ${String(n).padStart(9)} 行`);
  }

  // requested を2つに割る
  const 一部 = db.prepare(`
    SELECT q.fld FROM requested q JOIN fld f ON f.id=q.fld
    GROUP BY q.fld HAVING count(*) < (SELECT count(*) FROM row WHERE tbl=f.tbl)`).all().map((r) => r.fld);
  const 全行 = db.prepare(`
    SELECT q.fld FROM requested q JOIN fld f ON f.id=q.fld
    GROUP BY q.fld HAVING count(*) >= (SELECT count(*) FROM row WHERE tbl=f.tbl)`).all().map((r) => r.fld);

  {
    const ph = 一部.map(() => "?").join(",");
    const out = fs.createWriteStream(path.join(先, "requested_partial.copy"));
    const h = crypto.createHash("sha256");
    let n = 0;
    /** requested は WITHOUT ROWID。rowid が無いので主キーの順で出す（失われる順序は無い）。 */
    for (const r of db.prepare(
      `SELECT fld, "row" FROM requested WHERE fld IN (${ph}) ORDER BY fld, "row"`).iterate(...一部)) {
      const 行 = [逃がす(r.fld), 逃がす(r.row)].join("\t") + "\n";
      out.write(行); h.update(行); n++;
    }
    out.end();
    台帳.push({ 表: "requested_partial", 元の表: "requested（一部要求のみ）",
                列: ["fld", "row_id"], 行数: n, sha256: h.digest("hex") });
    console.log(`  requested_partial  ${String(n).padStart(9)} 行`);
  }
  {
    const h = crypto.createHash("sha256");
    const 本文 = 全行.map((f) => 逃がす(f) + "\n").join("");
    h.update(本文);
    fs.writeFileSync(path.join(先, "requested_full.copy"), 本文);
    台帳.push({ 表: "requested_full", 元の表: "requested（全行要求の項目）",
                列: ["fld"], 行数: 全行.length, sha256: h.digest("hex") });
    console.log(`  requested_full     ${String(全行.length).padStart(9)} 行`);
  }

  const 索引 = {
    作った: new Date().toISOString(),
    元: path.resolve(元),
    元のsha256: crypto.createHash("sha256").update(fs.readFileSync(元)).digest("hex"),
    表: 台帳,
  };
  fs.writeFileSync(path.join(先, "manifest.json"), JSON.stringify(索引, null, 2));

  // psql で流すための手順書。FK があるので順序を守る
  const 流す = ["\\set ON_ERROR_STOP on", "BEGIN;",
    ...台帳.map((t) => `\\copy ${t.表} (${t.列.join(",")}) FROM '${t.表}.copy' WITH (FORMAT text)`),
    "SELECT setval(pg_get_serial_sequence('write_log','seq'), COALESCE((SELECT max(seq) FROM write_log),1));",
    "SELECT setval(pg_get_serial_sequence('load_log','seq'), COALESCE((SELECT max(seq) FROM load_log),1));",
    "COMMIT;"].join("\n");
  fs.writeFileSync(path.join(先, "load.sql"), 流す + "\n");

  console.log(`\n書き出しました: ${先}`);
  console.log(`  manifest.json と load.sql も置きました`);
  console.log(`  流すとき: psql "<接続文字列>" -f load.sql   （db/pg/001_schema.sql を先に当てる）`);
}

/** 書き出した COPY ファイルを読み直して、元の SQLite と突き合わせる。
 *  逃がし方が壊れていれば、ここで必ず落ちる。 */
function 確かめる(先, 元) {
  const 索引 = JSON.parse(fs.readFileSync(path.join(先, "manifest.json"), "utf8"));
  const db = new DatabaseSync(元 ?? 索引.元, { readOnly: true });
  let 悪い = 0;
  for (const t of 索引.表) {
    if (t.表 === "requested_full") continue;          // 1列なので別扱い
    const 生 = fs.readFileSync(path.join(先, `${t.表}.copy`), "utf8");
    const 行たち = 生.length ? 生.slice(0, -1).split("\n") : [];
    if (行たち.length !== t.行数) { console.log(`× ${t.表} 行数 ${行たち.length} ≠ ${t.行数}`); 悪い++; continue; }

    const lite = t.元の表.replace(/（.*/, "");
    const 列 = t.列.slice(1);                          // _rowid を除く
    const sqlite列 = db.prepare("SELECT name FROM pragma_table_info(?)").all(lite).map((r) => r.name);
    const 条件 = t.表 === "requested_partial" ? " WHERE fld IN (SELECT fld FROM (" +
      "SELECT q.fld FROM requested q JOIN fld f ON f.id=q.fld GROUP BY q.fld " +
      "HAVING count(*) < (SELECT count(*) FROM row WHERE tbl=f.tbl)))" : "";
    const rowidあり = t.列[0] === "_rowid";
    const 並び = rowidあり ? "rowid" : sqlite列.map((c) => `"${c}"`).join(",");
    const 元行 = db.prepare(
      `SELECT ${rowidあり ? "rowid AS _rowid, " : ""}${sqlite列.map((c) => `"${c}"`).join(",")} FROM "${lite}"${条件} ORDER BY ${並び}`).all();

    let 差 = 0;
    for (let i = 0; i < 行たち.length && 差 < 3; i++) {
      const 欄 = 行たち[i].split("\t").map(戻す);
      if (rowidあり && String(欄[0]) !== String(元行[i]._rowid)) { 差++; console.log(`× ${t.表} #${i} rowid ${欄[0]} ≠ ${元行[i]._rowid}`); continue; }
      const ずれ = rowidあり ? 1 : 0;
      for (let j = 0; j < sqlite列.length; j++) {
        const a = 元行[i][sqlite列[j]];
        const b = 欄[j + ずれ];
        const 同 = a === null || a === undefined ? b === null : String(a) === b;
        if (!同) { 差++; console.log(`× ${t.表} #${i} 列 ${sqlite列[j]}: ${JSON.stringify(String(a).slice(0,60))} ≠ ${JSON.stringify(String(b).slice(0,60))}`); break; }
      }
    }
    if (差) 悪い++; else console.log(`○ ${t.表.padEnd(18)} ${String(t.行数).padStart(9)} 行  往復一致`);
  }
  console.log(`\n${悪い === 0 ? "すべて一致しました。" : `★ ${悪い} 表で食い違いました。`}`);
  process.exit(悪い ? 1 : 0);
}

const 確 = 取る("--確かめる");
if (確) 確かめる(確, 取る("--元"));
else 書き出す(取る("--元", "data/ttcf.db"), 取る("--先", "db/pg/data"));
