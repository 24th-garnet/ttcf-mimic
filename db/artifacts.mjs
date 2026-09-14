/**
 * 帳票の実物（`crawl/out/artifacts` 1,057件・127MB）の**読み口**。
 *
 *   import { 一覧, 引く } from "../../db/artifacts.mjs";
 *   const 名たち = 一覧(ROOT);              // 同期。名前だけ
 *   const r = await 引く(ROOT, 名);          // {ctype, bytes, body} か null
 *
 * ■ なぜ名前と中身を分けるか
 *
 * `app/ext/40-dash.mjs` は 2 通りの使い方をする。
 *
 *   実物を探す()  … 名前の一覧を舐めて `__<行ID>__` で当てる（726行・747行）。**同期**で要る
 *   /artifact/:名 … 中身をそのまま返す（885行）
 *
 * 名前だけなら 1,057 件で 120KB しかないので起動時に載せる。
 * 中身は 127MB あるので**叩かれたときにその都度引く**。コールドスタートを 127MB ぶん
 * 重くするのは割に合わない（実物を開くのは稀で、画面の描画には要らない）。
 *
 * ■ 常駐版はファイルのまま
 *
 * 何も預けられていなければ `crawl/out/artifacts` を読む。
 * **常駐版が比較の正解**なので、そちらの振る舞いを変えない。
 */
import fs from "node:fs";
import path from "node:path";
import pg from "pg";

let 名たち = null;        // Supabase から預かった名前
let 接続文字列 = null;
let 池 = null;

/** 起動時に一度だけ。`db/hydrate.mjs` が呼ぶ。 */
export function 預ける(名の配列, url) { 名たち = 名の配列; 接続文字列 = url; }

const 置き場 = (ROOT) => path.join(ROOT, "crawl", "out", "artifacts");

/** 実物の名前。**同期**。常駐版の `fs.readdirSync` と同じ並び（名前順）。 */
export function 一覧(ROOT) {
  if (名たち) return 名たち;
  try { return fs.readdirSync(置き場(ROOT)); } catch { return []; }
}

const 種類 = {
  ".pdf": "application/pdf", ".png": "image/png", ".jpg": "image/jpeg", ".jpeg": "image/jpeg",
  ".gif": "image/gif", ".webp": "image/webp", ".svg": "image/svg+xml",
};

/**
 * 1 件の中身。無ければ null。
 * **必ず Promise を返す**（置き先で同期・非同期が変わると呼ぶ側が 2 通りになるため）。
 */
export async function 引く(ROOT, 名) {
  if (!名たち) {
    const p = path.join(置き場(ROOT), 名);
    if (!p.startsWith(置き場(ROOT) + path.sep) || !fs.existsSync(p) || !fs.statSync(p).isFile()) return null;
    return { ctype: 種類[path.extname(名).toLowerCase()] ?? "application/octet-stream",
             bytes: fs.statSync(p).size, body: fs.readFileSync(p) };
  }
  /** 預かっている名前にしか答えない（置き場の外を見ないのと同じ意味） */
  if (!名たち.includes(名)) return null;
  池 ??= new pg.Pool({ connectionString: 接続文字列, max: 2, connectionTimeoutMillis: 15_000, idleTimeoutMillis: 30_000 });
  const r = await 池.query("select ctype, bytes, body from artifact where name = $1", [名]);
  if (!r.rows.length) return null;
  const x = r.rows[0];
  return { ctype: x.ctype, bytes: Number(x.bytes), body: x.body };
}

/** 何件持っているか（診断用）。 */
export const 実物の数 = (ROOT) => 一覧(ROOT).length;
