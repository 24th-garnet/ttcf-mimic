/**
 * **レコード詳細（recordContainer）と入口（queryContainer / rowSelector / inbox / filter）を、現行と同じ入れ子で描く。**
 * ローカルDBと crawl/out の生レイアウトだけを読む。外へは一切つながない。
 *
 * ■ 何を描くか（要素 3,242 個のうち、これまで平らに並べるか描いていなかったもの）
 *
 *   recordContainer  53   type='row' の画面の骨。受け口（slotType）は title / section / callToAction の 3 つ
 *   section         168   見出し（label。94 個が名前あり）と見せる条件（visible_when）を持つ箱。中身は sectionGridRow
 *   sectionGridRow  742   横一列。中身は cellEditor / queryContainer / button
 *   queryContainer  266   一覧の器。固定の絞り込み・絞り込み帯の列・利用者に開放する操作・CSV の可否を持つ。
 *                         器の元（source）は table 206 / foreignKey 45（row 画面で「この行の関連先」を出すもの）
 *   rowSelector      30   母集団から 1 行選ぶ箱（entry 画面）。選んだ行が出力 selectedRow=peo… になり、
 *                         その出力を source に持つ一覧（26 本）は選んだ行の関連先だけを出す
 *   inbox             2   左に一覧、右に選んだ行の詳細
 *   filter           19   絞り込み帯。DB の spec は空なので生レイアウトの elementById を読む
 *
 * ■ 親子は elem.path で分かる。並びと結び付きは生レイアウトに要る
 *
 *   親子     path の最後の「型:pel…」が直近の親（section → sectionGridRow → cellEditor …）
 *   並び     DB に順序の列が無い。生レイアウトの slotElementsById / horizontalBarRowById / elementRowById /
 *            columnsRowById / columnById が fractional index（"a0" < "a0V" < "a1"。文字列比較でよい）を持つので、
 *            path 上の各節の index を並べた鍵で兄弟を並べる。生が無いときは rowid（取り込み順）
 *   器と一覧  別の canvasArea に置かれて親子になっていない。一覧の 段のクエリ.1.source.query.outputId が
 *            器の 出力 "query=peo…" と一致するもの（177 本のうち 156 が DB だけで結べる。残りは生の outputs で結ぶ）
 *   器の元   DB の spec に無い（source が写されていない）。生の elementById[器].source を読む。
 *            foreignKey なら foreignRow.outputId（根の行 か rowSelector の行）の関連先だけを出す
 *   帯       filter 要素の spec は空。生の filters.filterSet（列と比べ方）と outputs.interactiveFilters.id を読み、
 *            一覧 / inbox / rowSelector の query.interactiveFilters.outputId で結ぶ（19 本すべて結べた）
 *   根の行   row 画面は生の rootRowContainer.output.id。無ければ「この画面のどの要素も出していない出どころ」
 *   面の連鎖  面（canvasArea）は 1 つの canvas（横棒・行の面・全面要素）を持ち、横棒は下の面（canvasAreaId）を、
 *            全面要素の inbox は canvasAreaId の面を、器は viewCanvasAreas の面を持つ。inbox の右側に何が置かれて
 *            いるかはこの連鎖（面の索引）で決める。実測 2 画面とも root 面 → 横棒 → 面 → 全面(inbox) → 面 → 行の面。
 *            クロールが写した path は横棒と面を繰り返して写しているだけで、この連鎖が読めない
 *
 * ■ 一覧の行はどう決めるか
 *
 *   器の固定の絞り込み（staticFilters）は現行では一覧に掛かっている（例: 売掛一覧 pagCuLzzkAl9xnIQx は
 *   売上登録=true かつ 請求締日 空）。serve.mjs の 一覧の行 は leafLevel.filters しか見ないので、ここで
 *   器の固定の絞り込み・帯の値・利用者の絞り込みを and で束ねる。
 *
 *   **節は 3 つに分けて当てる（節を分ける）。** クエリエンジン（文脈.実行 = db/query.mjs）は cells → calc しか読まず、
 *   要求されていない列は「判定できない」で行を落とす。そのまま渡すと 売上登録 = 空（rowSelector の母集団）が 0 行になる。
 *     引ける  列の値が cells / calc / snap にある（checkbox は要求が半数以上）→ 文脈.実行 に渡す（並びも任せる）
 *     判定    値は無いが含意（row.implied。画面の所属から決まった値）がある → 計算器.通る で当て直す
 *             固定の絞り込み 465 節のうち 147 節がこれ（売上登録 31 器・入庫登録 39 器・振替登録 15 器 …）
 *     外す    手元に値も含意も無い列（無名の lookup / formula が大半。140 節）→ 条件を外し、外したと画面に書く。
 *             0 行を出すより「現行より多く出ている可能性がある」と分かる形の方が確かめられる
 *   結果は (表, 絞り込み, 並び, write_log の件数) を鍵に覚える（計算器で 19,611 行を当て直すと約 1 秒かかる）。
 *   関連先だけを出す一覧は、行集合を絞る入口が 一覧を描く に無いので、同じ表示形で自前に描く。
 *   関連先は link 表の前向き（親→子）・親の cells の値・逆側の項目の後ろ向き（子→親）の和。
 *   205 本の関連が「逆にしない」で辺 0 なので、どちらか片方にしか無い（売上.出庫リンク: 前向き 0・後ろ向き 34,610）。
 *
 * ■ 行の文脈の受け渡し
 *
 *   row 画面    ?row=rec…（10-buttons・20-cells と同じ鍵）
 *   rowSelector ?sel_<peo>=rec… を正とし、/sel/<画面>/<要素> が同じ値を ?row= にも写す
 *              （ボタンの行の文脈は 10-buttons が ?row= から読むため）
 *   欄         文脈.欄を描く に、選んだ行を row に入れた URL を渡す。継承した見せる条件は節（section）側で
 *              判定するので、欄には自分の条件だけを残して渡す（二重に畳まない）。
 *              節の欄は sectionGridRow（横一列）をまたいでまとめ、**その節の cellEditor たちを 1 回の 欄を描く に渡す**
 *              （ボタン・器が挟まればそこで区切る）。行ごとに箱を分けると 1 節 9 箱になり、現行の 1 枚の形と違う
 *
 * ■ 描かないもの
 *
 *   dashboard 型の画面、集計要素（bigNumber / chart / pivotTable / text / attachmentCarousel / rowActivityFeed /
 *   verticalStack）は別工程。文脈.拡張.要素 に描き手があれば呼び、無ければ「その他の要素」に残す。
 *   type='row' でも layout_kind が formContainer の 6 画面（モーダルの純正フォーム）は今までどおり。
 */
import fs from "node:fs";
import path from "node:path";
import { decodeAirFile } from "../../crawl/lib/airmsg.mjs";

let X = null;                 // 文脈（準備で受ける）
const 起動 = new Date().toISOString();

/** ─── 生レイアウト ─── */
const 生の断面 = "pages-20260911";
/** 09-11 の断面で本文が来なかった 15 画面（売上一覧・出庫一覧・出荷実績 × 5 束）だけ、09-12 に --bridge で取り直した置き場。無い画面はこちらを見る */
const 補いの断面 = "pages-20260912-layout";
const 生の頁 = new Map();      // pid → publishedLayout
const 開いた = new Set();
/** 画面のファイルにはその応答に入っていた画面ぶんのレイアウトが入っている（実測 1〜36 画面）。開いたら全部覚える */
function 生レイアウト(pid) {
  if (!生の頁.has(pid) && !開いた.has(pid)) {
    開いた.add(pid);
    const p = [生の断面, 補いの断面].map((d) => path.join(X.ROOT, "crawl", "out", "raw", d, `${pid}.msgpack`)).find((x) => fs.existsSync(x)) ?? "";
    if (fs.existsSync(p)) {
      try {
        for (const pg of decodeAirFile(p)?.top?.data?.pages ?? [])
          if (pg?.id && pg.publishedLayout && !生の頁.has(pg.id)) 生の頁.set(pg.id, pg.publishedLayout);
      } catch (e) { console.error(`生レイアウト ${pid} を読めません: ${e.message}`); }
    }
  }
  return 生の頁.get(pid) ?? null;
}
const 生の要素 = (pid, pel) => 生レイアウト(pid)?.elementById?.[pel] ?? null;

/** 並びを持つ節（slot / bar / row / column …）を ID で引く */
const 節の索引 = new Map();
function 節を引く(pid, id) {
  if (!節の索引.has(pid)) {
    const l = 生レイアウト(pid);
    const m = new Map();
    if (l) for (const k of ["slotElementsById", "horizontalBarRowById", "horizontalBarElementById", "elementRowById", "columnsRowById", "columnById", "canvasAreaById", "horizontalBarById", "rowCanvasById", "fullCanvasElementById"])
      for (const [id2, n] of Object.entries(l[k] ?? {})) m.set(id2, n);
    節の索引.set(pid, m);
  }
  return 節の索引.get(pid).get(id) ?? null;
}

/**
 * 生の置き場の構造から、要素 → 面（canvasArea）と、面 → 子の面 を組む。
 * 面は 1 つの canvas（横棒 / 行の面 / 全面要素）を持ち、横棒は下の面（canvasAreaId）を、全面要素の inbox は
 * canvasAreaId の面を、器は viewCanvasAreas の面を持つ。実測: 受信箱 2 画面（原価計算・月間原価計算 review）とも
 * root 面 → 横棒 → 面 → 全面(inbox) → 面 → 行の面 の連鎖で、inbox の右側の欄はこの連鎖の先に置かれている。
 * クロールが写した path は横棒と面を繰り返して写しているだけ（40 段）で、どの面に属すかが読めない。
 */
const 面の記憶 = new Map();
function 面の索引(pid) {
  if (面の記憶.has(pid)) return 面の記憶.get(pid);
  const 生 = 生レイアウト(pid);
  const 要素の面 = new Map(), 子の面 = new Map();
  if (生) {
    const 面of = new Map();   // canvasId → 面ID
    for (const [id, a] of Object.entries(生.canvasAreaById ?? {})) if (a?.canvasId) 面of.set(a.canvasId, id);
    const 足す = (親, 子) => { if (親 && 子 && 親 !== 子) (子の面.get(親) ?? 子の面.set(親, []).get(親)).push(子); };
    for (const [id, b] of Object.entries(生.horizontalBarById ?? {})) 足す(面of.get(id), b?.canvasAreaId);
    for (const [id, f] of Object.entries(生.fullCanvasElementById ?? {})) if (f?.elementId) 要素の面.set(f.elementId, 面of.get(id));
    for (const x of Object.values(生.horizontalBarElementById ?? {})) if (x?.elementId) 要素の面.set(x.elementId, 面of.get(生.horizontalBarRowById?.[x.parentId]?.parentId));
    for (const x of Object.values(生.elementRowById ?? {})) {
      if (!x?.elementId) continue;
      const 列 = 生.columnById?.[x.parentId];
      const 行 = 生.columnsRowById?.[列?.parentId ?? x.parentId];
      要素の面.set(x.elementId, 面of.get(行?.parentId ?? 列?.parentId ?? x.parentId));
    }
    for (const [id, e] of Object.entries(生.elementById ?? {})) {
      if (e?.canvasAreaId) 足す(要素の面.get(id), e.canvasAreaId);
      for (const v of e?.viewCanvasAreas ?? []) 足す(要素の面.get(id), v?.canvasAreaId);
    }
  }
  const 子孫 = (面) => { const out = new Set(); const 見る = (a) => { for (const c of 子の面.get(a) ?? []) if (!out.has(c)) { out.add(c); 見る(c); } }; if (面) 見る(面); return out; };
  const r = { 要素の面, 子孫, ある: !!生 };
  面の記憶.set(pid, r);
  return r;
}

/** ─── 経路（elem.path）─── */
const spec = (e) => { try { return e.spec ? JSON.parse(e.spec) : {}; } catch { return {}; } };
const 路を読む = (e) => { try { return JSON.parse(e.path ?? "[]"); } catch { return []; } };
const 段の型 = (s) => String(s).slice(0, String(s).indexOf(":"));
const 段のID = (s) => String(s).slice(String(s).indexOf(":") + 1);
/** 直近の親要素（pel…）。section / sectionGridRow / recordContainer / queryContainer … */
function 親要素(e) {
  const 路 = 路を読む(e);
  for (let i = 路.length - 1; i >= 0; i--) { const id = 段のID(路[i]); if (id.startsWith("pel") && id !== e.id) return id; }
  return null;
}
/**
 * 置き場。entry 画面は 横棒（bar）と 面（canvas: 行 → 列 → 段）と 全面（full: 器や inbox が面いっぱい）。
 * クロールが写した path は横棒と面の節を何度も繰り返している（実測 40 段）ので、末尾から読む。
 */
