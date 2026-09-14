/**
 * **集計要素を描く。** ローカルDBだけ。外へは一切つながない。
 *
 * ■ 対象（elem の実数）
 *
 *   bigNumber 14 / chart 11 / pivotTable 3 / dashboard 5 / verticalStack 5 /
 *   horizontalDivider 2 / text 24 / attachmentCarousel 3 / rowActivityFeed 1
 *
 * bigNumber・chart・pivotTable・dashboard・verticalStack は全部 **予実の 5 画面**（商品別・担当者/顧客別・
 * 運賃・倉庫比較・海外営業 分類別・年間実績）にある。text 24 のうち 20 は同じ 4 本の見出しが 5 画面に
 * 複製されたもの（受注管理v1 × 5）。attachmentCarousel 3 は製造/製品生産の詳細 3 画面の「製造指示書」。
 *
 * ■ 行集合は serve.mjs の 一覧の行 と同じ道（文脈.実行 = db/query.mjs）で得る
 *
 * 集計要素の `query.source` は `{type:"query", query:{outputId:"peo…"}}` で、**同じ画面の他要素の出力**を指す。
 * 生レイアウトを読むと鎖は 3 段ある（実測 5 画面すべて同じ形）:
 *
 *   queryContainer（絞り込み帯）  source={type:"table"} + staticFilters   → outputs.query.id = peoA
 *   dashboard                     query.source → peoA                    → outputs.query.id = peoB
 *   bigNumber / chart / pivotTable / levels   query.source → peoB（＋自分の query.filters）
 *
 * `elem.spec` には出力IDしか写っていないので、鎖は生レイアウト（crawl/out/raw/pages-20260911）で辿り、
 * たどり着いた表と、途中の絞り込み全部を and で束ねて **文脈.実行** に渡す。自前の SQL で全行は読まない。
 * 例: 運賃・倉庫比較 の 2 本の chart は 種類番号 isAnyOf [4, 6] を通った 538 行（779 行中）だけを集計する。
 *
 * ■ 手元の断面で集計できるもの・できないもの（正直に出す）
 *
 *   予実/担当者月間(運賃・倉庫)  779 行・値あり            → chart 2 本は完全に描ける
 *   予実/Table（年間実績）       19,989 行・金額は cells にある → 合計は出る。**軸の 分類1/2/3・月(計上日) は
 *                                                          どの画面も要求していない（requested 0）**ので、
 *                                                          軸は 1 群「（未取得）」に畳まれる
 *   予実/商品別月間・売掛台帳・分類別   行 0                → 「手元に行がありません」と出す
 *
 * 集計の答えは要素ごとに `<details>` の表で開けるようにしておく（検算できるように）。
 *
 * ■ dashboard 型の 5 画面は 画面 フックで、生レイアウトの面（canvasArea）の順に描く
 *
 * serve.mjs の既定の描き方は 一覧 → ボタン → 拡張の要素 の順なので、現行（帯 → 数字 → 図 → 一覧）と逆になる。
 * 生レイアウトの根の面が verticalStack（帯）、帯の queryContainer.viewCanvasAreas が指す面が dashboard
 * （実測 5 画面すべて同じ形。区画は numbersSection@a0 → chartsSection@a1 → visualizationsSection@a2）。
 * 30-detail は dashboard 型を引き受けない（引き受けるか が false）ので競合しない。生レイアウトが無い・例外 → null で既定に戻す。
 *
 * ■ 生レイアウトから読んだ鍵（PATCHES-dash.md に一覧）
 *
 *   text              document[]  Quill の差分形式 [{insert, attributes:{header,bold,italic,link…}}]
 *   dashboard         query.source / outputs.query.id
 *   queryContainer    source / staticFilters / outputs.query.id / presetFilters / label.value
 *   pivotTable        query（spec に無い）
 *   slotElementsById  parentId / elementId / index（分数索引の文字列。文字列比較で並ぶ）/ slotType
 *   attachmentCarousel source.row.outputId / numAttachmentsPerCarouselPage
 *   rowActivityFeed   sourceRow.outputId / areCommentsDisabled
 */
import fs from "node:fs";
import path from "node:path";
import { レイアウト } from "../../db/layouts.mjs";
import { 一覧 as 実物の名前, 引く as 実物を引く } from "../../db/artifacts.mjs";

let X = null;   // 文脈（準備で受ける。要素の描き手にも毎回渡るが、道具関数から引けるように控える）

/** ─── 生レイアウト ─── */
/**
 * もとは crawl/out/raw の msgpack（812MB）を実行時に読んでいたが、
 * 読むのは publishedLayout だけで全 335 画面ぶんで 2.2MB しか無い。
 * spec/published-layout.json にまとめて、Vercel のバンドルにも載るようにした。
 * **引いた結果は前と同じ**（抽出時に衝突 0 件・335/335 取得を確認済み）。
 */
const 生の配置の記憶 = new Map();
function 生の配置(ROOT, pid) {
  if (生の配置の記憶.has(pid)) return 生の配置の記憶.get(pid);
  const L = レイアウト(ROOT, pid);
  const v = L?.elementById ? {
    要素: L.elementById, 枠: L.slotElementsById ?? {},
    /** 面の並び（dashboard 型の画面で使う）: 根の面 → fullCanvasElement → 要素 */
    面: L.canvasAreaById ?? {}, 全面: L.fullCanvasElementById ?? {}, 根: L.rootCanvasAreaId ?? null,
  } : null;
  生の配置の記憶.set(pid, v);
  return v;
}
const 生の要素 = (pid, pel) => 生の配置(X.ROOT, pid)?.要素?.[pel] ?? null;

/**
 * 親の下に置かれた子を並び順で返す。並びは slotElementsById の `index`（分数索引。"Zz" < "ZzV" < "a0" < "a1"）。
 * 実測: 商品別 の bigNumber 3 個は Zz(販売金額)・ZzV(原価)・Zzl(粗利益) で、画面の左→右と一致する。
 */
function 子たち(pid, 親ID) {
  const 配置 = 生の配置(X.ROOT, pid);
  if (!配置) return [];
  return Object.values(配置.枠).filter((s) => s.parentId === 親ID)
    .sort((a, b) => (a.index < b.index ? -1 : a.index > b.index ? 1 : 0))
    .map((s) => ({ id: s.elementId, 枠: s.slotType, 生: 配置.要素[s.elementId] ?? null }));
}

/** ─── 出力（peo…）の鎖を辿る ─── */
/**
 * `source` を表まで辿り、途中の絞り込みを集める。
 * @returns {{表ID, 絞り込み: object[], 経路: [{型,id,名}], 切れた: boolean}|null}
 */
function 源を辿る(配置, source, 深 = 0) {
  if (!source || 深 > 8) return null;
  if (source.type === "table") return { 表ID: source.tableId, 絞り込み: [], 経路: [], 切れた: false };
  if (source.type === "query") {
    const out = source.query?.outputId;
    const 親 = Object.values(配置.要素).find((e) => e?.outputs?.query?.id === out);
    const 表ID = source.tableId ?? source.query?.tableId ?? null;
    if (!親) return { 表ID, 絞り込み: [], 経路: [{ 型: "?", id: out, 名: null }], 切れた: true };
    const 上 = 源を辿る(配置, 親.source ?? 親.query?.source, 深 + 1) ?? { 表ID, 絞り込み: [], 経路: [], 切れた: true };
    const 自分の = [親.staticFilters, 親.query?.filters].filter((f) => f?.filterSet?.length);
    return { 表ID: 上.表ID ?? 表ID, 絞り込み: [...上.絞り込み, ...自分の], 経路: [...上.経路, { 型: 親.type, id: 親.id, 名: 親.label?.value ?? null }], 切れた: 上.切れた };
  }
  /** row 型（詳細画面の 1 行）はここでは扱わない */
  return null;
}

/** 1 リクエストの間だけ持つ記憶。鍵は URL の物（serve.mjs は 1 リクエストに 1 つ作る） */
const 記憶 = new WeakMap();
function 覚える(u, 鍵, 作る) {
  const k = (u && typeof u === "object") ? u : 記憶;
  let m = 記憶.get(k);
  if (!m) { m = new Map(); 記憶.set(k, m); }
  if (!m.has(鍵)) m.set(鍵, 作る());
  return m.get(鍵);
}

/**
 * 要素の query から行集合を得る。**serve.mjs の 一覧の行 と同じく 文脈.実行 に table 型の source と絞り込みを渡す。**
 * 値は 計算器.取る で読む（cells→calc→snap→implied の順に見る 計算器.値 のため）。
 */
/**
 * **値が未設定の節は制約にしない。** 取得時点で利用者の絞り込みは全部 value=null だった（db/query.mjs の注）。
 * クエリエンジンは `source: arbitraryColumnFilters` の付いた節だけ落とすが、集計要素の `query.filters` には
 * source が付かない（実測: 運賃・倉庫比較 の chart が `Field contains null`、同じ画面の levels も
 * `月TEXT contains null`）。しかも「Field」列はどの画面も要求していないので、そのまま渡すと
 * エンジンは全 538 行を「判定できない」に入れて 0 行になる。値の要る節で値が無いものは外してから渡す。
 */
function 未設定を落とす(f) {
  if (!f) return null;
  if (f.filterSet) {
    const 節 = f.filterSet.map(未設定を落とす).filter(Boolean);
    return 節.length ? { ...f, filterSet: 節 } : null;
  }
  if (f.sourceColumnId) return f;
  if (f.value == null && !["isEmpty", "isNotEmpty"].includes(f.operator)) return null;
  return f;
}

