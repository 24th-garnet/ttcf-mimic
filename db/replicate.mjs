/**
 * 書き込みを Supabase へ流し、他のインスタンスから取り込む。
 *
 *   import { 始める, 取り込む, 送り出す, 錠を取る, 錠を返す } from "./db/replicate.mjs";
 *
 * ■ なぜ受付でやるか
 *
 * ミミックは全部が同期で書かれている（`async` 関数は 0 本・`.prepare(` が 442 箇所）。
 * 書き込みの途中から Postgres を叩こうとすると `db/write.mjs` と `db/actions.mjs`（103KB）を
 * async 化することになり、**漏れを作る最短路**になる。
 * 計画では worker_threads ＋ `Atomics.wait` の同期ブリッジを置くとしていたが、
 * `server.mjs` の受付が内側の `app/serve.mjs` へ流す作りなので、
 * **要求が終わってから流せば足りる**。同期ブリッジは要らない。
 *
 *   受付 → （書き込みなら）錠を取る → 取り込む → 内側へ流す → 送り出す → 錠を返す → 応答
 *
 * **`db/write.mjs`・`db/actions.mjs`・`app/serve.mjs` を一行も変えない。**
 *
 * ■ 何を送るか — 「意図」ではなく「やった結果」
 *
 * `write_log` は意図の記録で、これを再生しても同じにはならない
 * （採番の値・`link` の変更・再計算の結果が載っていない。行IDは乱数で決まる）。
 * だから**書き終わった後の行の最終形**をそのまま送る。
 * 受け取る側は UPSERT / DELETE として当てるだけで、`検証()` も `採る()` も `乱英数()` も走らない。
 * 冪等で、`seq` 順なら決定的。
 *
 * 触った行は `書いた後`（`db/write.mjs:57`）の購読で集める。
 * **再計算で触れた親の行もここに入る**（`知らせる` の `行たち`）ので、取りこぼさない。
 *
 * ■ 採番
 *
 * `db/write.mjs:247` の `採る()` はインメモリの `counter` を読んで書く。
 * 2 インスタンスが同時に走ると**同じ番号を配る**。
 * 書き込みの間だけ Postgres のアドバイザリロックで世界に 1 本にすれば、
 * `採る()` を触らずに直る（取る → 取り込む → 書く、の順なので最新の counter を見る）。
 */
import pg from "pg";
import { 書いた後, 外から知らせる } from "./write.mjs";

/** アドバイザリロックの鍵。db/pg/003_effect.sql に由来を書いてある。 */
const 鍵 = 8787001;

let db = null;
let 池 = null;             // 取り込み・送り出し用
let 錠の接続 = null;        // **錠は同じ接続で取って返す。** 別接続だと返せない
let 位置 = 0;              // ここまで当てた effect.seq
let 私 = "?";
let 触った = new Set();    // いまの要求で触った行
let 動き = new Set();      // createRow / updateRow / deleteRow / triggerWorkflow
let 最後のwrite_log = 0;   // ここまで送った write_log.seq
let 送った = 0, 取り込んだ = 0;

/**
 * 起動時に一度だけ。`server.mjs` が hydrate の後に呼ぶ。
 * `起点` は hydrate が**読み始める前**の `max(seq)`。
 * 後に取ると、読んでいる最中に入った書き込みを取りこぼす
 * （前に取れば二重に当たるが、当て方が冪等なので害がない）。
 */
export function 始める({ db: 器, url, 起点 = 0, 名 = null }) {
  db = 器;
  位置 = 起点;
  私 = 名 ?? process.env.VERCEL_DEPLOYMENT_ID ?? `pid${process.pid}`;
  池 = new pg.Pool({ connectionString: url, max: 3, connectionTimeoutMillis: 15_000, idleTimeoutMillis: 30_000 });
  書いた後(({ 行たち, 動作 }) => {
    /** 取り込みで自分が鳴らしたものは数えない（他人の書き込みを送り返してしまう） */
    if (動作 === "replicate") return;
    for (const r of 行たち ?? []) 触った.add(r);
    if (動作) 動き.add(動作);
  });
  /**
   * **write_log の基準はここで取る。** 送り出すときに取ると、そのとき書いたぶんが
   * 既に入っているので `seq > 基準` が空になり、write_log が 1 件も複製されない（実測）。
   */
  最後のwrite_log = db.prepare("SELECT coalesce(max(seq),0) s FROM write_log").get().s;
  return { 位置, write_log: 最後のwrite_log };
}

export const 動いている = () => db != null && 池 != null;
export const 様子 = () => ({ 位置, 送った, 取り込んだ, 私, 待っている: 触った.size, write_log: 最後のwrite_log });

/* ═══════════════ 錠 ═══════════════ */

