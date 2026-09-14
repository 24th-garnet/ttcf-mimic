/**
 * Supabase から読んで、**インメモリの SQLite** を組む。
 *
 *   import { 用意する } from "./db/hydrate.mjs";
 *   const db = await 用意する();      // DatabaseSync（:memory:）が返る
 *
 * ■ なぜこの形にするか
 *
 * ミミックの値打ちは「現行 Airtable と同じに動くこと」だけで、移植でそれが 1 つでも欠ければ
 * 意味が無くなる。だから **db/query.mjs・calc.mjs・write.mjs・actions.mjs・app/ を
 * 一行も変えない**。器だけを差し替える。
 *
 * クエリエンジンは SQLite の上で動く前提で書かれている（5 層のフォールバック・3 値論理・
 * `Intl.Collator("ja",{numeric:true})` の自然順・`ORDER BY rowid` 9 箇所）。これを SQL に
 * 書き直すと、そこが漏れの出どころになる。書き直さないのが一番安全である。
 *
 * Postgres は「記録の本体」と「インスタンス間の複製ログ」の 2 役だけを負う。
 * **絞り込みも並びも Postgres には一切やらせない。**
 *
 * ■ 実測（手元 → :memory:、2026-09-13）
 *
 *   移送 13.5 秒（読み 5.9 ＋ 投入 7.6）＋ 作る() 8.6 秒 ＝ 22.0 秒
 *   最大 RSS 2,712MB（Vercel Pro の 4,096MB に対して 66%）
 *
 * ■ 気をつけること
 *
 *   rowid を明示で入れる。`ORDER BY rowid` が 9 箇所あり、順序は機能である
 *   （app/doc-mfg.mjs:235 の仕掛品の並びは実物 8 品と 8/8 一致している）。
 */
import fs from "node:fs";
import path from "node:path";
import readline from "node:readline";
import { fileURLToPath } from "node:url";
import { DatabaseSync } from "node:sqlite";
import pg from "pg";
import { to as copyTo } from "pg-copy-streams";
import { 表の対応, 列を戻す, インメモリ用のスキーマ } from "./pg/mapping.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

/** pg は int8 を文字列で返す。SQLite 側は integer なので数に直す。 */
pg.types.setTypeParser(20, (v) => (v === null ? null : Number(v)));

/** COPY text 形式の 1 欄を戻す。書き出し側（tools/export-to-pg.mjs）の逃がし方と対。 */
function 戻す(s) {
  if (s === "\\N") return null;
  if (!s.includes("\\")) return s;
  let out = "";
  for (let i = 0; i < s.length; i++) {
    if (s[i] !== "\\") { out += s[i]; continue; }
    const c = s[++i];
    out += c === "t" ? "\t" : c === "n" ? "\n" : c === "r" ? "\r" : c === "\\" ? "\\" : c;
  }
  return out;
}

/** 数として入れるべき列。SQLite は型が緩いので、明示しないと全部 text になる。 */
const 数の列 = {
  tbl: ["hidden", "synced", "ord"],
  fld: ["is_primary", "is_computed", "ord", "synced", "writable", "from_page"],
  calc_order: ["seq"],
  page: ["in_nav", "has_layout"],          // ord は fractional index の文字列なので入れない
  bundle: [],                               // ord は同上
  elem: ["depth", "read_only"],
  form: ["is_child"],
  link: ["ord"],
  attach: ["bytes"],
  csv_row: ["seq"],
  csv_file: ["行", "列", "一致列"],
  counter: ["next"],
  write_log: ["seq"],
  load_log: ["seq", "n"],
};

export async function 用意する({ url = process.env.SUPABASE_SESSION_URL, 知らせる = console.log } = {}) {
  if (!url) throw new Error("SUPABASE_SESSION_URL がありません");
  const T0 = Date.now();

  const db = new DatabaseSync(":memory:");
  db.exec(インメモリ用のスキーマ(fs.readFileSync(path.join(ROOT, "db", "schema.sql"), "utf8")));

  /**
   * 繋ぐのを数回試す。Vercel の 1 回目で EAUTHTIMEOUT を踏んだことがある（手元からは
   * 71〜185ms で繋がるので、置き先側の一時的なもの）。**1 回の失敗でコールドスタートを
   * 落とすと、そのインスタンスは作り直されるまで使えない。**
   */
  let c = null;
  for (let 試み = 1; ; 試み++) {
    c = new pg.Client({
      connectionString: url, application_name: "ttcf-hydrate",
      statement_timeout: 0, query_timeout: 0, keepAlive: true,
      connectionTimeoutMillis: 20_000,
    });
    try { await c.connect(); break; }
    catch (e) {
      try { await c.end(); } catch { /* もう閉じている */ }
      if (試み >= 4) throw e;
      知らせる(`  繋げませんでした（${e.code ?? e.message}）。${試み * 3}秒おいて試みます`);
      await new Promise((r) => setTimeout(r, 試み * 3000));
    }
  }

  let 合計 = 0;
  const 表たち = [
    ...表の対応,
    { pg: "requested_partial", lite: "requested_partial", 列名: { row: "row_id" }, rowidなし: true },
    { pg: "requested_full", lite: "requested_full", rowidなし: true },
  ];

  for (const t of 表たち) {
    // Postgres 側の列の並びをそのまま使う（_rowid が先頭に来る）
    const 列 = (await c.query(
      `SELECT column_name FROM information_schema.columns
       WHERE table_schema='public' AND table_name=$1 ORDER BY ordinal_position`, [t.pg]
    )).rows.map((r) => r.column_name)
      // 複製ログ用に Postgres 側にだけ足した列は、インメモリ側に無いので外す
      .filter((x) => !(t.pg === "write_log" && (x === "effect" || x === "batch")));

    const 戻し = 列を戻す(t);
    const lite列 = 列.filter((x) => x !== "_rowid").map(戻し);
    const 数 = new Set(数の列[t.lite] ?? []);

    const 置く = db.prepare(
      `INSERT INTO "${t.lite}" (${t.rowidなし ? "" : "rowid,"}${lite列.map((x) => `"${x}"`).join(",")})
       VALUES (${t.rowidなし ? "" : "?,"}${lite列.map(() => "?").join(",")})`);

    const 流し = c.query(copyTo(
      `COPY (SELECT ${列.map((x) => `"${x}"`).join(",")} FROM "${t.pg}"${t.rowidなし ? "" : ' ORDER BY "_rowid"'})
       TO STDOUT WITH (FORMAT text)`));
    const rl = readline.createInterface({ input: 流し, crlfDelay: Infinity });

    let n = 0;
    db.exec("BEGIN");
    for await (const 行 of rl) {
      if (行 === "") continue;
      const 欄 = 行.split("\t");
      const 値 = [];
      let i = 0;
      if (!t.rowidなし) 値.push(Number(戻す(欄[i++])));
      for (const c2 of lite列) {
        const v = 戻す(欄[i++]);
        値.push(v !== null && 数.has(c2) ? Number(v) : v);
      }
      置く.run(...値);
      n++;
    }
    db.exec("COMMIT");
    合計 += n;
    知らせる(`  ${t.lite.padEnd(18)} ${n.toLocaleString().padStart(10)} 行`);
  }

  await c.end();
  知らせる(`移送 ${合計.toLocaleString()} 行 / ${((Date.now() - T0) / 1000).toFixed(1)}秒`);
  return db;
}