function 置き場を読む(e) {
  const 路 = 路を読む(e);
  const 型 = 路.map(段の型);
  const 末 = 型[型.length - 1];
  if (末 === "horizontalBarElement") {
    const 行 = [...路].reverse().find((s) => 段の型(s) === "horizontalBarRow");
    return { 種: "bar", 行: 行 ? 段のID(行) : null, 位: 段のID(路[路.length - 1]) };
  }
  const iRC = 型.lastIndexOf("rowCanvas");
  if (iRC >= 0 && !路.slice(iRC + 1).some((s) => 段のID(s).startsWith("pel"))) {
    const 尾 = 路.slice(iRC);
    const 面 = iRC > 0 && 型[iRC - 1] === "canvasArea" ? 段のID(路[iRC - 1]) : 段のID(路[iRC]);
    const 列 = 尾.find((s) => 段の型(s) === "column");
    const 行 = 尾.find((s) => 段の型(s) === "columnsRow") ?? 尾.find((s) => 段の型(s) === "elementRow");
    const 段 = [...尾].reverse().find((s) => 段の型(s) === "elementRow");
    return { 種: "canvas", 面, 行: 行 ? 段のID(行) : null, 列: 列 ? 段のID(列) : null, 段: 段 ? 段のID(段) : null };
  }
  const iFull = 型.lastIndexOf("fullCanvasElement");
  if (iFull >= 0 && !路.slice(iFull + 1).some((s) => 段のID(s).startsWith("pel")))
    return { 種: "full", 面: iFull > 0 ? 段のID(路[iFull - 1]) : null };
  return { 種: "内", 親: 親要素(e) };
}
/** 並びの鍵。path 上の節の index を順に並べる。兄弟の比較では接頭が同じなので末尾の index で決まる */
function 並び鍵(pid, e) {
  const 鍵 = [];
  for (const s of 路を読む(e)) { const n = 節を引く(pid, 段のID(s)); if (n?.index != null) 鍵.push(String(n.index)); }
  return 鍵;
}
function 比べる(a, b) {
  for (let i = 0; i < Math.max(a.length, b.length); i++) { const x = a[i] ?? "", y = b[i] ?? ""; if (x !== y) return x < y ? -1 : 1; }
  return 0;
}
const 並べ替え = (pid, xs) => xs.map((e) => [並び鍵(pid, e), e]).sort((p, q) => 比べる(p[0], q[0]) || (p[1].順 - q[1].順)).map((x) => x[1]);

/** ─── 行 ─── */
const 取る = (rid) => (rid ? X.書き込み.計算器.取る(rid) : null);
const 値 = (行, fid) => X.書き込み.計算器.値(行, fid, true);
const 主項目 = new Map();
function 表示名(行) {
  if (!行) return "";
  if (!主項目.has(行.tbl)) 主項目.set(行.tbl, X.db.prepare("SELECT primary_fld FROM tbl WHERE id=?").get(行.tbl)?.primary_fld ?? null);
  const 主 = 主項目.get(行.tbl);
  const s = 主 ? String(X.書く(値(行, 主), X.項目.get(主)) ?? "") : "";
  return s || 行.id;
}
/** lookup を値の並びに平らにする（計算器の 通る は {valuesByForeignRowId} を読まない。10-buttons と同じ手） */
function 平らな行(行) {
  const 直す = (o) => {
    const out = {};
    for (const [k, v] of Object.entries(o ?? {})) {
      if (v && typeof v === "object" && !Array.isArray(v) && v.valuesByForeignRowId) {
        const 順 = v.foreignRowIdOrder ?? Object.keys(v.valuesByForeignRowId);
        out[k] = 順.flatMap((r) => { const x = v.valuesByForeignRowId[r]; return Array.isArray(x) ? x : [x]; }).filter((x) => x != null);
      } else out[k] = v;
    }
    return out;
  };
  return { ...行, cells: 直す(行.cells), calc: 直す(行.calc), snap: 直す(行.snap), implied: 直す(行.implied) };
}
const 条件に合う = (行, 条件) => { try { return X.書き込み.計算器.通る(平らな行(行), X.書き込み.条件を直す(条件)); } catch { return true; } };
/** and で束ねる。null は捨てる */
const 全部で = (...xs) => { const a = xs.filter((x) => x?.filterSet?.length); return a.length === 0 ? null : a.length === 1 ? a[0] : { conjunction: "and", filterSet: a }; };

/**
 * 起動後に触った行を足す。**クエリエンジン（文脈.実行）は起動時の断面しか見ない**（db/query.mjs は 作る(db) で全行を読む）。
 * write_log で起動後に触った行だけ、計算器の 通る で今の値に当て直す（20-cells の 母集団 と同じ手）
 */
function 触った行を足す(表ID, 絞り込み, 行) {
  if (!表ID) return 行;
  const 触った = X.db.prepare("SELECT DISTINCT row FROM write_log WHERE tbl=? AND at>=?").all(表ID, 起動).map((r) => r.row);
  if (!触った.length) return 行;
  const s = new Set(触った);
  const out = 行.filter((rid) => !s.has(rid));
  for (const rid of 触った) { const e = 取る(rid); if (e && (!絞り込み || 条件に合う(e, 絞り込み))) out.push(rid); }
  return out;
}

/** ─── 絞り込みの節を、引ける・判定・外す に分ける ─── */
const 覆いの記憶 = new Map();   // 表ID|項目ID → { 行数, 有, 含意, 要求 }
/**
 * 列が手元でどれだけ埋まっているか。**クエリエンジンは cells / calc しか読まないので、含意（implied）だけの列は別に当てる。**
 * json_type は値が JSON の null でも 'null' を返す（含意の「空」は null で入っている）。
 * 3 万行の表で 100ms ほどかかるので起動中は覚える（行の値は起動後に変わっても、列が手元にあるか無いかは変わらない）
 */
function 列の覆い(表ID, fid) {
  const k = `${表ID}|${fid}`;
  if (覆いの記憶.has(k)) return 覆いの記憶.get(k);
  const p = `$.${fid}`;
  const 行数 = X.db.prepare("SELECT count(*) c FROM row WHERE tbl=?").get(表ID).c;
  const 有 = X.db.prepare("SELECT count(*) c FROM row WHERE tbl=? AND (json_type(cells,?) IS NOT NULL OR json_type(calc,?) IS NOT NULL OR json_type(snap,?) IS NOT NULL)").get(表ID, p, p, p).c;
  const 含意 = X.db.prepare("SELECT count(*) c FROM row WHERE tbl=? AND json_type(implied,?) IS NOT NULL").get(表ID, p).c;
  const 要求 = X.db.prepare("SELECT count(*) c FROM requested WHERE fld=?").get(fid).c;
  const r = { 行数, 有, 含意, 要求 };
  覆いの記憶.set(k, r);
  return r;
}
/**
 * 節を 3 つに分ける。
 *   引ける  エンジンが見る cells / calc に値がある列（checkbox は要求が半数以上のとき。未要求の checkbox は「判定できない」になる）
 *   判定    値は無いが含意がある列。計算器.通る（cells → calc → snap → implied を読む）で当て直す
 *   外す    値も含意も無い列。条件から外し、外したことを控える（画面に書く）
 * 入れ子の and は平らにする（and の and は and）。or の集合は分けられないので丸ごと 1 つとして扱う。
 * 関連の副問い合わせ（sourceColumnId）はエンジンだけが解けるので引ける側へ。
 * 利用者が動かす絞り込み（source が arbitraryColumnFilters）で値の無い節は、エンジンが無視するのと同じく捨てる
 */
function 節を分ける(表ID, 絞り込み) {
  const 外した = [], 含意で = new Set();
  const 葉の種 = (f) => {
    if (f.sourceColumnId || f.type === "foreignKey" || !f.columnId) return "引ける";
    const t = X.項目.get(f.columnId)?.type;
    /** 関連項目はエンジン（query.mjs の 値()）が link 表の辺（両向き）から値を起こす。辺が 1 本でもあれば引ける */
    if (t === "foreignKey") {
      const 逆 = X.項目.get(f.columnId)?.opts?.逆側の項目 ?? null;
      const 辺 = X.db.prepare("SELECT count(*) c FROM link WHERE fld=? OR fld=?").get(f.columnId, 逆 ?? "").c;
      if (辺 > 0) return "引ける";
    }
    const c = 列の覆い(表ID, f.columnId);
    if (c.有 === 0 && c.含意 === 0) return "外す";
    /** checkbox は行ごとに「要求された行では空＝false、未要求は不明」と決まる性質。列ごとの割合では決められないので常に計算器に回す */
    if (t === "checkbox") return "判定";
    if (c.有 > 0 && c.含意 <= c.有) return "引ける";
    return "判定";
  };
  /** 外す葉を刈り、and の入れ子を平らにする。集合の source は葉に写す（エンジンが arbitraryColumnFilters を見るため） */
  const 刈る = (f, 出どころ = null) => {
    if (!f) return null;
    const s = f.source ?? 出どころ;
    if (f.filterSet) {
      const 子 = [];
      const 前 = 外した.length;
      for (const x of f.filterSet) {
        const y = 刈る(x, s);
        if (!y) continue;
        if (y.filterSet && (y.conjunction ?? "and") === "and" && (f.conjunction ?? "and") === "and") 子.push(...y.filterSet);
        else 子.push(y);
      }
      /**
       * **or の一部だけを残してはいけない。** 判定できない枝を落として残りだけ当てると、落とした枝で通るはずの行が消える（狭める向きの誤り）。
       * 製造/入庫の一覧「A が空でない または B が空でない または C が空でない」で A だけ残し、2020-01-01 の行が消えた（2026-09-13）。
       * or の枝が 1 つでも外れたら or 全体を外し、まとめて記録する（広がる向きに倒す）
       */
      if ((f.conjunction ?? "and") === "or" && 外した.length > 前 && 子.length) { 外した.splice(前); 外した.push(f); return null; }
      return 子.length ? { ...f, filterSet: 子 } : null;
    }
    if (s === "arbitraryColumnFilters" && f.value == null && !f.sourceColumnId && !["isEmpty", "isNotEmpty"].includes(f.operator)) return null;
    const 種 = 葉の種(f);
    if (種 === "外す") { 外した.push(f); return null; }
    if (種 === "判定") 含意で.add(f.columnId);
    return s && !f.source ? { ...f, source: s } : f;
  };
  const 全体 = 刈る(絞り込み);
  const 引けるか = (f) => f.filterSet ? f.filterSet.every(引けるか) : 葉の種(f) === "引ける";
  const 引ける = [], 判定 = [];
  if (全体?.filterSet?.length) {
    if (全体.conjunction === "or") (引けるか(全体) ? 引ける : 判定).push(全体);
    else for (const f of 全体.filterSet) (引けるか(f) ? 引ける : 判定).push(f);
  }
  const 束 = (xs) => xs.length ? { conjunction: "and", filterSet: xs } : null;
  return { 引ける: 束(引ける), 判定: 束(判定), 外した, 含意で: [...含意で] };
}

const 行集合の記憶 = new Map();   // 表|絞り込み|並び|版 → 結果
/**
 * 表の行集合を絞り込みと並びで求める。節を分けてクエリエンジンと計算器に振り分け、結果を覚える。
 * 起動後に触った行は write_log で足し直す（エンジンは起動時の断面しか見ない）。鍵に write_log の件数を含めるので、
 * 何か書けば覚えた結果は捨てられる
 */
function 行集合を求める(表ID, 絞り込み, 並び = []) {
  if (!表ID || !X.表.has(表ID)) return { 行: [], 母数: 0, 含意で: [], 外した: [], 注: [] };
  const 版 = X.db.prepare("SELECT count(*) c FROM write_log").get().c;
  const 鍵 = `${表ID}|${JSON.stringify(絞り込み ?? null)}|${JSON.stringify(並び ?? [])}|${版}`;
  if (行集合の記憶.has(鍵)) return 行集合の記憶.get(鍵);
  const 分 = 節を分ける(表ID, 絞り込み);
  const r = X.実行({ source: { type: "table", tableId: 表ID }, sorts: 並び ?? [], filters: 分.引ける });
  let 行 = r.行;
  if (分.判定) 行 = 行.filter((rid) => { const e = 取る(rid); return e && 条件に合う(e, 分.判定); });
  行 = 触った行を足す(表ID, 全部で(分.引ける, 分.判定), 行);
  const 注 = [];
  if (分.含意で.length) 注.push(`${分.含意で.map((c) => X.項目.get(c)?.name || c).join("・")} は画面の要求に無い列なので、画面の所属から決まった値（含意）で判定した`);
  if (分.外した.length) 注.push(`外した条件（手元に値も含意も無い列）: ${分.外した.map((f) => 文にする(f)).join(" / ")} — 現行より多く出ている可能性がある`);
  const out = { 行, 母数: r.母数, 含意で: 分.含意で, 外した: 分.外した, 注 };
  if (行集合の記憶.size >= 300) 行集合の記憶.delete(行集合の記憶.keys().next().value);
  行集合の記憶.set(鍵, out);
  return out;
}

/**
 * 親の行の関連先（子の行）。source が foreignKey の器・一覧が出す行。
 *   1. link 前向き（親 → 子。fld = foreignColumnId）
 *   2. 親の cells / snap の値（[{foreignRowId}]）
 *   3. link 後ろ向き（子 → 親。fld = 逆側の項目）
 *   4. 1〜3 が空なら、子の表を「逆側の項目 = 親の行ID」で引く（子の cells にだけ関連が入っている形）
 */
function 子の行集合(親, fk, 子表) {
  const out = new Set();
  const 注 = [];
  for (const r of X.db.prepare("SELECT dst_row FROM link WHERE src_row=? AND fld=? ORDER BY ord").all(親.id, fk)) out.add(r.dst_row);
  const v = 値(親, fk);
  for (const x of Array.isArray(v) ? v : []) if (x?.foreignRowId) out.add(x.foreignRowId);
  const 逆 = X.項目.get(fk)?.opts?.逆側の項目 ?? null;
  if (逆) for (const r of X.db.prepare("SELECT src_row FROM link WHERE dst_row=? AND fld=?").all(親.id, 逆)) out.add(r.src_row);
  if (!out.size && 逆 && 子表 && X.表.has(子表)) {
    const r = X.実行({ source: { type: "table", tableId: 子表 }, filters: { conjunction: "and", filterSet: [{ columnId: 逆, operator: "=", value: 親.id }] }, sorts: [] });
    for (const rid of r.行) out.add(rid);
    if (out.size) 注.push(`関連の辺が無いので子の ${X.項目.get(逆)?.name || "逆側の項目"} から引いた`);
  }
  if (子表) for (const rid of [...out]) { const e = 取る(rid); if (!e || e.tbl !== 子表) out.delete(rid); }
  return { 行: [...out], 注 };
}

