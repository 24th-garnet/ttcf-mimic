#!/usr/bin/env node
/**
 * db/pg/data/*.copy を Supabase へ流す。
 *
 *   node tools/load-to-pg.mjs                 足りない表だけ入れる（再開できる）
 *   node tools/load-to-pg.mjs --確かめる        入っている行数を見るだけ
 *   node tools/load-to-pg.mjs --空にしてから     先に全表を空にしてから入れ直す
 *
 * ■ 再開できるようにしてある
 *
 * 行数が既に合っている表は飛ばす。150万行の途中で切れても、続きから流せる。
 *
 * ■ 大きい表は分けて流す
 *
 * requested_partial（150万行・52MB）を 1 本の COPY で流したら ECONNRESET になった。
 * Supavisor（プーラー）が長い転送を切ったものと見られる。**1 回の COPY を短くする**のが確実で、
 * 途中で切れても入った分は残るので、再開と相性が良い。
 *
 * 行の区切りは素の改行でよい。書き出し側が本物の改行を `\n`（2 文字）に逃がしているので、
 * ファイル中の生の改行は必ず行の切れ目である。
 *
 * ■ 接続はセッション用（5432）
 *
 * COPY は長い転送になる。トランザクション用（6543）は短命な接続向け。
 */
import fs from "node:fs";
import path from "node:path";
import readline from "node:readline";
import { pipeline } from "node:stream/promises";
import { Readable } from "node:stream";
import pg from "pg";
import { from as copyFrom } from "pg-copy-streams";
import { ROOT, 読む, 宛先を確かめる } from "./pgenv.mjs";

const 確かめるだけ = process.argv.includes("--確かめる");
const 空にする = process.argv.includes("--空にしてから");
const 一度に = Number(process.env.CHUNK ?? 200_000);   // 1 回の COPY に流す行数

const 置き場 = path.join(ROOT, "db", "pg", "data");
const 索引 = JSON.parse(fs.readFileSync(path.join(置き場, "manifest.json"), "utf8"));
const { SUPABASE_SESSION_URL: url } = 読む(["SUPABASE_SESSION_URL"]);
const 宛 = 宛先を確かめる(url);

const 繋ぐ = async () => {
  const c = new pg.Client({
    connectionString: url, application_name: "ttcf-load",
    statement_timeout: 0, query_timeout: 0,
    keepAlive: true, keepAliveInitialDelayMillis: 10_000,
  });
  await c.connect();
  return c;
};

const mb = (b) => (b / 1024 / 1024).toFixed(1) + "MB";
console.log(`宛先: ${宛.ホスト}:${宛.ポート}\n`);

let c = await 繋ぐ();
const 数える = async (表) => Number((await c.query(`SELECT count(*)::bigint n FROM "${表}"`)).rows[0].n);

if (確かめるだけ) {
  let 未 = 0;
  for (const t of 索引.表) {
    const n = await 数える(t.表);
    const ok = n === t.行数;
    if (!ok) 未++;
    console.log(`${ok ? "○" : "×"} ${t.表.padEnd(18)} ${n.toLocaleString().padStart(10)} / ${t.行数.toLocaleString()}`);
  }
  console.log(`\n未了 ${未} 表`);
  await c.end();
  process.exit(未 ? 1 : 0);
}

if (空にする) {
  console.log("全表を空にします…");
  await c.query(`TRUNCATE ${索引.表.map((t) => `"${t.表}"`).join(", ")} RESTART IDENTITY CASCADE`);
}

/** 1 表を、必要なら分けて流す。切れたら繋ぎ直して続きから。 */
async function 流す(t) {
  const f = path.join(置き場, `${t.表}.copy`);
  const 列 = t.列.map((x) => `"${x}"`).join(",");
  let 済み = await 数える(t.表);
  if (済み === t.行数) { console.log(`— ${t.表.padEnd(18)} ${済み.toLocaleString().padStart(10)} 行 既に入っている`); return; }
  if (済み > 0) {
    console.log(`  ${t.表.padEnd(18)} ${済み.toLocaleString()} 行だけ入っている。入れ直すため空にします`);
    await c.query(`TRUNCATE "${t.表}" CASCADE`);
    済み = 0;
  }

  const t0 = Date.now();
  process.stdout.write(`  ${t.表.padEnd(18)} ${String(t.行数).padStart(9)}行 ${mb(fs.statSync(f).size).padStart(8)} … `);

  const rl = readline.createInterface({ input: fs.createReadStream(f), crlfDelay: Infinity });
  let 束 = [], 送った = 0, 回 = 0;
  const 送る = async () => {
    if (!束.length) return;
    const 本文 = 束.join("\n") + "\n";
    束 = [];
    for (let 試み = 1; ; 試み++) {
      try {
        const ws = c.query(copyFrom(`COPY "${t.表}" (${列}) FROM STDIN WITH (FORMAT text)`));
        await pipeline(Readable.from([本文]), ws);
        return;
      } catch (e) {
        if (試み >= 3) throw e;
        process.stdout.write(`[切れたので繋ぎ直す ${試み}] `);
        try { await c.end(); } catch { /* もう閉じている */ }
        c = await 繋ぐ();
      }
    }
  };
  for await (const 行 of rl) {
    if (行 === "") continue;
    束.push(行);
    if (束.length >= 一度に) { await 送る(); 送った += 一度に; 回++; }
  }
  await 送る(); 回++;

  const n = await 数える(t.表);
  const 秒 = ((Date.now() - t0) / 1000).toFixed(1);
  const 合う = n === t.行数;
  console.log(`${合う ? "○" : "×"} ${n.toLocaleString()}行 ${秒}秒${回 > 1 ? ` (${回}回に分けた)` : ""}`);
  if (!合う) throw new Error(`${t.表}: 期待 ${t.行数} / 実際 ${n}`);
}

const T0 = Date.now();
for (const t of 索引.表) await 流す(t);

for (const t of ["write_log", "load_log"]) {
  await c.query(`SELECT setval(pg_get_serial_sequence('${t}','seq'), COALESCE((SELECT max(seq) FROM "${t}"),1))`);
}
console.log("\n採番の続きを合わせました（write_log / load_log）");
console.log(`投入しました: ${((Date.now() - T0) / 1000).toFixed(1)}秒`);
await c.end();
