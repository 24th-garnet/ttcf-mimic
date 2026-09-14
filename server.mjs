/**
 * Vercel の入口。
 *
 * Vercel は **ルートの `server.{js,mjs,ts}` が `listen()` を呼ぶのを検出して Function にする**。
 * 渡ってくるのは素の `IncomingMessage` / `ServerResponse` なので、`app/serve.mjs` の作りが
 * そのまま動く。**app/serve.mjs は一行も変えない。**
 *
 * ■ なぜ受付を挟むのか
 *
 * `listen()` を 2 回呼ぶと衝突する。そこで外側（この受付）が Vercel の掴む口を先に取り、
 * `app/serve.mjs` は内側の口で待たせて、受付が流す。常駐版の deploy/front.mjs と同じ形で、
 * あちらで実証済みである。
 *
 * 受付が自分で答えるのは 3 つだけ。
 *   /_health /_warm  … 用意ができたか
 *   /__env           … 置き先の前提（リージョン・メモリ・ロケール・時間帯・Node）
 *   用意ができていないとき … 何が起きているかを出す
 * それ以外は全部そのまま内側へ流す。
 *
 * ■ 起動に時間がかかる
 *
 * 実測（手元 → Supabase 東京）: 移送 40.4 秒 ＋ クエリエンジン 12.9 秒。
 * Fluid compute がインスタンスを使い回すので、温まっていれば 8〜10ms。
 * 冷えたときだけこれを払う。vercel.json の cron が 5 分ごとに /_warm を叩く。
 *
 * ■ 準備は 1 本だけ
 *
 * 同時に来た要求が別々に組み始めると、2,700MB を 2 つ抱えて落ちる。
 * 1 本の Promise にして全員がそれを待つ。
 */
import http from "node:http";
import os from "node:os";
import v8 from "node:v8";

const PORT = Number(process.env.PORT) || 8787;
const 内側 = Number(process.env.INNER_PORT) || 8799;

/** 置き先の前提。壊れていたら黙って違う結果を出すより、はっきり出す。 */
function 土台を診る() {
  const mb = (b) => Math.round(b / 1024 / 1024);
  const 総 = mb(os.totalmem());
  const 地 = process.env.VERCEL_REGION;
  const ロケール = new Intl.NumberFormat().resolvedOptions().locale;
  const 帯 = Intl.DateTimeFormat().resolvedOptions().timeZone;
  return {
    リージョン: { 実際: 地 ?? "(Vercel 外)", 期待: "hnd1",
      判定: !地 ? "—" : 地 === "hnd1" ? "○" : "× vercel.json の regions が効いていない" },
    メモリ: { totalmem: 総 + "MB", ヒープ上限: mb(v8.getHeapStatistics().heap_size_limit) + "MB",
      期待: "4096MB",
      判定: 総 >= 3500 ? "○" : "× Function CPU を Performance(4GB) にして**再デプロイ**する" },
    ロケール: { 既定: ロケール, 例: (1234567.5).toLocaleString(), icu: process.versions.icu ?? "なし",
      期待: "en-US", 判定: ロケール === "en-US" ? "○" : "× 335 画面すべてで桁区切りが変わる" },
    時間帯: { 既定: 帯, TZ: process.env.TZ ?? "(未設定)", 期待: "UTC",
      判定: 帯 === "UTC" ? "○" : "× 手元と揃っていない" },
    // 比較の正解（常駐版）が v22。node:sqlite は 22 では experimental・24 では安定で、
    // 同じ入力で同じ出力になる保証が無い。移植前後の比較が済むまでは揃える。
    node: { 実際: process.version, 期待: "v22.x",
      判定: process.version.startsWith("v22.") ? "○" : "× package.json の engines が効いていない" },
  };
}

const 状態 = { 段階: "まだ始めていない", 秒: null, 誤り: null, 移送: null, 試み: 0 };

/**
 * 準備は 1 本だけ。同時に来た要求が別々に組み始めると 2,700MB を 2 つ抱えて落ちる。
 * **ただし失敗したらやり直せるようにする。** 一度の失敗で固まると、そのインスタンスは
 * 作り直されるまで使えないままになる（Vercel の 1 回目で EAUTHTIMEOUT を踏んだ）。
 */
