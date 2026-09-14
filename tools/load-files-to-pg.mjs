#!/usr/bin/env node
/**
 * 実行時に読むファイル（控え 12MB・実物 127MB）を Supabase へ入れる。
 *
 *   node tools/load-files-to-pg.mjs bom        使用原材料の控え
 *   node tools/load-files-to-pg.mjs artifact   帳票の実物
 *   node tools/load-files-to-pg.mjs 確かめる    入っているものと手元を突き合わせる
 *
 * ■ 気をつけること
 *
 * 実物は 127MB ある。1 文で送ると切られるので**少しずつ**送り、
 * 途中で切れても**やり直せる**ようにする（入っているものは飛ばす）。
 * 1.5M 行の COPY で ECONNRESET を踏んだのと同じ理由。
 *
 * 照合は**バイトの sha256** で行う。件数だけでは中身の欠けが素通りする。
 */
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import pg from "pg";
import { 読む, 宛先を確かめる, ROOT } from "./pgenv.mjs";

const 何 = process.argv[2];
if (!["bom", "artifact", "確かめる"].includes(何)) {
  console.error("使い方: node tools/load-files-to-pg.mjs <bom|artifact|確かめる>"); process.exit(2);
}

const v = 読む(["SUPABASE_SESSION_URL"]);
const 先 = 宛先を確かめる(v.SUPABASE_SESSION_URL);
console.log(`宛先 ${先.ホスト}:${先.ポート}`);

const 種類 = {
  ".pdf": "application/pdf", ".png": "image/png", ".jpg": "image/jpeg", ".jpeg": "image/jpeg",
  ".gif": "image/gif", ".webp": "image/webp", ".svg": "image/svg+xml",
};

const 置き場 = {
  bom: path.join(ROOT, "crawl", "out", "raw", "bom"),
  artifact: path.join(ROOT, "crawl", "out", "artifacts"),
};

const c = new pg.Client({ connectionString: v.SUPABASE_SESSION_URL, connectionTimeoutMillis: 20_000, statement_timeout: 0, query_timeout: 0 });
await c.connect();

if (何 === "確かめる") { await 確かめる(); await c.end(); process.exit(0); }

const dir = 置き場[何];
const 名たち = fs.readdirSync(dir).filter((f) => fs.statSync(path.join(dir, f)).isFile()).sort();
const 表 = 何 === "bom" ? "bom_file" : "artifact";

/** 既に入っているものは飛ばす（やり直せるように） */
const 済 = new Set((await c.query(`select name from "${表}"`)).rows.map((r) => r.name));
const 要る = 名たち.filter((n) => !済.has(n));
console.log(`手元 ${名たち.length} 件 ／ 入っている ${済.size} 件 ／ これから ${要る.length} 件`);

let n = 0, バイト = 0;
const 束 = 何 === "bom" ? 4 : 8;              // 実物は 1 件 平均 124KB。8 件で約 1MB
for (let i = 0; i < 要る.length; i += 束) {
  const 組 = 要る.slice(i, i + 束);
  if (何 === "bom") {
    const 値 = [], 印 = [];
    組.forEach((名, j) => { 値.push(名, fs.readFileSync(path.join(dir, 名), "utf8")); 印.push(`($${j * 2 + 1},$${j * 2 + 2})`); });
    await c.query(`insert into bom_file(name,body) values ${印.join(",")} on conflict (name) do update set body=excluded.body`, 値);
  } else {
    const 値 = [], 印 = [];
    組.forEach((名, j) => {
      const b = fs.readFileSync(path.join(dir, 名));
      値.push(名, 種類[path.extname(名).toLowerCase()] ?? "application/octet-stream", b.length, b);
      印.push(`($${j * 4 + 1},$${j * 4 + 2},$${j * 4 + 3},$${j * 4 + 4})`);
    });
    await c.query(`insert into artifact(name,ctype,bytes,body) values ${印.join(",")} on conflict (name) do update set ctype=excluded.ctype,bytes=excluded.bytes,body=excluded.body`, 値);
  }
  for (const 名 of 組) バイト += fs.statSync(path.join(dir, 名)).size;
  n += 組.length;
  if (n % (束 * 10) === 0 || n === 要る.length) process.stdout.write(`  ${n}/${要る.length}  ${(バイト / 1048576).toFixed(1)}MB\r`);
}
console.log(`\n入れました ${n} 件 / ${(バイト / 1048576).toFixed(1)}MB`);
await 確かめる();
await c.end();

/** 入っているものと手元を、**バイトの sha256** で突き合わせる */
async function 確かめる() {
  for (const [名, 表, 列] of [["bom", "bom_file", "convert_to(body,'UTF8')"], ["artifact", "artifact", "body"]]) {
    const dir = 置き場[名];
    if (!fs.existsSync(dir)) { console.log(`  ${名}: 手元に置き場がありません`); continue; }
    const 手元 = fs.readdirSync(dir).filter((f) => fs.statSync(path.join(dir, f)).isFile());
    const r = await c.query(`select name, encode(sha256(${列}),'hex') h, length(${列}) n from "${表}"`);
    const 向こう = new Map(r.rows.map((x) => [x.name, x]));
    let 一致 = 0; const 欠け = [], 違い = [];
    for (const f of 手元) {
      const y = 向こう.get(f);
      if (!y) { 欠け.push(f); continue; }
      const h = crypto.createHash("sha256").update(fs.readFileSync(path.join(dir, f))).digest("hex");
      if (h === y.h) 一致++; else 違い.push(f);
    }
    const 余り = [...向こう.keys()].filter((k) => !手元.includes(k));
    console.log(`  ${名.padEnd(9)} 手元 ${手元.length} / 向こう ${向こう.size} / sha一致 ${一致} / 欠け ${欠け.length} / 中身違い ${違い.length} / 余分 ${余り.length}`);
    for (const f of [...欠け, ...違い].slice(0, 5)) console.log(`      ${f}`);
  }
}