function 行集合(pid, u, 設定, 表IDの既定 = null) {
  const q = 設定?.query ?? null;
  const 配置 = 生の配置(X.ROOT, pid);
  const 源 = 配置 && q?.source ? 源を辿る(配置, q.source) : null;
  const 表ID = 源?.表ID ?? q?.source?.tableId ?? q?.source?.query?.tableId ?? 表IDの既定;
  const 絞り込み = [...(源?.絞り込み ?? []), ...(q?.filters?.filterSet?.length ? [q.filters] : [])].map(未設定を落とす).filter(Boolean);
  const filters = !絞り込み.length ? null : 絞り込み.length === 1 ? 絞り込み[0] : { conjunction: "and", filterSet: 絞り込み };
  return 覚える(u, `行集合|${表ID}|${JSON.stringify(filters)}`, () => {
    if (!表ID || !X.表.has(表ID)) return { 表ID, 行: [], 怪しい: 0, 母数: 0, 絞り込み, 源, 表がある: false };
    const r = X.実行({ source: { type: "table", tableId: 表ID }, filters, sorts: [] });
    const 行 = r.行.map((id) => X.書き込み.計算器.取る(id)).filter(Boolean);
    return { 表ID, 行, 怪しい: r.怪しい.length, 母数: r.母数, 絞り込み, 源, 表がある: true };
  });
}

/** ─── 値の読み方 ─── */
const 項目名 = (fid) => X.項目.get(fid)?.name ?? fid ?? "?";
const 選択肢名 = (fid, id) => X.書き込み.計算器.選択肢.get(fid)?.[id] ?? null;
const 空か = (v) => v == null || v === "" || (Array.isArray(v) && !v.length) || (typeof v === "object" && !Array.isArray(v) && v.valuesByForeignRowId && !Object.keys(v.valuesByForeignRowId).length);

/** 値の中の数を全部並べる（lookup の {valuesByForeignRowId} と配列は平らにする） */
function 数の並び(v) {
  if (v == null || v === "") return [];
  if (typeof v === "number") return Number.isFinite(v) ? [v] : [];
  if (typeof v === "boolean") return [v ? 1 : 0];
  if (typeof v === "string") { const n = Number(v); return Number.isFinite(n) && v.trim() !== "" ? [n] : []; }
  if (Array.isArray(v)) return v.flatMap(数の並び);
  if (v.valuesByForeignRowId) return (v.foreignRowIdOrder ?? Object.keys(v.valuesByForeignRowId)).flatMap((k) => 数の並び(v.valuesByForeignRowId[k]));
  return [];
}

/**
 * 値を「群の鍵」にする文字。選択肢は名前、関連は表示名、lookup は相手の行の順に並べて連結。
 * `文脈.書く` は lookup の中の選択肢IDを名前に直せない（opts.選択肢ID が無い）ので、ここで 計算器.選択肢 を通す。
 */
function 表示(v, fid) {
  if (空か(v)) return null;
  const f = X.項目.get(fid);
  const 中の項目 = f?.opts?.引く項目;
  const 一つ = (x, 元fid) => {
    if (x == null || x === "") return null;
    if (typeof x === "string" && /^sel[A-Za-z0-9]{14}$/.test(x)) return 選択肢名(fid, x) ?? (中の項目 ? 選択肢名(中の項目, x) : null) ?? x;
    if (typeof x === "object" && !Array.isArray(x) && x.foreignRowDisplayName !== undefined) return String(x.foreignRowDisplayName ?? x.foreignRowId);
    if (Array.isArray(x)) return x.map((y) => 一つ(y, 元fid)).filter(Boolean).join(", ");
    if (x && typeof x === "object" && x.valuesByForeignRowId) return (x.foreignRowIdOrder ?? Object.keys(x.valuesByForeignRowId)).map((k) => 一つ(x.valuesByForeignRowId[k], 元fid)).filter(Boolean).join(", ");
    const 中 = 中の項目 ? X.項目.get(中の項目) : null;
    return String(X.書く(x, 中 ?? f) ?? x);
  };
  const s = 一つ(v, fid);
  return s === "" ? null : s;
}

/** 並べるための鍵。選択肢は選択肢の並び順（db/query.mjs と同じ考え）、数は数、日付は時刻、それ以外は文字 */
function 並べ鍵(v, fid) {
  if (空か(v)) return null;
  const 順表 = X.書き込み.計算器.選択肢.get(fid);
  const 先頭 = (x) => (Array.isArray(x) ? 先頭(x[0]) : x && typeof x === "object" && x.valuesByForeignRowId ? 先頭(x.valuesByForeignRowId[(x.foreignRowIdOrder ?? Object.keys(x.valuesByForeignRowId))[0]]) : x);
  const x = 先頭(v);
  if (x == null) return null;
  if (順表 && typeof x === "string" && x in 順表) return Object.keys(順表).indexOf(x);
  if (typeof x === "number") return x;
  if (typeof x === "string" && /^\d{4}-\d{2}-\d{2}/.test(x)) { const t = new Date(x).getTime(); return Number.isNaN(t) ? x : t; }
  if (typeof x === "object" && x.foreignRowDisplayName !== undefined) return String(x.foreignRowDisplayName ?? "");
  return String(x);
}
const 照合 = new Intl.Collator("ja", { numeric: true, sensitivity: "variant" });
const 鍵を比べる = (a, b) => {
  if (a === b) return 0;
  if (a == null) return 1;                 // 空は最後（Airtable と同じ）
  if (b == null) return -1;
  if (typeof a === "number" && typeof b === "number") return a - b;
  return 照合.compare(String(a), String(b));
};

/**
 * 集計関数。Airtable の columnSummary / aggregationFunction / summaryFunction の鍵。
 * 実測は sum だけ（bigNumber 14・chart 11・pivot 3 とも）。他の鍵も定義から来たときに描けるように持つ。
 * @returns {number|null} 行が 0 なら null
 */
function 集計する(値たち, 関数 = "sum") {
  if (!値たち.length) return null;
  const 数 = 値たち.flatMap(数の並び);
  const 空の数 = 値たち.filter(空か).length;
  /** 全部空（列を取っていない）のに sum が 0 を返すと「¥0」と描かれる。数の集計は null（—）にする。件数系はそのまま */
  if (!数.length && 空の数 === 値たち.length && !/count|empty|filled|unique/i.test(関数)) return null;
  const 和 = (xs) => xs.reduce((a, b) => a + b, 0);
  switch (関数) {
    case "sum": return 和(数);
    case "average": case "avg": case "mean": return 数.length ? 和(数) / 数.length : null;
    case "min": return 数.length ? Math.min(...数) : null;
    case "max": return 数.length ? Math.max(...数) : null;
    case "median": { if (!数.length) return null; const s = [...数].sort((a, b) => a - b); const m = s.length >> 1; return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2; }
    case "range": return 数.length ? Math.max(...数) - Math.min(...数) : null;
    case "stdDev": case "standardDeviation": { if (数.length < 2) return 0; const m = 和(数) / 数.length; return Math.sqrt(和(数.map((x) => (x - m) ** 2)) / 数.length); }
    case "count": case "countAll": case "countRows": return 値たち.length;
    case "countEmpty": case "empty": return 空の数;
    case "countFilled": case "filled": return 値たち.length - 空の数;
    case "countUnique": case "unique": return new Set(値たち.filter((v) => !空か(v)).map((v) => JSON.stringify(v))).size;
    case "percentEmpty": return 値たち.length ? (空の数 / 値たち.length) * 100 : null;
    case "percentFilled": return 値たち.length ? ((値たち.length - 空の数) / 値たち.length) * 100 : null;
    default: return 和(数);
  }
}
const 数える系 = new Set(["count", "countAll", "countRows", "countEmpty", "empty", "countFilled", "filled", "countUnique", "unique"]);
const 割合系 = new Set(["percentEmpty", "percentFilled"]);
/** 集計の結果を書式に当てる。合計・平均などは元の項目の書式（¥・小数桁）、数えるものは整数、割合は % */
function 結果を書く(n, fid, 関数 = "sum") {
  if (n == null) return "—";
  if (割合系.has(関数)) return `${(Math.round(n * 10) / 10).toLocaleString()}%`;
  if (数える系.has(関数) || !fid) return Math.round(n).toLocaleString();
  const f = X.項目.get(fid);
  const o = f?.opts ?? {};
  if (o.書式 || o.記号 || o.小数桁 != null) return X.書く(n, f);
  return Number.isInteger(n) ? n.toLocaleString() : (Math.round(n * 100) / 100).toLocaleString();
}

/** 絞り込みを文にする（画面の頭に「何を集計しているか」を出すため） */
const 比べ方の名 = new Map([["contains", "を含む"], ["doesNotContain", "を含まない"], ["=", "＝"], ["!=", "≠"], [">", "＞"], [">=", "≧"], ["<", "＜"], ["<=", "≦"], ["isEmpty", "が空"], ["isNotEmpty", "が空でない"], ["isAnyOf", "のいずれか"], ["|", "のいずれか"], ["isNoneOf", "のいずれでもない"], ["isWithin", "の範囲"]]);
function 絞り込みを文に(f) {
  if (!f) return "";
  if (f.filterSet) {
    const 中 = f.filterSet.map(絞り込みを文に).filter(Boolean);
    return 中.length > 1 ? `(${中.join(f.conjunction === "or" ? " または " : " かつ ")})` : (中[0] ?? "");
  }
  if (f.sourceColumnId) return `${項目名(f.sourceColumnId)} の先が ${絞り込みを文に(f.foreignTableFilter) || "（条件なし）"}`;
  if (!f.columnId) return "";
  if (f.value == null && !["isEmpty", "isNotEmpty"].includes(f.operator)) return `${項目名(f.columnId)} ${比べ方の名.get(f.operator) ?? f.operator} （未設定・効かない）`;
  const 値 = (x) => (typeof x === "string" && /^sel[A-Za-z0-9]{14}$/.test(x) ? (選択肢名(f.columnId, x) ?? x) : String(x));
  const v = Array.isArray(f.value) ? f.value.map(値).join("・") : f.value == null ? "" : 値(f.value);
  return `${項目名(f.columnId)} ${比べ方の名.get(f.operator) ?? f.operator}${v ? ` ${v}` : ""}`;
}