/** ─── 絞り込み帯 ─── */
const 比べ方の名 = new Map([["contains", "を含む"], ["doesNotContain", "を含まない"], ["=", "＝"], ["!=", "≠"], [">", "＞"], [">=", "≧"], ["<", "＜"], ["<=", "≦"], ["isEmpty", "が空"], ["isNotEmpty", "が空でない"], ["isAnyOf", "のいずれか"], ["|", "のいずれか"], ["isNoneOf", "のいずれでもない"], ["isWithin", "の期間内"]]);
/**
 * 帯の列の比べ方。filter 要素は生に operator を持つ（contains 14 / = 9 / | 3）。器の presetFilters は列だけなので型で決める。
 * 日付は "=" だと ISO 文字列と一致しないので contains（"2026-09" で月、"2026-09-10" で日が引ける）
 */
function 既定の比べ方(fid) {
  const t = X.項目.get(fid)?.type;
  if (["select", "multiSelect", "checkbox", "number", "autoNumber", "count"].includes(t)) return "=";
  return "contains";
}
function 帯の値を型に(c, v) {
  const t = X.項目.get(c.fld)?.type;
  if (c.op === "|" || c.op === "isAnyOf" || c.op === "isNoneOf") return [v];
  if (t === "checkbox") return v === "true" ? true : v === "false" ? false : v;
  if (["number", "autoNumber", "count"].includes(t) && Number.isFinite(Number(v))) return Number(v);
  return v;
}
function 帯を集める(ctx) {
  const 帯 = [];
  for (const e of ctx.要素) {
    if (e.type === "filter") {
      const 生 = 生の要素(ctx.pid, e.id);
      const 列 = (生?.filters?.filterSet ?? []).filter((f) => f.columnId).map((f) => ({ fld: f.columnId, 名: X.項目.get(f.columnId)?.name ?? f.columnId, op: f.operator ?? 既定の比べ方(f.columnId) }));
      帯.push({ id: e.id, 種: "filter", 要素: e, 出力: 生?.outputs?.interactiveFilters?.id ?? null, 表ID: 生?.tableId ?? null, 列, 生あり: !!生 });
    } else if (e.type === "queryContainer") {
      const sp = spec(e);
      const 列 = (sp.絞り込み帯の列 ?? []).filter((c) => c?.id).map((c) => ({ fld: c.id, 名: c.名 ?? X.項目.get(c.id)?.name ?? c.id, op: 既定の比べ方(c.id), 既定: c.既定 }));
      if (列.length) 帯.push({ id: e.id, 種: "器", 要素: e, 出力: null, 表ID: e.tbl, 列, 生あり: true });
    }
  }
  for (const b of 帯) {
    b.値 = new Map();
    for (const c of b.列) {
      const v = ctx.u.searchParams.get(`b_${b.id}_${c.fld}`);
      if (v != null && v !== "") b.値.set(c.fld, v);
      else if (c.既定 != null && typeof c.既定 !== "object") b.値.set(c.fld, String(c.既定));
    }
  }
  return 帯;
}
const 帯の節 = (b) => {
  const 節 = [];
  for (const c of b.列) {
    const v = b.値.get(c.fld); if (v == null) continue;
    /** 日付の「=」: 値は ISO 日時（…T00:00:00.000Z）なので YYYY-MM-DD の入力は先頭 10 桁の contains で当てる（検証 2026-09-13: = だと 0 行） */
    const 日付 = X.項目.get(c.fld)?.type === "date" && c.op === "=" && /^\d{4}-\d{2}-\d{2}$/.test(String(v));
    節.push({ columnId: c.fld, operator: 日付 ? "contains" : c.op, value: 日付 ? String(v).slice(0, 10) : 帯の値を型に(c, v), type: "columnComparison" });
  }
  return 節.length ? { conjunction: "and", filterSet: 節 } : null;
};
/** ある出力（interactiveFilters の peo）に結ばれた帯の節。出力が分からなければ同じ表の filter 要素を当てる */
function 帯の節で出力(ctx, peo, 表ID) {
  const 該当 = ctx.帯.filter((b) => b.種 === "filter" && (peo ? b.出力 === peo : (b.表ID && b.表ID === 表ID)));
  return 該当.map(帯の節).filter(Boolean);
}
function 帯を描く(ctx, b) {
  const { E, 項目 } = X;
  const 枠 = "padding:4px 7px;border:1px solid #ccd;border-radius:4px;font:inherit";
  const 隠す = [...ctx.u.searchParams].filter(([k]) => !k.startsWith(`b_${b.id}_`) && !/^(msg|ok)_/.test(k));
  const 入力 = b.列.map((c) => {
    const f = 項目.get(c.fld);
    const 名 = `b_${b.id}_${c.fld}`;
    const 今 = b.値.get(c.fld) ?? "";
    let 欄;
    if (f?.type === "select" || f?.type === "multiSelect") {
      const m = f.opts?.選択肢ID ?? {};
      欄 = `<select name="${E(名)}" style="${枠};max-width:200px"><option value="">（すべて）</option>${Object.entries(m).map(([id, n]) => `<option value="${E(id)}"${今 === id || 今 === n ? " selected" : ""}>${E(n)}</option>`).join("")}</select>`;
    } else if (f?.type === "checkbox") {
      欄 = `<select name="${E(名)}" style="${枠}"><option value="">（すべて）</option><option value="true"${今 === "true" ? " selected" : ""}>✓</option><option value="false"${今 === "false" ? " selected" : ""}>空</option></select>`;
    } else {
      const t = ["number", "autoNumber", "count"].includes(f?.type) ? "number" : "text";
      欄 = `<input name="${E(名)}" type="${t}" value="${E(今)}" placeholder="${E(f?.type === "date" ? "YYYY-MM-DD" : "")}" style="${枠};width:${f?.type === "date" ? 130 : 160}px">`;
    }
    return `<label style="display:inline-flex;gap:4px;align-items:center;font-size:12px"><span style="color:#4a4f57">${E(c.名)}</span><span class=tag>${E(比べ方の名.get(c.op) ?? c.op)}</span>${欄}</label>`;
  }).join("");
  return `<form method=get action="/p/${E(ctx.pid)}" style="padding:8px 12px;border-bottom:1px solid #eee;background:#f6f8fb;display:flex;gap:10px;flex-wrap:wrap;align-items:center">
    ${隠す.map(([k, v]) => `<input type=hidden name="${E(k)}" value="${E(v)}">`).join("")}
    <span style="font-size:11px;color:#6b6f76;font-weight:600">絞り込み帯${b.種 === "filter" ? "（filter 要素）" : "（器の presetFilters）"}</span>
    ${入力 || '<span class=tag>列の定義が手元にありません</span>'}
    ${b.列.length ? `<button class=btn style="background:#2d7ff9;color:#fff;border:0;cursor:pointer">当てる</button>` : ""}
    ${b.値.size ? `<a class=btn style="background:var(--chip);color:var(--ink-2);text-decoration:none" href="${E(道(ctx.u, Object.fromEntries(b.列.map((c) => [`b_${b.id}_${c.fld}`, null]))))}">外す</a>` : ""}
    ${b.種 === "filter" && !b.生あり ? '<span class=cond>生レイアウトが無いので列が読めません</span>' : ""}
  </form>`;
}

/** URL を組み直す。null は消す */
function 道(u, 上書き = {}) {
  const q = new URLSearchParams(u.searchParams);
  for (const [k, v] of Object.entries(上書き)) { if (v === null || v === undefined || v === "") q.delete(k); else q.set(k, String(v)); }
  for (const k of [...q.keys()]) if (/^(msg|ok)_/.test(k)) q.delete(k);
  const s = q.toString();
  return u.pathname + (s ? "?" + s : "");
}
/** 絞り込みを読める文にする（器の見出しに出す） */
function 文にする(f, 深 = 0) {
  if (!f) return "";
  if (f.filterSet) return f.filterSet.map((x) => 文にする(x, 深 + 1)).filter(Boolean).join(f.conjunction === "or" ? " または " : " かつ ");
  if (f.sourceColumnId) return `${X.項目.get(f.sourceColumnId)?.name ?? f.sourceColumnId} の先が（${文にする(f.foreignTableFilter, 深 + 1)}）`;
  const fld = X.項目.get(f.columnId);
  const 肢 = fld?.opts?.選択肢ID ?? {};
  const v = f.value === null || f.value === undefined ? "空" : f.value === true ? "✓" : f.value === false ? "空" : Array.isArray(f.value) ? f.value.map((x) => 肢[x] ?? x).join(",") : (肢[f.value] ?? String(f.value));
  return `${fld?.name ?? f.columnId} ${比べ方の名.get(f.operator) ?? f.operator} ${["isEmpty", "isNotEmpty"].includes(f.operator) ? "" : v}`.trim();
}

/** ─── 文脈（1 画面ぶんの下ごしらえ）─── */
function 文脈を組む(p, 要素, pid, u) {
  const 生 = 生レイアウト(pid);
  const 索引 = new Map(要素.map((e) => [e.id, e]));
  const 子 = new Map();
  for (const e of 要素) { const 親 = 親要素(e); if (親 && 索引.has(親)) (子.get(親) ?? 子.set(親, []).get(親)).push(e); }
  const 置き場 = new Map(要素.map((e) => [e.id, 置き場を読む(e)]));
  /** 出力（peo…）→ それを出す要素 */
  const 出力 = new Map();
  const 剥く = (o) => String(o ?? "").replace(/^[A-Za-z]+=/, "");
  /**
   * rowSelector / queryContainer の 出力 は ["selectedRow=peo…"] の並び、inbox / formContainer は "peo…" の 1 つ。
   * （以前は for の中の if に else if が結び付いていて、inbox と formContainer の出力が一度も登録されず、
   *   受信箱で行を選んでも右側が出なかった）
   */
  for (const e of 要素) {
    if (!["rowSelector", "queryContainer", "inbox", "formContainer"].includes(e.type)) continue;
    const sp = spec(e);
    for (const o of Array.isArray(sp.出力) ? sp.出力 : [sp.出力]) { const id = 剥く(o); if (id) 出力.set(id, { 種: e.type, 要素: e }); }
  }
  /** 根の行の出力（row 画面） */
  let 根 = 生?.rootRowContainer?.output?.id ?? null;
  if (!根 && p.type === "row") {
    const 候補 = new Set();
    for (const e of 要素) { const sp = spec(e); const o = sp.行の出どころ ?? sp.対象の行?.出力 ?? sp.段のクエリ?.["1"]?.source?.foreignRow?.outputId; if (o && !出力.has(o)) 候補.add(o); }
    根 = [...候補][0] ?? null;
  }
  if (根) 出力.set(根, { 種: "root", 要素: null });

  const ctx = { p, pid, u, 要素, 索引, 子, 置き場, 出力, 根, 生, 消費: new Set(), 予約: new Set(), 描いた: new Map(), その他: [], 注: [] };
  ctx.数える = (t, n = 1) => ctx.描いた.set(t, (ctx.描いた.get(t) ?? 0) + n);
  /** 出力の表 */
  ctx.出力の表 = (peo) => {
    const 出 = 出力.get(peo);
    if (!出) return null;
    if (出.種 === "root") return p.tbl;
    const 生e = 生の要素(pid, 出.要素.id);
    return 生e?.query?.source?.tableId ?? 出.要素.tbl ?? X.表を名前で.get(spec(出.要素).母集団の表) ?? null;
  };
  /** 出力に選ばれている行。root は ?row=、rowSelector / inbox は ?sel_<peo>=（無ければ ?row= が表に合えばそれ） */
  ctx.行を引く = (peo) => {
    const 出 = 出力.get(peo);
    if (!出 || 出.種 === "formContainer" || 出.種 === "queryContainer") return null;
    const 表ID = ctx.出力の表(peo);
    const rid = (出.種 === "root" ? null : u.searchParams.get(`sel_${peo}`)) || u.searchParams.get("row") || null;
    const r = 取る(rid);
    return r && (!表ID || r.tbl === 表ID) ? r : null;
  };
  /** 一覧の器（query の出力を出している queryContainer）。DB で結べなければ生の outputs で */
  ctx.器を引く = (peo) => {
    if (!peo) return null;
    const 出 = 出力.get(peo);
    if (出?.種 === "queryContainer") return 出.要素;
    if (生) for (const [id, x] of Object.entries(生.elementById ?? {})) if (x.type === "queryContainer" && x.outputs?.query?.id === peo && 索引.has(id)) return 索引.get(id);
    return null;
  };
  ctx.帯 = 帯を集める(ctx);
  /** 一覧 → 器 の対応を先に決める（器が一覧より後に並ぶことがあるので、一覧を単独で描いてしまわないため） */
  ctx.一覧の器 = new Map();
  for (const e of 要素) if (e.type === "levels" || e.type === "grid") {
    const src = spec(e).段のクエリ?.["1"]?.source ?? 生の要素(pid, e.id)?.query?.source ?? 生の要素(pid, e.id)?.queryByLevel?.["1"]?.source ?? null;
    const 器 = src?.type === "query" ? ctx.器を引く(src.query?.outputId) : null;
    if (器) ctx.一覧の器.set(e.id, 器.id);
  }
  /**
   * inbox の面（右側の詳細）に置かれた要素。生の面の連鎖（inbox.canvasAreaId とその子孫の面）で決め、
   * 生が無ければ置き場が面（canvas）の要素と、出どころが inbox の行の欄で補う。
   * ここでは **消費ではなく予約** にする。消費にすると 面を描く / 並んだ要素を描く が飛ばしてしまい、右側に何も出ない
   */
  ctx.面 = 面の索引(pid);
  ctx.受信箱の面 = new Map();
  for (const e of 要素) if (e.type === "inbox") {
    const 生e = 生の要素(pid, e.id);
    const peo = 剥く(spec(e).出力);
    const 中の面 = 生e?.canvasAreaId ? new Set([生e.canvasAreaId, ...ctx.面.子孫(生e.canvasAreaId)]) : null;
    const 中 = 要素.filter((x) => x.id !== e.id && x.type !== "inbox" && (
      (中の面 ? 中の面.has(ctx.面.要素の面.get(x.id)) : 置き場.get(x.id).種 === "canvas") || spec(x).行の出どころ === peo));
    ctx.受信箱の面.set(e.id, 中);
    for (const x of 中) ctx.予約.add(x.id);
  }
  return ctx;
}