/** 書き込みの間だけ世界で 1 本にする。`採る()` が同じ番号を配らないようにするため。 */
export async function 錠を取る() {
  if (!動いている()) return;
  錠の接続 = await 池.connect();
  await 錠の接続.query("select pg_advisory_lock($1)", [鍵]);
}

export async function 錠を返す() {
  if (!錠の接続) return;
  const c = 錠の接続; 錠の接続 = null;
  try { await c.query("select pg_advisory_unlock($1)", [鍵]); } finally { c.release(); }
}

/* ═══════════════ 取り込む ═══════════════ */

/** 他のインスタンスが書いたものを当てる。当てた行数を返す。 */
export async function 取り込む() {
  if (!動いている()) return 0;
  const r = await 池.query(
    "select seq, rows, links, counters, logs from effect where seq > $1 order by seq", [位置]);
  if (!r.rows.length) return 0;

  const 全部 = new Set();
  for (const e of r.rows) {
    当てる(JSON.parse(e.rows), JSON.parse(e.links), JSON.parse(e.counters), JSON.parse(e.logs), 全部);
    位置 = Number(e.seq);
  }
  /**
   * クエリエンジンの断面を追随させる。`app/serve.mjs:54` が `書いた後` で
   * `実行.読み直す(行たち)` を呼んでいるので、同じ道に流す。
   * これが無いと、他のインスタンスが作った行が一覧に出ない。
   */
  外から知らせる({ 動作: "replicate", 表ID: null, 行ID: null, 行たち: [...全部] });
  取り込んだ += 全部.size;
  /** 自分が当てたぶんで送り出しが起きないようにする（これは他人の書き込みである） */
  触った.clear(); 動き.clear();
  最後のwrite_log = db.prepare("SELECT coalesce(max(seq),0) s FROM write_log").get().s;
  return 全部.size;
}

/**
 * 効果を 1 つ当てる。**rowid は書いた側の値を明示で入れる。**
 * SQLite に任せるとインスタンスごとに違う値が付き、`ORDER BY rowid` の 9 箇所で並びが割れる。
 */
function 当てる(行たち, 辺, カウンタ, ログ, 全部) {
  db.exec("BEGIN");
  try {
    const 消す行 = db.prepare("DELETE FROM row WHERE id=?");
    const 置く行 = db.prepare(
      `INSERT INTO row(rowid,id,tbl,cells,calc,snap,implied,src,loaded) VALUES(?,?,?,?,?,?,?,?,?)
       ON CONFLICT(id) DO UPDATE SET tbl=excluded.tbl, cells=excluded.cells, calc=excluded.calc,
         snap=excluded.snap, implied=excluded.implied, src=excluded.src, loaded=excluded.loaded`);
    for (const x of 行たち) {
      全部.add(x.id);
      if (x.消す) { 消す行.run(x.id); continue; }
      置く行.run(x._rowid, x.id, x.tbl, x.cells, x.calc, x.snap, x.implied, x.src, x.loaded);
    }
    /** 辺は「触った行に繋がるものを全部消してから入れ直す」。差分を持たなくて済む */
    const 辺を消す = db.prepare("DELETE FROM link WHERE src_row=? OR dst_row=?");
    for (const r of 辺.触った) { 辺を消す.run(r, r); 全部.add(r); }
    const 辺を置く = db.prepare(
      "INSERT INTO link(rowid,src_row,fld,dst_row,ord) VALUES(?,?,?,?,?) ON CONFLICT(src_row,fld,dst_row) DO UPDATE SET ord=excluded.ord");
    for (const e of 辺.辺) { 辺を置く.run(e._rowid, e.src_row, e.fld, e.dst_row, e.ord); 全部.add(e.src_row); 全部.add(e.dst_row); }

    const 数 = db.prepare("INSERT INTO counter(rowid,fld,next) VALUES(?,?,?) ON CONFLICT(fld) DO UPDATE SET next=excluded.next");
    for (const c of カウンタ) 数.run(c._rowid, c.fld, c.next);

    /** write_log は seq を明示で入れる。`app/ext/30-detail.mjs:325` が max(seq) を見る */
    const 記 = db.prepare(
      'INSERT INTO write_log(rowid,seq,at,action,tbl,"row",origin,before,after,note) VALUES(?,?,?,?,?,?,?,?,?,?) ON CONFLICT(seq) DO NOTHING');
    for (const l of ログ) 記.run(l._rowid, l.seq, l.at, l.action, l.tbl, l.row_id, l.origin, l.before, l.after, l.note);

    db.exec("COMMIT");
  } catch (e) { db.exec("ROLLBACK"); throw e; }
}

/* ═══════════════ 送り出す ═══════════════ */

