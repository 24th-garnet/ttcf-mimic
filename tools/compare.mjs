#!/usr/bin/env node
/**
 * 2 つの置き先を全経路で突き合わせる。**移植で漏れが出ていないことを機械で示す。**
 *
 *   node tools/compare.mjs --取る 常駐 --base http://127.0.0.1:8787
 *   node tools/compare.mjs --取る vercel --base https://… --bypass <32文字>
 *   node tools/compare.mjs --比べる 常駐 vercel
 *
 * ■ 生のバイトを比べる
 *
 * 正解は移植前の常駐版。同じコードが同じデータを読むのだから、**出力は 1 バイトも
 * 違わないはず**である。正規化は「本当に非決定な 3 つ」だけに限る。
 * 増やすほど漏れを見逃すので、足すときは必ず理由を書くこと。
 *
 *   起動時刻      app/ext/20-cells.mjs:91 と 30-detail.mjs:74 の `起動`。
 *                 HTML には出ないが、write_log の絞り込みに使う。
 *                 **書き込み 0 件の状態で読み取りを回せば値に依らず同じ**になるので、
 *                 正規化ではなく「書き込みをしない」ことで決定化する。ここでは触らない。
 *   /detail-stats の ms   自己計測。JSON の ms だけ伏せる。経路ごと外さない
 *   <style> の CSS        全応答に 130 行が同じ形で入る。**消さずに sha へ縮約**する。
 *                         消すと CSS の劣化が見えなくなる。sha が違えば即不一致
 *
 * 汎用の空白潰し・タグ除去・属性ソート・**配列ソートは入れない**。
 * 順序の壊れ（ORDER BY rowid の消失）こそ検出したいものだからである。
 *
 * ■ 副作用のある GET は叩かない
 *
 * method 指定が無く GET でも書き込みが走る経路が 6 本ある
 * （/button/:pag/:pel, /button/:pag/:pel/form, /fbtn/csv, /fbtn/act/:鍵,
 *   /do/-/:鍵, /fbtn/:fld/:rec）。読み取りの比較に入れると基準を汚す。
 */
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { DatabaseSync } from "node:sqlite";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const 置き場 = path.join(ROOT, "spec", "compare");
const 引数 = process.argv.slice(2);
const 取る = 引数.includes("--取る") ? 引数[引数.indexOf("--取る") + 1] : null;
/** 既に取ってあるスナップショットに、spec/compare/追加経路.json のぶんだけを**足す**。
 *  同じコード・同じ置き先から取り足すときにだけ使う。取り直しを避けるためのもので、
 *  古い断面と新しい断面を混ぜると比較が嘘になる。混ざっていないことは呼ぶ側の責任。 */
const 足す = 引数.includes("--足す") ? 引数[引数.indexOf("--足す") + 1] : null;
const 比べる = 引数.includes("--比べる");
const BASE = (引数.includes("--base") ? 引数[引数.indexOf("--base") + 1] : "").replace(/\/$/, "");
const BYPASS = 引数.includes("--bypass") ? 引数[引数.indexOf("--bypass") + 1] : null;
const 並列 = Number(process.env.並列 ?? 4);

/** 叩く経路を DB から機械的に組む。画面だけでは足りない（/gates の 500 が長く見つからなかった）。 */
function 経路たち() {
  const db = new DatabaseSync(path.join(ROOT, "data", "ttcf.db"), { readOnly: true });
  const 出 = ["/", "/gates", "/actions", "/forms", "/docs", "/docs/native", "/fbtn", "/ui.js"];
  for (const b of db.prepare("SELECT tab FROM base ORDER BY rowid").all()) 出.push(`/?base=${encodeURIComponent(b.tab)}`);
  for (const p of db.prepare("SELECT id FROM page WHERE has_layout=1 ORDER BY rowid").all()) {
    出.push(`/p/${p.id}`);
    出.push(`/print/${p.id}`);
  }
  // 一覧の要素は CSV も出せる
  for (const e of db.prepare(
    "SELECT page,id FROM elem WHERE type IN ('levels','grid') ORDER BY rowid").all()) {
    出.push(`/csv/${e.page}/${e.id}`);
  }
  // 門は rule から
  for (const r of db.prepare("SELECT fld FROM rule ORDER BY rowid").all()) 出.push(`/gate/${r.fld}`);
  // 行を選ぶ画面
  for (const e of db.prepare("SELECT page,id FROM elem WHERE type='rowSelector' ORDER BY rowid").all()) {
    出.push(`/sel/${e.page}/${e.id}`);
  }
  // 純正フォーム（GET のみ。POST はしない）
  for (const e of db.prepare("SELECT page,id FROM elem WHERE type='formContainer' ORDER BY rowid").all()) {
    出.push(`/form/${e.page}/${e.id}`);
  }
  db.close();
  return [...new Set(出)];
}

/** 本当に非決定なものだけを縮約する。消さずに sha へ置き換え、置換回数も数える。 */
function 均す(体, 経路) {
  const 記録 = [];
  let s = 体;

  // CSS は全応答に同じものが入る。消すと劣化が見えなくなるので sha に縮約する
  s = s.replace(/<style>([\s\S]*?)<\/style>/g, (_, 中) => {
    記録.push("STYLE");
    return `<style>{{sha:${crypto.createHash("sha256").update(中).digest("hex").slice(0, 8)}}}</style>`;
  });

  // /detail-stats の自己計測だけ伏せる
  if (経路.startsWith("/detail-stats")) {
    s = s.replace(/"ms"\s*:\s*\d+/g, () => { 記録.push("MS"); return '"ms":{{数}}'; });
  }
  return { 体: s, 記録 };
}

