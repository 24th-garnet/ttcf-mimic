#!/usr/bin/env node
/**
 * db/hydrate.mjs を手元で試す。**Vercel に上げる前に、ここで確かめる。**
 *
 *   node tools/try-hydrate.mjs
 *
 * Supabase から組んだインメモリ DB と、元の data/ttcf.db で同じクエリエンジンを動かし、
 * 全表の行集合と並びをハッシュで突き合わせる。
 *
 * 絞り込みの無いクエリだけでは足りない。`要求された()` が一度も効かず、
 * requested の畳み方の誤りを見逃すためである（一度それで見落とした）。
 * だから **絞り込み付きのクエリと、並べ替え付きのクエリも混ぜる**。
 */
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { DatabaseSync } from "node:sqlite";
import { ROOT, 読む, 宛先を確かめる } from "./pgenv.mjs";
import { 用意する } from "../db/hydrate.mjs";

const { SUPABASE_SESSION_URL: url } = 読む(["SUPABASE_SESSION_URL"]);
const 宛 = 宛先を確かめる(url);
console.log(`宛先: ${宛.ホスト}:${宛.ポート}\n`);

const mb = () => Math.round(process.memoryUsage().rss / 1024 / 1024) + "MB";

console.log("Supabase から組む…");
const T0 = Date.now();
const mem = await 用意する({ url });
console.log(`  RSS ${mb()}\n`);

const { 作る } = await import("../db/query.mjs");

console.log("クエリエンジンを起こす…");
const t1 = Date.now();
const 実行A = 作る(mem);
console.log(`  Supabase 版 ${((Date.now() - t1) / 1000).toFixed(1)}秒  RSS ${mb()}`);

const 元 = new DatabaseSync(path.join(ROOT, "data", "ttcf.db"), { readOnly: true });
const t2 = Date.now();
const 実行B = 作る(元);
console.log(`  手元の元  ${((Date.now() - t2) / 1000).toFixed(1)}秒  RSS ${mb()}\n`);

/** requested の畳み方が効いているかを、まず名指しで見る */
const 集計 = (db) => {
  const rows = db.prepare(`
    SELECT q.fld, count(*) n, (SELECT count(*) FROM row WHERE tbl=f.tbl) 表の行数
    FROM requested q JOIN fld f ON f.id=q.fld GROUP BY q.fld`).all();
  const 全行 = rows.filter((x) => x.n >= x.表の行数).length;
  return { 全行, 一部: rows.length - 全行 };
};
const a = 集計(mem), b = 集計(元);
console.log(`requested の判定   Supabase版 全行${a.全行}/一部${a.一部}   元 全行${b.全行}/一部${b.一部}   ` +
  (a.全行 === b.全行 && a.一部 === b.一部 ? "一致" : "★不一致"));

const h = (s) => crypto.createHash("sha256").update(s).digest("hex").slice(0, 16);
const 表たち = 元.prepare("SELECT id,name FROM tbl ORDER BY id").all();
const 項目 = (tid) => 元.prepare("SELECT id,type FROM fld WHERE tbl=? ORDER BY id").all(tid);

const 試す = [];
for (const t of 表たち) 試す.push({ 名: `全行 ${t.name}`, spec: { source: { type: "table", tableId: t.id }, filters: null, sorts: [] } });

// 並べ替え付き（自然順が効く）
for (const t of 表たち.slice(0, 12)) {
  const f = 項目(t.id).find((x) => x.type === "text");
  if (f) 試す.push({ 名: `並び ${t.name}`, spec: { source: { type: "table", tableId: t.id }, filters: null, sorts: [{ fieldId: f.id, direction: "asc" }] } });
}
// 絞り込み付き（要求された() と 3 値論理が効く）
for (const t of 表たち) {
  for (const f of 項目(t.id).slice(0, 3)) {
    試す.push({
      名: `絞り ${t.name}.${f.id}`,
      spec: {
        source: { type: "table", tableId: t.id },
        filters: { conjunction: "and", filterSet: [{ fieldId: f.id, operator: "isNotEmpty", value: null }] },
        sorts: [],
      },
    });
  }
}

console.log(`\n${試す.length} 本のクエリを突き合わせます…`);
let 違い = 0;
const 例 = [];
for (const q of 試す) {
  const rA = 実行A(q.spec), rB = 実行B(q.spec);
  const kA = [rA.母数, rA.行.length, rA.怪しい.length, h(rA.行.join(",")), h(rA.怪しい.join(","))].join("|");
  const kB = [rB.母数, rB.行.length, rB.怪しい.length, h(rB.行.join(",")), h(rB.怪しい.join(","))].join("|");
  if (kA !== kB) { 違い++; if (例.length < 5) 例.push(`  ${q.名}\n    Supabase版 ${kA}\n    元         ${kB}`); }
}
console.log(違い === 0
  ? `全 ${試す.length} 本が一致しました。`
  : `★ ${違い} / ${試す.length} 本で食い違いました。\n${例.join("\n")}`);
console.log(`\n最大 RSS ${mb()}  （Vercel Pro の 4,096MB に対して ${Math.round(process.memoryUsage().rss / 1024 / 1024 / 4096 * 100)}%）`);
process.exit(違い ? 1 : 0);
