/**
 * Vercel の入口。
 *
 * Vercel は **ルートの `server.{js,mjs,ts}` が `listen()` を呼ぶのを検出して Function にする**。
 * 渡ってくるのは素の `IncomingMessage` / `ServerResponse` なので、`app/serve.mjs` の作りが
 * そのまま動く。だからハンドラを切り出す必要は無い。
 *
 * ■ いまは第1段（土台の確認）
 *
 * データ層（Supabase → インメモリ SQLite）はまだ繋いでいない。
 * この段では**置き先の前提が本当に成り立っているか**だけを確かめる。確かめるのは:
 *
 *   node:sqlite が使えるか   ← これが無ければ計画全体が成り立たない。最優先
 *   リージョンが hnd1 か     ← 既定は iad1（米国東部）。ずれると毎回 345MB を太平洋越しに引く
 *   メモリが 4GB か          ← vercel.json では設定できない。ダッシュボードの設定漏れを検出する
 *   既定ロケールが en-US か  ← 違うと 335 画面すべてで桁区切りが変わる
 *   同梱したファイルが在るか ← includeFiles が効いているか
 *
 * ■ 第2段になったら
 *
 *   await 用意する();                  // db/hydrate.mjs（Supabase → :memory:）
 *   await import("./app/serve.mjs");   // 既存のまま。末尾の listen() を Vercel が拾う
 *
 * に置き換える。`app/serve.mjs` は一行も変えない。**手元と Vercel が同じものを実行する**のが、
 * 移植前後を突き合わせるための前提である。
 */
import http from "node:http";
import v8 from "node:v8";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.dirname(fileURLToPath(import.meta.url));
const PORT = Number(process.env.PORT) || 8787;

/** node:sqlite が使えるか。ここが駄目なら案βは成立しない。 */
async function sqliteを試す() {
  try {
    const { DatabaseSync } = await import("node:sqlite");
    const db = new DatabaseSync(":memory:");
    db.exec("CREATE TABLE t (a TEXT, b INTEGER)");
    db.prepare("INSERT INTO t VALUES (?,?)").run("あ", 1);
    const r = db.prepare("SELECT a, b, rowid FROM t").get();
    // 実行時に要る schema.sql がそのまま通るかも見る
    let スキーマ = "未確認";
    const p = path.join(ROOT, "db", "schema.sql");
    if (fs.existsSync(p)) {
      try {
        const m = new DatabaseSync(":memory:");
        m.exec(fs.readFileSync(p, "utf8").replace(/PRAGMA[^;]*;/g, ""));
        const n = m.prepare("SELECT count(*) c FROM sqlite_master WHERE type='table'").get().c;
        スキーマ = `${n} 表を作れた`;
      } catch (e) { スキーマ = "失敗: " + e.message; }
    } else スキーマ = "db/schema.sql が同梱されていない";
    return { 使える: true, 読み書き: r, rowid: r.rowid, スキーマ };
  } catch (e) {
    return { 使える: false, 理由: e.message };
  }
}

/** includeFiles が効いているか。実行時に要るものを名指しで見る。 */
function 同梱を見る() {
  const 要る = [
    "db/schema.sql", "app/ui.js", "spec/gates.json",
    "app/serve.mjs", "app/format.mjs", "app/doc.mjs", "app/doc-mfg.mjs", "app/doc-sales.mjs",
    "app/ext/10-buttons.mjs", "app/ext/20-cells.mjs", "app/ext/30-detail.mjs",
    "app/ext/40-dash.mjs", "app/ext/50-fieldbuttons.mjs", "app/ext/60-docs.mjs",
    "db/open.mjs", "db/query.mjs", "db/write.mjs", "db/actions.mjs",
    "db/calc.mjs", "db/formula.mjs", "crawl/lib/airmsg.mjs",
  ];
  const 在り = [], 無し = [];
  for (const f of 要る) (fs.existsSync(path.join(ROOT, f)) ? 在り : 無し).push(f);
  return { 在り: 在り.length, 無し };
}