let 準備 = null;
const 用意 = () => (準備 ??= 始める());
async function 始める() {
  if (!process.env.SUPABASE_SESSION_URL) { 状態.段階 = "データ層 未接続（SUPABASE_SESSION_URL が無い）"; return false; }
  const t0 = Date.now();
  try {
    状態.試み++;
    状態.段階 = "Supabase から読んでいる";
    const { 用意する } = await import("./db/hydrate.mjs");
    const 記録 = [];
    const db = await 用意する({ url: process.env.SUPABASE_SESSION_URL, 知らせる: (s) => 記録.push(s.trim()) });
    状態.移送 = 記録;

    状態.段階 = "クエリエンジンを起こしている";
    const { 預ける } = await import("./db/open.mjs");
    預ける(db);

    // app/serve.mjs は読み込まれた瞬間に open() を呼び（預けた DB が返る）、
    // 末尾で listen() する。内側の口で待たせる。
    process.env.PORT = String(内側);
    process.env.HOST = "127.0.0.1";
    await import("./app/serve.mjs");

    状態.段階 = "動いている";
    状態.秒 = ((Date.now() - t0) / 1000).toFixed(1);
    console.log(`用意できました（${状態.秒}秒）`);
    return true;
  } catch (e) {
    状態.段階 = "失敗";
    状態.誤り = e?.stack ?? String(e);
    console.error("用意に失敗しました:", e);
    準備 = null;          // 次の要求でやり直せるようにする
    return false;
  }
}

const E = (s) => String(s).replace(/[&<>]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;" }[c]));

http.createServer(async (req, res) => {
  const u = new URL(req.url ?? "/", `http://${req.headers.host ?? "localhost"}`);
  const 出す = (code, 型, 体) => { res.writeHead(code, { "content-type": 型 }); res.end(体); };

  if (u.pathname === "/_health" || u.pathname === "/_warm") {
    const ok = await 用意();
    return 出す(ok ? 200 : 503, "application/json; charset=utf-8",
      JSON.stringify({ ok, 段階: 状態.段階, 秒: 状態.秒, at: new Date().toISOString() }));
  }

  if (u.pathname === "/__env") {
    const 土台 = 土台を診る();
    await 用意();
    return 出す(200, "application/json; charset=utf-8",
      JSON.stringify({ ...土台, データ層: 状態 }, null, 2));
  }

  const ok = await 用意();
  if (!ok) {
    const 土台 = 土台を診る();
    const だめ = Object.entries(土台).filter(([, v]) => String(v.判定).startsWith("×"));
    return 出す(503, "text/html; charset=utf-8",
      `<meta charset=utf-8><title>TTCF ミミック — 用意できていません</title>
<body style="font:14px/1.7 system-ui;max-width:56rem;margin:3rem auto;padding:0 1rem">
<h1 style="font-size:20px">用意できていません</h1>
<p style="padding:.6rem .9rem;border-radius:6px;background:#fde8e8"><b>${E(状態.段階)}</b></p>
${だめ.length ? `<p>置き先の前提で ${だめ.length} 件が期待どおりではありません。</p>` : ""}
<pre style="background:#f6f6f4;padding:1rem;border-radius:6px;overflow:auto">${
  E(JSON.stringify({ ...土台, データ層: 状態 }, null, 2))}</pre>
<p><a href="/__env">/__env</a></p>`);
  }

  // 用意ができていれば、あとは全部そのまま内側へ流す
  const 流す = http.request(
    { host: "127.0.0.1", port: 内側, path: req.url, method: req.method,
      headers: { ...req.headers, host: `127.0.0.1:${内側}` } },
    (ir) => { res.writeHead(ir.statusCode ?? 502, ir.headers); ir.pipe(res); });
  流す.on("error", (e) => {
    if (res.headersSent) return res.destroy();
    出す(502, "text/plain; charset=utf-8", `内側へ流せませんでした: ${e.code ?? e.message}\n`);
  });
  req.pipe(流す);
}).listen(PORT, () => console.log(`http://localhost:${PORT}  （用意しています…）`));
