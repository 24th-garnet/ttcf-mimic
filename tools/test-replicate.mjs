#!/usr/bin/env node
/**
 * 書き込みの複製を通しで試す。**本物の Supabase に書いて、本物から読み戻す。**
 *
 *   node tools/test-replicate.mjs
 *
 * ■ 何を確かめるか
 *
 *   作る   → effect と本体（rec_row / write_log / counter）に載る。rowid も運ばれる
 *   更新   → 同上。cells が置き換わる
 *   消す   → effect に「消す」が載り、本体から消える
 *   取り込む → 別インスタンスが書いたものが、インメモリとクエリエンジンの断面に入る
 *
 * ■ 後片付け
 *
 * 作った行は最後に消す。**試しの行を残さない。**
 * 落ちたときのために、作った行IDを標準出力に出す。
 */
import { 用意する } from "../db/hydrate.mjs";
import { 預ける } from "../db/open.mjs";
import { 読む, 宛先を確かめる } from "./pgenv.mjs";
import pg from "pg";

const v = 読む(["SUPABASE_SESSION_URL"]);
const 先 = 宛先を確かめる(v.SUPABASE_SESSION_URL);
console.log(`宛先 ${先.ホスト}:${先.ポート}\n`);

const 調べる = new pg.Client({ connectionString: v.SUPABASE_SESSION_URL, connectionTimeoutMillis: 20_000 });
await 調べる.connect();
const 数える = async (q, ...a) => Number((await 調べる.query(q, a)).rows[0].n);

const 起点 = Number((await 調べる.query("select coalesce(max(seq),0) s from effect")).rows[0].s);
const 基準 = {
  rec_row: await 数える("select count(*) n from rec_row"),
  write_log: await 数える("select count(*) n from write_log"),
  effect: await 数える("select count(*) n from effect"),
};
console.log("基準:", JSON.stringify(基準), " effect の起点", 起点);

const db = await 用意する({ url: v.SUPABASE_SESSION_URL, 知らせる: () => {} });
預ける(db);

const 複製 = await import("../db/replicate.mjs");
複製.始める({ db, url: v.SUPABASE_SESSION_URL, 起点, 名: "試し" });

const { 書き込み器を作る } = await import("../db/write.mjs");
const w = 書き込み器を作る(db);

let 合格 = 0, 不合格 = 0;
const 判定 = (名, 条件, 補 = "") => {
  if (条件) { 合格++; console.log(`  ○ ${名} ${補}`); }
  else { 不合格++; console.log(`  ★ ${名} ${補}`); }
};

/** 試しに使う表。PDF生成指示（販売）。必須は 出力帳票・出荷日1・種類番号 */
const 表 = "tbldhtCdQkTBw4HGi";
const 値 = {
  fldRr8ojzWUnZob2S: "selw7n9gzdM1WqYox",
  fldHSoXbqcbeygxPt: "2026-09-14T00:00:00.000Z",
  fldDr9mQT2OfefgPQ: ["selTEdhNPmjzPhjdp"],
};