/** ─── 一覧 ─── */
function 一覧の材料(ctx, e) {
  const sp = spec(e);
  const 生 = 生の要素(ctx.pid, e.id);
  const q1 = sp.段のクエリ?.["1"] ?? 生?.queryByLevel?.["1"] ?? 生?.query ?? null;
  const 源 = q1?.source ?? null;
  const 表ID = 源?.tableId ?? (X.表.has(e.tbl) ? e.tbl : X.表を名前で.get(e.tbl)) ?? null;
  const 注記 = [], 追加 = [];
  let 行集合 = null, 器 = null, 親の行 = null;
  const 関連先だけ = (src) => {
    const peo = src.foreignRow?.outputId;
    const 親 = ctx.行を引く(peo);
    if (!親) { 行集合 = []; 注記.push(ctx.出力.get(peo)?.種 === "root" ? "行が選ばれていません" : "行を選ぶと、その行の関連先が出ます"); return; }
    親の行 = 親;
    const r = 子の行集合(親, src.foreignColumnId, 表ID);
    行集合 = r.行; 注記.push(...r.注);
  };
  if (源?.type === "query") {
    器 = ctx.器を引く(源.query?.outputId);
    if (器) {
      const csp = spec(器);
      if (csp.固定の絞り込み?.filterSet?.length) 追加.push(csp.固定の絞り込み);
      const b = ctx.帯.find((x) => x.id === 器.id); const 節 = b ? 帯の節(b) : null; if (節) 追加.push(節);
      const 器源 = 生の要素(ctx.pid, 器.id)?.source ?? null;
      if (器源?.type === "foreignKey") 関連先だけ(器源);
      else if (!器源 && ctx.p.type === "row") {
        /** 生が無いときの補い: 画面の表から一覧の表への関連が 1 本だけならそれ */
        const 候補 = [...X.項目.values()].filter((f) => f.tbl === ctx.p.tbl && f.type === "foreignKey" && f.opts?.関連先 === 表ID);
        if (候補.length === 1 && ctx.根) 関連先だけ({ foreignRow: { outputId: ctx.根 }, foreignColumnId: 候補[0].id });
        else 注記.push("器の元（source）が手元に無く、行の関連先に絞れません");
      }
    } else 注記.push("この一覧の器（queryContainer）が定義に見つかりません");
  }
  if (源?.type === "foreignKey") 関連先だけ(源);
  /** 帯（filter 要素）。結び付きは生の interactiveFilters。無ければ同じ表の filter */
  const 帯出力 = q1?.interactiveFilters?.outputId ?? null;
  追加.push(...帯の節で出力(ctx, 帯出力, 表ID));
  /** 行を開くと は 2 形: {type:"custom", pageId}（78 本・表IDの鍵なし）と {tbl…:{…}}（173 本）。鍵なしを読めず 72 画面でリンクが出なかった（検証 2026-09-13） */
  const 開 = sp.行を開くと;
  const o = 開?.type ? 開 : 開?.[表ID];
  const 開く先 = typeof o === "string" ? (/^pag/.test(o) ? o : null) : (o?.pageId ?? null);
  const 名 = 生?.label?.isEnabled && 生.label.value ? 生.label.value : (e.label || null);
  const 親段 = (sp.段の設定?.orderedParentLevels ?? []).length;
  return { spec: sp, 表ID, 列: sp.見せる列 ?? sp.主項目なしの列 ?? [], 追加, 行集合, 親の行, 器, 開く先, 注記, 名, 親段,
    許し: 器 ? (spec(器).利用者が操れるもの ?? null) : null, CSV: 器 ? spec(器).CSV書き出し === true : null };
}
function 一覧の行を求める(ctx, e, 材, 操作) {
  const { 表ID, 列 } = 材;
  const 空 = { 行: [], 全部: [], 母数: 0, 絞った後: 0, 値を引く: () => ({}), 絞り込み: null, 注: [], 注記: "" };
  if (!表ID || !X.表.has(表ID)) return { ...空, 注記: "この表の行は手元にありません" };
  /** 関連先だけの一覧で親の行が無いときは、表を引いても 0 行。3 万行の表を絞る手間を省く */
  if (Array.isArray(材.行集合) && !材.行集合.length) return 空;
  const 元 = 材.spec.段の設定?.leafLevel?.filters ?? 材.spec.絞り込み ?? null;
  const 絞り込み = X.利用者の絞り込み(操作, 全部で(元, ...材.追加));
  const 並び = 操作.並び ? [{ columnId: 操作.並び, ascending: 操作.昇順 }]
    : (材.spec.段の設定?.leafLevel?.sorts ?? 材.spec.段のクエリ?.["1"]?.sorts ?? 材.spec.並び ?? []);
  const r = 行集合を求める(表ID, 絞り込み, 並び);
  let 行 = r.行;
  if (材.行集合) {
    const s = new Set(材.行集合), 中 = new Set(行);
    行 = 行.filter((x) => s.has(x));
    /** エンジンの断面に無い子（起動後に作った行など）は今の値で当て直す */
    for (const rid of 材.行集合) if (!中.has(rid)) { const x = 取る(rid); if (x && (!絞り込み || 条件に合う(x, 絞り込み))) 行.push(rid); }
  }
  const 値を引く = (rid) => { const x = 取る(rid); if (!x) return {}; const o = {}; for (const c of 列) o[c] = 値(x, c); return o; };
  const 絞った = X.検索で絞る(行, 列, 操作.検索, 値を引く);
  return { 表ID, 列, 全部: 絞った, 行: 絞った.slice((操作.頁 - 1) * 操作.件数, 操作.頁 * 操作.件数), 母数: r.母数, 絞った後: 絞った.length, 値を引く, 絞り込み, 注: r.注, 注記: "" };
}
/**
 * 一覧を描く。serve.mjs の 一覧を描く と同じ表示形（見出し・操作の棒・表・頁送り）だが、
 * 器の固定の絞り込み・帯・行集合（関連先）を掛け、利用者に開放されていない操作は出さない。
 */
