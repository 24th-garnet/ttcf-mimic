#!/usr/bin/env node
/**
 * 重い CSV を描いたときのメモリを測る。**OOM の裏取り。**
 *
 *   node tools/measure-csv.mjs
 *
 * インメモリ SQLite の実体は V8 ヒープの外にある。
 * 「RSS − ヒープ」がその native ぶんで、ヒープ上限をそこに足したものが
 * 容器を超えると、プロセスごと落ちる。
 */
import v8 from "node:v8";
import { 用意する } from "../db/hydrate.mjs";
import { 預ける } from "../db/open.mjs";
import { 読む } from "./pgenv.mjs";

const mb = (b) => Math.round(b / 1048576);
const 見る = (名) => {
  const m = process.memoryUsage();
  console.log(`  ${名.padEnd(28)} RSS ${String(mb(m.rss)).padStart(5)}MB  ヒープ ${String(mb(m.heapUsed)).padStart(5)}MB  外 ${String(mb(m.rss - m.heapTotal)).padStart(5)}MB`);
};

console.log(`ヒープ上限 ${mb(v8.getHeapStatistics().heap_size_limit)}MB`);
見る("起動直後");

const v = 読む(["SUPABASE_SESSION_URL"]);
const db = await 用意する({ url: v.SUPABASE_SESSION_URL, 知らせる: () => {} });
預ける(db);
見る("移送のあと");

process.env.PORT = "18841"; process.env.HOST = "127.0.0.1";
await import("../app/serve.mjs");
見る("クエリエンジンのあと");

/** 実測で一番重かった 3 本（Vercel で 500 になった 2 本を含む） */
const 道 = [
  "/csv/pagCuLzzkAl9xnIQx/pel6BBXdjhtoXMFxa",   // 4.11MB。Vercel で 500
  "/csv/pagkHxn4wc9saeXvD/pelVczU83yiZVPvzN",   // 0.5MB。Vercel で 500
  "/csv/pag6hizwTlu40EPqQ/pel5tzU2WsQEieD3l",   // 5.26MB。一番大きい
];
for (let 周 = 1; 周 <= 2; 周++) {
  for (const p of 道) {
    const t0 = Date.now();
    const r = await fetch("http://127.0.0.1:18841" + p, { signal: AbortSignal.timeout(300_000) });
    const n = (await r.text()).length;
    見る(`${周}周目 ${p.slice(5, 22)} ${(n / 1048576).toFixed(1)}MB ${((Date.now() - t0) / 1000).toFixed(0)}s`);
  }
}
const m = process.memoryUsage();
console.log(`\n最終 RSS ${mb(m.rss)}MB`);
console.log(`このうち V8 ヒープの外（インメモリ SQLite など）: 約 ${mb(m.rss - m.heapTotal)}MB`);
console.log(`Vercel の容器 4,377MB に対し、ヒープ上限 4,071MB ＋ 外 ${mb(m.rss - m.heapTotal)}MB = ${4071 + mb(m.rss - m.heapTotal)}MB`);
console.log(`→ ${4071 + mb(m.rss - m.heapTotal) > 4377 ? "★ 容器を超えうる。ヒープ上限を下げる必要がある" : "収まる"}`);
process.exit(0);
