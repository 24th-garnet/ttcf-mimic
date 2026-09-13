/**
 * ローカルDBを開く。無ければ作る。
 *
 *   import { open, ROOT } from "./db/open.mjs";
 *   const db = open();                    data/ttcf.db を開く
 *   const db = open({ file: ":memory:" }); 試験用
 *   const db = open({ fresh: true });      作り直す
 *
 * ■ node:sqlite を使う理由
 *
 * Node 22 に入っている（`--experimental-sqlite` は 22.5 以降なら不要）。
 * ネイティブのビルドが要らないので、環境の差で詰まらない。
 * 速さも足りている（実測: 20万行の投入703ms、生成列＋索引の絞り込み0ms）。
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { DatabaseSync } from "node:sqlite";

export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
export const SPEC = path.join(ROOT, "spec");
export const DATA = path.join(ROOT, "data");
export const DB_FILE = path.join(DATA, "ttcf.db");

export function open({ file = DB_FILE, fresh = false } = {}) {
  if (file !== ":memory:") {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    if (fresh) for (const suffix of ["", "-wal", "-shm"]) {
      try { fs.unlinkSync(file + suffix); } catch { /* 無ければよい */ }
    }
  }
  const db = new DatabaseSync(file);
  db.exec(fs.readFileSync(path.join(ROOT, "db", "schema.sql"), "utf8"));
  /**
   * 既にある DB に後から足した列を補う。
   * `CREATE TABLE IF NOT EXISTS` は既存の表に列を足さないので、ここで当てる。
   */
  for (const [表, 列, 定義] of [["row", "snap", "TEXT NOT NULL DEFAULT '{}'"], ["row", "implied", "TEXT NOT NULL DEFAULT '{}'"]]) {
    const ある = db.prepare(`SELECT count(*) n FROM pragma_table_info(?) WHERE name=?`).get(表, 列).n;
    if (!ある) db.exec(`ALTER TABLE ${表} ADD COLUMN ${列} ${定義}`);
  }
  return db;
}

/** spec/ の JSON を読む。無ければ null（どこで止まったか分かるように） */
export function spec(name) {
  const p = path.join(SPEC, name);
  if (!fs.existsSync(p)) return null;
  return JSON.parse(fs.readFileSync(p, "utf8"));
}

/** 取り込みの記録。あとで「この数字はどこから来たのか」を辿れるようにする */
export function log(db, what, n, note = null) {
  db.prepare("INSERT INTO load_log(at,what,n,note) VALUES(?,?,?,?)")
    .run(new Date().toISOString(), what, n ?? null, note);
}

/**
 * まとめて入れる。1件ずつの run は遅いので必ずトランザクションで囲む
 * （囲まないと20万行で数十秒かかる）。
 */
export function bulk(db, sql, rows) {
  const st = db.prepare(sql);
  db.exec("BEGIN");
  try { for (const r of rows) st.run(...r); db.exec("COMMIT"); }
  catch (e) { db.exec("ROLLBACK"); throw e; }
  return rows.length;
}

export const J = (v) => (v == null ? null : JSON.stringify(v));