/**
 * いまの要求で書いたものを Supabase へ。書いていなければ何もしない。
 *
 * ■ rowid を必ず運ぶ
 *
 * `ORDER BY rowid` が 9 箇所ある（`db/actions.mjs:849` の締処理の行選択、
 * `app/doc-mfg.mjs:235` の仕掛品の並びは実物 8 品と 8/8 一致と明記）。**順序は機能である。**
 * 再生側で SQLite に任せると、インスタンスごとに違う rowid が付いて並びが割れる。
 * だから書いた側の rowid をそのまま運び、受け取る側は**明示で**入れる。
 * 書き込みは錠で世界に 1 本ずつなので、全インスタンスが同じ順で同じ rowid を入れる。
 */
export async function 送り出す() {
  if (!動いている() || !触った.size) { 触った.clear(); return 0; }
  const 行ID = [...触った];
  const o = [...動き].join(",") || null;
  触った.clear(); 動き.clear();

  /** メモリの**いまの形**をそのまま持ち出す。意図ではなく結果を送る */
  const 印 = 行ID.map(() => "?").join(",");
  const 生きている = new Map(db.prepare(
    `SELECT rowid AS _rowid,id,tbl,cells,calc,snap,implied,src,loaded FROM row WHERE id IN (${印})`)
    .all(...行ID).map((r) => [r.id, r]));
  const 行たち = 行ID.map((id) => 生きている.get(id) ?? { id, 消す: true });
  const 辺 = db.prepare(
    `SELECT rowid AS _rowid,src_row,fld,dst_row,ord FROM link WHERE src_row IN (${印}) OR dst_row IN (${印})`)
    .all(...行ID, ...行ID);
  const カウンタ = db.prepare("SELECT rowid AS _rowid,fld,next FROM counter").all();
  const ログ = db.prepare(
    'SELECT rowid AS _rowid,seq,at,action,tbl,"row" AS row_id,origin,before,after,note FROM write_log WHERE seq > ? ORDER BY seq')
    .all(最後のwrite_log);

  const c = await 池.connect();
  try {
    await c.query("BEGIN");
    /** ① 効果ログ。他のインスタンスはこれを見て追いつく */
    const r = await c.query(
      `insert into effect(at,who,note,rows,links,counters,logs) values($1,$2,$3,$4,$5,$6,$7) returning seq`,
      [new Date().toISOString(), 私, o, JSON.stringify(行たち),
       JSON.stringify({ 触った: 行ID, 辺 }), JSON.stringify(カウンタ), JSON.stringify(ログ)]);

    /** ② 記録の本体。次のコールドスタートはここだけを読む（hydrate は変えない） */
    await 本体へ当てる(c, 行たち, 行ID, 辺, カウンタ, ログ);

    await c.query("COMMIT");
    位置 = Number(r.rows[0].seq);
    送った++;
    if (ログ.length) 最後のwrite_log = ログ[ログ.length - 1].seq;
    return 行ID.length;
  } catch (e) { await c.query("ROLLBACK").catch(() => {}); throw e; }
  finally { c.release(); }
}

/**
 * Postgres の本体へ当てる。**名前は db/pg/mapping.mjs のとおり**
 * （row は予約語なので rec_row、write_log.row は row_id）。
 * `_rowid` はどの表も NOT NULL で既定値が無いので、必ず入れる。
 */
async function 本体へ当てる(c, 行たち, 行ID, 辺, カウンタ, ログ) {
  for (const x of 行たち) {
    if (x.消す) { await c.query("delete from rec_row where id=$1", [x.id]); continue; }
    await c.query(
      `insert into rec_row(_rowid,id,tbl,cells,calc,snap,implied,src,loaded)
       values($1,$2,$3,$4,$5,$6,$7,$8,$9)
       on conflict (id) do update set tbl=excluded.tbl, cells=excluded.cells, calc=excluded.calc,
         snap=excluded.snap, implied=excluded.implied, src=excluded.src, loaded=excluded.loaded`,
      [x._rowid, x.id, x.tbl, x.cells, x.calc, x.snap, x.implied, x.src, x.loaded]);
  }
  if (行ID.length) await c.query("delete from link where src_row = any($1) or dst_row = any($1)", [行ID]);
  for (const e of 辺) {
    await c.query(
      `insert into link(_rowid,src_row,fld,dst_row,ord) values($1,$2,$3,$4,$5)
       on conflict (src_row,fld,dst_row) do update set ord=excluded.ord`,
      [e._rowid, e.src_row, e.fld, e.dst_row, e.ord]);
  }
  for (const x of カウンタ) {
    await c.query(
      "insert into counter(_rowid,fld,next) values($1,$2,$3) on conflict (fld) do update set next=excluded.next",
      [x._rowid, x.fld, x.next]);
  }
  for (const l of ログ) {
    await c.query(
      `insert into write_log(_rowid,seq,at,action,tbl,row_id,origin,before,after,note)
       values($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) on conflict (seq) do nothing`,
      [l._rowid, l.seq, l.at, l.action, l.tbl, l.row_id, l.origin, l.before, l.after, l.note]);
  }
}