function 一覧を組む(ctx, e) {
  const { E, 項目, 表, 書く, 右寄せか } = X;
  const u = ctx.u, pid = ctx.pid;
  const 材 = 一覧の材料(ctx, e);
  const 操作 = X.操作を読む(u, e.id);
  const R = 一覧の行を求める(ctx, e, 材, 操作);
  const { 表ID, 列 } = 材;
  const 許し = 材.許し;
  const 絞れる = 許し ? !!許し.isFilterEnabled : true, 並べられる = 許し ? !!許し.isSortEnabled : true, 探せる = 許し ? !!許し.isSearchEnabled : true;
  const CSVできる = 材.CSV === null ? true : 材.CSV;
  const 幅 = 材.spec.列幅 ?? {};
  const 選べる列 = 列.filter((c) => 項目.has(c));
  const 選択肢 = (名, 今, xs, 空の字) => `<select name="${E(名)}" style="max-width:190px"><option value="">${E(空の字)}</option>${xs.map(([v, t]) => `<option value="${E(v)}"${String(今) === String(v) ? " selected" : ""}>${E(t)}</option>`).join("")}</select>`;
  const 比べ方 = [["contains", "を含む"], ["doesNotContain", "を含まない"], ["=", "＝"], ["!=", "≠"], [">", "＞"], [">=", "≧"], ["<", "＜"], ["<=", "≦"], ["isEmpty", "が空"], ["isNotEmpty", "が空でない"], ["isAnyOf", "のいずれか（カンマ区切り）"], ["isNoneOf", "のいずれでもない（カンマ区切り）"]];
  const 節の行 = (i) => { const x = 操作.節[i - 1] ?? {}; return `<div style="display:flex;gap:5px;align-items:center;margin-bottom:4px;flex-wrap:wrap">
      ${選択肢(`f${i}_${e.id}`, x.項目 ?? "", 選べる列.map((c) => [c, 項目.get(c)?.name ?? c]), "（項目）")}${選択肢(`o${i}_${e.id}`, x.節 ?? "", 比べ方, "（比べ方）")}
      <input name="v${i}_${e.id}" value="${E(x.値 ?? "")}" placeholder="値" style="width:150px"></div>`; };
  const 見出し文 = (t) => `<div style="font-size:11px;color:var(--muted);margin-bottom:4px">${t}</div>`;
  /** 当てている条件はチップで出し、棒は畳んでおく（serve.mjs と同じ形。demo の FilterChip） */
  const チップ = X.操作のチップ(pid, e.id, u, 操作);
  const 操作の棒 = `<details class=ops${チップ.length ? " open" : ""}>
    <summary>${チップ.length ? チップ.join(" ") : `<span style="color:var(--muted)">絞り込み・並べ替え・検索</span>`}
      <span class=tag>${(R.絞った後 ?? 0).toLocaleString()} 行</span></summary>
  <form method=get action="/p/${E(pid)}" style="padding:10px 14px;border-top:1px solid var(--grid)">
    ${[...u.searchParams].filter(([k]) => !k.endsWith(`_${e.id}`) && !/^(msg|ok)_/.test(k)).map(([k, v]) => `<input type=hidden name="${E(k)}" value="${E(v)}">`).join("")}
    <div style="display:flex;gap:14px;flex-wrap:wrap;align-items:flex-start">
      ${絞れる ? `<div>${見出し文("絞り込み")}${節の行(1)}${節の行(2)}${節の行(3)}</div>` : `<div>${見出し文("絞り込み")}<span class=tag>現行では利用者に開放していません</span></div>`}
      ${並べられる ? `<div>${見出し文("並べ替え")}<div style="display:flex;gap:5px;align-items:center">${選択肢(`s_${e.id}`, 操作.並び ?? "", 選べる列.map((c) => [c, 項目.get(c)?.name ?? c]), "（画面の既定）")}${選択肢(`d_${e.id}`, 操作.昇順 ? "asc" : "desc", [["asc", "昇順"], ["desc", "降順"]], "昇順")}</div></div>` : `<div>${見出し文("並べ替え")}<span class=tag>非開放</span></div>`}
      ${探せる ? `<div>${見出し文("検索")}<input name="q_${E(e.id)}" value="${E(操作.検索)}" placeholder="見えている列を探す" style="width:170px"></div>` : `<div>${見出し文("検索")}<span class=tag>非開放</span></div>`}
      <div>${見出し文("1頁の件数")}${選択肢(`n_${e.id}`, 操作.件数, [[25, "25"], [50, "50"], [100, "100"], [200, "200"], [500, "500"]], "50")}</div>
      <div style="align-self:flex-end;display:flex;gap:6px">
        <button class=btn style="background:var(--side-accent);color:#fff;border:0;cursor:pointer" type=submit>当てる</button>
        ${操作.何かある ? `<a class=btn style="background:var(--chip);color:var(--ink-2);text-decoration:none" href="${E(道(u, Object.fromEntries([...u.searchParams.keys()].filter((k) => k.endsWith(`_${e.id}`)).map((k) => [k, null]))))}">外す</a>` : ""}
        <a class=btn style="background:var(--chip);color:var(--ink-2);text-decoration:none" href="/csv/${E(pid)}/${E(e.id)}${E(u.search)}">CSV${CSVできる ? "" : "（現行では非開放）"}</a>
      </div></div></form></details>`;
  const 見出し = 列.map((c) => {
    const f = 項目.get(c);
    const w = 幅[c] ? ` style="min-width:${Math.round(幅[c] / 1.51)}px"` : "";
    const 今か = 操作.並び === c;
    const 中 = `${E(f?.name ?? c)}${今か ? (操作.昇順 ? " ▲" : " ▼") : ""}`;
    return `<th class="${右寄せか(f) ? "r" : ""}"${w}>${並べられる ? `<a href="${E(X.道を組む(pid, e.id, u, { s: c, d: 今か && 操作.昇順 ? "desc" : "asc", p: null }))}" style="color:inherit;text-decoration:none">${中}</a>` : 中}</th>`;
  }).join("");
  const 本体 = R.行.map((rid) => {
    const v = R.値を引く(rid);
    return "<tr>" + 列.map((c, i) => {
      const f = 項目.get(c);
      const 字 = E(書く(v[c], f));
      const 開く = i === 0 && 材.開く先 ? `<a href="/p/${E(材.開く先)}?row=${E(rid)}" title="${E(X.db.prepare("SELECT name FROM page WHERE id=?").get(材.開く先)?.name ?? 材.開く先)} を開く">${字 || "（空）"}</a>` : 字;
      return `<td class="${右寄せか(f) ? "r" : ""}">${開く}</td>`;
    }).join("") + "</tr>";
  }).join("");
  const 最後の頁 = Math.max(1, Math.ceil((R.絞った後 ?? 0) / 操作.件数));
  const 頁送り = 最後の頁 <= 1 ? "" : `<div style="padding:8px 12px;display:flex;gap:8px;align-items:center;font-size:12px">
    ${操作.頁 > 1 ? `<a href="${E(X.道を組む(pid, e.id, u, { p: 操作.頁 - 1 }))}">← 前</a>` : '<span style="color:#bbb">← 前</span>'}
    <span>${操作.頁} / ${最後の頁} 頁</span>
    ${操作.頁 < 最後の頁 ? `<a href="${E(X.道を組む(pid, e.id, u, { p: 操作.頁 + 1 }))}">次 →</a>` : '<span style="color:#bbb">次 →</span>'}
    <span style="color:#6b6f76">（${((操作.頁 - 1) * 操作.件数 + 1).toLocaleString()}〜${Math.min(操作.頁 * 操作.件数, R.絞った後).toLocaleString()} 件目）</span></div>`;
  const 編集 = 材.spec.編集できるか?.canUpdateAllVisibleCells;
  ctx.数える(e.type);
  /** 見出しは名前と行数だけ（demo の一覧）。要素型・列数・編集可否・親の段・行を開くと は折りたたみへ */
  const 一覧の定義 = `<details class=defs><summary>この一覧の定義</summary><div class=def>
      <span class=tag>${E(e.type)}</span><span class=tag>${列.length}列</span>
      ${材.名 ? `<span class=tag>表 ${E(表.get(表ID)?.表示 ?? "")}</span>` : ""}
      ${編集 ? '<span class=tag>編集できる</span>' : '<span class=tag>読み取り専用</span>'}
      ${材.親段 ? `<span class=tag>親の段 ${材.親段}（平らに出す）</span>` : ""}
      ${材.開く先 ? `<span class=tag>行を開くと → ${E(X.db.prepare("SELECT name FROM page WHERE id=?").get(材.開く先)?.name ?? 材.開く先)}</span>` : ""}
      ${材.行集合 ? `<span class=tag>親の行の関連先 ${材.行集合.length.toLocaleString()} 行に絞る</span>` : ""}
  </div></details>`;
  return `<div class=el><div class=elh>${E(材.名 ?? 表.get(表ID)?.表示 ?? e.tbl ?? "?")}
      <span class=tag>${(R.絞った後 ?? 0).toLocaleString()}行</span></div>
    ${操作の棒}
    ${[R.注記, ...材.注記, ...(R.注 ?? [])].filter(Boolean).map((n) => `<div class=note>${E(n)}</div>`).join("")}
    <div class=scroll><table data-rowheight="${E(({ small: "短い", medium: "中", large: "高い", xlarge: "高い" })[材.spec?.行の高さ] ?? "中")}"><thead><tr>${見出し}</tr></thead><tbody>${本体 || `<tr><td colspan="${Math.max(1, 列.length)}" class=note>行がありません</td></tr>`}</tbody></table></div>
    ${頁送り}${一覧の定義}</div>`;
}
/** CSV。画面と同じ絞り込み（器・帯・関連先・利用者の操作）で全部の行を出す。serve.mjs の 一覧のCSV と同じ形（BOM 付き） */
function CSVを組む(ctx, e) {
  const 材 = 一覧の材料(ctx, e);
  const 操作 = { ...X.操作を読む(ctx.u, e.id), 頁: 1, 件数: 1e9 };
  const R = 一覧の行を求める(ctx, e, 材, 操作);
  const 逃がす = (x) => { const t = String(x ?? ""); return /[",\n\r]/.test(t) ? `"${t.replace(/"/g, '""')}"` : t; };
  const 行 = [材.列.map((c) => 逃がす(X.項目.get(c)?.name ?? c)).join(",")];
  for (const rid of R.全部 ?? []) { const v = R.値を引く(rid); 行.push(材.列.map((c) => 逃がす(X.書く(v[c], X.項目.get(c)))).join(",")); }
  return { 名: `${(ctx.p.name ?? ctx.pid).replace(/[\\/:*?"<>|]/g, "_")}.csv`, 中身: "﻿" + 行.join("\r\n") + "\r\n" };
}

/** ─── 器（queryContainer）─── */
function 器を描く(ctx, e) {
  const { E, 表 } = X;
  const sp = spec(e);
  const 生 = 生の要素(ctx.pid, e.id);
  const 中の一覧 = 並べ替え(ctx.pid, ctx.要素.filter((x) => (x.type === "levels" || x.type === "grid") && ctx.一覧の器.get(x.id) === e.id));
  for (const x of 中の一覧) ctx.消費.add(x.id);
  const 帯 = ctx.帯.find((b) => b.id === e.id);
  const 許し = sp.利用者が操れるもの ?? {};
  const 開放 = (k, 名) => 許し[k] === undefined ? "" : `<span class=tag${許し[k] ? "" : ' style="color:#9aa0a6"'}>${名}${許し[k] ? "" : " 非開放"}</span>`;
  const 源 = 生?.source ?? null;
  const 源の字 = 源?.type === "foreignKey" ? `行 ${E(ctx.出力.get(源.foreignRow?.outputId)?.種 === "root" ? "（この画面の行）" : (ctx.出力.get(源.foreignRow?.outputId)?.種 ?? "?"))} の ${E(X.項目.get(源.foreignColumnId)?.name || "関連")} の先`
    : 源?.type === "table" ? "表の全行" : "（元は生レイアウトに無い）";
  const 子 = 並べ替え(ctx.pid, (ctx.子.get(e.id) ?? []).filter((x) => !ctx.消費.has(x.id)));
  ctx.数える("queryContainer");
  return `<div class=el style="border-color:#c9d3e6"><div class=elh style="background:#f3f6fb">${E(e.label || 表.get(e.tbl)?.表示 || "一覧の器")}
      <span class=tag>queryContainer</span>${e.label ? `<span class=tag>${E(表.get(e.tbl)?.表示 ?? "")}</span>` : ""}
      <span class=tag>${源の字}</span>
      ${開放("isFilterEnabled", "絞り込み")}${開放("isSortEnabled", "並べ替え")}${開放("isSearchEnabled", "検索")}${開放("isGroupLevelsEnabled", "グループ")}
      ${sp.CSV書き出し === true ? '<span class=tag>CSV 可</span>' : sp.CSV書き出し === false ? '<span class=tag style="color:#9aa0a6">CSV 非開放</span>' : ""}
      ${sp.PDF書き出し === true ? '<span class=tag>PDF 可</span>' : ""}
      ${sp.絞り込み帯の種類 ? `<span class=tag>帯: ${E(sp.絞り込み帯の種類)}</span>` : ""}
    </div>
    ${sp.固定の絞り込み?.filterSet?.length ? `<div class=note>固定の絞り込み: ${E(文にする(sp.固定の絞り込み))}</div>` : ""}
    ${帯 ? 帯を描く(ctx, 帯) : ""}
    <div style="padding:8px 8px 0">${中の一覧.map((x) => 一覧を組む(ctx, x)).join("") || '<div class=note>この器に属する一覧が定義にありません</div>'}
    ${並んだ要素を描く(ctx, 子)}</div></div>`;
}

/** ─── 行を選ぶ箱（rowSelector）─── */
function 選択器を描く(ctx, e) {
  const { E, 表 } = X;
  const sp = spec(e);
  const 生 = 生の要素(ctx.pid, e.id);
  const peo = String((Array.isArray(sp.出力) ? sp.出力[0] : sp.出力) ?? "").replace(/^[A-Za-z]+=/, "");
  const 表ID = ctx.出力の表(peo);
  const 帯節 = 帯の節で出力(ctx, 生?.query?.interactiveFilters?.outputId ?? null, null);
  const 絞り込み = 全部で(生?.query?.filters ?? null, ...帯節);
  /** 母集団。売上登録 = 空 のような含意でしか分からない節は 節を分ける が計算器に回す（エンジンだけだと 0 行になる） */
  const R = 行集合を求める(表ID, 絞り込み, 生?.query?.sorts ?? []);
  let 行 = R.行; const 母数 = R.母数;
  const 注々 = [...R.注];
  /**
   * 節を外した（手元に値も含意も無い列。例: 振替の 区分）ときは、クロール時にこの画面に出ていた行（row.src）を優先する。
   * 振替入庫入力 と 振替出庫入力 は現行では 1 行ずつ別々に出るが、区分の節を外すと両方 2 行になった（検証 2026-09-13）。
   * row.src は「来ていない値は画面の所属で決まる」と同じ含意。同名の束 5 画面のどれかに出ていれば同じ母集団とみなす
   */
  if (R.外した?.length && 行.length) {
    const 同名 = X.db.prepare("SELECT id FROM page WHERE tab=? AND name=?").all(ctx.p.tab, ctx.p.name).map((x) => x.id);
    const 出ていた = new Set(X.db.prepare(`SELECT id FROM row WHERE tbl=? AND (${同名.map(() => "src LIKE ?").join(" OR ")})`).all(表ID, ...同名.map((id) => `%${id}%`)).map((x) => x.id));
    const 優先 = 行.filter((rid) => 出ていた.has(rid));
    if (優先.length) { 行 = 優先; 注々.push(`外した条件の代わりに、クロール時にこの画面に出ていた行（${優先.length} 行）だけを母集団にした`); }
  }
  const 語 = (ctx.u.searchParams.get(`sq_${e.id}`) ?? "").trim().toLowerCase();
  const 選ばれ = ctx.行を引く(peo);
  const 肢 = [];
  for (const rid of 行) { const x = 取る(rid); if (!x) continue; const 名 = 表示名(x); if (語 && !名.toLowerCase().includes(語)) continue; 肢.push([rid, 名]); if (肢.length >= 300) break; }
  const 隠す = [...ctx.u.searchParams].filter(([k]) => k !== `sel_${peo}` && k !== "row" && k !== `sq_${e.id}` && !/^(msg|ok)_/.test(k));
  const 枠 = "padding:4px 7px;border:1px solid #ccd;border-radius:4px;font:inherit";
  const 形 = sp.埋め込みフォームのボタン;
  let 作る = "";
  if (形?.pageId) {
    const fc = X.db.prepare("SELECT id FROM elem WHERE page=? AND type='formContainer'").get(形.pageId);
    const 名 = X.db.prepare("SELECT name FROM page WHERE id=?").get(形.pageId)?.name ?? 形.pageId;
    作る = fc && 形.isEnabled ? `<a class=btn style="background:#2d7ff9;color:#fff;text-decoration:none" href="/form/${E(形.pageId)}/${E(fc.id)}">＋ ${E(名)}</a>` : `<span class=tag>新規作成ボタン「${E(名)}」は現行では無効</span>`;
  }
  ctx.数える("rowSelector");
  return `<div class=el style="border-color:#c9d3e6"><div class=elh style="background:#f3f6fb">行を選ぶ <span class=tag>rowSelector</span><span class=tag>${E(表.get(表ID)?.表示 ?? sp.母集団の表 ?? "?")}</span>
      <span class=tag>母集団 ${行.length.toLocaleString()} 行${母数 ? `（全${母数.toLocaleString()}件）` : ""}</span>${生 ? "" : '<span class=cond>生レイアウトが無いので母集団を絞れません</span>'}</div>
    ${sp.母集団 ? `<div class=note>母集団: ${E(sp.母集団)}</div>` : ""}
    ${注々.map((n) => `<div class=note>${E(n)}</div>`).join("")}
    <form method=get action="/sel/${E(ctx.pid)}/${E(e.id)}" style="padding:8px 12px;display:flex;gap:6px;flex-wrap:wrap;align-items:center">
      ${隠す.map(([k, v]) => `<input type=hidden name="${E(k)}" value="${E(v)}">`).join("")}
      <input name="sq_${E(e.id)}" value="${E(ctx.u.searchParams.get(`sq_${e.id}`) ?? "")}" placeholder="主項目で探す" style="${枠};width:180px">
      <select name=v style="${枠};max-width:min(420px,100%)"><option value="">（行を選ぶ${肢.length < 行.length ? `・先頭${肢.length}件` : ""}）</option>
        ${肢.map(([rid, 名]) => `<option value="${E(rid)}"${選ばれ?.id === rid ? " selected" : ""}>${E(名)}</option>`).join("")}</select>
      <button class=btn style="background:#2d7ff9;color:#fff;border:0;cursor:pointer">選ぶ</button>
      ${選ばれ ? `<span>選択中 <b>${E(表示名(選ばれ))}</b> <code style="font-size:11px;color:#6b6f76">${E(選ばれ.id)}</code> <a href="${E(道(ctx.u, { [`sel_${peo}`]: null, row: null }))}" style="font-size:12px">外す</a></span>` : '<span class=tag>選ぶと、この行を元にする欄・一覧・ボタンが出ます</span>'}
      ${作る}
    </form></div>`;
}

/** ─── 受信箱（inbox。左に一覧、右に選んだ行）─── */
function 受信箱を描く(ctx, e) {
  const { E, 表, 項目, 書く, 右寄せか } = X;
  const sp = spec(e);
  const 生 = 生の要素(ctx.pid, e.id);
  const peo = String(sp.出力 ?? "").replace(/^[A-Za-z]+=/, "");
  const 表ID = e.tbl ?? 生?.query?.source?.tableId ?? null;
  if (!主項目.has(表ID)) 主項目.set(表ID, X.db.prepare("SELECT primary_fld FROM tbl WHERE id=?").get(表ID)?.primary_fld ?? null);
  const 列 = (sp.見せる列 ?? 生?.visibleColumnIds ?? [主項目.get(表ID)]).filter(Boolean);
  const 帯節 = 帯の節で出力(ctx, 生?.query?.interactiveFilters?.outputId ?? null, 表ID);
  const 絞り込み = 全部で(生?.query?.filters ?? null, ...帯節);
  const 操作 = X.操作を読む(ctx.u, e.id);
  const R = 行集合を求める(表ID, 絞り込み, sp.並び ?? 生?.query?.sorts ?? []);
  const 行 = R.行, 母数 = R.母数;
  const 値を引く = (rid) => { const x = 取る(rid); if (!x) return {}; const o = {}; for (const c of 列) o[c] = 値(x, c); return o; };
  const 絞った = X.検索で絞る(行, 列, 操作.検索, 値を引く);
  const 頁 = 絞った.slice((操作.頁 - 1) * 操作.件数, 操作.頁 * 操作.件数);
  const 選ばれ = ctx.行を引く(peo);
  const 左 = 頁.map((rid) => { const v = 値を引く(rid); return `<tr${選ばれ?.id === rid ? ' style="background:#fffbe6"' : ""}>${列.map((c, i) => { const f = 項目.get(c); const 字 = E(書く(v[c], f)); return `<td class="${右寄せか(f) ? "r" : ""}">${i === 0 ? `<a href="${E(道(ctx.u, { [`sel_${peo}`]: rid, row: rid }))}">${字 || "（空）"}</a>` : 字}</td>`; }).join("")}</tr>`; }).join("");
  const 最後の頁 = Math.max(1, Math.ceil(絞った.length / 操作.件数));
  const 中 = ctx.受信箱の面.get(e.id) ?? [];
  const 種で = (...ks) => 中.filter((x) => ks.includes(ctx.置き場.get(x.id).種));
  /** 右側は現行の並びどおり: inbox の中の横棒 → 行の面 → その他。行が無ければ欄の名前だけ出し、欄以外は行なしで描く */
  let 右;
  if (選ばれ) 右 = 並んだ要素を描く(ctx, 並べ替え(ctx.pid, 種で("bar"))) + 面を描く(ctx, 種で("canvas")) + 並んだ要素を描く(ctx, 並べ替え(ctx.pid, 中.filter((x) => !["bar", "canvas"].includes(ctx.置き場.get(x.id).種))));
  else {
    const 欄々 = 中.filter((x) => x.type === "cellEditor");
    for (const x of 欄々) ctx.消費.add(x.id);
    右 = `<div class=note>左の一覧から行を選ぶと、右にその行の詳細（欄 ${欄々.length} 個）が出ます</div>` + 欄の名だけ(ctx, 欄々) + 並んだ要素を描く(ctx, 並べ替え(ctx.pid, 中.filter((x) => x.type !== "cellEditor")));
  }
  ctx.数える("inbox");
  return `<div class=el style="border-color:#c9d3e6"><div class=elh style="background:#f3f6fb">${E(e.label || 表.get(表ID)?.表示 || "受信箱")} <span class=tag>inbox</span><span class=tag>${E(表.get(表ID)?.表示 ?? "")}</span>
      <span class=tag>${絞った.length.toLocaleString()}行${絞った.length !== 母数 ? `（全${母数.toLocaleString()}件から絞り込み）` : ""}</span></div>
    ${R.注.map((n) => `<div class=note>${E(n)}</div>`).join("")}
    <div style="display:flex;gap:0;align-items:stretch;flex-wrap:wrap">
      <div style="flex:0 0 340px;max-width:100%;border-right:1px solid #eee">
        <form method=get action="/p/${E(ctx.pid)}" style="padding:6px 10px;border-bottom:1px solid #eee;display:flex;gap:5px;align-items:center">
          ${[...ctx.u.searchParams].filter(([k]) => !k.endsWith(`_${e.id}`) && !/^(msg|ok)_/.test(k)).map(([k, v]) => `<input type=hidden name="${E(k)}" value="${E(v)}">`).join("")}
          <input name="q_${E(e.id)}" value="${E(操作.検索)}" placeholder="探す" style="padding:4px 7px;border:1px solid #ccd;border-radius:4px;font:inherit;width:150px">
          <button class=btn style="background:#2d7ff9;color:#fff;border:0;cursor:pointer">当てる</button></form>
        <div class=scroll><table><thead><tr>${列.map((c) => `<th>${E(項目.get(c)?.name ?? c)}</th>`).join("")}</tr></thead><tbody>${左 || `<tr><td colspan="${Math.max(1, 列.length)}" class=note>行がありません</td></tr>`}</tbody></table></div>
        ${最後の頁 > 1 ? `<div style="padding:6px 10px;font-size:12px;display:flex;gap:8px">${操作.頁 > 1 ? `<a href="${E(X.道を組む(ctx.pid, e.id, ctx.u, { p: 操作.頁 - 1 }))}">← 前</a>` : ""}<span>${操作.頁} / ${最後の頁} 頁</span>${操作.頁 < 最後の頁 ? `<a href="${E(X.道を組む(ctx.pid, e.id, ctx.u, { p: 操作.頁 + 1 }))}">次 →</a>` : ""}</div>` : ""}
      </div>
      <div style="flex:1 1 360px;min-width:0;padding:10px 12px">
        ${選ばれ ? `<div style="font-size:15px;font-weight:600;margin-bottom:8px">${E(表示名(選ばれ))} <code style="font-size:11px;color:#6b6f76">${E(選ばれ.id)}</code></div>` : ""}
        ${右}</div></div></div>`;
}

/** ─── 欄・ボタンの群 ─── */
/** 欄の名前と型だけ（行が選ばれていないとき。20-cells の行選びと二重にならないように） */
function 欄の名だけ(ctx, cells) {
  if (!cells.length) return "";
  const { E, 項目 } = X;
  ctx.数える("cellEditor", cells.length);
  return `<div class=el><div class=elh>入力欄 <span class=tag>${cells.length}個</span><span class=tag>行を選ぶと値が出ます</span></div><div class=cells>${cells.map((e) => { const f = 項目.get(e.fld); return `<div class=k>${E(e.label || f?.name || e.fld)}${e.read_only ? ' <span class=tag>読み取り専用</span>' : ""}</div><div><span class=tag>${E(f?.type ?? "?")}</span></div>`; }).join("")}</div></div>`;
}
/**
 * cellEditor の群を 文脈.欄を描く に渡す（20-cells がその場で書ける欄を差し込む。無ければ既定の描き方）。
 * 行は出どころ（peo）で決める。継承した見せる条件は節の側で見るので、自分の条件だけ残して渡す。
 */
function 欄群を描く(ctx, cells) {
  if (!cells.length) return "";
  const peo = spec(cells[0]).行の出どころ ?? null;
  const 出 = ctx.出力.get(peo);
  const 行 = ctx.行を引く(peo);
  if (!行 && 出?.種 !== "formContainer") return 欄の名だけ(ctx, cells);
  const 自分だけ = cells.map((e) => { let 条 = []; try { 条 = JSON.parse(e.visible_when ?? "[]"); } catch { 条 = []; } return { ...e, visible_when: JSON.stringify((Array.isArray(条) ? 条 : []).filter((c) => !c?.元 || c.元 === e.id)) }; });
  const u2 = new URL(ctx.u.href);
  if (行) u2.searchParams.set("row", 行.id);
  ctx.数える("cellEditor", cells.length);
  try { return X.欄を描く(自分だけ, ctx.p, ctx.pid, u2, { 見出し: ctx.今の節 ?? null }) ?? ""; }
  catch (err) { return `<div class=warn>欄を描けません: ${X.E(err.message)}</div>`; }
}
/**
 * ボタンは serve.mjs の ボタンを描く に任せる。行の文脈（?row= / ?sel_<peo>=）は URL で渡す。
 * 10-buttons は 拡張.画面 の先頭で URL を控えるが、/detail-stats や /csv のように 画面を描く を通らない経路では古いままなので、
 * ここから URL を渡す（serve.mjs の ボタンを描く は第 3 引数に u を受ける）
 */
function ボタン群を描く(ctx, buttons) {
  if (!buttons.length) return "";
  ctx.数える("button", buttons.length);
  const u2 = new URL(ctx.u.href);
  const 行 = ctx.根 ? ctx.行を引く(ctx.根) : null;
  if (行 && !u2.searchParams.get("row")) u2.searchParams.set("row", 行.id);
  /** 横棒（Airtable の上の帯）のボタンは画面ごとのボタン。骨() が帯の右端へ持ち上げる（demo の PageHeader） */
  try { return X.ボタンを描く(buttons, ctx.pid, u2, { 画面の: !!ctx.棒の中 }); }
  catch (err) { return `<div class=warn>ボタンを描けません: ${X.E(err.message)}</div>`; }
}
/** 1 要素。型で分ける。描けない型は 文脈.拡張.要素 の描き手か「その他」へ */
function 要素を描く(ctx, e) {
  if (ctx.消費.has(e.id) && e.type !== "levels" && e.type !== "grid") return "";
  switch (e.type) {
    case "levels": case "grid":
      if (ctx.一覧の器.has(e.id)) return "";          // 器が描く
      ctx.消費.add(e.id);
      return 一覧を組む(ctx, e);
    case "queryContainer": ctx.消費.add(e.id); return 器を描く(ctx, e);
    case "rowSelector": ctx.消費.add(e.id); return 選択器を描く(ctx, e);
    case "inbox": ctx.消費.add(e.id); return 受信箱を描く(ctx, e);
    case "filter": { ctx.消費.add(e.id); const b = ctx.帯.find((x) => x.id === e.id); ctx.数える("filter"); return b ? `<div class=el>${帯を描く(ctx, b)}</div>` : ""; }
    case "recordContainer": ctx.消費.add(e.id); return 詳細を描く(ctx, e);
    case "section": ctx.消費.add(e.id); return 節を描く(ctx, e);
    case "sectionGridRow": ctx.消費.add(e.id); ctx.数える("sectionGridRow"); return 並んだ要素を描く(ctx, 並べ替え(ctx.pid, ctx.子.get(e.id) ?? []));
    case "cellEditor": return 欄群を描く(ctx, [e]);
    case "button": return ボタン群を描く(ctx, [e]);
    case "formContainer":
      if (ctx.フォーム済) return "";
      ctx.フォーム済 = true; ctx.消費.add(e.id); ctx.数える("formContainer", ctx.要素.filter((x) => x.type === "formContainer").length);
      return X.フォームの入口(ctx.pid);
    case "horizontalDivider": {
      /** 別工程（40-dash）に描き手があればそれ。無ければ罫線 */
      ctx.消費.add(e.id); ctx.数える("horizontalDivider");
      const 描き手 = X.拡張.要素.get(e.type);
      let h = null;
      if (描き手) { try { h = 描き手(e, spec(e), ctx.pid, ctx.u, X); } catch { h = null; } }
      return h || `<hr style="border:0;border-top:1px solid #dcdfe4;margin:10px 0">`;
    }
    default: {
      ctx.消費.add(e.id);
      const 描き手 = X.拡張.要素.get(e.type);
      if (描き手) { try { const h = 描き手(e, spec(e), ctx.pid, ctx.u, X); if (h) { ctx.数える(e.type); return h; } } catch (err) { return `<div class=warn>${X.E(e.type)} を描けません: ${X.E(err.message)}</div>`; } }
      ctx.その他.push(e);
      return "";
    }
  }
}
/** 並んだ要素。続く cellEditor（同じ出どころ）は 1 つの欄の箱に、続く button は 1 つのボタンの箱に束ねる */
function 並んだ要素を描く(ctx, xs) {
  let 出 = "";
  let 欄 = [], ボタン = [];
  const 流す = () => { if (欄.length) { 出 += 欄群を描く(ctx, 欄); 欄 = []; } if (ボタン.length) { 出 += ボタン群を描く(ctx, ボタン); ボタン = []; } };
  for (const e of xs) {
    if (ctx.消費.has(e.id)) continue;
    if (e.type === "cellEditor") { if (欄.length && spec(欄[0]).行の出どころ !== spec(e).行の出どころ) 流す(); if (ボタン.length) 流す(); 欄.push(e); ctx.消費.add(e.id); continue; }
    if (e.type === "button") { if (欄.length) 流す(); ボタン.push(e); ctx.消費.add(e.id); continue; }
    流す();
    出 += 要素を描く(ctx, e);
  }
  流す();
  return 出;
}

/** ─── 節（section）と詳細（recordContainer）─── */
/**
 * 節の中身を並び順に平らにする。sectionGridRow（横一列）は箱ではなく並びなので、**節の cellEditor たちは
 * 行をまたいで 1 回の 文脈.欄を描く に渡す**（並んだ要素を描く が続く欄を束ねる。ボタン・器が挟まればそこで区切る）。
 * 行ごとに描くと 受注情報 の節が 9 箱に割れ、現行の 1 枚の形と違ってしまう（実測: 運用-受注登録）
 */
function 節の中身(ctx, e) {
  const xs = [];
  for (const g of 並べ替え(ctx.pid, ctx.子.get(e.id) ?? [])) {
    if (g.type === "sectionGridRow") { ctx.消費.add(g.id); ctx.数える("sectionGridRow"); xs.push(...並べ替え(ctx.pid, ctx.子.get(g.id) ?? [])); }
    else xs.push(g);
  }
  return xs;
}
function 節を描く(ctx, e) {
  const { E } = X;
  const 生 = 生の要素(ctx.pid, e.id);
  const 題 = e.label || 生?.title || "";
  const 出す題 = 生 ? 生.shouldDisplayTitle !== false && !!題 : !!題;
  let 条 = []; try { 条 = JSON.parse(e.visible_when ?? "[]"); } catch { 条 = []; }
  const 自分の = (Array.isArray(条) ? 条 : []).filter((c) => c?.元 === e.id && c.生);
  const 行 = ctx.根 ? ctx.行を引く(ctx.根) : null;
  const 合わない = 行 ? 自分の.filter((c) => !条件に合う(行, c.生)) : [];
  /** 節の中の欄の箱は節の名を見出しにする（現行の見え方。serve.mjs の 欄を描く が { 見出し } を受ける） */
  const 前の節 = ctx.今の節; ctx.今の節 = 出す題 ? 題 : null;
  const 中 = 並んだ要素を描く(ctx, 節の中身(ctx, e));
  ctx.今の節 = 前の節;
  ctx.数える("section");
  /** 現行は shouldDisplayTitle=false の節に何も出さない。ここも見出しは出さず、節であることだけ札で示す */
  const 見出し = `${出す題 ? `<span style="font-weight:600">${E(題)}</span>` : ""} <span class=tag>section</span>${自分の.length && !合わない.length ? `<span class=cond>見せる条件: ${E(自分の.map((c) => c.条件).join(" / "))}</span>` : ""}`;
  if (合わない.length)
    return `<details style="margin:0 0 14px;border:1px dashed #d0d4db;border-radius:6px;background:#fafafb"><summary style="padding:8px 12px;cursor:pointer;font-size:12.5px">${見出し}
        <span class=cond>見せる条件に合わないので畳んでいます（現行では非表示）: ${E(合わない.map((c) => c.条件).join(" / "))}</span></summary><div style="padding:8px 12px 0">${中}</div></details>`;
  return `<section style="margin:0 0 14px;padding:8px 12px 0;border-left:3px solid #dfe5f0;background:${生?.style?.backgroundColor ? "#fbfbfc" : "transparent"}"><div style="font-size:12.5px;margin-bottom:8px">${見出し}</div>${中}</section>`;
}
function 詳細を描く(ctx, rc) {
  const { E } = X;
  const 行 = ctx.根 ? ctx.行を引く(ctx.根) : null;
  const 子 = 並べ替え(ctx.pid, ctx.子.get(rc.id) ?? []);
  const 受け口 = (e) => {
    const 路 = 路を読む(e); const 枠 = [...路].reverse().find((s) => 段の型(s) === "slotElements");
    return 枠 ? 節を引く(ctx.pid, 段のID(枠))?.slotType ?? null : null;
  };
  const 題の欄 = [], 節々 = [], 呼び出し = [], 他 = [];
  for (const e of 子) {
    const s = 受け口(e);
    if (s === "title" || (!s && e.type === "cellEditor" && !e.label && e.fld === (主項目.get(ctx.p.tbl) ?? X.db.prepare("SELECT primary_fld FROM tbl WHERE id=?").get(ctx.p.tbl)?.primary_fld))) 題の欄.push(e);
    else if (s === "section" || (!s && e.type === "section")) 節々.push(e);
    else if (s === "callToAction" || (!s && e.type === "button")) 呼び出し.push(e);
    else 他.push(e);
  }
  for (const e of 題の欄) { ctx.消費.add(e.id); ctx.数える("cellEditor"); }
  /** 呼び出し（callToAction）のボタンはここで描くので消費に入れる（入れないと画面の末尾の「残り」で二重に出る） */
  for (const e of 呼び出し) ctx.消費.add(e.id);
  const 題 = 題の欄.length && 行 ? 題の欄.map((e) => E(X.書く(値(行, e.fld), X.項目.get(e.fld)))).join(" ") : E(表示名(行));
  ctx.数える("recordContainer");
  return `<div class=el><div class=elh style="font-size:15px">${題 || "（無題）"}
      <code style="font-size:11px;color:#6b6f76;font-weight:400">${E(行?.id ?? "")}</code><span class=tag>recordContainer</span>
      ${行?.src === "ミミックの入力" ? '<span class=tag>ミミックで作った行</span>' : ""}
      <a href="${E(道(ctx.u, { row: null }))}" style="margin-left:auto;font-size:12px">別の行を選ぶ</a></div>
    ${呼び出し.length ? `<div style="padding:6px 8px 0">${ボタン群を描く(ctx, 呼び出し)}</div>` : ""}
    <div style="padding:10px 12px 0">${節々.map((e) => 要素を描く(ctx, e)).join("")}${並んだ要素を描く(ctx, 他)}</div></div>`;
}

/** ─── entry 画面の面（canvas: 行 → 列 → 段）と横棒（bar）─── */
function 面を描く(ctx, 要素たち) {
  const xs = 並べ替え(ctx.pid, 要素たち.filter((e) => !ctx.消費.has(e.id) || e.type === "levels" || e.type === "grid"));
  const 行群 = [], 行の索引 = new Map();
  for (const e of xs) {
    const p = ctx.置き場.get(e.id);
    const k = p.行 ?? e.id;
    if (!行の索引.has(k)) { const r = { 列群: [], 列の索引: new Map() }; 行の索引.set(k, r); 行群.push(r); }
    const 行 = 行の索引.get(k);
    const ck = p.列 ?? "_";
    if (!行.列の索引.has(ck)) { const c = { 要素: [], 幅: 節を引く(ctx.pid, p.段 ?? "")?.widthUnits ?? null }; 行.列の索引.set(ck, c); 行.列群.push(c); }
    行.列の索引.get(ck).要素.push(e);
  }
  /**
   * **欄（cellEditor）だけで出来た行が続くときは、列に分けずに 1 つの欄の箱へ束ねる。**
   * 受信箱の右側（原価計算 pagxncMVIH0jmZAfp）は 5 行 × 3 列に 1 欄ずつ置かれていて、列ごとに描くと
   * 「入力欄 1 個」の箱が 14 個並ぶ。現行は 1 枚の詳細として見えるので、同じ出どころの欄はまとめて
   * 文脈.欄を描く に渡す（並んだ要素を描く が続く欄を束ねる）。欄以外を含む行はそのまま列に並べる
   */
  const 欄だけ = (行) => 行.列群.every((c) => c.要素.every((e) => e.type === "cellEditor"));
  let 出 = "", 束 = [];
  const 流す = () => { if (束.length) { 出 += 並んだ要素を描く(ctx, 束); 束 = []; } };
  for (const 行 of 行群) {
    if (欄だけ(行)) { for (const c of 行.列群) 束.push(...c.要素); continue; }
    流す();
    出 += 行.列群.length === 1
      ? 並んだ要素を描く(ctx, 行.列群[0].要素)
      : `<div style="display:flex;gap:12px;flex-wrap:wrap;align-items:flex-start;margin-bottom:4px">${行.列群.map((c) => `<div style="flex:${c.幅 ?? 1} 1 240px;min-width:0">${並んだ要素を描く(ctx, c.要素)}</div>`).join("")}</div>`;
  }
  流す();
  return 出;
}
function 棒を描く(ctx, 要素たち) {
  const xs = 並べ替え(ctx.pid, 要素たち.filter((e) => !ctx.消費.has(e.id) && !ctx.予約.has(e.id)));
  if (!xs.length) return "";
  const 行群 = [], 行の索引 = new Map();
  for (const e of xs) { const k = ctx.置き場.get(e.id).行 ?? "_"; if (!行の索引.has(k)) { const r = { id: k, 要素: [] }; 行の索引.set(k, r); 行群.push(r); } 行の索引.get(k).要素.push(e); }
  /**
   * 横棒（Airtable の画面の上の帯）。**枠も見出しも出さない**（demo の PageHeader は帯にボタンが並ぶだけ）。
   * 中のボタンは 棒の中 の旗で「画面ごとのボタン」として描き、骨() が帯の右端へ持ち上げる。
   * ボタン以外（文字・区切り）が残ったときだけ、その場に出す。
   */
  ctx.棒の中 = true;
  const 中身 = 行群.map((r) => {
    const 寄せ = 節を引く(ctx.pid, r.id)?.alignment;
    return `<div style="display:flex;gap:10px;flex-wrap:wrap;align-items:center;justify-content:${寄せ === "end" ? "flex-end" : 寄せ === "center" ? "center" : "flex-start"}">${並んだ要素を描く(ctx, r.要素)}</div>`;
  }).join("");
  ctx.棒の中 = false;
  /** 中身がボタンだけなら（骨() が持ち上げたあと空になる）その場には何も残さない */
  const 骨だけ = 中身.replace(/<div class="acts page">[\s\S]*?<\/div>/g, "").replace(/<div[^>]*>|<\/div>|\s/g, "") === "";
  return 骨だけ ? 中身 : `<div style="margin-bottom:14px">${中身}</div>`;
}

/** その他の要素（描き手が無い型）。serve.mjs と同じ出し方 */
function その他を描く(ctx) {
  const { E, 表 } = X;
  const 残り = [...ctx.その他, ...ctx.要素.filter((e) => !ctx.消費.has(e.id) && !ctx.その他.includes(e))];
  if (!残り.length) return "";
  return `<div class=el><div class=elh>その他の要素 <span class=tag>${残り.length}個</span></div>` +
    残り.map((e) => `<div class=note><b>${E(e.type)}</b>${e.label ? ` 〈${E(e.label)}〉` : ""}${e.tbl ? ` — ${E(表.get(e.tbl)?.表示 ?? e.tbl)}` : ""}</div>`).join("") + `</div>`;
}
const 様式 = `<style>
.el .el{margin-bottom:10px}
.elh .tag{white-space:nowrap}
</style>`;
function 頭(ctx, 補足 = "") {
  const { E, db } = X;
  const p = ctx.p;
  const 束 = p.bundle ? db.prepare("SELECT name FROM bundle WHERE id=?").get(p.bundle)?.name : null;
  return `${様式}<h1>${E(p.name)}</h1><div class=sub>${E(p.tab)}${束 ? ` / ${E(束)}` : ""}・${E(p.layout_kind ?? "")}${p.variant ? `・${E(p.variant)}` : ""}・要素 ${ctx.要素.length}個${補足}</div>`;
}

/** ─── entry 画面 ─── */
function 入口を描く(ctx) {
  /** inbox の右側に予約された要素は inbox が描く（横棒・面・全面の並びからは外す） */
  const 外 = (e) => !ctx.消費.has(e.id) && !ctx.予約.has(e.id);
  const 棒 = ctx.要素.filter((e) => ctx.置き場.get(e.id).種 === "bar" && 外(e));
  const 根の面 = ctx.生?.rootCanvasAreaId ?? null;
  const 全面 = ctx.要素.filter((e) => ctx.置き場.get(e.id).種 === "full" && (!根の面 || ctx.置き場.get(e.id).面 === 根の面 || !ctx.一覧の器.has(e.id)) && 外(e));
  const 面 = ctx.要素.filter((e) => ctx.置き場.get(e.id).種 === "canvas" && (!根の面 || ctx.置き場.get(e.id).面 === 根の面) && 外(e));
  let 中 = 頭(ctx);
  中 += 棒を描く(ctx, 棒);
  中 += 並んだ要素を描く(ctx, 全面.sort((a, b) => a.順 - b.順));
  中 += 面を描く(ctx, 面);
  /** 置き場の分からない要素・器に属さず面にも無い一覧など */
  const 残り = ctx.要素.filter((e) => !ctx.消費.has(e.id) && !ctx.その他.includes(e));
  if (残り.length) 中 += 並んだ要素を描く(ctx, 並べ替え(ctx.pid, 残り));
  if (!ctx.フォーム済 && ctx.要素.some((e) => e.type === "formContainer")) { ctx.フォーム済 = true; 中 += X.フォームの入口(ctx.pid); ctx.数える("formContainer", ctx.要素.filter((e) => e.type === "formContainer").length); for (const e of ctx.要素) if (e.type === "formContainer") ctx.消費.add(e.id); }
  中 += その他を描く(ctx);
  return 中;
}

/** ─── row 画面 ─── */
/**
 * 行が無いときの入口。この画面へ飛ぶ一覧（行を開くと → この画面）・ボタン（navigateToSelectedPage）・
 * 新規作成（rowSelector の埋め込みフォーム）を持つ親画面を挙げ、その親画面に出ている行（row.src に親画面ID）を先に並べる。
 * `detail:<この画面>` を src に持つ行は現行でこの画面を実際に開けた行（crawl/28-detail-rows。47 行）なので最優先。
 */
/** この画面へ飛ぶ親画面。行を開くと → この画面 の一覧、navigateToSelectedPage のボタン、rowSelector の新規作成 */
function 親画面を集める(pid) {
  const 親画面 = new Map();
  for (const r of X.db.prepare("SELECT e.page,e.type,e.spec,p.name,p.in_nav,p.tab,(SELECT name FROM bundle WHERE id=p.bundle) 束 FROM elem e JOIN page p ON p.id=e.page WHERE e.page<>? AND e.type IN ('levels','grid','button','rowSelector') AND e.spec LIKE ?").all(pid, `%${pid}%`)) {
    const sp = JSON.parse(r.spec ?? "{}");
    let 経 = null;
    if (r.type === "levels" || r.type === "grid") { for (const v of Object.values(sp.行を開くと ?? {})) if ((typeof v === "string" ? v : v?.pageId) === pid) 経 = "一覧の行を開く"; }
    else if (r.type === "button" && sp.動作の詳細?.行き先の画面 === pid) 経 = `ボタン「${sp.文字 ?? ""}」`;
    else if (r.type === "rowSelector" && sp.埋め込みフォームのボタン?.pageId === pid) 経 = "新規作成";
    if (!経) continue;
    /** 同じ名前の画面が束ごとにある（運用-編集 へ来る道は 海外売上入力 × 5 束・国内売上入力 × 5 束）ので、束の名を添えて見分ける */
    const x = 親画面.get(r.page) ?? { id: r.page, 名: r.name, 束: r.束 ?? r.tab ?? null, in_nav: r.in_nav, 経路: new Set() };
    x.経路.add(経); 親画面.set(r.page, x);
  }
  return 親画面;
}
/**
 * row 画面に出せる行の候補。位 0: src に detail:<画面> を持つ行（現行でこの画面を実際に開けた行。47 行）、
 * 位 1: 親画面の一覧に出ていた行（row.src にその画面ID）、位 2: その他。同じ位の中は取り込みが新しい順
 */
function 候補の行(p, pid, 親画面) {
  const 全 = p.tbl && X.表.has(p.tbl) ? X.db.prepare("SELECT id,src FROM row WHERE tbl=? ORDER BY loaded DESC, rowid DESC").all(p.tbl) : [];
  const 親 = [...親画面.keys()];
  return 全.map((r) => { const src = r.src ?? ""; return { id: r.id, src, 位: src.includes(`detail:${pid}`) ? 0 : 親.some((k) => src.includes(k)) ? 1 : 2 }; })
    .sort((a, b) => a.位 - b.位);
}
function 行を選ぶ画面(ctx, 注 = null) {
  const { E, 表 } = X;
  const pid = ctx.pid, p = ctx.p;
  const 親画面 = 親画面を集める(pid);
  const 語 = (ctx.u.searchParams.get("q") ?? "").trim().toLowerCase();
  const 候補 = 候補の行(p, pid, 親画面);
  const 全 = 候補;
  const 出 = [];
  for (const c of 候補) { if (出.length >= 150) break; const e = 取る(c.id); if (!e) continue; const 名 = 表示名(e); if (語 && !名.toLowerCase().includes(語)) continue; 出.push({ ...c, 名, 親: [...親画面.keys()].filter((k) => c.src.includes(k)).map((k) => 親画面.get(k).名) }); }
  const 数 = [0, 1, 2].map((i) => 候補.filter((c) => c.位 === i).length);
  const 位の名 = ["この画面で実際に開けた行", "親画面の一覧に出る行", "その他の行"];
  const 節々 = ctx.要素.filter((e) => e.type === "section");
  const 欄々 = ctx.要素.filter((e) => e.type === "cellEditor");
  const 中 = 頭(ctx, `・欄 ${欄々.length}・節 ${節々.length}`) +
    (注 ? `<div class=warn>${E(注)}</div>` : "") +
    `<div class=el><div class=elh>この画面へ来る道 <span class=tag>${親画面.size}画面</span></div>
      ${親画面.size ? [...親画面.values()].map((x) => `<div class=note><a href="/p/${E(x.id)}">${E(x.名)}</a>${x.束 ? ` <span class=tag>${E(x.束)}</span>` : ""}${x.in_nav ? "" : ' <span class=tag>ナビに出ない</span>'} — ${E([...x.経路].join("・"))}</div>`).join("") : '<div class=note>この画面へ飛ぶ一覧・ボタンは定義に見つかりません（URL で直接開く画面）</div>'}</div>
    <div class=el><div class=elh>行を選ぶ <span class=tag>${E(表.get(p.tbl)?.表示 ?? p.tbl ?? "?")}</span><span class=tag>${全.length.toLocaleString()}行</span>
        <span class=tag>${位の名[0]} ${数[0]}</span><span class=tag>${位の名[1]} ${数[1].toLocaleString()}</span></div>
      <form method=get action="/p/${E(pid)}" style="padding:8px 12px;border-bottom:1px solid #eee;display:flex;gap:6px;align-items:center">
        <input name=q value="${E(ctx.u.searchParams.get("q") ?? "")}" placeholder="主項目で探す" style="padding:5px 7px;border:1px solid #ccd;border-radius:4px;font:inherit;width:220px">
        <button class=btn style="background:#2d7ff9;color:#fff;border:0;cursor:pointer">探す</button><span class=tag>先頭 ${出.length} 件</span></form>
      <div class=scroll><table><thead><tr><th>行</th><th>どこから来る</th><th>出ている親画面</th></tr></thead><tbody>
        ${出.map((x) => `<tr><td><a href="${E(道(ctx.u, { row: x.id, q: null }))}">${E(x.名)}</a> <code style="font-size:11px;color:#6b6f76">${E(x.id)}</code></td><td>${x.位 === 0 ? '<span style="color:#0a7">' + 位の名[0] + "</span>" : 位の名[x.位]}</td><td style="white-space:normal">${E(x.親.join("・"))}</td></tr>`).join("") || '<tr><td colspan=3 class=note>該当する行がありません</td></tr>'}
      </tbody></table></div></div>
    <div class=el><div class=elh>この画面の作り</div><div class=note>${節々.map((s) => `節「${E(s.label || "無題")}」 ${(ctx.子.get(s.id) ?? []).reduce((n, g) => n + (ctx.子.get(g.id) ?? []).length, 0)} 要素`).join("<br>") || "節なし"}<br>
      一覧 ${ctx.要素.filter((e) => e.type === "levels" || e.type === "grid").length}・ボタン ${ctx.要素.filter((e) => e.type === "button").length}・器 ${ctx.要素.filter((e) => e.type === "queryContainer").length}</div></div>`;
  return 中;
}
function 詳細画面を描く(ctx) {
  const rid = ctx.u.searchParams.get("row") || null;
  const 行 = 取る(rid);
  if (!rid) return 行を選ぶ画面(ctx);
  if (!行) return 行を選ぶ画面(ctx, `行 ${rid} は手元にありません`);
  if (行.tbl !== ctx.p.tbl) return 行を選ぶ画面(ctx, `行 ${rid} は ${X.表.get(行.tbl)?.表示 ?? 行.tbl} の行で、この画面の表 ${X.表.get(ctx.p.tbl)?.表示 ?? ctx.p.tbl} と違います`);
  const rc = ctx.要素.find((e) => e.type === "recordContainer");
  let 中 = 頭(ctx, `・行 <b>${X.E(表示名(行))}</b>`);
  中 += 要素を描く(ctx, rc);
  const 残り = ctx.要素.filter((e) => !ctx.消費.has(e.id) && !ctx.その他.includes(e));
  if (残り.length) 中 += 並んだ要素を描く(ctx, 並べ替え(ctx.pid, 残り));
  中 += その他を描く(ctx);
  return 中;
}

/** ─── 差し込み口 ─── */
const 担当の型 = new Set(["queryContainer", "recordContainer", "rowSelector", "inbox", "filter", "section"]);
function 引き受けるか(p, 要素) {
  if (!p || !要素?.length) return false;
  if (p.layout_kind === "dashboard") return false;
  if (p.type === "row") return 要素.some((e) => e.type === "recordContainer");
  if (p.type === "entry") return 要素.some((e) => 担当の型.has(e.type));
  return false;
}
/** 要素を rowid（取り込み順）付きで読む。生レイアウトが無いときの並びに使う */
const 要素を読む = (pid) => X.db.prepare("SELECT rowid AS 順, * FROM elem WHERE page=? ORDER BY rowid").all(pid);

function 描く(p, pid, u) {
  const 要素 = 要素を読む(pid);
  if (!引き受けるか(p, 要素)) return null;
  const ctx = 文脈を組む(p, 要素, pid, u);
  const 中 = p.type === "row" ? 詳細画面を描く(ctx) : 入口を描く(ctx);
  return { html: X.骨(p.name ?? pid, 中, pid), ctx };
}

export const 画面 = (p, 要素, pid, u, 文脈) => {
  if (!X) X = 文脈;
  try {
    const r = 描く(p, pid, u ?? new URL("http://x/"));
    return r ? r.html : null;
  } catch (e) {
    console.error(`30-detail ${pid}: ${e.stack ?? e.message}`);
    return null;   // 壊さない。既定の描き方に戻す
  }
};

export const 経路 = [
  /** rowSelector で選んだ行を ?sel_<peo>= と ?row= の両方に写して画面へ戻る */
  { method: "GET", pattern: /^\/sel\/(pag[A-Za-z0-9]+)\/(pel[A-Za-z0-9]+)$/, handler: (req, res, u, m, 文脈) => {
    if (!X) X = 文脈;
    const [, pid, eid] = m;
    const e = X.db.prepare("SELECT * FROM elem WHERE page=? AND id=? AND type='rowSelector'").get(pid, eid);
    if (!e) return X.出す(res, X.骨("404", "<h1>その行を選ぶ箱はありません</h1>", null), 404);
    const sp = spec(e);
    const peo = String((Array.isArray(sp.出力) ? sp.出力[0] : sp.出力) ?? "").replace(/^[A-Za-z]+=/, "");
    const v = u.searchParams.get("v") || null;
    const q = new URLSearchParams(u.searchParams);
    q.delete("v");
    for (const k of [...q.keys()]) if (/^(msg|ok)_/.test(k)) q.delete(k);
    if (v && /^rec[A-Za-z0-9]{14}$/.test(v)) { q.set(`sel_${peo}`, v); q.set("row", v); } else { q.delete(`sel_${peo}`); q.delete("row"); }
    const s = q.toString();
    res.writeHead(303, { location: `/p/${pid}${s ? "?" + s : ""}` }); res.end();
  } },
  /** CSV。この拡張が描く画面の一覧は、画面と同じ絞り込み（器・帯・関連先）で出す。それ以外は serve.mjs の 一覧のCSV へ */
  { method: "GET", pattern: /^\/csv\/(pag[A-Za-z0-9]+)\/(pel[A-Za-z0-9]+)$/, handler: (req, res, u, m, 文脈) => {
    if (!X) X = 文脈;
    const [, pid, eid] = m;
    let r = null;
    try {
      const p = X.db.prepare("SELECT * FROM page WHERE id=?").get(pid);
      const 要素 = p ? 要素を読む(pid) : [];
      const e = 要素.find((x) => x.id === eid && (x.type === "levels" || x.type === "grid"));
      if (p && e && 引き受けるか(p, 要素)) r = CSVを組む(文脈を組む(p, 要素, pid, u), e);
    } catch (err) { console.error(`30-detail csv ${pid}/${eid}: ${err.message}`); }
    if (!r) r = X.一覧のCSV(pid, eid, u);
    if (!r) return X.出す(res, X.骨("404", "<h1>その一覧はありません</h1>", null), 404);
    res.writeHead(200, { "content-type": "text/csv; charset=utf-8", "content-disposition": `attachment; filename*=UTF-8''${encodeURIComponent(r.名)}` });
    res.end(r.中身);
  } },
  /**
   * 描いた要素の型と個数（確認用）。?pages=pag…,pag… で絞れる。無指定はこの拡張が引き受ける全画面を描いて数える。
   * row 画面は ?row= が無いので行選びの画面になる。?rows=1 を付けると各 row 画面を「親画面に出ている行」で 1 行ぶん描く
   */
  { method: "GET", pattern: /^\/detail-stats$/, handler: (req, res, u, m, 文脈) => {
    if (!X) X = 文脈;
    const 指定 = (u.searchParams.get("pages") ?? "").split(",").filter(Boolean);
    const 行も = u.searchParams.get("rows") === "1";
    const 画面たち = X.db.prepare("SELECT * FROM page WHERE has_layout=1").all().filter((p) => !指定.length || 指定.includes(p.id));
    const 合計 = new Map(), その他 = new Map(), 出 = [];
    let 引き受け = 0, 落ちた = 0;
    const t0 = Date.now();
    for (const p of 画面たち) {
      const 要素 = 要素を読む(p.id);
      if (!引き受けるか(p, 要素)) continue;
      引き受け++;
      let u2 = new URL(`http://x/p/${p.id}`);
      if (行も && p.type === "row" && p.tbl) {
        /** 行選びの画面と同じ順（実際に開けた行 → 親画面に出ていた行 → その他）で先頭の 1 行 */
        const c = 候補の行(p, p.id, 親画面を集める(p.id))[0];
        if (c) u2.searchParams.set("row", c.id);
      }
      try {
        const ctx = 文脈を組む(p, 要素, p.id, u2);
        const html = p.type === "row" ? 詳細画面を描く(ctx) : 入口を描く(ctx);
        for (const [k, v] of ctx.描いた) 合計.set(k, (合計.get(k) ?? 0) + v);
        for (const e of ctx.その他) その他.set(e.type, (その他.get(e.type) ?? 0) + 1);
        出.push({ 画面: p.id, 名: p.name, 型: p.type, 描いた: Object.fromEntries(ctx.描いた), その他: ctx.その他.map((e) => e.type), 長さ: html.length });
      } catch (err) { 落ちた++; 出.push({ 画面: p.id, 名: p.name, 落ちた: err.message }); }
    }
    res.writeHead(200, { "content-type": "application/json; charset=utf-8" });
    res.end(JSON.stringify({ 引き受けた画面: 引き受け, 落ちた, ms: Date.now() - t0, 描いた: Object.fromEntries([...合計].sort((a, b) => b[1] - a[1])), その他: Object.fromEntries(その他), 画面: 出 }, null, 1));
  } },
];

export function 準備(文脈) {
  X = 文脈;
  const n = (t) => 文脈.db.prepare("SELECT count(*) c FROM elem WHERE type=?").get(t).c;
  const 画面数 = 文脈.db.prepare("SELECT count(*) c FROM page WHERE has_layout=1 AND ((type='row' AND id IN (SELECT page FROM elem WHERE type='recordContainer')) OR (type='entry' AND layout_kind<>'dashboard' AND id IN (SELECT page FROM elem WHERE type IN ('queryContainer','rowSelector','inbox','filter','section'))))").get().c;
  console.log(`詳細と入口: ${画面数}画面を入れ子で描く（recordContainer ${n("recordContainer")}・section ${n("section")}・sectionGridRow ${n("sectionGridRow")}・queryContainer ${n("queryContainer")}・rowSelector ${n("rowSelector")}・inbox ${n("inbox")}・filter ${n("filter")}）`);
}

/**
 * 画面フックで入れ子ごと描いている型（db/15-coverage.mjs が「描いている要素の種類」を数える根拠）。
 * 証拠: /detail-stats?rows=1 が 319 画面（entry 266・row 53）を落ちずに描き queryContainer 260・rowSelector 30・filter 19・inbox 2 を出した（2026-09-13 再計測）。
 * row 画面 4 件（Record Detail・運用-read only・担当者月間 Detail）で section の見出しが HTML に全部出た（2026-09-12）。
 */
export const 描く種類 = ["recordContainer", "section", "sectionGridRow", "queryContainer", "rowSelector", "filter", "inbox"];