/** ─── 色 ─── */
/** Airtable の colorTheme（solidRed など）を色に。実測は solidRed / solidYellow / solidCyan / solidPink の 4 種 */
function 色を解く(theme) {
  if (!theme) return ["#f2f4f8", "#1d1f25"];
  const m = String(theme).match(/^(solid|light|dark)?(.*)$/i);
  const 名 = (m?.[2] ?? theme).replace(/^./, (c) => c.toLowerCase());
  if (m?.[1] === "light") return [X.色[`${名}Light2`] ?? X.色[名] ?? "#f2f4f8", "#1d1f25"];
  return X.ボタンの色[名] ?? ["#f2f4f8", "#1d1f25"];
}
/** 図の色。Airtable の categorical "airtable" 配色を写す（青・水・青緑・緑・黄・橙・赤・桃・紫・灰） */
const 図の色 = ["#2d7ff9", "#18bfff", "#20d9d2", "#20c933", "#fcb400", "#ff6f2c", "#f82b60", "#ff08c2", "#8b46ff", "#666"];
const 系列の色 = (i, 起点 = 0) => 図の色[(起点 + i) % 図の色.length];

/** ─── 画面の頭（どの表の何行を集計しているか）─── */
function 母集団の札(集) {
  const { E, 表 } = X;
  if (!集.表がある) return `<span class=tag style="background:#fde8e8;color:#a00">表 ${E(表.get(集.表ID)?.表示 ?? 集.表ID ?? "?")} の行が手元にありません</span>`;
  return `<span class=tag>${E(表.get(集.表ID)?.表示 ?? 集.表ID)}</span>
    <span class=tag>${集.行.length.toLocaleString()}行${集.行.length !== 集.母数 ? `（全${集.母数.toLocaleString()}件から絞り込み）` : ""}</span>
    ${集.怪しい ? `<span class=tag title="絞り込みが見る列を要求していない行。合否を決められないので外した">判定できず ${集.怪しい.toLocaleString()}行</span>` : ""}
    ${集.源?.切れた ? `<span class=tag style="color:#a00">出力の鎖が途中で切れています</span>` : ""}`;
}

/** 軸の列が手元に無いときの注記。要求されていない列は全行が空になる（値が無いのではなく取っていない） */
/** 列を取っていないか（どの画面も要求しておらず、母集団のどの行にも値が無い）。「値が無い」と「取っていない」は別物 */
function 取っていない(集, fid) {
  if (!fid || !集.行.length) return false;
  if (X.db.prepare("SELECT count(*) c FROM requested WHERE fld=?").get(fid).c) return false;
  return !集.行.some((e) => !空か(X.書き込み.計算器.値(e, fid, true)));
}
function 軸の注記(集, fid) {
  if (!取っていない(集, fid)) return "";
  return `<div class=cond>軸の列「${X.E(項目名(fid))}」はどの画面も要求していないため手元に値が無く、1 群に畳まれています。${X.E(復元できない訳(fid))}</div>`;
}
/** 集計する列を取っていないときの注記（bigNumber・chart の系列・pivot の値）。値は「—」になる */
function 列の注記(集, fid) {
  if (!取っていない(集, fid)) return "";
  return `<div class=cond>列「${X.E(項目名(fid))}」はどの画面も要求していないため手元に値が無く、集計できません（—）。予実/売掛台帳 の 8 列がこれ（検証 2026-09-13）</div>`;
}
/**
 * 要求されていない軸の列を、手元の他のデータから復元できないかを調べて、できない理由を文にする。
 * 実測（予実/年間実績）: 分類1/2/3 は 種類番号（関連）を辿る lookup だが、関連は両側とも辺 0 で、相手の表 tblk4nvc6mRJsX25T は 0 行。
 * 月(計上日) は関連で、辺 0。表は同期表（airtableSharedView）だが同期元の項目 fldoST0FM6IzL8hyM は手元の定義に無く、
 * 主項目「Field」も未要求なので同期元の行とも結べない。だから 1 群に畳むしかない。
 */
const 復元の記憶 = new Map();
function 復元できない訳(fid) {
  if (復元の記憶.has(fid)) return 復元の記憶.get(fid);
  const { db, 項目, 表 } = X;
  const f = 項目.get(fid);
  const 辺 = (id) => (id ? db.prepare("SELECT count(*) c FROM link WHERE fld=?").get(id).c : 0);
  const 行数 = (tid) => (tid ? db.prepare("SELECT count(*) c FROM row WHERE tbl=?").get(tid).c : 0);
  const 関連の訳 = (rid) => {
    const r = 項目.get(rid);
    if (!r) return "";
    const 逆 = r.opts?.逆側の項目;
    return `関連「${r.name}」は辺 ${辺(rid).toLocaleString()}${逆 ? `・逆側「${項目.get(逆)?.name ?? 逆}」は辺 ${辺(逆).toLocaleString()}` : ""}、相手の表 ${表.get(r.opts?.関連先)?.表示 ?? "?"}（${r.opts?.関連先 ?? "?"}）は ${行数(r.opts?.関連先).toLocaleString()} 行`;
  };
  const 文 = [];
  if (f?.type === "lookup") 文.push(`lookup がたどる${関連の訳(f.opts?.たどる関連)}`);
  else if (f?.type === "foreignKey") 文.push(関連の訳(fid));
  const t = f ? db.prepare("SELECT primary_fld, sync_cfg FROM tbl WHERE id=?").get(f.tbl) : null;
  if (t?.sync_cfg) {
    try {
      const c = JSON.parse(t.sync_cfg);
      const ext = c.externalFieldIdByColumnId?.[fid];
      if (ext) 文.push(項目.has(ext) ? `同期元の項目は ${表.get(項目.get(ext).tbl)?.表示}.${項目.get(ext).name}` : `同期元の項目 ${ext} は手元の定義に無い`);
      const 主 = t.primary_fld;
      if (主 && !db.prepare("SELECT count(*) c FROM requested WHERE fld=?").get(主).c) 文.push(`主項目「${項目.get(主)?.name ?? 主}」も未要求で同期元の行と結べない`);
    } catch {}
  }
  const 出 = 文.length ? `復元もできない: ${文.join("。")}。` : "";
  復元の記憶.set(fid, 出);
  return 出;
}