async function 取りに行く() {
  if (!BASE) { console.error("× --base が要ります"); process.exit(2); }
  const 名 = 取る ?? 足す;
  const 先 = path.join(置き場, 名);
  fs.mkdirSync(先, { recursive: true });

  /** 足すときは、既にある索引を残したまま、まだ無い経路だけを取る */
  const 索引 = [];
  let 既に = new Set();
  let 経路;
  if (足す) {
    const 前 = JSON.parse(fs.readFileSync(path.join(先, "index.json"), "utf8"));
    if (前.base !== BASE) { console.error(`× 置き先が違います: 前 ${前.base} / 今 ${BASE}`); process.exit(2); }
    索引.push(...前.経路);
    既に = new Set(前.経路.map((x) => x.経路));
    const 足し = JSON.parse(fs.readFileSync(path.join(置き場, "追加経路.json"), "utf8")).経路;
    経路 = 足し.filter((u) => !既に.has(u));
    console.log(`${名}: ${BASE}  既に ${既に.size} 本 ＋ 足す ${経路.length} 本  並列 ${並列}\n`);
  } else {
    経路 = 経路たち();
    console.log(`${名}: ${BASE}  経路 ${経路.length} 本  並列 ${並列}\n`);
  }

  let 済 = 0;
  const 頭 = BYPASS ? { "x-vercel-protection-bypass": BYPASS } : {};

  async function 一本(u) {
    const t0 = Date.now();
    let code = 0, 体 = "", 型 = "";
    try {
      const r = await fetch(BASE + u, { headers: 頭, signal: AbortSignal.timeout(180_000) });
      code = r.status;
      型 = r.headers.get("content-type") ?? "";
      体 = await r.text();
    } catch (e) { code = -1; 体 = "((取れません)) " + (e?.message ?? e); }
    const ms = Date.now() - t0;
    const { 体: 均した, 記録 } = 均す(体, u);
    索引.push({
      経路: u, code, 型, バイト: Buffer.byteLength(体, "utf8"), ms,
      生: crypto.createHash("sha256").update(体).digest("hex"),
      均: crypto.createHash("sha256").update(均した).digest("hex"),
      縮約: 記録.join(","),
    });
    // 本文は差を見るときだけ要る。経路名を安全な名前に直して置く
    fs.writeFileSync(path.join(先, crypto.createHash("sha1").update(u).digest("hex") + ".txt"), 均した);
    if (++済 % 100 === 0) process.stdout.write(`  ${済}/${経路.length}\n`);
  }

  for (let i = 0; i < 経路.length; i += 並列) {
    await Promise.all(経路.slice(i, i + 並列).map(一本));
  }
  索引.sort((a, b) => a.経路.localeCompare(b.経路));
  fs.writeFileSync(path.join(先, "index.json"), JSON.stringify({ base: BASE, 取った: new Date().toISOString(), 経路: 索引 }, null, 1));

  const 悪い = 索引.filter((x) => x.code !== 200);
  console.log(`\n取りました: ${索引.length} 本 / 200 以外 ${悪い.length} 本`);
  for (const x of 悪い.slice(0, 10)) console.log(`  ${x.code}  ${x.経路}`);
}

function 突き合わせる() {
  const [a, b] = [引数[引数.indexOf("--比べる") + 1], 引数[引数.indexOf("--比べる") + 2]];
  const 読む = (名) => JSON.parse(fs.readFileSync(path.join(置き場, 名, "index.json"), "utf8"));
  const A = 読む(a), B = 読む(b);
  const mapB = new Map(B.経路.map((x) => [x.経路, x]));

  const 差 = [];
  let 生一致 = 0, 均一致 = 0;
  for (const x of A.経路) {
    const y = mapB.get(x.経路);
    if (!y) { 差.push({ 経路: x.経路, 種: "片方に無い" }); continue; }
    if (x.生 === y.生) { 生一致++; 均一致++; continue; }
    if (x.均 === y.均) { 均一致++; 差.push({ 経路: x.経路, 種: "縮約で吸収", 縮約: x.縮約 }); continue; }
    差.push({ 経路: x.経路, 種: "不一致", A: `${x.code} ${x.バイト}B`, B: `${y.code} ${y.バイト}B` });
  }

  console.log(`${a} ${A.経路.length} 本  対  ${b} ${B.経路.length} 本\n`);
  console.log(`生のバイトが一致        ${生一致} / ${A.経路.length}`);
  console.log(`縮約後に一致            ${均一致} / ${A.経路.length}`);
  const 不一致 = 差.filter((d) => d.種 === "不一致");
  const 吸収 = 差.filter((d) => d.種 === "縮約で吸収");
  console.log(`縮約で吸収した差        ${吸収.length}  ← 規則ごとの理由が言えること`);
  console.log(`★ 不一致                ${不一致.length}`);
  for (const d of 不一致.slice(0, 30)) console.log(`   ${d.経路}   ${d.A} ≠ ${d.B}`);
  if (不一致.length > 30) console.log(`   …ほか ${不一致.length - 30} 本`);

  fs.writeFileSync(path.join(置き場, `差分-${a}-${b}.json`), JSON.stringify(差, null, 1));
  console.log(`\n差の一覧: spec/compare/差分-${a}-${b}.json`);
  console.log(`本文を見るには: spec/compare/{${a},${b}}/<経路のsha1>.txt`);
  process.exit(不一致.length ? 1 : 0);
}

if (取る || 足す) await 取りに行く();
else if (比べる) 突き合わせる();
else { console.error("--取る <名前> --base <URL> [--bypass <鍵>]\n--足す <名前> --base <URL> [--bypass <鍵>]   追加経路.json のぶんだけ足す\n--比べる <名前> <名前>"); process.exit(2); }
