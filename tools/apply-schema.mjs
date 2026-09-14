#!/usr/bin/env node
/**
 * db/pg/001_schema.sql を Supabase に当てる。
 *
 *   node tools/apply-schema.mjs           当てる（既に表があれば何もしない）
 *   node tools/apply-schema.mjs --作り直す  落としてから当てる
 *
 * セッション用の接続（5432）を使う。DDL はトランザクションで包む。
 */
import fs from "node:fs";
import path from "node:path";
import pg from "pg";
import { ROOT, 読む, 宛先を確かめる } from "./pgenv.mjs";

const 作り直す = process.argv.includes("--作り直す");
const { SUPABASE_SESSION_URL: url } = 読む(["SUPABASE_SESSION_URL"]);
const 宛 = 宛先を確かめる(url);
console.log(`宛先: ${宛.ホスト}:${宛.ポート}`);

const c = new pg.Client({ connectionString: url, application_name: "ttcf-apply-schema" });
await c.connect();

const 表がある = (await c.query(
  `SELECT count(*)::int n FROM information_schema.tables WHERE table_schema='public'`)).rows[0].n;
console.log(`いま public にある表: ${表がある}`);

if (表がある && !作り直す) {
  console.log("既に表があります。作り直すなら --作り直す を付けてください。");
  await c.end(); process.exit(0);
}

const sql = fs.readFileSync(path.join(ROOT, "db", "pg", "001_schema.sql"), "utf8");
try {
  await c.query("BEGIN");
  if (作り直す) {
    console.log("public を作り直します…");
    await c.query("DROP SCHEMA public CASCADE; CREATE SCHEMA public;");
  }
  await c.query(sql);
  await c.query("COMMIT");
  console.log("当てました。");
} catch (e) {
  await c.query("ROLLBACK").catch(() => {});
  console.error("× 失敗:", e.message);
  if (e.position) console.error("  位置:", e.position, "付近:", sql.slice(Math.max(0, e.position - 120), Number(e.position) + 80).replace(/\n/g, " "));
  await c.end(); process.exit(1);
}

const 表 = (await c.query(
  `SELECT table_name FROM information_schema.tables WHERE table_schema='public' ORDER BY table_name`)).rows;
console.log(`\npublic の表 ${表.length} 本:`);
console.log("  " + 表.map((r) => r.table_name).join(" "));
await c.end();
