#!/usr/bin/env node
/**
 * 移送の忠実さを確かめる。SQLite → Postgres が値をそのまま運べたか。
 *
 *   node tools/verify-pg.mjs            全表
 *   node tools/verify-pg.mjs --だけ page
 *
 * ■ なぜ「型つき」で見るのか
 *
 * 書き出し側（export-to-pg.mjs --確かめる）は**文字列の形しか見ていない**。
 * SQLite は型が緩く、同じ "1" でも integer と text は別物である。JS では
 * `0`（integer）は偽、`"0"`（text）は真になるので、型が変わると挙動が変わる。
 * 実際 page.ord は INTEGER 宣言なのに中身は text だった。
 * だからここでは **値と型の両方**を混ぜてハッシュする。
 *
 * ■ 見るもの
 *
 *   1. 行数
 *   2. _rowid の並び（ORDER BY rowid が 9 箇所ある。順序は機能である）
 *   3. 全列の型つきハッシュ   T:文字列 / I:整数 / R:実数 / N:NULL
 */
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { DatabaseSync } from "node:sqlite";
import pg from "pg";
import { ROOT, 読む, 宛先を確かめる } from "./pgenv.mjs";

/**
 * pg は int8（bigint）を**文字列で返す**。精度を落とさないための既定だが、
 * SQLite 側は integer で返すので、そのままだと型が食い違って全部「不一致」になる。
 * ここで扱う値はどれも安全な範囲（最大でも write_log.seq の 47,380）なので数に直す。
 * 20 = int8 の OID。
 */
pg.types.setTypeParser(20, (v) => (v === null ? null : Number(v)));

const 区切り = String.fromCharCode(1);

const だけ = process.argv.includes("--だけ") ? process.argv[process.argv.indexOf("--だけ") + 1] : null;
const 索引 = JSON.parse(fs.readFileSync(path.join(ROOT, "db", "pg", "data", "manifest.json"), "utf8"));
const { SUPABASE_SESSION_URL: url } = 読む(["SUPABASE_SESSION_URL"]);
宛先を確かめる(url);

const lite = new DatabaseSync(path.join(ROOT, "data", "ttcf.db"), { readOnly: true });
const c = new pg.Client({ connectionString: url, statement_timeout: 0, keepAlive: true });
await c.connect();

/** SQLite の値 → 型つきの正規形。Postgres 側も同じ形に直してから比べる。 */
const 形 = (v) =>
  v === null || v === undefined ? "N:"
  : typeof v === "bigint" ? "I:" + v
  : typeof v === "number" ? (Number.isInteger(v) ? "I:" + v : "R:" + v)
  : "T:" + v;

let 悪い = 0;
console.log("表".padEnd(20) + "行数".padStart(11) + "  rowid順   内容");
console.log("-".repeat(62));

for (const t of 索引.表) {
  if (だけ && t.表 !== だけ) continue;

  const lite表 = t.元の表.replace(/（.*/, "");
  const 列 = t.列.filter((x) => x !== "_rowid");
  const rowidあり = t.列[0] === "_rowid";
  // Postgres 側で改名した列を SQLite 側の名前に戻す
  const 戻す = { row_id: "row", n_rows: "行", n_cols: "列", n_matched: "一致列", headers: "見出し" };
  const lite列 = 列.map((x) => 戻す[x] ?? x);

  /**
   * requested は 2 つに割って移した。SQLite 側からも同じ条件で取り出さないと比べられない。
   *   requested_partial … 一部要求の項目の行だけ（1,506,668 行）
   *   requested_full    … 全行要求の項目の一覧だけ（423 行。行の実体は持たない）
   */
  const 一部の条件 = `(SELECT q.fld FROM requested q JOIN fld f ON f.id=q.fld GROUP BY q.fld
                       HAVING count(*) < (SELECT count(*) FROM row WHERE tbl=f.tbl))`;
  const 全行の条件 = `(SELECT q.fld FROM requested q JOIN fld f ON f.id=q.fld GROUP BY q.fld
                       HAVING count(*) >= (SELECT count(*) FROM row WHERE tbl=f.tbl))`;
  const 条件 = t.表 === "requested_partial" ? ` WHERE fld IN ${一部の条件}` : "";
  const 並び = rowidあり ? "rowid" : lite列.map((x) => '"' + x + '"').join(",");
  const sql = "SELECT " + (rowidあり ? "rowid AS _rowid, " : "")
    + lite列.map((x) => '"' + x + '"').join(",")
    + ' FROM "' + lite表 + '"' + 条件 + " ORDER BY " + 並び;

  let lite行 = 0;
  const liteRowid = crypto.createHash("sha256");
  const lite内容 = crypto.createHash("sha256");
  const 引く = t.表 === "requested_full"
    ? lite.prepare(`SELECT q.fld FROM requested q JOIN fld f ON f.id=q.fld GROUP BY q.fld
                    HAVING count(*) >= (SELECT count(*) FROM row WHERE tbl=f.tbl)
                    ORDER BY q.fld`)
    : lite.prepare(sql);
  for (const r of 引く.iterate()) {
    lite行++;
    if (rowidあり) liteRowid.update(String(r._rowid) + ",");
    lite内容.update(lite列.map((x) => 形(r[x])).join(区切り) + "\n");
  }

  /**
   * 並べ替えの照合順序を SQLite の BINARY に合わせる。
   * Postgres の既定は en_US.UTF-8 で、大小を無視して並べる（recA reca recB の順）。
   * SQLite は byte の順（recA recB reca）。揃えないと、中身が同じでも並びが違って
   * 「不一致」になる。COLLATE "C" が byte の順である。
   */
  const pg並び = rowidあり
    ? '"_rowid"'
    : 列.map((x) => '"' + x + '" COLLATE "C"').join(",");
  const pg行 = await c.query(
    "SELECT " + (rowidあり ? '"_rowid",' : "") + 列.map((x) => '"' + x + '"').join(",")
    + ' FROM "' + t.表 + '" ORDER BY ' + pg並び);
  const pgRowid = crypto.createHash("sha256");
  const pg内容 = crypto.createHash("sha256");
  for (const r of pg行.rows) {
    if (rowidあり) pgRowid.update(String(r._rowid) + ",");
    pg内容.update(列.map((x) => 形(r[x])).join(区切り) + "\n");
  }

  const 行OK = lite行 === pg行.rows.length;
  const rowidOK = !rowidあり || liteRowid.digest("hex") === pgRowid.digest("hex");
  const 内容OK = lite内容.digest("hex") === pg内容.digest("hex");
  if (!(行OK && rowidOK && 内容OK)) 悪い++;

  console.log(
    (行OK && rowidOK && 内容OK ? "○ " : "× ") + t.表.padEnd(18)
    + lite行.toLocaleString().padStart(11)
    + (rowidあり ? (rowidOK ? "    一致  " : "    x     ") : "    -     ")
    + (内容OK ? "一致" : "★不一致"));
}

console.log("-".repeat(62));
console.log(悪い === 0
  ? "すべて一致しました。移送は値も型も順序も保たれています。"
  : "★ " + 悪い + " 表で食い違いました。");
await c.end();
process.exit(悪い ? 1 : 0);