/** ─── bigNumber ─── */
function 大数を描く(e, 設定, pid, u) {
  const { E } = X;
  const 集 = 行集合(pid, u, 設定, e.tbl);
  const fid = 設定.columnId;
  const 関数 = 設定.summary?.summaryFunctionKey ?? "sum";
  const 値たち = 集.行.map((r) => X.書き込み.計算器.値(r, fid, true));
  const n = 集計する(値たち, 関数);
  const [bg, fg] = 色を解く(設定.colorTheme);
  const 塗る = 設定.isBackgroundColorEnabled !== false;
  return `<div style="flex:1 1 180px;min-width:180px;border-radius:8px;padding:14px 16px;${塗る ? `background:${bg};color:${fg}` : `background:#fff;border:1px solid #e5e5e7;color:#1d1f25`}">
      <div style="font-size:12px;opacity:.85">${E(設定.descriptionText ?? 項目名(fid))}</div>
      <div style="font-size:30px;font-weight:700;line-height:1.2;font-variant-numeric:tabular-nums;margin:4px 0">${E(結果を書く(n, fid, 関数))}</div>
      ${設定.descriptionSubText ? `<div style="font-size:11px;opacity:.85;white-space:pre-wrap">${E(設定.descriptionSubText)}</div>` : ""}
      ${列の注記(集, fid)}
      <div style="font-size:10.5px;opacity:.8;margin-top:4px">${E(関数)}（${E(項目名(fid))}）・${集.表がある ? `${集.行.length.toLocaleString()}行` : "行なし"}${集.怪しい ? `・判定できず ${集.怪しい}` : ""}</div>
    </div>`;
}

/** ─── 群に分ける（chart / pivot 共通）─── */
/**
 * 行を軸の値で群に分ける。
 * @returns [{鍵, 表示, 行: [...]}] 並びは 並べ鍵 の昇順（選択肢は選択肢の順、空は最後）
 */
function 群に分ける(行, fid) {
  if (!fid) return [{ 鍵: null, 表示: "全体", 行 }];
  /** 列を取っていない（要求 0・値 0 行）なら群名は「（未取得）」。値が本当に空の「（空）」と区別する */
  const 未取得 = 取っていない({ 行 }, fid);
  const m = new Map();
  for (const r of 行) {
    const v = X.書き込み.計算器.値(r, fid, true);
    const 表 = 表示(v, fid);
    /** 空は null を鍵にする。Map は null を鍵にできる。文字の番兵（"空"など）は実値と衝突しうる */
    const k = 表;
    let g = m.get(k);
    if (!g) { g = { 鍵: 並べ鍵(v, fid), 表示: 表 ?? (未取得 ? "（未取得）" : "（空）"), 行: [] }; m.set(k, g); }
    g.行.push(r);
  }
  return [...m.values()].sort((a, b) => 鍵を比べる(a.鍵, b.鍵));
}
/** 系列 1 本の集計値 */
const 系列値 = (群, 系) => (系.type === "count" ? 群.行.length : 集計する(群.行.map((r) => X.書き込み.計算器.値(r, 系.columnId, true)), 系.aggregationFunction ?? "sum"));
const 系列名 = (系) => (系.type === "count" ? "行数" : `${項目名(系.columnId)}${系.aggregationFunction && 系.aggregationFunction !== "sum" ? `（${系.aggregationFunction}）` : ""}`);

/** 目盛り。実データの範囲を 5 分割前後の「きれいな」刻みに */
function 目盛り(最小, 最大, n = 5) {
  let lo = Math.min(0, 最小), hi = Math.max(0, 最大);
  if (lo === hi) hi = lo + n;   // 全部 0 なら 0…n を 1 刻みに（0.2 刻みだと ¥ 書式で「¥0 ¥0 ¥1 ¥1」と重複した）
  const 幅 = (hi - lo) / n;
  const 桁 = 10 ** Math.floor(Math.log10(幅));
  const 刻み = [1, 2, 2.5, 5, 10].map((k) => k * 桁).find((k) => k >= 幅) ?? 桁 * 10;
  lo = Math.floor(lo / 刻み) * 刻み; hi = Math.ceil(hi / 刻み) * 刻み;
  const 目 = []; for (let v = lo; v <= hi + 刻み / 2; v += 刻み) 目.push(Math.round(v / 刻み) * 刻み);
  return { lo, hi, 目 };
}
/** 軸の文字。¥ 付きの長い数は 万・億 で縮める（目盛りが 9 桁だと図が潰れる） */
function 軸の字(n, fid) {
  const a = Math.abs(n);
  const 短く = a >= 1e8 ? `${Math.round(n / 1e8 * 10) / 10}億` : a >= 1e4 ? `${Math.round(n / 1e4 * 10) / 10}万` : null;
  if (短く) { const 記号 = X.項目.get(fid)?.opts?.記号 ?? ""; return `${記号}${短く}`; }
  return 結果を書く(n, fid);
}

/** 図の下に付ける「集計の表」。数字がそのまま検算できる */
function 数の表(群たち, 系たち, 軸名) {
  const { E } = X;
  return `<details style="margin:6px 12px 10px"><summary style="cursor:pointer;font-size:11.5px;color:#6b6f76">集計の表（${群たち.length}群 × ${系たち.length}系列）</summary>
    <div class=scroll><table><thead><tr><th>${E(軸名)}</th><th class=r>行数</th>${系たち.map((s) => `<th class=r>${E(系列名(s))}</th>`).join("")}</tr></thead><tbody>
    ${群たち.map((g) => `<tr><td>${E(g.表示)}</td><td class=r>${g.行.length.toLocaleString()}</td>${系たち.map((s) => `<td class=r>${E(結果を書く(系列値(g, s), s.columnId, s.type === "count" ? "count" : s.aggregationFunction))}</td>`).join("")}</tr>`).join("")}
    <tr style="font-weight:600"><td>合計</td><td class=r>${群たち.reduce((a, g) => a + g.行.length, 0).toLocaleString()}</td>${系たち.map((s) => { const 全 = { 行: 群たち.flatMap((g) => g.行) }; return `<td class=r>${E(結果を書く(系列値(全, s), s.columnId, s.type === "count" ? "count" : s.aggregationFunction))}</td>`; }).join("")}</tr>
    </tbody></table></div></details>`;
}

/** ─── chart ─── */
function 図を描く(e, 設定, pid, u) {
  const { E } = X;
  const 集 = 行集合(pid, u, 設定, e.tbl);
  const d = 設定.definition ?? {};
  const 題 = 設定.title || e.label || "";
  const 起点 = d.colorScheme?.primaryColorIndex ?? 0;
  const 頭 = `<div class=elh>${題 ? E(題) : `<span style="color:#6b6f76">（題なし）</span>`} <span class=tag>chart・${E(d.type ?? "?")}</span> ${母集団の札(集)}
      ${設定.isDrillDownEnabled ? '<span class=tag>現行は棒を押すと行が開く</span>' : ""}</div>
    ${設定.query?.filters?.filterSet?.length ? `<div class=note>この図だけの絞り込み: ${E(絞り込みを文に(設定.query.filters))}</div>` : ""}`;
  if (!集.行.length) return `<div class=el>${頭}<div class=note>集計する行がありません</div></div>`;

  if (d.type === "pie" || d.type === "donut") {
    const fid = d.sliceColumnId;
    const 系 = d.sliceArcLength ?? { type: "count" };
    const 群たち = 群に分ける(集.行, fid);
    const 値 = 群たち.map((g) => Math.max(0, 系列値(g, 系) ?? 0));
    const 総 = 値.reduce((a, b) => a + b, 0);
    const cx = 150, cy = 150, R = 120, r0 = d.type === "donut" ? 60 : 0;
    let 角 = -Math.PI / 2;
    const 片 = 群たち.map((g, i) => {
      const 割 = 総 ? 値[i] / 総 : 0;
      const a0 = 角, a1 = 角 + 割 * 2 * Math.PI; 角 = a1;
      const p = (a, rr) => [cx + rr * Math.cos(a), cy + rr * Math.sin(a)];
      const [x0, y0] = p(a0, R), [x1, y1] = p(a1, R), 大 = 割 > 0.5 ? 1 : 0;
      const 道 = 割 >= 0.99999
        ? `M${cx + R},${cy} A${R},${R} 0 1 1 ${cx - R},${cy} A${R},${R} 0 1 1 ${cx + R},${cy}` + (r0 ? ` M${cx + r0},${cy} A${r0},${r0} 0 1 0 ${cx - r0},${cy} A${r0},${r0} 0 1 0 ${cx + r0},${cy}` : "")
        : r0 ? `M${p(a0, r0)} L${x0},${y0} A${R},${R} 0 ${大} 1 ${x1},${y1} L${p(a1, r0)} A${r0},${r0} 0 ${大} 0 ${p(a0, r0)} Z`
             : `M${cx},${cy} L${x0},${y0} A${R},${R} 0 ${大} 1 ${x1},${y1} Z`;
      const [lx, ly] = p((a0 + a1) / 2, (R + r0) / 2 + 12);
      const 字 = d.labelAppearance?.shouldShowPercentageOnChart !== false && 割 >= 0.04 ? `<text x="${lx}" y="${ly}" font-size="11" text-anchor="middle" fill="#fff" font-weight="600">${Math.round(割 * 100)}%</text>` : "";
      return `<path d="${道}" fill="${系列の色(i, 起点)}" stroke="#fff" stroke-width="1.5"${r0 ? ' fill-rule="evenodd"' : ""}><title>${E(g.表示)}: ${E(結果を書く(値[i], 系.columnId, 系.type === "count" ? "count" : 系.aggregationFunction))}（${Math.round(割 * 1000) / 10}%）</title></path>${字}`;
    }).join("");
    const 凡例 = 群たち.map((g, i) => `<div style="display:flex;gap:6px;align-items:center;font-size:12px"><span style="width:10px;height:10px;border-radius:2px;background:${系列の色(i, 起点)};flex:0 0 10px"></span>
        <span style="min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${E(g.表示)}</span><span style="margin-left:auto;font-variant-numeric:tabular-nums">${E(結果を書く(値[i], 系.columnId, 系.type === "count" ? "count" : 系.aggregationFunction))}</span><span style="color:#6b6f76;width:44px;text-align:right">${総 ? Math.round(値[i] / 総 * 1000) / 10 : 0}%</span></div>`).join("");
    return `<div class=el>${頭}
      <div style="display:flex;gap:16px;flex-wrap:wrap;align-items:center;padding:8px 12px">
        <svg viewBox="0 0 300 300" width="300" height="300" role="img" aria-label="${E(題 || "円グラフ")}">${総 ? 片 : `<circle cx="${cx}" cy="${cy}" r="${R}" fill="#eee"/><text x="${cx}" y="${cy}" text-anchor="middle" font-size="12" fill="#666">値が 0</text>`}</svg>
        <div style="flex:1 1 260px;min-width:220px;max-height:300px;overflow:auto">${凡例}</div></div>
      ${軸の注記(集, fid)}
      ${数の表(群たち, [系], 項目名(fid))}</div>`;
  }

  /** 棒・折れ線・散布 */
  const x = d.xAxisColumnId;
  const 主系 = (d.yAxisSeriesPrimary?.length ? d.yAxisSeriesPrimary : [d.yAxis ?? { type: "count" }]).map((s) => ({ ...s, 軸: "左" }));
  const 副 = d.yAxisSecondary?.aggregation ? { ...d.yAxisSecondary.aggregation, 軸: "右", 形: d.yAxisSecondary.type ?? "line", 色: d.yAxisSecondary.color } : null;
  const 系たち = 副 ? [...主系, 副] : 主系;
  const 群たち = 群に分ける(集.行, x);
  const 値表 = 群たち.map((g) => 系たち.map((s) => 系列値(g, s) ?? 0));
  const 左の値 = 値表.flatMap((v) => v.filter((_, i) => 系たち[i].軸 === "左"));
  const 右の値 = 副 ? 値表.map((v) => v[v.length - 1]) : [];
  const 左 = 目盛り(Math.min(...左の値), Math.max(...左の値));
  const 右 = 副 ? 目盛り(d.yAxisSecondary?.shouldNotStartAtZero ? Math.min(...右の値) : Math.min(0, ...右の値), Math.max(...右の値)) : null;
  const W = 760, H = 320, mL = 84, mR = 副 ? 84 : 16, mT = 16, mB = 群たち.length > 8 ? 78 : 46;
  const pw = W - mL - mR, ph = H - mT - mB;
  const yで = (v, 軸) => mT + ph - ((v - 軸.lo) / (軸.hi - 軸.lo)) * ph;
  const 群幅 = pw / Math.max(1, 群たち.length);
  const 棒の系 = 主系.length;
  const 棒幅 = Math.max(2, (群幅 * 0.72) / 棒の系);
  const 線か = d.type === "line";
  const 散布か = d.type === "scatter";
  let 中 = "";
  /** 横の目盛線と左の目盛り */
  for (const t of 左.目) 中 += `<line x1="${mL}" x2="${W - mR}" y1="${yで(t, 左)}" y2="${yで(t, 左)}" stroke="${t === 0 ? "#999" : "#eee"}"/><text x="${mL - 6}" y="${yで(t, 左) + 4}" font-size="10.5" text-anchor="end" fill="#555">${E(軸の字(t, 主系[0]?.columnId))}</text>`;
  if (副) for (const t of 右.目) 中 += `<text x="${W - mR + 6}" y="${yで(t, 右) + 4}" font-size="10.5" fill="${X.ボタンの色[副.色]?.[0] ?? "#a00"}">${E(軸の字(t, 副.columnId))}</text>`;
  /** 棒か点 */
  群たち.forEach((g, gi) => {
    const x0 = mL + gi * 群幅;
    if (!線か && !散布か) 主系.forEach((s, si) => {
      const v = 値表[gi][si];
      const y = yで(Math.max(v, 左.lo), 左), y0 = yで(Math.min(Math.max(0, 左.lo), 左.hi), 左);
      const bx = x0 + 群幅 * 0.14 + si * 棒幅;
      中 += `<rect x="${bx}" y="${Math.min(y, y0)}" width="${棒幅 - 1}" height="${Math.max(0.5, Math.abs(y0 - y))}" fill="${系列の色(si, 起点)}"><title>${E(g.表示)} — ${E(系列名(s))}: ${E(結果を書く(v, s.columnId, s.type === "count" ? "count" : s.aggregationFunction))}</title></rect>`;
    });
    const ラベル = g.表示.length > 14 ? g.表示.slice(0, 13) + "…" : g.表示;
    中 += 群たち.length > 8
      ? `<text transform="translate(${x0 + 群幅 / 2},${H - mB + 10}) rotate(-40)" font-size="10.5" text-anchor="end" fill="#444">${E(ラベル)}</text>`
      : `<text x="${x0 + 群幅 / 2}" y="${H - mB + 16}" font-size="10.5" text-anchor="middle" fill="#444">${E(ラベル)}</text>`;
  });
  /** 折れ線（line 型の主系列、または右軸の副系列） */
  const 線を引く = (si, 軸, 色, 点も) => {
    const 点 = 群たち.map((g, gi) => [mL + gi * 群幅 + 群幅 / 2, yで(値表[gi][si], 軸)]);
    let s = `<polyline points="${点.map((p) => p.join(",")).join(" ")}" fill="none" stroke="${色}" stroke-width="2"/>`;
    if (点も) s += 点.map((p, gi) => `<circle cx="${p[0]}" cy="${p[1]}" r="3.5" fill="${色}"><title>${E(群たち[gi].表示)} — ${E(系列名(系たち[si]))}: ${E(結果を書く(値表[gi][si], 系たち[si].columnId, 系たち[si].type === "count" ? "count" : 系たち[si].aggregationFunction))}</title></circle>`).join("");
    return s;
  };
  if (線か || 散布か) 主系.forEach((s, si) => { 中 += 散布か ? 線を引く(si, 左, 系列の色(si, 起点), true).replace(/<polyline[^>]*\/>/, "") : 線を引く(si, 左, 系列の色(si, 起点), 設定.shouldAlwaysPlotDotsOnLines !== false); });
  if (副) 中 += 線を引く(系たち.length - 1, 右, X.ボタンの色[副.色]?.[0] ?? "#f82b60", true);
  中 += `<line x1="${mL}" x2="${mL}" y1="${mT}" y2="${mT + ph}" stroke="#999"/>`;
  const 凡例 = 系たち.map((s, i) => `<span style="display:inline-flex;gap:5px;align-items:center;font-size:11.5px;margin-right:12px"><span style="width:10px;height:10px;border-radius:2px;background:${s.軸 === "右" ? (X.ボタンの色[s.色]?.[0] ?? "#f82b60") : 系列の色(i, 起点)}"></span>${E(系列名(s))}${s.軸 === "右" ? "（右軸・折れ線）" : ""}</span>`).join("");
  return `<div class=el>${頭}
    <div style="padding:6px 12px 0">${凡例}</div>
    <div class=scroll style="padding:0 6px"><svg viewBox="0 0 ${W} ${H}" width="${W}" height="${H}" style="max-width:100%;height:auto;font-family:inherit" role="img" aria-label="${E(題 || "図")}">${中}</svg></div>
    ${d.yAxisLabel ? `<div class=note>縦軸: ${E(d.yAxisLabel)}</div>` : ""}
    ${軸の注記(集, x)}
    ${数の表(群たち, 系たち, 項目名(x))}</div>`;
}