let 行ID = null;
try {
  /* ───────── ① 作る ───────── */
  console.log("\n① 作る");
  const a = w.作る(表, 値, { 出どころ: "tools/test-replicate.mjs" });
  判定("行が作れた", !!a.行ID, a.行ID ?? a.文言?.join("/"));
  行ID = a.行ID;
  if (!行ID) throw new Error("作れませんでした: " + (a.文言 ?? []).join(" / "));
  console.log(`     ★後片付け用の行ID: ${行ID}`);
  const 送1 = await 複製.送り出す();
  判定("送り出した", 送1 > 0, `${送1} 行`);
  判定("本体の行が増えた", await 数える("select count(*) n from rec_row") === 基準.rec_row + 1);
  判定("write_log が載った", await 数える("select count(*) n from write_log where row_id=$1", 行ID) === 1);
  const rid = Number((await 調べる.query("select _rowid from rec_row where id=$1", [行ID])).rows[0]._rowid);
  const mem = db.prepare("SELECT rowid AS r FROM row WHERE id=?").get(行ID).r;
  判定("rowid が一致する", rid === mem, `pg=${rid} mem=${mem}`);

  /* ───────── ② 更新 ───────── */
  console.log("\n② 更新");
  const b = w.更新(行ID, { fldHSoXbqcbeygxPt: "2026-11-11T00:00:00.000Z" }, { 出どころ: "試し" });
  判定("更新できた", !b.文言?.length, (b.文言 ?? []).join("/"));
  await 複製.送り出す();
  const cells = JSON.parse((await 調べる.query("select cells from rec_row where id=$1", [行ID])).rows[0].cells);
  判定("本体の cells が変わった", cells.fldHSoXbqcbeygxPt === "2026-11-11T00:00:00.000Z", cells.fldHSoXbqcbeygxPt);
  判定("write_log が 2 件になった", await 数える("select count(*) n from write_log where row_id=$1", 行ID) === 2);

  /* ───────── ③ 別インスタンスからの取り込み ───────── */
  console.log("\n③ 取り込む（別インスタンスが書いたことにする）");
  const r0 = (await 調べる.query("select _rowid,id,tbl,cells,calc,snap,implied,src,loaded from rec_row where id=$1", [行ID])).rows[0];
  const c2 = { ...JSON.parse(r0.cells), fldHSoXbqcbeygxPt: "2026-12-25T00:00:00.000Z" };
  const カ = (await 調べる.query("select _rowid,fld,next from counter")).rows
    .map((x) => ({ _rowid: Number(x._rowid), fld: x.fld, next: Number(x.next) }));
  await 調べる.query(
    "insert into effect(at,who,note,rows,links,counters,logs) values($1,$2,$3,$4,$5,$6,$7)",
    [new Date().toISOString(), "もう一台", "updateRow",
     JSON.stringify([{ _rowid: Number(r0._rowid), id: r0.id, tbl: r0.tbl, cells: JSON.stringify(c2),
                       calc: r0.calc, snap: r0.snap, implied: r0.implied, src: "もう一台", loaded: r0.loaded }]),
     JSON.stringify({ 触った: [行ID], 辺: [] }), JSON.stringify(カ), "[]"]);
  await 調べる.query("update rec_row set cells=$2 where id=$1", [行ID, JSON.stringify(c2)]);
  const 取 = await 複製.取り込む();
  判定("取り込んだ", 取 > 0, `${取} 行`);
  const mem2 = JSON.parse(db.prepare("SELECT cells FROM row WHERE id=?").get(行ID).cells);
  判定("インメモリに入った", mem2.fldHSoXbqcbeygxPt === "2026-12-25T00:00:00.000Z", mem2.fldHSoXbqcbeygxPt);
  const 送2 = await 複製.送り出す();
  判定("他人の書き込みを送り返さない", 送2 === 0, `送った ${送2}`);

  /* ───────── ④ 消す ───────── */
  console.log("\n④ 消す");
  const d = w.消す(行ID, { 出どころ: "試し" });
  判定("消せた", !d.文言?.length, (d.文言 ?? []).join("/"));
  await 複製.送り出す();
  判定("本体から消えた", await 数える("select count(*) n from rec_row where id=$1", 行ID) === 0);
  const 効 = (await 調べる.query("select rows from effect order by seq desc limit 1")).rows[0];
  判定("effect に「消す」が載った", JSON.parse(効.rows).some((x) => x.消す && x.id === 行ID));
  判定("行数が基準に戻った", await 数える("select count(*) n from rec_row") === 基準.rec_row);
  行ID = null;
} finally {
  if (行ID) {
    console.log(`\n後片付け: ${行ID} を消します`);
    try { w.消す(行ID, { 出どころ: "後片付け" }); await 複製.送り出す(); } catch (e) { console.error("  消せません:", e.message); }
  }
  /** 試しで作った effect は残さない（本体は元に戻っているので、ログだけ掃く） */
  await 調べる.query("delete from effect where seq > $1", [起点]);
  console.log(`effect を起点 ${起点} まで戻しました（${await 数える("select count(*) n from effect")} 件）`);
  await 調べる.end();
}

console.log(`\n合格 ${合格} / 不合格 ${不合格}`);
process.exit(不合格 ? 1 : 0);
