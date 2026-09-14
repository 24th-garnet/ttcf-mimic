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

const 状態 = { 段階: "まだ始めていない", 秒: null, 誤り: null, 移送: null, 試み: 0, 複製: null };

/** `db/replicate.mjs`（用意ができてから入る） */
let 複製 = null;

/** hydrate が読み始める**前**の effect.seq。ここから取り込む */
async function 複製の起点(url) {
  const pg = (await import("pg")).default;
  const c = new pg.Client({ connectionString: url, connectionTimeoutMillis: 20_000 });
  await c.connect();
  try { return Number((await c.query("select coalesce(max(seq),0) s from effect")).rows[0].s); }
  finally { await c.end(); }
}

/**
 * ─── 書き込みの経路 ───
 *
 * **method 指定が無く、GET でも書き込みが走る経路が 6 本ある。**
 * 見落とすと錠を取らずに書くことになり、採番が衝突する。
 *   app/ext/10-buttons.mjs:636,638 ／ 50-fieldbuttons.mjs:455,456,458,459
 */
const 書く経路 = [
  /^\/button\/pag[A-Za-z0-9]+\/pel[A-Za-z0-9]+(\/form)?$/,
  /^\/fbtn\/csv$/, /^\/fbtn\/act\//, /^\/do\/-\//, /^\/fbtn\/fld[A-Za-z0-9]+\//,
];
const 書きに来た = (req, u) =>
  req.method !== "GET" && req.method !== "HEAD" ? true : 書く経路.some((r) => r.test(u.pathname));

/**
 * ─── 要求を 1 本ずつ処理する ───
 *
 * `app/serve.mjs:1400` の `見せるタブ` と `app/ext/10-buttons.mjs:43`・`50-fieldbuttons.mjs:36` の
 * `今のURL` は**モジュールの変数**で、要求ごとに上書きされる。
 * 「全部同期だから大丈夫」という前提は既に破れていて、POST 経路には
 * `await X.本文を読む(req)` がある（10-buttons.mjs:516,602 ほか 5 箇所）。
 *
 * インスタンスの中で 1 本ずつ処理すれば 3 つとも完全に塞がり、
 * **単一プロセスの常駐版と全く同じ意味論になる**（比較可能性が一番高く保たれる）。
 * 温まった画面は 8〜10ms なので 1 インスタンスで 100 req/s 出る。
 * スループットを捨てて同一性を買う。並びは Fluid compute のインスタンス数で稼ぐ。
 */
let 列 = Promise.resolve();
const 並ばせる = (fn) => (列 = 列.then(fn, fn));

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
    /**
     * **読み始める前**に effect の末尾を控える。後に取ると、読んでいる最中に入った
     * 書き込みを取りこぼす。前に取れば二重に当たるが、当て方が冪等なので害がない。
     */
    const 起点 = await 複製の起点(process.env.SUPABASE_SESSION_URL);

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

    /**
     * 書き込みの複製。**app/serve.mjs を読み込んだ後**に起こす。
     * serve.mjs:54 が `書いた後` を購読して `実行.読み直す` を呼ぶので、
     * その購読が先に並んでいないと、取り込んだ行が一覧に出ない。
     */
    複製 = await import("./db/replicate.mjs");
    複製.始める({ db, url: process.env.SUPABASE_SESSION_URL, 起点 });
    状態.複製 = { 起点 };

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

const server = http.createServer(async (req, res) => {
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

  if (u.pathname === "/_replicate") {
    return 出す(200, "application/json; charset=utf-8",
      JSON.stringify(複製?.様子 ? 複製.様子() : { 複製: "動いていません" }));
  }

  /**
   * ここから先は 1 本ずつ。前の要求が終わってから次を始める。
   *
   *   （書き込みなら）錠を取る → 取り込む → 内側へ流す → 送り出す → 錠を返す → 応答
   *
   * **応答を返す前に送り出す。** 先に返すと、利用者が「保存できた」と思った後で
   * Supabase への書き出しが落ちる窓ができる。
   */
  並ばせる(async () => {
    const 書く = 書きに来た(req, u);
    try {
      if (複製?.動いている?.()) {
        if (書く) await 複製.錠を取る();
        await 複製.取り込む();
      }
      const 返り = await 内側へ流す(req);
      /**
       * 書き込みが走っていれば送り出す。**書く経路だと思っていない要求でも確かめる。**
       * 経路の見落としで静かに消えるより、錠なしでも残るほうがよい（そのときは印を出す）。
       */
      if (複製?.動いている?.()) {
        const n = await 複製.送り出す();
        if (n && !書く) console.error(`× 書き込みの経路として数えていない要求が ${n} 行を書きました: ${req.method} ${u.pathname}`);
      }
      res.writeHead(返り.code, 返り.頭);
      res.end(返り.体);
    } catch (e) {
      console.error("受付で落ちました:", e);
      if (!res.headersSent) 出す(502, "text/plain; charset=utf-8", `受付で落ちました: ${e?.message ?? e}\n`);
      else res.destroy();
    } finally {
      if (複製?.動いている?.()) await 複製.錠を返す().catch((e) => console.error("錠を返せません:", e));
    }
  });
});

/**
 * 内側の `app/serve.mjs` へ流し、**応答を受け切ってから**返す。
 * 受け切るのは、書き込みが終わったことを確かめてから利用者に返すため。
 * 一番大きい応答は CSV の 5.26MB（実測）なので、抱えても差し支えない。
 */
function 内側へ流す(req) {
  return new Promise((解決, 拒否) => {
    const r = http.request(
      { host: "127.0.0.1", port: 内側, path: req.url, method: req.method,
        headers: { ...req.headers, host: `127.0.0.1:${内側}` } },
      (ir) => {
        const 塊 = [];
        ir.on("data", (d) => 塊.push(d));
        ir.on("end", () => {
          const 体 = Buffer.concat(塊);
          const 頭 = { ...ir.headers };
          /** 受け切ったので長さは自分で言う。元の content-length は当てにしない */
          delete 頭["content-length"]; delete 頭["transfer-encoding"];
          頭["content-length"] = String(体.length);
          解決({ code: ir.statusCode ?? 502, 頭, 体 });
        });
        ir.on("error", 拒否);
      });
    r.on("error", (e) => 拒否(new Error(`内側へ流せませんでした: ${e.code ?? e.message}`)));
    req.pipe(r);
  });
}

server.listen(PORT, () => console.log(`http://localhost:${PORT}  （用意しています…）`));
