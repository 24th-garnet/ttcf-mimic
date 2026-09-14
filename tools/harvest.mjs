#!/usr/bin/env node
/**
 * 取得済みの常駐スナップショットから **押せるリンクを収穫**して、比較の経路を広げる。
 *
 *   node tools/harvest.mjs 常駐            spec/compare/追加経路.json を作る
 *
 * ■ なぜ DB から組まないか
 *
 * `/doc/:種/:鍵` の鍵は `app/doc-*.mjs` の `一覧()` が組んでおり（app/ext/60-docs.mjs:37）、
 * `/artifact/:名` も画面側が組む。これを tools 側で作り直すと**二重実装になり、
 * ずれた瞬間に「比較していないのに比較したつもり」になる**。
 * 本文に出ている href をそのまま拾えば、利用者が押せるものと一致する。
 *
 * ■ 叩いてはいけないもの
 *
 * GET でも書き込みが走る経路が 6 本ある（tools/compare.mjs の頭に列挙）。
 * **既定で拒否し、通すものだけを名指しする。** 判断に迷うものは通さない。
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const 置き場 = path.join(ROOT, "spec", "compare");
const 名 = process.argv[2];
if (!名) { console.error("使い方: node tools/harvest.mjs <スナップショット名>"); process.exit(2); }

/** 書き込みが走る経路。**ここに当たったら必ず落とす。** */
const 書く経路 = [
  /^\/button\//,          // 10-buttons.mjs:636,638  GETで押す（addForeignRow 等が書く）
  /^\/fbtn\/csv/,         // 50-fieldbuttons.mjs:455
  /^\/fbtn\/act\//,       // 50-fieldbuttons.mjs:456
  /^\/do\/-\//,           // 50-fieldbuttons.mjs:458
  /^\/fbtn\/fld[A-Za-z0-9]+\//, // 50-fieldbuttons.mjs:459
];

/** 読み取りだと確かめた経路だけを通す（既定は拒否）。 */
const 通す経路 = [
  /^\/doc\/[^/]+\/.+$/,                         // 60-docs.mjs:50   組む() は読むだけ
  /^\/artifact\/[^/]+$/,                        // 40-dash.mjs:885  ファイルを返すだけ
  /^\/do\/(pag[A-Za-z0-9]+|[^-][^/]*)\/[^/]+$/, // serve.mjs:1450   GET は 動作の画面()。POST だけが押す
  /^\/detail-stats$/,                           // 30-detail.mjs:1232
  /^\/mform\/[^/]+\/tbl[A-Za-z0-9]+$/,          // serve.mjs:1420   GET は描くだけ
  /^\/cell\/pag[A-Za-z0-9]+\/pel[A-Za-z0-9]+\/rec[A-Za-z0-9]+$/, // 20-cells.mjs:441 GET は描くだけ
];

const 索引 = JSON.parse(fs.readFileSync(path.join(置き場, 名, "index.json"), "utf8"));
const 既に = new Set(索引.経路.map((x) => x.経路));

const 見つけた = new Map();   // 経路 → 出どころ（最初の1つ）
let 本文数 = 0;
for (const f of fs.readdirSync(path.join(置き場, 名)).filter((x) => x.endsWith(".txt"))) {
  const 体 = fs.readFileSync(path.join(置き場, 名, f), "utf8");
  if (!体.startsWith("<!doctype") && !体.startsWith("<!DOCTYPE") && !体.includes("<a ")) continue;
  本文数++;
  for (const m of 体.matchAll(/href="(\/[^"#]*)"/g)) {
    const u = m[1].replace(/&amp;/g, "&");
    if (!見つけた.has(u)) 見つけた.set(u, f);
  }
}

const 落とした = { 既出: 0, 書く: 0, 対象外: 0 };
const 追加 = [];
const 対象外の例 = new Map();
for (const u of 見つけた.keys()) {
  const 道 = u.split("?")[0];
  if (既に.has(u)) { 落とした.既出++; continue; }
  if (書く経路.some((r) => r.test(道))) { 落とした.書く++; continue; }
  if (!通す経路.some((r) => r.test(道))) {
    落とした.対象外++;
    const 頭 = "/" + (道.split("/")[1] ?? "");
    対象外の例.set(頭, (対象外の例.get(頭) ?? 0) + 1);
    continue;
  }
  追加.push(u);
}
追加.sort();

console.log(`${名}: 本文 ${本文数} 本から href ${見つけた.size} 種`);
console.log(`  既に取ってある      ${落とした.既出}`);
console.log(`  書き込みなので外す   ${落とした.書く}`);
console.log(`  通す規則に無い       ${落とした.対象外}`);
for (const [k, v] of [...対象外の例].sort((a, b) => b[1] - a[1])) console.log(`     ${k} ${v}`);
console.log(`\n追加する経路          ${追加.length}`);
const 内訳 = new Map();
for (const u of 追加) { const k = "/" + u.split("/")[1]; 内訳.set(k, (内訳.get(k) ?? 0) + 1); }
for (const [k, v] of [...内訳].sort((a, b) => b[1] - a[1])) console.log(`  ${k.padEnd(16)} ${v}`);

const 先 = path.join(置き場, "追加経路.json");
fs.writeFileSync(先, JSON.stringify({ 出どころ: 名, 作った: new Date().toISOString(), 経路: 追加 }, null, 1));
console.log(`\n書きました: spec/compare/追加経路.json`);