/** ─── pivotTable ─── */
function ピボットを描く(e, spec, pid, u) {
  const { E } = X;
  const 生 = 生の要素(pid, e.id);
  const 集 = 行集合(pid, u, 生 ?? {}, e.tbl);
  const 行軸 = spec.行の軸 ?? 生?.rowDimensions ?? [];
  const 列軸 = spec.列の軸 ?? 生?.columnDimensions ?? [];
  const 集計 = spec.集計 ?? 生?.summaries ?? [];
  const 題 = e.label || 生?.label?.value || "";
  const 頭 = `<div class=elh>${E(題 || "ピボット")} <span class=tag>pivotTable</span> ${母集団の札(集)}
    <span class=tag>行: ${E(行軸.map((a) => 項目名(a.columnId)).join(" › ") || "—")}</span>
    <span class=tag>列: ${E(列軸.map((a) => 項目名(a.columnId)).join(" › ") || "—")}</span>
    <span class=tag>集計: ${E(集計.map((s) => `${項目名(s.columnId)} ${s.summaryFunction}`).join("・") || "行数")}</span></div>`;
  if (!集.行.length) return `<div class=el>${頭}<div class=note>集計する行がありません</div></div>`;

  /** 多段の軸は鍵を " / " で結んで 1 段に畳む（実測は 1 段ずつ）。降順の指定は並びを逆にする */
  const 軸で分ける = (行, 軸たち) => {
    if (!軸たち.length) return [{ 鍵: null, 表示: "全体", 行 }];
    let 群 = [{ 鍵: [], 表示: "", 行 }];
    for (const a of 軸たち) {
      const 次 = [];
      for (const g of 群) {
        let 子 = 群に分ける(g.行, a.columnId);
        if (a.sort?.order === "descending") 子 = [...子].reverse();
        for (const c of 子) 次.push({ 鍵: [...g.鍵, c.鍵], 表示: g.表示 ? `${g.表示} / ${c.表示}` : c.表示, 行: c.行 });
      }
      群 = 次;
    }
    return 群;
  };
  const 行群 = 軸で分ける(集.行, 行軸);
  const 列群 = 軸で分ける(集.行, 列軸);
  const 列の鍵 = new Map(列群.map((g, i) => [g.表示, i]));
  const 系 = 集計.length ? 集計.map((s) => ({ type: "column", columnId: s.columnId, aggregationFunction: s.summaryFunction ?? "sum" })) : [{ type: "count" }];
  const 値 = (行) => 系.map((s) => 系列値({ 行 }, s));
  /** 行と列が交わらない升は空白（Airtable のピボットも空白。「—」だと 0 と読み違える） */
  const 書 = (v, s) => (v == null ? "" : E(結果を書く(v, s.columnId, s.type === "count" ? "count" : s.aggregationFunction)));
  const 行の合計 = 行軸.some((a) => a.shouldShowTotalValues) || !行軸.length;
  const 列の合計 = 列軸.some((a) => a.shouldShowTotalValues) || !列軸.length;
  /** 列ごとに行を交差させる（行 ∩ 列）。行ID の集合で引く */
  const 表体 = 行群.map((rg) => {
    const ids = new Set(rg.行.map((r) => r.id));
    const 交差 = 列群.map((cg) => 値(cg.行.filter((r) => ids.has(r.id))));
    return { rg, 交差, 合計: 値(rg.行) };
  });
  const 列合計 = 列群.map((cg) => 値(cg.行));
  const 総合計 = 値(集.行);
  const 見出し = `<tr><th rowspan="${系.length > 1 ? 2 : 1}">${E(行軸.map((a) => 項目名(a.columnId)).join(" / ") || "")}</th>
      ${列群.map((cg) => `<th class=r colspan="${系.length}">${E(cg.表示)}</th>`).join("")}${列の合計 ? `<th class=r colspan="${系.length}">合計</th>` : ""}</tr>
    ${系.length > 1 ? `<tr>${列群.map(() => 系.map((s) => `<th class=r>${E(系列名(s))}</th>`).join("")).join("")}${列の合計 ? 系.map((s) => `<th class=r>${E(系列名(s))}</th>`).join("") : ""}</tr>` : ""}`;
  const 本体 = 表体.map(({ rg, 交差, 合計 }) => `<tr><td>${E(rg.表示)}</td>${交差.map((vs) => vs.map((v, i) => `<td class=r>${書(v, 系[i])}</td>`).join("")).join("")}${列の合計 ? 合計.map((v, i) => `<td class=r style="font-weight:600">${書(v, 系[i])}</td>`).join("") : ""}</tr>`).join("");
  const 末 = 行の合計 ? `<tr style="font-weight:600;background:#fafafb"><td>合計</td>${列合計.map((vs) => vs.map((v, i) => `<td class=r>${書(v, 系[i])}</td>`).join("")).join("")}${列の合計 ? 総合計.map((v, i) => `<td class=r>${書(v, 系[i])}</td>`).join("") : ""}</tr>` : "";
  return `<div class=el>${頭}
    ${行軸.map((a) => 軸の注記(集, a.columnId)).join("")}${列軸.map((a) => 軸の注記(集, a.columnId)).join("")}
    <div class=scroll><table><thead>${見出し}</thead><tbody>${本体}${末}</tbody></table></div>
    <div class=note>${行群.length}行 × ${列群.length}列・${集.行.length.toLocaleString()}行を集計${生?.isPdfExportEnabled ? "・現行は PDF 書き出しあり" : ""}</div></div>`;
}

/** ─── dashboard（配置）─── */
/** 描いた要素を控える。子は serve.mjs の要素の輪でもう一度呼ばれるので、二度描かないために見る */
const 描いた = (u) => 覚える(u, "描いた", () => new Set());
/** 画面フック（dashboard 型）が描いている最中か。一覧・ボタンをその場に描くかどうかを決める */
const 画面が描く = (u) => 覚える(u, "画面が描く", () => ({ 中: false })).中;

