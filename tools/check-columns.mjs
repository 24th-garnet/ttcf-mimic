#!/usr/bin/env node
/**
 * manifest.json が書き出した列と、Postgres 側の列が一致するかを**投入前に**全表まとめて見る。
 * COPY は 1 表ずつしか失敗を教えてくれないので、先に全部そろえる。
 */
import fs from "node:fs";
import path from "node:path";
import pg from "pg";
import { ROOT, 読む, 宛先を確かめる } from "./pgenv.mjs";

const 索引 = JSON.parse(fs.readFileSync(path.join(ROOT, "db", "pg", "data", "manifest.json"), "utf8"));
const { SUPABASE_SESSION_URL: url } = 読む(["SUPABASE_SESSION_URL"]);
宛先を確かめる(url);
const c = new pg.Client({ connectionString: url });
await c.connect();

let 悪い = 0;
for (const t of 索引.表) {
  const r = await c.query(
    `SELECT column_name, data_type FROM information_schema.columns
     WHERE table_schema='public' AND table_name=$1 ORDER BY ordinal_position`, [t.表]);
  if (!r.rows.length) { console.log(`× ${t.表}: 表が無い`); 悪い++; continue; }
  const pg列 = new Set(r.rows.map((x) => x.column_name));
  const 無い = t.列.filter((x) => !pg列.has(x));
  const 余り = r.rows.map((x) => x.column_name).filter((x) => !t.列.includes(x));
  if (無い.length) { console.log(`× ${t.表}: Postgres に無い列 → ${無い.join(", ")}`); 悪い++; }
  else if (余り.length) console.log(`  ${t.表}: Postgres 側にだけある列 ${余り.join(", ")}（COPY は列を名指しするので害は無い）`);
  else console.log(`○ ${t.表.padEnd(18)} ${t.列.length} 列`);
}
console.log(悪い ? `\n★ ${悪い} 表を直してください。` : "\nすべての表で列がそろっています。");
await c.end();
process.exit(悪い ? 1 : 0);
