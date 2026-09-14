#!/usr/bin/env node
/**
 * **書き込みを新旧に同じ順で当てて突き合わせる。** 計画の第3段 3-3。
 *
 *   node tools/write-compare.mjs --A http://127.0.0.1:18822 --B https://… --bypass <鍵>
 *
 * ■ 読み取りの比較だけでは足りない
 *
 * 2,822 経路の突き合わせは「同じ入力に同じ出力」を示すが、**書き込みは通っていない**。
 * Vercel 側にだけある仕掛け（要求の直列化・アドバイザリロック・効果ログ・取り込み）が
 * 結果を変えていないことは、実際に書いて確かめるしかない。
 *
 * ■ 何を比べるか
 *
 *   ① 応答の HTML        入力を弾く文言まで含めて同じか
 *   ② 書いた後の一覧     クエリエンジンを通した CSV。**計算列の追従もここに出る**
 *   ③ 書いた後の記録     write_log の action / origin
 *
 * ■ 決定的でないもの（ここだけ伏せる）
 *
 *   行ID       `db/write.mjs:251` の `"rec"+乱英数()`。両側で必ず違う → {{行}} に置く
 *   作成日時   `new Date().toISOString()` と、calc の作成日時の項目 → {{時刻}} に置く
 *   <style>    全応答に入る 130 行 → sha へ縮約（tools/compare.mjs と同じ規則）
 *
 * それ以外は一切正規化しない。
 *
 * ■ 後片付け
 *
 * A 側は `TTCF_DB` で複製を指して走らせる前提（正解の DB を汚さない）。
 * B 側（Supabase）は作った行・write_log・effect をこの道具が消して基準へ戻す。
 * **基準へ戻ったことを数えて示す。**
 */
import fs from "node:fs";
import crypto from "node:crypto";
import pg from "pg";
import { 読む, 宛先を確かめる } from "./pgenv.mjs";

const 引 = process.argv.slice(2);
const 取 = (k, 既定 = null) => (引.includes(k) ? 引[引.indexOf(k) + 1] : 既定);
const A = (取("--A") ?? "").replace(/\/$/, "");
const B = (取("--B") ?? "").replace(/\/$/, "");
const BYPASS = 取("--bypass");
if (!A || !B) { console.error("使い方: --A <URL> --B <URL> [--bypass <鍵>]"); process.exit(2); }

/** 試しに使う表: 販売/PDF生成指示。必須は 出力帳票・出荷日1・種類番号 */
const フォーム = "/form/pagcdcU1ALmkyh6Ov/pel8hCBb7s8skqCsq";
const 一覧CSV = "/csv/pag7jRGDTxdgM0uFy/pelcwicqb4tW5vpbS";
const 表ID = "tbldhtCdQkTBw4HGi";

/** 当てる操作。**両側に同じ順で当てる。** */
const 手順 = [
  { 名: "① 一覧を読む（当てる前）", 道: 一覧CSV },
  { 名: "② 必須を欠いて作る（弾かれるはず）", 道: フォーム, 方: "POST",
    値: { fldHSoXbqcbeygxPt: "2026-09-14" } },
  { 名: "③ 正しく作る", 道: フォーム, 方: "POST",
    値: { fldHSoXbqcbeygxPt: "2026-09-14", fldRr8ojzWUnZob2S: "4", fldDr9mQT2OfefgPQ: "出荷明細書" },
    行を覚える: true },
  { 名: "④ 一覧を読む（作った後）", 道: 一覧CSV },
  { 名: "⑤ もう 1 件作る（採番が進むか）", 道: フォーム, 方: "POST",
    値: { fldHSoXbqcbeygxPt: "2026-10-01", fldRr8ojzWUnZob2S: "6", fldDr9mQT2OfefgPQ: "納品書・受領書" },
    行を覚える: true },
  { 名: "⑥ 一覧を読む（2 件目の後）", 道: 一覧CSV },
  { 名: "⑦ 帳票の一覧を読む", 道: "/docs" },
];

const 頭 = (base) => (base === B && BYPASS ? { "x-vercel-protection-bypass": BYPASS } : {});

async function 当てる(base, 名札) {
  const 出 = [];
  const 行たち = [];
  for (const s of 手順) {
    const o = { headers: { ...頭(base) }, signal: AbortSignal.timeout(300_000) };
    if (s.方 === "POST") {
      o.method = "POST";
      o.headers["content-type"] = "application/x-www-form-urlencoded";
      o.body = new URLSearchParams(s.値).toString();
    }
    const r = await fetch(base + s.道, o);
    const 体 = await r.text();
    if (s.行を覚える) {
      const m = 体.match(/rec[A-Za-z0-9]{14}/);
      if (m) 行たち.push(m[0]);
    }
    出.push({ 名: s.名, code: r.status, 体 });
    console.log(`  ${名札} ${s.名}  ${r.status}  ${Buffer.byteLength(体)}B`);
  }
  return { 出, 行たち };
}