function 子を描く(子, pid, u, 要素の索引) {
  const { E } = X;
  const e = 要素の索引.get(子.id) ?? { id: 子.id, type: 子.生?.type, tbl: null, label: null, spec: null };
  const spec = e.spec ? JSON.parse(e.spec) : {};
  描いた(u).add(子.id);
  switch (子.生?.type ?? e.type) {
    case "bigNumber": return 大数を描く(e, spec.設定 ?? 子.生 ?? {}, pid, u);
    case "chart": return `<div style="flex:1 1 100%">${図を描く(e, spec.設定 ?? 子.生 ?? {}, pid, u)}</div>`;
    case "pivotTable": return `<div style="flex:1 1 100%">${ピボットを描く(e, spec, pid, u)}</div>`;
    case "levels": case "grid":
      /** serve.mjs は dashboard 型で一覧を先に描かない（2026-09-13 から）ので、画面フックでも既定の経路でもここで描く */
      return `<div style="flex:1 1 100%">${X.一覧を描く(e, spec, pid, u)}</div>`;
    case "button": return e.spec ? `<div style="flex:1 1 100%">${X.ボタンを描く([e], pid, u)}</div>` : "";
    default: return `<div class=note style="flex:1 1 100%">${E(子.生?.type ?? e.type ?? "?")}</div>`;
  }
}

/**
 * dashboard は 3 つの区画（numbersSection / chartsSection / visualizationsSection）を持ち、
 * 各区画は section → sectionGridRow → 子 の順に並ぶ。並びは slotElementsById の index。
 */
function 配置を描く(e, spec, pid, u) {
  const { E, db } = X;
  const 要素の索引 = new Map(db.prepare("SELECT * FROM elem WHERE page=?").all(pid).map((r) => [r.id, r]));
  const 生 = 生の要素(pid, e.id);
  const 集 = 生 ? 行集合(pid, u, 生, null) : null;
  const 鎖 = 集?.源?.経路?.map((p) => `${p.名 ? `${p.名}（${p.型}）` : p.型}`).join(" → ") ?? "";
  let 中 = `<div class=el><div class=elh>集計の配置 <span class=tag>dashboard</span> ${集 ? 母集団の札(集) : '<span class=tag style="color:#a00">生レイアウトが無く、鎖を辿れません</span>'}</div>
    <div class=note>母集団の鎖: ${E(X.表.get(集?.表ID)?.表示 ?? "?")}${鎖 ? ` → ${E(鎖)} → この配置` : ""}
      ${集?.絞り込み?.length ? `<br>固定の絞り込み: ${E(集.絞り込み.map(絞り込みを文に).join(" かつ "))}` : "<br>固定の絞り込みなし（表の全行）"}</div></div>`;
  const 区画 = 子たち(pid, e.id);
  if (!区画.length) {
    /** 生レイアウトが無いときは DB の path で束ねる（section → sectionGridRow の順は path の文字列順） */
    const 下 = [...要素の索引.values()].filter((x) => ["bigNumber", "chart", "pivotTable"].includes(x.type) && String(x.path ?? "").includes(`dashboard:${e.id}`)).sort((a, b) => 照合.compare(a.path ?? "", b.path ?? ""));
    中 += `<div style="display:flex;gap:10px;flex-wrap:wrap">${下.map((x) => 子を描く({ id: x.id, 生: null }, pid, u, 要素の索引)).join("")}</div>`;
    return 中;
  }
  const 区画名 = { numbersSection: "数字", chartsSection: "図", visualizationsSection: "一覧" };
  for (const 区 of 区画) {
    const 行たち = 子たち(pid, 区.id);
    const 本 = 行たち.map((r) => {
      const 子 = 子たち(pid, r.id);
      if (!子.length) return "";
      return `<div style="display:flex;gap:10px;flex-wrap:wrap;margin-bottom:10px${r.生?.contentArea === "center" ? ";justify-content:center" : ""}">${子.map((c) => 子を描く(c, pid, u, 要素の索引)).join("")}</div>`;
    }).join("");
    if (!本.trim()) continue;
    中 += `<div style="margin-bottom:6px"><div style="font-size:11px;color:#6b6f76;font-weight:600;margin:2px 0 6px">${E(区画名[区.枠] ?? 区.枠)}${区.生?.shouldDisplayTitle && 区.生?.title ? `・${E(区.生.title)}` : ""}</div>${本}</div>`;
  }
  return 中;
}

/**
 * verticalStack は dashboard 画面の上に載る「絞り込み帯（queryContainer）」の器。
 * 器の中身は elem.spec（利用者が操れるもの・絞り込み帯の列・固定の絞り込み・保存された絞り込み）から描く。
 */
function 帯を描く(e, spec, pid, u) {
  const { E, db } = X;
  const 器たち = db.prepare("SELECT * FROM elem WHERE page=? AND type='queryContainer'").all(pid)
    .filter((x) => String(x.path ?? "").includes(`verticalStack:${e.id}`))
    .map((x) => ({ ...x, sp: JSON.parse(x.spec ?? "{}") }));
  if (!器たち.length) return `<div class=el><div class=elh>縦の積み <span class=tag>verticalStack</span></div><div class=note>中に置かれた要素は定義にありません</div></div>`;
  return 器たち.map((器) => {
    const 生 = 生の要素(pid, 器.id);
    const 表ID = 生?.source?.tableId ?? 器.tbl;
    const 許し = 器.sp.利用者が操れるもの ?? {};
    const 列 = 器.sp.絞り込み帯の列 ?? [];
    const 保存 = 器.sp.保存された絞り込み ?? [];
    return `<div class=el><div class=elh>${E(器.label || 器.sp.label || "絞り込み帯")} <span class=tag>verticalStack › queryContainer</span>
        <span class=tag>${E(X.表.get(表ID)?.表示 ?? 表ID ?? "?")}</span>
        ${器.sp.PDF書き出し ? '<span class=tag>PDF 書き出しあり</span>' : ""}${器.sp.CSV書き出し ? '<span class=tag>CSV 書き出しあり</span>' : ""}</div>
      <div style="padding:8px 12px;display:flex;gap:8px;flex-wrap:wrap;align-items:center">
        <span style="font-size:11px;color:#6b6f76;font-weight:600">絞り込み帯（${E(器.sp.絞り込み帯の種類 ?? "presets")}）</span>
        ${列.map((c) => `<span class=btn style="background:#eef0f4;color:#333;font-weight:500">${E(c.名 && !/^fld/.test(c.名) ? c.名 : 項目名(c.id))} ▾</span>`).join("") || '<span class=note>列なし</span>'}
        <span class=tag style="margin-left:auto">利用者に開放: ${["isFilterEnabled", "isSortEnabled", "isSearchEnabled", "isGroupLevelsEnabled"].filter((k) => 許し[k]).map((k) => k.replace(/^is|Enabled$/g, "")).join("・") || "なし"}</span></div>
      ${器.sp.固定の絞り込み ? `<div class=note>固定の絞り込み（利用者は外せない）: ${E(絞り込みを文に(器.sp.固定の絞り込み))}</div>` : ""}
      ${保存.length ? `<div class=note>保存された絞り込み: ${保存.map((s) => `「${E(s.name ?? (s.type === "allRows" ? "すべて" : "?"))}」${s.filters ? ` = ${E(絞り込みを文に(s.filters))}` : ""}`).join("・")}（現行の帯では ${E(器.sp.絞り込み帯の種類 ?? "presets")} が有効）</div>` : ""}
      <div class=note>帯の値は取得時すべて未設定（filterObj null）だったので、ミミックでは制約にしていない。列ごとの絞り込みは各一覧の「絞り込み」で当てられる。</div></div>`;
  }).join("");
}

/** ─── text（Quill の差分形式）─── */
/**
 * 生レイアウトの `document` は Quill の差分（[{insert, attributes}]）。改行の insert に付く attributes が行の種類
 * （header: 1..3、list: bullet/ordered）、それ以外の attributes が文字の飾り（bold/italic/underline/strike/link/code）。
 * link は外へ飛ばさず、宛先を文字で添える。
 */
function 差分をHTMLに(document) {
  const { E } = X;
  if (!Array.isArray(document)) return "";
  const 行たち = []; let 今 = [];
  for (const op of document) {
    if (typeof op?.insert !== "string") { if (op?.insert) 今.push({ 字: "[埋め込み]", 飾: {} }); continue; }
    const 片 = op.insert.split("\n");
    片.forEach((t, i) => {
      if (t) 今.push({ 字: t, 飾: op.attributes ?? {} });
      if (i < 片.length - 1) { 行たち.push({ 中: 今, 行の飾: op.attributes ?? {} }); 今 = []; }
    });
  }
  if (今.length) 行たち.push({ 中: 今, 行の飾: {} });
  const 字を描く = (p) => {
    let s = E(p.字);
    if (p.飾.code) s = `<code>${s}</code>`;
    if (p.飾.bold) s = `<b>${s}</b>`;
    if (p.飾.italic) s = `<i>${s}</i>`;
    if (p.飾.underline) s = `<u>${s}</u>`;
    if (p.飾.strike) s = `<s>${s}</s>`;
    if (p.飾.link) s = `${s} <code style="font-size:11px;color:#6b6f76">(${X.引き金か(p.飾.link) ? "⚠ 引き金の宛先・開きません: " : X.外部か(p.飾.link) ? "外部・開きません: " : ""}${E(String(p.飾.link).slice(0, 120))})</code>`;
    return s;
  };
  let out = "", 一覧 = null;
  const 閉じる = () => { if (一覧) { out += `</${一覧}>`; 一覧 = null; } };
  for (const 行 of 行たち) {
    const 中 = 行.中.map(字を描く).join("") || "&nbsp;";
    const h = 行.行の飾.header;
    if (行.行の飾.list) {
      const 種 = 行.行の飾.list === "ordered" ? "ol" : "ul";
      if (一覧 !== 種) { 閉じる(); 一覧 = 種; out += `<${種} style="margin:2px 0 2px 18px;padding:0">`; }
      out += `<li>${中}</li>`;
      continue;
    }
    閉じる();
    out += h ? `<h${Math.min(3, Math.max(1, Number(h))) + 1} style="margin:4px 0;font-size:${h === 1 ? 17 : h === 2 ? 15 : 13.5}px">${中}</h${Math.min(3, Math.max(1, Number(h))) + 1}>` : `<p style="margin:2px 0">${中}</p>`;
  }
  閉じる();
  return out;
}
function 本文を描く(e, spec, pid) {
  const 生 = 生の要素(pid, e.id);
  if (!生?.document) return `<div class=el><div class=note><b>text</b>${e.label ? ` 〈${X.E(e.label)}〉` : ""} — 本文は定義（elem.spec）に写っておらず、生レイアウトも手元にありません</div></div>`;
  return `<div class=el><div style="padding:8px 12px">${差分をHTMLに(生.document)}</div></div>`;
}