async function 診る() {
  const mb = (b) => Math.round(b / 1024 / 1024);
  return {
    "★node:sqlite": await sqliteを試す(),
    "★リージョン": {
      実際: process.env.VERCEL_REGION ?? "(Vercel 外)",
      期待: "hnd1",
      判定: process.env.VERCEL_REGION ? (process.env.VERCEL_REGION === "hnd1" ? "○" : "× iad1 のままなら vercel.json の regions が効いていない") : "—",
    },
    "★メモリ": {
      totalmem: mb(os.totalmem()) + "MB",
      制約: (() => { const n = process.constrainedMemory?.() ?? 0; return n > 0 && n < os.totalmem() * 4 ? mb(n) + "MB" : "上限なし"; })(),
      ヒープ上限: mb(v8.getHeapStatistics().heap_size_limit) + "MB",
      期待: "4096MB",
      判定: mb(os.totalmem()) >= 3500 ? "○" : "× ダッシュボードで Function CPU を Performance(4GB) にして再デプロイ",
    },
    "★ロケール": {
      既定: new Intl.NumberFormat().resolvedOptions().locale,
      例: (1234567.5).toLocaleString(),
      期待: "en-US / 1,234,567.5",
      判定: new Intl.NumberFormat().resolvedOptions().locale === "en-US" ? "○" : "× 335画面すべてで桁区切りが変わる",
      icu: process.versions.icu ?? "なし",
    },
    "★時間帯": {
      既定: Intl.DateTimeFormat().resolvedOptions().timeZone,
      TZ: process.env.TZ ?? "(未設定)",
      期待: "UTC",
      // 手元の WSL は既定が America/Los_Angeles だった。置き先と揃えないと日付の出方が変わりうる。
      // db/calc.mjs は {tz:"UTC", clientTz:"Asia/Tokyo"} を明示で受けるので直接は効かないが、
      // 素の Date#toLocaleString が漏れている箇所があれば差になる。両方で固定する。
      判定: Intl.DateTimeFormat().resolvedOptions().timeZone === "UTC" ? "○" : "× 手元と置き先で揃っていない。TZ=UTC を明示すること",
    },
    "★同梱": 同梱を見る(),
    node: process.version,
    fluid: process.env.VERCEL_DEPLOYMENT_ID ? "デプロイID あり" : "—",
    データ層: process.env.SUPABASE_SESSION_URL ? "接続文字列あり（第2段で使う）" : "未接続（第1段なので正常）",
  };
}

http.createServer(async (req, res) => {
  const u = new URL(req.url ?? "/", `http://${req.headers.host ?? "localhost"}`);

  if (u.pathname === "/_health" || u.pathname === "/_warm") {
    res.writeHead(200, { "content-type": "application/json; charset=utf-8" });
    return res.end(JSON.stringify({ ok: true, at: new Date().toISOString() }));
  }

  if (u.pathname === "/__env") {
    const d = await 診る();
    res.writeHead(200, { "content-type": "application/json; charset=utf-8" });
    return res.end(JSON.stringify(d, null, 2));
  }

  const d = await 診る();
  const ng = Object.entries(d).filter(([k, v]) => k.startsWith("★") && typeof v === "object" && String(v.判定 ?? "").startsWith("×"));
  res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
  res.end(`<meta charset=utf-8><title>TTCF ミミック — 土台の確認</title>
<body style="font:14px/1.7 system-ui;max-width:56rem;margin:3rem auto;padding:0 1rem">
<h1 style="font-size:20px">TTCF ミミック — 第1段（土台の確認）</h1>
<p>データ層はまだ繋いでいません。この段では置き先の前提だけを確かめます。</p>
<p style="padding:.6rem .9rem;border-radius:6px;background:${ng.length ? "#fde8e8" : "#e8f5e9"}">
${ng.length ? `<b>${ng.length} 件が期待どおりではありません。</b>` : "<b>前提はすべて満たしています。</b>"}</p>
<pre style="background:#f6f6f4;padding:1rem;border-radius:6px;overflow:auto">${
  JSON.stringify(d, null, 2).replace(/[&<>]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;" }[c]))
}</pre>
<p><a href="/__env">/__env</a>（JSON） ／ <a href="/_health">/_health</a></p>`);
}).listen(PORT, () => console.log(`http://localhost:${PORT}  （第1段: 土台の確認）`));