/** 決定的でない 3 つだけを伏せる */
function 均す(体, 行たち) {
  let s = 体;
  s = s.replace(/<style>([\s\S]*?)<\/style>/g,
    (_, 中) => `<style>{{sha:${crypto.createHash("sha256").update(中).digest("hex").slice(0, 8)}}}</style>`);
  行たち.forEach((r, i) => { s = s.split(r).join(`{{行${i + 1}}}`); });
  /** 行IDは応答のどこにでも出る。覚えた以外のものも伏せる（作った行は両側で必ず違う） */
  s = s.replace(/\b\d{4}-\d{2}-\d{2}[ T]\d{2}:\d{2}(:\d{2}(\.\d+)?Z?)?/g, "{{時刻}}");
  return s;
}

console.log(`A（正解）  ${A}`);
console.log(`B（移植後）${B}\n`);

console.log("── A に当てる ──");
const a = await 当てる(A, "A");
console.log("\n── B に当てる ──");
const b = await 当てる(B, "B");

console.log("\n── 突き合わせ ──");
let 同 = 0; const 違 = [];
for (let i = 0; i < 手順.length; i++) {
  const x = 均す(a.出[i].体, a.行たち), y = 均す(b.出[i].体, b.行たち);
  const 同じ = a.出[i].code === b.出[i].code && x === y;
  if (同じ) { 同++; console.log(`  ○ ${手順[i].名}`); }
  else {
    違.push(i);
    console.log(`  ★ ${手順[i].名}  A=${a.出[i].code} ${Buffer.byteLength(a.出[i].体)}B  B=${b.出[i].code} ${Buffer.byteLength(b.出[i].体)}B`);
    fs.writeFileSync(`/tmp/wc-${i}-A.txt`, x); fs.writeFileSync(`/tmp/wc-${i}-B.txt`, y);
    console.log(`     diff /tmp/wc-${i}-A.txt /tmp/wc-${i}-B.txt`);
  }
}
console.log(`\n一致 ${同} / ${手順.length}　不一致 ${違.length}`);
console.log(`A の作った行: ${a.行たち.join(" ")}`);
console.log(`B の作った行: ${b.行たち.join(" ")}`);

/* ── B 側（Supabase）を基準へ戻す ── */
console.log("\n── Supabase を基準へ戻す ──");
const v = 読む(["SUPABASE_SESSION_URL"]);
宛先を確かめる(v.SUPABASE_SESSION_URL);
const c = new pg.Client({ connectionString: v.SUPABASE_SESSION_URL, connectionTimeoutMillis: 20_000 });
await c.connect();
const 数 = async (q, ...p) => Number((await c.query(q, p)).rows[0].n);
if (b.行たち.length) {
  await c.query("delete from link where src_row = any($1) or dst_row = any($1)", [b.行たち]);
  await c.query("delete from rec_row where id = any($1)", [b.行たち]);
  await c.query("delete from write_log where row_id = any($1)", [b.行たち]);
}
await c.query("delete from effect");
/** カウンタは手元の正解へ戻す（autoNumber を消費していたら進んだままになる） */
const { DatabaseSync } = await import("node:sqlite");
const 元 = new DatabaseSync(process.env.TTCF_正解 || "data/ttcf.db", { readOnly: true });
let 戻した = 0;
for (const r of 元.prepare("SELECT fld,next FROM counter").all()) {
  const 今 = Number((await c.query("select next from counter where fld=$1", [r.fld])).rows[0]?.next ?? r.next);
  if (今 !== Number(r.next)) { await c.query("update counter set next=$2 where fld=$1", [r.fld, r.next]); 戻した++; }
}
console.log(`  rec_row   ${await 数("select count(*) n from rec_row")}  （期待 ${元.prepare("SELECT count(*) n FROM row").get().n}）`);
console.log(`  write_log ${await 数("select count(*) n from write_log")}  （期待 ${元.prepare("SELECT count(*) n FROM write_log").get().n}）`);
console.log(`  link      ${await 数("select count(*) n from link")}  （期待 ${元.prepare("SELECT count(*) n FROM link").get().n}）`);
console.log(`  effect    ${await 数("select count(*) n from effect")}  （期待 0）`);
console.log(`  counter を戻した ${戻した} 件`);
await c.end();

process.exit(違.length ? 1 : 0);