/** ─── attachmentCarousel ─── */
const 実物の置き場 = () => path.join(X.ROOT, "crawl", "out", "artifacts");
let 実物の一覧 = null;
/** 手元の実物。ファイル名は `<タブ>-<表>-<項目>__<行ID>__<元のファイル名>` */
function 実物を探す(行ID, ファイル名) {
  実物の一覧 ??= 実物の名前(X.ROOT);
  return 実物の一覧.find((f) => f.includes(`__${行ID}__`) && f.endsWith(`__${ファイル名}`)) ?? 実物の一覧.find((f) => f.endsWith(`__${ファイル名}`)) ?? null;
}
const 大きさ = (b) => (b == null ? "" : b >= 1e6 ? `${Math.round(b / 1e5) / 10} MB` : b >= 1e3 ? `${Math.round(b / 100) / 10} KB` : `${b} B`);

function 回転木馬を描く(e, spec, pid, u) {
  const { E, db } = X;
  const fid = spec.項目ID ?? e.fld;
  const 一面 = Math.max(1, Number(spec.一面あたり) || 1);
  const 名 = e.label || 項目名(fid);
  const rid = u.searchParams.get("row");
  const 行 = rid ? X.書き込み.計算器.取る(rid) : null;
  const 頭 = `<div class=elh>${E(名)} <span class=tag>attachmentCarousel・1面 ${一面}枚</span> <span class=tag>${E(X.表.get(e.tbl)?.表示 ?? e.tbl ?? "")}</span></div>`;
  if (!行 || 行.tbl !== e.tbl) return `<div class=el>${頭}<div class=note>${rid ? `行 ${E(rid)} は${行 ? "この表の行ではありません" : "手元にありません"}` : "行が選ばれていません。上の「行を選ぶ」から選ぶと、その行の添付をここに出します"}</div></div>`;
  const 生 = X.書き込み.計算器.値(行, fid, true);
  const 添付 = Array.isArray(生) ? 生 : 生 ? [生] : [];
  const 手元 = new Map(db.prepare("SELECT id,name,path,bytes,kind FROM attach WHERE row=? AND fld=?").all(行.id, fid).map((a) => [a.id, a]));
  if (!添付.length) {
    const 全体 = db.prepare(`SELECT count(*) c FROM row WHERE tbl=? AND (json_extract(cells, ?) IS NOT NULL OR json_extract(snap, ?) IS NOT NULL)`).get(e.tbl, `$.${fid}`, `$.${fid}`).c;
    const 要求 = db.prepare("SELECT count(*) c FROM requested WHERE fld=?").get(fid).c;
    const 表名 = X.表.get(e.tbl);
    実物の一覧 ??= 実物の名前(X.ROOT);
    const 実物 = 表名 ? 実物の一覧.filter((f) => f.startsWith(`${表名.tab}-${表名.name}-`)).length : 0;
    /**
     * **「値が無い」と「要求していない」は別物**（db/query.mjs の注と同じ）。
     * 実測: 製造/製品生産.製造指示書 は 320 画面のどれも列として要求しておらず（requested 0）、2,226 行すべて値が来ていない。
     * 添付が無いのではなく取っていないので、そう書く。実物の置き場にもこの表の実物は 0 件。
     */
    if (!要求 && !全体) return `<div class=el>${頭}<div class=note>「${E(名)}」はどの画面も列として要求していない（requested 0）ため、手元の断面には値が来ていません。<b>添付が無いのではなく取っていない</b>（読み取りだけの追加取得で埋まります）。実物の置き場 crawl/out/artifacts にも ${E(表名?.表示 ?? "")} の実物は ${実物} 件です。</div></div>`;
    return `<div class=el>${頭}<div class=note>この行に「${E(名)}」の添付はありません（手元の断面では ${E(表名?.表示 ?? "")} の全 ${db.prepare("SELECT count(*) c FROM row WHERE tbl=?").get(e.tbl).c.toLocaleString()} 行中、この項目に値がある行は ${全体} 行）</div></div>`;
  }
  const 面の数 = Math.ceil(添付.length / 一面);
  const 面 = Math.min(面の数, Math.max(1, Number(u.searchParams.get(`c_${e.id}`)) || 1));
  const 道 = (k) => { const q = new URLSearchParams(u.searchParams); q.set(`c_${e.id}`, String(k)); return `${u.pathname}?${q}`; };
  const 出す = 添付.slice((面 - 1) * 一面, 面 * 一面).map((a) => {
    const 実 = 手元.get(a.id)?.path ?? 実物を探す(行.id, a.filename ?? "");
    const 種 = a.type ?? "";
    const 局所 = 実 ? `/artifact/${encodeURIComponent(path.basename(実))}` : null;
    const 中身 = !局所 ? `<div class=note>実物は手元にありません（外部の URL は開きません）: <code>${E(String(a.url ?? "").replace(/^(https?:\/\/[^/]+).*/, "$1/…"))}</code></div>`
      : /^image\//.test(種) ? `<img src="${E(局所)}" alt="${E(a.filename ?? "")}" style="max-width:100%;max-height:520px;display:block">`
      : /pdf/.test(種) ? `<iframe src="${E(局所)}" style="width:100%;height:560px;border:0;background:#f7f7f8" title="${E(a.filename ?? "")}"></iframe>`
      : `<a href="${E(局所)}">手元の実物を開く</a>`;
    return `<div style="flex:1 1 0;min-width:0;border:1px solid #eee;border-radius:6px;padding:8px">
      <div style="font-size:12px;margin-bottom:6px"><b>${E(a.filename ?? a.id ?? "添付")}</b> <span class=tag>${E(種 || "?")}</span>${a.size ? ` <span class=tag>${E(大きさ(a.size))}</span>` : ""}${局所 ? ` <span class=tag style="background:#e7f3ff;color:#0b5ea8">手元の実物</span>` : ""}</div>${中身}</div>`;
  }).join("");
  return `<div class=el>${頭}
    <div style="display:flex;gap:10px;padding:8px 12px">${出す}</div>
    <div style="padding:6px 12px 10px;display:flex;gap:8px;align-items:center;font-size:12px">
      ${面 > 1 ? `<a href="${E(道(面 - 1))}">← 前</a>` : '<span style="color:#bbb">← 前</span>'}
      <span>${面} / ${面の数} 面（${添付.length}枚）</span>
      ${面 < 面の数 ? `<a href="${E(道(面 + 1))}">次 →</a>` : '<span style="color:#bbb">次 →</span>'}</div></div>`;
}

/** ─── rowActivityFeed ─── */
const 動作の名 = { createRow: "作成", updateRow: "更新", deleteRow: "削除", triggerWorkflow: "自動処理" };
function 履歴を描く(e, spec, pid, u) {
  const { E, db } = X;
  const rid = u.searchParams.get("row");
  const 行 = rid ? X.書き込み.計算器.取る(rid) : null;
  const 頭 = `<div class=elh>履歴 <span class=tag>rowActivityFeed</span> <span class=tag>${E(X.表.get(e.tbl)?.表示 ?? e.tbl ?? "")}</span>${spec.コメントを止める ? '<span class=tag>コメント無効</span>' : '<span class=tag>現行ではコメントも書ける</span>'}</div>`;
  const 注 = `<div class=note>Airtable 自身の履歴（誰がいつ何を変えたか）とコメントは読み取りの経路に無く、手元にはありません。ここに出るのは<b>ミミックで書いた分（write_log）</b>だけです。</div>`;
  if (!行 && !rid) return `<div class=el>${頭}${注}<div class=note>行が選ばれていません。上の「行を選ぶ」から選ぶと、その行の履歴をここに出します</div></div>`;
  const 記録 = db.prepare("SELECT seq,at,action,tbl,row,origin,before,after,note FROM write_log WHERE row=? ORDER BY seq").all(rid);
  const 日時 = { type: "date", opts: { 時刻あり: true, 時間帯: "Asia/Tokyo" } };
  const 差分 = (r) => {
    const 前 = r.before ? JSON.parse(r.before) : {}, 後 = r.after ? JSON.parse(r.after) : {};
    /** write_log の after は行の cells 全部を持つ（実測: 更新 7 件が全項目を載せていた）。更新は値の変わった項目だけ出す */
    const 鍵 = [...new Set([...Object.keys(後), ...(r.action === "deleteRow" ? Object.keys(前) : [])])].filter((k) => /^fld/.test(k))
      .filter((k) => r.action !== "updateRow" || JSON.stringify(前[k] ?? null) !== JSON.stringify(後[k] ?? null));
    if (!鍵.length && r.action === "updateRow") return `<div style="font-size:12px;color:#6b6f76">（値の変化なし）</div>`;
    return 鍵.map((k) => { const f = X.項目.get(k); const a = X.書く(前[k], f), b = X.書く(後[k], f);
      return `<div style="font-size:12px"><span style="color:#6b6f76">${E(f?.name ?? k)}</span>: ${r.action === "createRow" ? E(b) : r.action === "deleteRow" ? `<s>${E(a)}</s>` : `${E(a) || "（空）"} → <b>${E(b) || "（空）"}</b>`}</div>`; }).join("");
  };
  return `<div class=el>${頭}${注}
    ${!行 ? `<div class=note>行 ${E(rid)} は手元にありません${記録.length ? "（削除された行の記録だけ出します）" : ""}</div>` : 行.tbl !== e.tbl ? `<div class=note>行 ${E(rid)} は ${E(X.表.get(行.tbl)?.表示 ?? 行.tbl)} の行で、この履歴の表（${E(X.表.get(e.tbl)?.表示 ?? e.tbl)}）の行ではありません</div>` : ""}
    ${記録.length ? 記録.map((r) => `<div style="padding:8px 12px;border-bottom:1px solid #f2f2f4;display:flex;gap:12px">
        <div style="flex:0 0 130px;font-size:11.5px;color:#6b6f76;font-variant-numeric:tabular-nums">${E(X.書く(r.at, 日時))}</div>
        <div style="flex:1;min-width:0"><b>${E(動作の名[r.action] ?? r.action)}</b> <span class=tag>${E(r.origin ?? "")}</span>${r.note ? ` <span class=tag>${E(r.note)}</span>` : ""}${差分(r)}</div></div>`).join("")
      : `<div class=note>この行にミミックからの書き込みはありません（write_log 0 件）</div>`}</div>`;
}

