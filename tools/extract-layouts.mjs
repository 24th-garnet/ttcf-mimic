#!/usr/bin/env node
/**
 * 生レイアウト（crawl/out/raw の msgpack 812MB）から、**実行時に読む分だけ**を取り出す。
 *
 *   node tools/extract-layouts.mjs            spec/published-layout.json を作る
 *   node tools/extract-layouts.mjs --確かめる   衝突が無いかだけ見る（書かない）
 *
 * ■ なぜ要るか
 *
 * app/ext/20-cells.mjs:59・30-detail.mjs:86・40-dash.mjs:68 が
 * crawl/out/raw/pages-20260911/<pid>.msgpack を実行時に読んでいる。
 * これは Vercel のバンドル（250MB 上限）に載らない。
 *
 * だが**読んでいるのは pg.publishedLayout だけ**で、335 画面ぶん全部で 2.2MB しかない
 * （元の 0.28%）。これを 1 つの JSON にすれば依存が消える。
 *
 * ■ 先に潰すべき罠
 *
 * 1 つの msgpack に最大 36 画面ぶんのレイアウトが入っており、実行時は
 * **先に開いたファイルが勝つ**（`!生の頁.has(pg.id)` の先着勝ち）。
 * つまり現状は「どの画面から先に見たか」でレイアウトが変わりうる。
 *
 * 抽出で固定するのは良いが、**固定した結果が常駐版と違えば比較が壊れる**。
 * だから「同じ画面 ID で中身が食い違う組」を数え、**0 件であること**を確かめる。
 * 0 件なら順序依存は理屈の上だけのもので、固定しても常駐版と一致する。
 *
 * ■ 読む順序
 *
 * 実行時と同じにする。app/ext/30-detail.mjs:87 は
 *   [生の断面, 補いの断面].map(...).find(存在するもの)
 * の順で探すので、pages-20260911 を先、pages-20260912-layout を後にする。
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { decodeAirFile } from "../crawl/lib/airmsg.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const 確かめるだけ = process.argv.includes("--確かめる");

/** app/ext/*.mjs が見ている断面と同じ順 */
const 断面 = ["pages-20260911", "pages-20260912-layout"];

const 頁 = new Map();          // pid → publishedLayout（先着勝ち。実行時と同じ規則）
const 衝突 = [];               // 同じ pid で中身が違ったもの
let ファイル = 0, 元バイト = 0;

for (const d of 断面) {
  const dir = path.join(ROOT, "crawl", "out", "raw", d);
  if (!fs.existsSync(dir)) { console.log(`（${d} が無いので飛ばします）`); continue; }
  for (const f of fs.readdirSync(dir).filter((x) => x.endsWith(".msgpack")).sort()) {
    const p = path.join(dir, f);
    ファイル++; 元バイト += fs.statSync(p).size;
    let pages;
    try { pages = decodeAirFile(p)?.top?.data?.pages ?? []; }
    catch (e) { console.error(`× ${f} を読めません: ${e.message}`); continue; }
    for (const pg of pages) {
      if (!pg?.id || !pg.publishedLayout) continue;
      const s = JSON.stringify(pg.publishedLayout);
      const 既 = 頁.get(pg.id);
      if (既 === undefined) 頁.set(pg.id, s);
      else if (既 !== s) 衝突.push({ 画面: pg.id, 先: 既.length, 後: s.length, ファイル: `${d}/${f}` });
    }
  }
}

const mb = (b) => (b / 1024 / 1024).toFixed(1) + "MB";
const 合計 = [...頁.values()].reduce((a, s) => a + Buffer.byteLength(s, "utf8"), 0);

console.log(`読んだ msgpack        ${ファイル} 本 / ${mb(元バイト)}`);
console.log(`publishedLayout       ${頁.size} 画面 / ${mb(合計)}`);
console.log(`元に対して            ${((合計 / 元バイト) * 100).toFixed(2)}%`);

// DB が持つ「レイアウトのある画面」と突き合わせる。取りこぼしは静かに壊れる原因になる。
try {
  const { DatabaseSync } = await import("node:sqlite");
  const db = new DatabaseSync(path.join(ROOT, "data", "ttcf.db"), { readOnly: true });
  const 要る = db.prepare("SELECT id FROM page WHERE has_layout=1").all().map((r) => r.id);
  const 無い = 要る.filter((id) => !頁.has(id));
  console.log(`has_layout=1 の画面    ${要る.length} 本 / 取れなかった ${無い.length} 本`);
  if (無い.length) console.log(`  ${無い.slice(0, 10).join(" ")}`);
} catch { console.log("（data/ttcf.db が無いので画面の照合は飛ばします）"); }

console.log(`\n衝突（同じ画面で中身が違う）  ${衝突.length} 件`);
for (const c of 衝突.slice(0, 5)) console.log(`  ${c.画面}  ${c.先} → ${c.後}  ${c.ファイル}`);

if (衝突.length) {
  console.error("\n★ 衝突があります。先に開いたファイルが勝つ規則なので、");
  console.error("  固定した結果が常駐版と食い違う恐れがあります。中身を確かめてください。");
  process.exit(1);
}

if (確かめるだけ) { console.log("\n衝突なし。--確かめる なので書きません。"); process.exit(0); }

const 先 = path.join(ROOT, "spec", "published-layout.json");
fs.writeFileSync(先, "{" + [...頁.entries()].map(([k, v]) => JSON.stringify(k) + ":" + v).join(",") + "}");
console.log(`\n書きました: ${先}  ${mb(fs.statSync(先).size)}`);