/** ─── 画面（dashboard 型）─── */
/**
 * 面の順に描く。根の面 → verticalStack（帯と、帯に載ったボタン）→ 帯が見ている面 → dashboard（数字 → 図 → 一覧）。
 * 面に置かれた要素の型が他なら 要素 フックか注記。DB にあって描かれなかった要素は最後に「その他」として出す。
 */
function 配置画面を描く(p, 要素, pid, u) {
  const { E, db } = X;
  if (p.layout_kind !== "dashboard") return null;
  const 配置 = 生の配置(X.ROOT, pid);
  if (!配置?.根 || !配置.面?.[配置.根]) return null;
  覚える(u, "画面が描く", () => ({ 中: false })).中 = true;
  const 索引 = new Map(要素.map((e) => [e.id, e]));
  const 済 = 描いた(u);
  const 面の要素 = (面ID) => { const 面 = 配置.面[面ID]; const 全 = 面 ? 配置.全面[面.canvasId] : null; return 全 ? 配置.要素[全.elementId] ?? null : null; };
  /** 面の並び: 根 → 根に載った queryContainer が見ている面 → 残り（定義の順） */
  const 順 = [配置.根];
  for (const e of Object.values(配置.要素)) if (e?.type === "queryContainer") for (const v of e.viewCanvasAreas ?? []) if (v?.canvasAreaId && !順.includes(v.canvasAreaId)) 順.push(v.canvasAreaId);
  for (const id of Object.keys(配置.面)) if (!順.includes(id)) 順.push(id);

  const 束 = p.bundle ? db.prepare("SELECT name FROM bundle WHERE id=?").get(p.bundle)?.name : null;
  let 中 = `<h1>${E(p.name)}</h1><div class=sub>${E(p.tab)}${束 ? ` / ${E(束)}` : ""}
     ・${E(p.layout_kind ?? "")}${p.variant ? `・${E(p.variant)}` : ""}・要素 ${要素.length}個・並びは生レイアウトの面と枠の順（帯 → 数字 → 図 → 一覧）</div>`;
  for (const 面ID of 順) {
    const 生 = 面の要素(面ID);
    if (!生) continue;
    const e = 索引.get(生.id) ?? { id: 生.id, type: 生.type, tbl: null, label: null, spec: null, page: pid };
    const spec = e.spec ? JSON.parse(e.spec) : {};
    済.add(e.id);
    if (生.type === "verticalStack") {
      中 += 帯を描く(e, spec, pid, u);
      /** 帯に載ったボタン（queryContainerCallToAction。実測: 運賃・倉庫比較 の「CSV」→ 担当者月間(運賃・倉庫) へ移る） */
      const ボタン = [];
      for (const 器 of 子たち(pid, e.id)) { 済.add(器.id); for (const c of 子たち(pid, 器.id)) { 済.add(c.id); const b = 索引.get(c.id); if (b?.type === "button") ボタン.push(b); } }
      if (ボタン.length) 中 += X.ボタンを描く(ボタン, pid);
      continue;
    }
    if (生.type === "dashboard") { 中 += 配置を描く(e, spec, pid, u); continue; }
    const 描き手 = X.拡張.要素.get(生.type);
    if (描き手) { const h = 描き手(e, spec, pid, u, X); if (h) 中 += h; continue; }
    中 += `<div class=el><div class=note><b>${E(生.type)}</b> — この面の要素は描き手がありません</div></div>`;
  }
  /** 面の外に残った要素。構造だけの型は数えない */
  const 構造 = new Set(["section", "sectionGridRow", "queryContainer", "verticalStack", "dashboard"]);
  const 残り = 要素.filter((e) => !済.has(e.id) && !構造.has(e.type));
  const ボタン = 残り.filter((e) => e.type === "button");
  if (ボタン.length) { 中 += X.ボタンを描く(ボタン, pid); for (const b of ボタン) 済.add(b.id); }
  if (残り.some((e) => e.type === "formContainer")) 中 += X.フォームの入口(pid);
  const 他 = 残り.filter((e) => !["button", "formContainer"].includes(e.type));
  if (他.length) 中 += `<div class=el><div class=elh>その他の要素 <span class=tag>${他.length}個</span></div>` +
    他.map((e) => `<div class=note><b>${E(e.type)}</b>${e.label ? ` 〈${E(e.label)}〉` : ""}${e.tbl ? ` — ${E(X.表.get(e.tbl)?.表示 ?? e.tbl)}` : ""}</div>`).join("") + `</div>`;
  return X.骨(p.name ?? pid, 中, pid);
}

export const 画面 = (p, 要素, pid, u, 文脈) => {
  X = 文脈;
  try { return 配置画面を描く(p, 要素, pid, u ?? new URL("http://x/")); }
  catch (e) { console.error(`40-dash 画面 ${pid}: ${e.stack ?? e.message}`); return null; }   // 壊さない。既定の描き方に戻す
};

/** ─── 差し込み口 ─── */
const 配置の中か = (e, u) => 描いた(u).has(e.id);
export const 要素 = {
  dashboard: (e, spec, pid, u, 文脈) => { X = 文脈; return 配置を描く(e, spec, pid, u); },
  verticalStack: (e, spec, pid, u, 文脈) => { X = 文脈; return 帯を描く(e, spec, pid, u); },
  bigNumber: (e, spec, pid, u, 文脈) => { X = 文脈; if (配置の中か(e, u)) return ""; return `<div class=el><div style="display:flex;gap:10px;padding:10px 12px">${大数を描く(e, spec.設定 ?? 生の要素(pid, e.id) ?? {}, pid, u)}</div></div>`; },
  chart: (e, spec, pid, u, 文脈) => { X = 文脈; if (配置の中か(e, u)) return ""; return 図を描く(e, spec.設定 ?? 生の要素(pid, e.id) ?? {}, pid, u); },
  pivotTable: (e, spec, pid, u, 文脈) => { X = 文脈; if (配置の中か(e, u)) return ""; return ピボットを描く(e, spec, pid, u); },
  horizontalDivider: (e, spec, pid, u, 文脈) => { X = 文脈; return `<hr style="border:0;border-top:1px solid #dcdfe4;margin:6px 0 14px">`; },
  text: (e, spec, pid, u, 文脈) => { X = 文脈; return 本文を描く(e, spec, pid); },
  attachmentCarousel: (e, spec, pid, u, 文脈) => { X = 文脈; return 回転木馬を描く(e, spec, pid, u); },
  rowActivityFeed: (e, spec, pid, u, 文脈) => { X = 文脈; return 履歴を描く(e, spec, pid, u); },
};

/**
 * 手元の実物（crawl/out/artifacts）を出す。**ローカルのファイルを読むだけ。外へは出ない。**
 * 名前は basename に限り、置き場の外は見ない。
 */
export const 経路 = [
  { method: "GET", pattern: /^\/artifact\/([^/]+)$/, handler: async (req, res, u, m, 文脈) => {
    X = 文脈;
    let 名; try { 名 = path.basename(decodeURIComponent(m[1])); } catch { return 文脈.出す(res, 文脈.骨("404", "<h1>その実物は手元にありません</h1>", null), 404); }
    const r = await 実物を引く(文脈.ROOT, 名);
    if (!r) return 文脈.出す(res, 文脈.骨("404", "<h1>その実物は手元にありません</h1>", null), 404);
    res.writeHead(200, { "content-type": r.ctype, "content-length": r.bytes, "content-disposition": `inline; filename*=UTF-8''${encodeURIComponent(名)}` });
    res.end(r.body);
  } },
];

/** 起動時に一言。数は定義から数える */
export function 準備(文脈) {
  X = 文脈;
  const n = Object.fromEntries(文脈.db.prepare("SELECT type, count(*) c FROM elem WHERE type IN ('bigNumber','chart','pivotTable','dashboard','verticalStack','horizontalDivider','text','attachmentCarousel','rowActivityFeed') GROUP BY type").all().map((r) => [r.type, r.c]));
  const d = 文脈.db.prepare("SELECT count(*) c FROM page WHERE layout_kind='dashboard' AND has_layout=1").get().c;
  console.log(`集計要素: ${Object.entries(n).map(([k, v]) => `${k} ${v}`).join("・")}（母集団は出力の鎖を生レイアウトで辿り、文脈.実行 に渡す）／ dashboard 型 ${d} 画面は面の順に描く`);
}
