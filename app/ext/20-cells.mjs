/**
 * **入力欄（cellEditor）をその場で書けるようにする。** ローカルDBだけ。外へは一切つながない。
 *
 * ■ 対象
 *
 * cellEditor は 1,216 個。うち read_only=0 が 208 個（entry 画面 123・row 画面 85）。
 * 208 個の項目型は date 60 / text 46 / number 35 / rollup 32 / checkbox 12 / select 9 /
 * foreignKey 4 / multipleAttachment 3 / multilineText 3 / formula 3 / multiSelect 1。
 * rollup・formula の 35 個は「読み取り専用でない」と定義されていても計算項目なので**表示のみ**。
 * 添付 3 個は写していないので表示のみ。残り 170 個をその場で書けるようにする。
 *
 * ■ 行はどこから来るか（`spec.行の出どころ` = peo…）
 *
 * 208 個の出どころを同じ画面の要素の `出力` と突き合わせると
 *   rowSelector 110（entry 画面。母集団つきの「行を選ぶ箱」）
 *   formContainer 32（純正フォームの入力欄。行はまだ無い → /form/… に送る）
 *   inbox 3（entry 画面の一覧から 1 行を選ぶ）
 *   root 63（row 画面。URL で渡された 1 行そのもの）
 * ミミックでは `?row=rec…` があればその行、無ければ出どころの母集団から行を選ばせる。
 * rowSelector / inbox の母集団は生レイアウトの `query`（絞り込み・並び）にあり、
 * `elem.spec` には文にした `母集団` しか入っていないので、生レイアウトを読む（ネットワーク不要）。
 *
 * ■ 値の作り方は serve.mjs の `値を整える` / `外フォームの値` と同じにする
 *
 *   number         Number(v)
 *   checkbox       v === "1" → true、外したら null（write.mjs の 更新 が null の鍵を消す。Airtable と同じく false は持たない）
 *   date           "YYYY-MM-DD" → "YYYY-MM-DDT00:00:00.000Z"（外フォームの値 と同じ）。時刻ありは JST として UTC に直す
 *   select         選択肢ID（名前で来たら 選択肢ID に直す）
 *   foreignKey     行ID → [{foreignRowId, foreignRowDisplayName}]（write.mjs の 関連を張る が受ける形）
 *
 * ■ 見せる条件（visible_when）
 *
 * cellEditor の visible_when は 154 節、全部が同じ表の列を見ている（別表 0）。
 * 形は Airtable の {conjunction, filterSet} なので、計算器の `通る` にそのまま当てられる。
 * 合わないものは消さずに**畳む**（現行は非表示だが、写す側では中身を確かめられる方がよい）。
 *
 * ■ 純正フォームの関連欄
 *
 * `/form/:pid/:eid` の関連項目 4 欄（在庫・商品ID・取引先・伝票区分）は serve.mjs では素のテキスト欄で、
 * 表示名を打つと `関連を張る` が表示名を行IDとして辺を張ってしまう。
 * ここでは GET を先取りして関連欄を検索ピッカーに置き換える。値は**行ID**で送る
 * （`値を整える` は文字列をそのまま通し、`関連を張る` は文字列の行IDを辺にする）。
 * POST は serve.mjs のまま。cells に行IDの文字列が残る点は PATCHES-cells.md に書いた。
 */
import fs from "node:fs";
import path from "node:path";
import { レイアウト } from "../../db/layouts.mjs";

/** ─── 生レイアウト ─── */
/**
 * もとは crawl/out/raw の msgpack（812MB）を実行時に読んでいたが、
 * 読むのは publishedLayout だけで全 335 画面ぶんで 2.2MB しか無い。
 * spec/published-layout.json にまとめて、Vercel のバンドルにも載るようにした。
 * **引いた結果は前と同じ**（抽出時に衝突 0 件・335/335 取得を確認済み）。
 */
function 生の要素(ROOT, pid, pel) {
  return レイアウト(ROOT, pid)?.elementById?.[pel] ?? null;
}

/** ─── 出どころ（peo…）→ それを出している要素 ─── */
const 出どころの索引 = new Map();   // pid → Map(peo → {種, 要素})
function 出どころを引く(db, pid, peo) {
  if (!出どころの索引.has(pid)) {
    const m = new Map();
    for (const r of db.prepare("SELECT id,type,tbl,spec FROM elem WHERE page=? AND type IN ('rowSelector','inbox','formContainer')").all(pid)) {
      const sp = r.spec ? JSON.parse(r.spec) : {};
      /** rowSelector は ["selectedRow=peo…"]、inbox / formContainer は "peo…" */
      for (const o of Array.isArray(sp.出力) ? sp.出力 : [sp.出力]) {
        const id = String(o ?? "").replace(/^[A-Za-z]+=/, "");
        if (id) m.set(id, { 種: r.type, 要素: { ...r, sp } });
      }
    }
    出どころの索引.set(pid, m);
  }
  return 出どころの索引.get(pid).get(peo) ?? { 種: "root", 要素: null };
}

/** サーバを起こした時刻。クエリエンジンはこの時点の断面を持つ（下の 母集団 を見よ） */
const 起動 = new Date().toISOString();

/** その場で書ける型。それ以外（計算項目・添付・ボタン…）は表示のみ */
const 書ける型 = new Set(["text", "multilineText", "number", "checkbox", "date", "select", "multiSelect", "foreignKey"]);
const 枠 = "padding:5px 7px;border:1px solid #ccd;border-radius:4px;font:inherit";

/** URL を組み直す。null は消す */
function 道(u, 上書き = {}) {
  const q = new URLSearchParams(u.searchParams);
  for (const [k, v] of Object.entries(上書き)) { if (v === null || v === undefined || v === "") q.delete(k); else q.set(k, String(v)); }
  const s = q.toString();
  return u.pathname + (s ? "?" + s : "");
}
/** 保存の結果（msg_ / ok_）を URL から落とす */
function 結果を落とす(u) {
  const u2 = new URL(u.href);
  for (const k of [...u2.searchParams.keys()]) if (/^(msg|ok)_/.test(k)) u2.searchParams.delete(k);
  return u2;
}

/** 表の主項目の表示名 */
function 表示名(文脈, e) {
  const 主 = 文脈.db.prepare("SELECT primary_fld FROM tbl WHERE id=?").get(e.tbl)?.primary_fld;
  const v = 主 ? 文脈.書き込み.計算器.値(e, 主, true) : null;
  const s = 主 ? String(文脈.書く(v, 文脈.項目.get(主)) ?? "") : "";
  return s || e.id;
}

/** 関連を書く形に。動作層の 関連の形 と同じ */
function 関連の形(文脈, 行IDたち) {
  return 行IDたち.filter((rid) => /^rec[A-Za-z0-9]{14}$/.test(rid)).map((rid) => {
    const r = 文脈.書き込み.計算器.取る(rid);
    return { foreignRowId: rid, foreignRowDisplayName: r ? 表示名(文脈, r) : rid };
  });
}

/**
 * 出どころの母集団。rowSelector / inbox は生レイアウトの query で絞る。
 *
 * クエリエンジン（文脈.実行）は 09-12 から 書いた後 → 読み直す で断面を差し替える（以前は起動時のまま）。
 * だからミミックで書いた行は結果に映らない。write_log で起動後に触った行を拾い、
 * それだけは計算器の `通る` で今の値に当て直す（触った行は少ないので毎回でも軽い）。
 */
function 母集団(文脈, pid, 出どころ, 表ID) {
  const { db, 実行, 書き込み } = 文脈;
  const 全部 = () => db.prepare("SELECT id FROM row WHERE tbl=? ORDER BY rowid").all(表ID).map((r) => r.id);
  if (出どころ.種 !== "rowSelector" && 出どころ.種 !== "inbox") return { 行: 全部(), 説明: null, 絞った: false };
  const raw = 生の要素(文脈.ROOT, pid, 出どころ.要素.id);
  const q = raw?.query;
  if (!q?.source || q.source.type !== "table" || q.source.tableId !== 表ID) return { 行: 全部(), 説明: 出どころ.要素.sp.母集団 ?? null, 絞った: false };
  const 結果 = 実行({ source: q.source, filters: q.filters ?? null, sorts: q.sorts ?? [] });
  const 触った = new Set(db.prepare("SELECT DISTINCT row FROM write_log WHERE tbl=? AND at>=?").all(表ID, 起動).map((r) => r.row));
  const 行 = 結果.行.filter((rid) => !触った.has(rid));
  for (const rid of 触った) {
    const e = 書き込み.計算器.取る(rid);
    if (e && (!q.filters || 書き込み.計算器.通る(e, q.filters))) 行.push(rid);
  }
  return { 行, 説明: 出どころ.要素.sp.母集団 ?? null, 絞った: !!q.filters?.filterSet?.length };
}

/** 行を選ぶ画面。新しい行から 50 件。?q= は主項目の表示名に当てる */
function 行を選ぶ(文脈, pid, 出どころ, 表ID, u, 注) {
  const { E, 表, 書き込み } = 文脈;
  const { 行, 説明, 絞った } = 母集団(文脈, pid, 出どころ, 表ID);
  const 語 = (u.searchParams.get("q") ?? "").trim().toLowerCase();
  const 出 = [];
  let 見た = 0;
  for (let i = 行.length - 1; i >= 0 && 出.length < 50; i--) {
    const e = 書き込み.計算器.取る(行[i]);
    if (!e) continue;
    見た++;
    const 名 = 表示名(文脈, e);
    if (語 && !名.toLowerCase().includes(語)) continue;
    出.push({ 行: e.id, 名 });
  }
  const 隠す = [...u.searchParams].filter(([k]) => k !== "q" && k !== "row" && !/^(msg|ok)_/.test(k));
  return `<div class=el><div class=elh>行を選ぶ <span class=tag>${E(表.get(表ID)?.表示 ?? 表ID)}</span>
      <span class=tag>${行.length.toLocaleString()}行${絞った ? "（画面の母集団で絞り込み）" : ""}</span>
      ${出どころ.種 !== "root" ? `<span class=tag>${E(出どころ.種)}</span>` : ""}</div>
    ${注 ? `<div class=warn style="margin:8px 12px">${E(注)}</div>` : ""}
    ${説明 ? `<div class=note>母集団: ${E(説明)}</div>` : ""}
    <form method=get action="${E(u.pathname)}" style="padding:8px 12px;border-bottom:1px solid #eee;display:flex;gap:6px;align-items:center">
      ${隠す.map(([k, v]) => `<input type=hidden name="${E(k)}" value="${E(v)}">`).join("")}
      <input name=q value="${E(u.searchParams.get("q") ?? "")}" placeholder="主項目で探す" style="${枠};width:220px">
      <button class=btn style="background:#2d7ff9;color:#fff;border:0;cursor:pointer">探す</button>
      <span class=tag>新しい行から ${出.length} 件</span></form>
    <div style="padding:6px 12px;columns:3 220px;font-size:12.5px">
      ${出.map((x) => `<div><a href="${E(道(結果を落とす(u), { row: x.行, q: null }))}">${E(x.名)}</a></div>`).join("") || `<div class=note>該当する行がありません</div>`}
    </div></div>`;
}

/** 日付の入力欄の値。表示（Asia/Tokyo）と同じ日付・時刻を出す */
function 日付の入力値(文脈, v, f) {
  if (v == null || v === "") return "";
  const s = 文脈.書く(v, f);                 // "YYYY-MM-DD" か "YYYY-MM-DD HH:mm"
  return s.replace(" ", "T");
}

/** 送られた値を項目の型に合わせる。serve.mjs の 値を整える / 外フォームの値 と同じ規則 */
function 値にする(文脈, f, 体) {
  const v = 体.get("v");
  const vs = 体.getAll("v").filter((x) => x !== "");
  const o = f.opts ?? {};
  switch (f.type) {
    case "checkbox": return (v === "1" || v === "on" || v === "true") ? true : null;   // 外したら null＝鍵を消す（Airtable は false を持たない。write.mjs 更新 が null で鍵を消す）
    case "number": {
      if (v == null || v === "") return null;
      const n = Number(String(v).replace(/[,¥￥%\s]/g, ""));
      if (!Number.isFinite(n)) return { 文言: `${f.name || f.id}: 数として読めません（${v}）` };
      /** Airtable の欄の設定を守る: negative:false（validatorName positive）は負を受けない、書式 integer は整数だけ */
      if ((o.その他?.negative === false || o.その他?.validatorName === "positive") && n < 0) return { 文言: `${f.name || f.id}: 負の数は入れられません（Airtable の設定 positive）` };
      if (o.書式 === "integer" && !Number.isInteger(n)) return { 文言: `${f.name || f.id}: 整数だけ入れられます（Airtable の設定 integer）` };
      return n;
    }
    case "date": {
      if (!v) return null;
      if (/^\d{4}-\d{2}-\d{2}$/.test(v)) return `${v}T00:00:00.000Z`;
      /** datetime-local は時間帯を持たない。利用者は日本で使うので JST と読む */
      if (/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}/.test(v)) { const d = new Date(`${v.length === 16 ? v + ":00" : v}+09:00`); return Number.isNaN(d.getTime()) ? { 文言: `${f.name || f.id}: 日時として読めません（${v}）` } : d.toISOString(); }
      const d = new Date(v);
      return Number.isNaN(d.getTime()) ? { 文言: `${f.name || f.id}: 日付として読めません（${v}）` } : d.toISOString();
    }
    case "select": case "multiSelect": {
      const m = o.選択肢ID ?? {};
      /** 選択肢に無い値は受けない（生レイアウトの smallSelectColumn 10 個は全部 allowChoiceCreation:false）。名前でも ID でも引けなければ断る */
      const 直す = (x) => (m[x] !== undefined ? x : (Object.entries(m).find(([, n]) => n === x)?.[0] ?? null));
      if (f.type === "select") { if (!v) return null; const id = 直す(v); return id ?? { 文言: `${f.name || f.id}: 「${v}」は選択肢にありません` }; }
      if (!vs.length) return null;   // 全部外したら鍵を消す（checkbox と同じ）
      const ids = vs.map(直す);
      const 無い = vs.filter((x, i) => ids[i] == null);
      return 無い.length ? { 文言: `${f.name || f.id}: 選択肢にありません: ${無い.join(", ")}` } : ids;
    }
    case "foreignKey": return 関連の形(文脈, vs);
    default: return v == null || v === "" ? null : v;
  }
}

/** 関連項目の検索ピッカー。候補は 文脈.候補を引く（主項目で探す）に、生レイアウトの選べる行の制約を当てる */
function 関連の候補(文脈, f, 語, 制約) {
  const 先 = f.opts?.関連先 ?? null;
  const 全 = 文脈.候補を引く(先, 語, 1e9);
  let 候補 = 全.候補;
  let 判定できず = 0;
  if (制約?.filterSet?.length) {
    const c = 文脈.書き込み.計算器;
    /** 制約の列に値が無い行は 通る が true に倒れる。手元に値（cells/calc/snap/implied）が無ければ判定できないとして候補から外す */
    const 列たち = []; (function 集める(f) { for (const x of f?.filterSet ?? []) { if (x.filterSet) 集める(x); else if (x.columnId) 列たち.push(x.columnId); } })(制約);
    候補 = 候補.filter((x) => {
      const e = c.取る(x.行); if (!e) return false;
      const 値あり = 列たち.every((fid) => [e.cells, e.calc, e.snap, e.implied].some((層) => 層 && 層[fid] !== undefined));
      if (!値あり) { 判定できず++; return false; }
      return c.通る(e, 制約);
    });
  }
  /** 表の定義はあっても行が 0 件のことがある（販売/Table tbl1Oj1e1MUiIwvkv = 取引先の相手）。定義ではなく行の数で見る */
  return { 先, 件数: 候補.length, 候補: 候補.slice(0, 200), 全部の数: 全.全部の数 ?? 0, 判定できず, 表がある: !!先 && 文脈.表.has(先) && (全.全部の数 ?? 0) > 0 };
}

function 関連ピッカー(文脈, { 名前, 語の名前, 語, f, 今 = [], 制約, 多重, 道筋, 隠す = [] }) {
  const { E, 表 } = 文脈;
  const { 先, 件数, 候補, 全部の数, 表がある, 判定できず } = 関連の候補(文脈, f, 語, 制約);
  const 今の = new Map(今.map((x) => [x.foreignRowId ?? x, x.foreignRowDisplayName ?? x]));
  const 肢 = new Map(候補.map((x) => [x.行, x.名]));
  for (const [k, v] of 今の) if (!肢.has(k)) 肢.set(k, `${v}（今の値）`);
  return `<form method=get action="${E(道筋)}" style="display:flex;gap:5px;align-items:center;flex-wrap:wrap;margin-bottom:4px">
      ${隠す.map(([k, v]) => `<input type=hidden name="${E(k)}" value="${E(v)}">`).join("")}
      <input name="${E(語の名前)}" value="${E(語)}" placeholder="🔍 ${E(表.get(先)?.表示 ?? "候補")}を探す" style="${枠};width:210px">
      <button class=btn style="background:#eef0f4;color:#333;border:0;cursor:pointer">絞る</button>
      <span class=tag>${件数.toLocaleString()}件${語 ? `／全${全部の数.toLocaleString()}件` : ""}</span>
      ${制約?.filterSet?.length ? `<span class=tag>選べる行に制約を当てた${判定できず ? `・制約の列が手元に無い ${判定できず} 行は外した` : ""}</span>` : ""}</form>
    <select name="${E(名前)}"${多重 ? " multiple size=6" : ""} style="${枠};max-width:min(420px,100%)">
      ${多重 ? "" : `<option value="">（空にする）</option>`}
      ${[...肢].map(([k, v]) => `<option value="${E(k)}"${今の.has(k) ? " selected" : ""}>${E(v)}</option>`).join("")}
    </select>
    ${件数 > 候補.length ? `<div class=cond>候補が多いので先頭${候補.length}件だけ出しています。絞ってください</div>` : ""}
    ${!表がある ? `<div class=cond>相手の表 ${E(先 ?? "?")} の行が手元にありません</div>` : ""}`;
}

/** 1 欄の入力部分。表示のみのときは 書く の文字を出す */
function 入力部(文脈, e, f, 行, pid, u, 書ける, 表示) {
  const { E } = 文脈;
  if (!書ける) return `<span class=ro>${E(表示)}</span>`;
  const 生 = 文脈.書き込み.計算器.値(行, f.id, true);
  const o = f.opts ?? {};
  const 送り先 = `/cell/${pid}/${e.id}/${行.id}`;
  const 戻り = 道(結果を落とす(u));
  const 保存 = `<button class=btn style="background:#2d7ff9;color:#fff;border:0;cursor:pointer;margin-left:6px">保存</button>`;
  const 頭 = `<form method=post action="${E(送り先)}" style="display:flex;gap:4px;align-items:flex-start;flex-wrap:wrap"><input type=hidden name=back value="${E(戻り)}">`;
  const 尾 = `${保存}</form>`;
  switch (f.type) {
    case "text":
      return `${頭}<input name=v value="${E(生 ?? "")}" style="${枠};width:min(360px,100%)">${尾}`;
    case "multilineText":
      return `${頭}<textarea name=v rows=3 style="${枠};width:min(420px,100%)">${E(生 ?? "")}</textarea>${尾}`;
    case "number":
      return `${頭}<input name=v type=number step=any value="${E(typeof 生 === "number" ? 生 : (生 ?? ""))}" style="${枠};width:180px;text-align:right">
        ${o.記号 ? `<span class=tag>${E(o.記号)}</span>` : ""}${o.書式 === "percentV2" ? `<span class=tag>%</span>` : ""}${o.小数桁 != null ? `<span class=tag>小数 ${o.小数桁} 桁</span>` : ""}${尾}`;
    case "date":
      return `${頭}<input name=v type="${o.時刻あり ? "datetime-local" : "date"}" value="${E(日付の入力値(文脈, 生, f))}" style="${枠}">${尾}`;
    case "checkbox":
      return `${頭}<label style="display:inline-flex;gap:6px;align-items:center;padding:5px 0"><input type=checkbox name=v value=1${生 === true || 生 === 1 || 生 === "1" ? " checked" : ""}> ${E(f.name || "")}</label>${尾}`;
    case "select": case "multiSelect": {
      /** 選択肢は ID で持つ（値は selXXXX）。名前で来ている値（ミミック外の書き込み）も選べるようにする */
      const m = o.選択肢ID ?? Object.fromEntries((o.選択肢 ?? []).map((n) => [n, n]));
      const 今 = new Set((Array.isArray(生) ? 生 : 生 == null ? [] : [生]).map(String));
      const 選ばれた = (id, n) => 今.has(id) || 今.has(n);
      const 多重 = f.type === "multiSelect";
      return `${頭}<select name=v${多重 ? " multiple size=5" : ""} style="${枠}">
          ${多重 ? "" : `<option value="">（空にする）</option>`}
          ${Object.entries(m).map(([id, n]) => `<option value="${E(id)}"${選ばれた(id, n) ? " selected" : ""}>${E(n)}</option>`).join("")}
        </select>${Object.keys(m).length ? "" : `<span class=tag>選択肢が手元にありません</span>`}${尾}`;
    }
    case "foreignKey": {
      const 語の名前 = `q_${e.id}`;
      const 制約 = 生の要素(文脈.ROOT, pid, e.id)?.foreignRowSelectionConstraint?.filters ?? null;
      const 隠す = [...結果を落とす(u).searchParams].filter(([k]) => k !== 語の名前);
      return 関連ピッカー(文脈, {
        名前: "v", 語の名前, 語: u.searchParams.get(語の名前) ?? "", f, 今: Array.isArray(生) ? 生 : 生 ? [生] : [],
        制約, 多重: o.多重度 === "many", 道筋: u.pathname, 隠す,
      }).replace(/<select /, `${頭}<select `) + 尾;
    }
    default:
      return `<span class=ro>${E(表示)}</span>`;
  }
}

/**
 * 差し込み口「欄」。serve.mjs の 欄を描く と、別工程の詳細画面（文脈.欄を描く）から呼ばれる。
 * 要素たちは画面の一部だけのこともある。行の文脈は ?row=rec…。
 */
export function 欄(要素たち, 画面, pid, u, 文脈, { 見出し = null } = {}) {   // 見出し: 節の名（30-detail が渡す）。無ければ「入力欄」
  if (!要素たち?.length) return null;
  const { db, E, 項目, 表, 書き込み } = 文脈;
  const 同期表 = new Set(db.prepare("SELECT id FROM tbl WHERE synced=1").all().map((r) => r.id));

  /** 出どころごとに束ねる。1 画面に rowSelector が 1 つの形が大半 */
  const 群 = new Map();
  for (const e of 要素たち) {
    const sp = e.spec ? JSON.parse(e.spec) : {};
    const k = sp.行の出どころ ?? "?";
    (群.get(k) ?? 群.set(k, { peo: k, 表ID: e.tbl ?? sp.表ID ?? 画面?.tbl, 要素: [] }).get(k)).要素.push(e);
  }

  let 中 = "";
  for (const g of 群.values()) {
    const 出どころ = 出どころを引く(db, pid, g.peo);

    /** 純正フォームの入力欄。行はまだ無い。フォームへ送る */
    if (出どころ.種 === "formContainer") {
      const sp = 出どころ.要素.sp;
      中 += `<div class=el><div class=elh>入力欄（行を作る） <span class=tag>${g.要素.length}個</span>
          <span class=tag>${E(sp.作る表 ?? 表.get(g.表ID)?.表示 ?? "")}</span>
          <a class=btn style="background:#2d7ff9;color:#fff;text-decoration:none;margin-left:auto" href="/form/${E(pid)}/${E(出どころ.要素.id)}">${E(sp.ボタン ?? "作成")}のフォームを開く</a></div>
        <div class=cells>${g.要素.map((e) => { const f = 項目.get(e.fld);
          return `<div class=k>${E(e.label || f?.name || e.fld)}${e.read_only ? ' <span class=tag>読み取り専用</span>' : ""}</div>
            <div><span class=tag>${E(f?.type ?? "?")}</span>${(sp.必須 ?? []).some((x) => x.id === e.fld) ? ' <span style="color:#c00">必須</span>' : ""}</div>`; }).join("")}</div></div>`;
      continue;
    }

    /** 行の文脈 */
    const rid = u.searchParams.get("row");
    const 行 = rid ? 書き込み.計算器.取る(rid) : null;
    if (!行 || 行.tbl !== g.表ID) {
      中 += 行を選ぶ(文脈, pid, 出どころ, g.表ID, u,
        rid && !行 ? `行 ${rid} は手元にありません` : 行 ? `行 ${rid} は ${表.get(行.tbl)?.表示 ?? 行.tbl} の行で、この欄の表と違います` : null);
      continue;
    }

    const 表は同期 = 同期表.has(g.表ID);
    let 書けた = 0, 畳んだ = 0;
    const 欄たち = g.要素.map((e) => {
      const f = 項目.get(e.fld) ?? null;
      const 名 = e.label || f?.name || e.fld;
      const 生 = f ? 書き込み.計算器.値(行, f.id, true) : undefined;
      const 表示 = 文脈.書く(生, f);
      const 書ける = !!f && !e.read_only && !f.is_computed && !表は同期 && 書ける型.has(f.type);
      if (書ける) 書けた++;
      const 理由 = !f ? "項目の定義がありません" : e.read_only ? "読み取り専用" : f.is_computed ? "計算項目" : 表は同期 ? "同期表" : f.type === "multipleAttachment" ? "添付は写していません" : 書ける ? null : `${f.type} は表示のみ`;

      /** 見せる条件。親から継承した節を今の行に当てる。合わないものは畳む */
      const 条件 = e.visible_when ? JSON.parse(e.visible_when) : [];
      const 合わない = (Array.isArray(条件) ? 条件 : []).filter((c) => c?.生 && !書き込み.計算器.通る(行, 書き込み.条件を直す(c.生)));
      if (合わない.length) 畳んだ++;

      const 文言 = u.searchParams.get(`msg_${e.id}`);
      const ok = u.searchParams.get(`ok_${e.id}`);
      const 中身 = `<div class=k>${E(名)}${理由 ? ` <span class=tag>${E(理由)}</span>` : ""}</div>
        <div>${入力部(文脈, e, f, 行, pid, u, 書ける, 表示)}
          ${f ? `<span class=tag style="margin-left:6px">${E(f.type)}${f.type === "date" && f.opts?.時刻あり ? "・時刻あり" : ""}</span>` : ""}
          ${文言 ? `<div class=warn style="margin:6px 0 0;padding:6px 8px">${E(文言).replace(/\n/g, "<br>")}</div>` : ""}
          ${ok ? `<div style="color:#0a7;font-size:11.5px;margin-top:4px">保存しました。計算し直した行 ${E(ok)}</div>` : ""}
          ${条件.length && !合わない.length ? `<div class=cond>見せる条件: ${E(条件.map((c) => c.条件).join(" / "))}</div>` : ""}</div>`;
      if (!合わない.length) return 中身;
      return `<details style="grid-column:1/-1;border-bottom:1px solid #f2f2f4"><summary style="padding:6px 12px;cursor:pointer;color:#6b6f76;font-size:12px">${E(名)}
          <span class=cond>見せる条件に合わないので畳んでいます: ${E(合わない.map((c) => c.条件).join(" / "))}</span></summary>
        <div class=cells style="border-top:1px dashed #eee">${中身}</div></details>`;
    }).join("");

    中 += `<div class=el><div class=elh>${E(見出し ?? "入力欄")} <span class=tag>${g.要素.length}個・書ける ${書けた}${畳んだ ? `・畳んだ ${畳んだ}` : ""}</span>
        <span class=tag>${E(表.get(g.表ID)?.表示 ?? g.表ID)}</span>
        <span>行 <b>${E(表示名(文脈, 行))}</b> <code style="font-size:11px;color:#6b6f76">${E(行.id)}</code></span>
        ${行.src === "ミミックの入力" ? '<span class=tag>ミミックで作った行</span>' : ""}
        <a href="${E(道(結果を落とす(u), { row: null, q: null }))}" style="margin-left:auto;font-size:12px">別の行を選ぶ</a></div>
      <div class=cells>${欄たち}</div></div>`;
  }
  return 中;
}

/** 本文を読む。文脈.本文を読む は同じ鍵の複数値（multiSelect・多重の関連）を落とすので、ここでは URLSearchParams のまま返す */
const 体を読む = (req) => new Promise((ok) => {
  let 体 = "";
  req.on("data", (d) => { 体 += d; if (体.length > 4e6) req.destroy(); });
  req.on("end", () => ok(new URLSearchParams(体)));
});

/** 戻り先。自分のサーバの経路だけ許す */
const 戻り先 = (s, 既定) => {
  if (typeof s !== "string" || !/^\/(?!\/)/.test(s) || /[\\]/.test(s)) return 既定;
  /** WHATWG URL は特殊スキームで \ を / と読むので、解いた後の origin と pathname も見る（"/./\\evil.com" → //evil.com になる） */
  try { const u = new URL(s, "http://localhost"); if (u.origin !== "http://localhost" || u.pathname.startsWith("//")) return 既定; return u.pathname + u.search; } catch { return 既定; }
};

export const 経路 = [
  /**
   * POST /cell/:pid/:eid/:rec  1 欄を書く。
   * 書き込み.更新 → 検証の文言か、再計算した行数を URL に載せて元の画面へ戻す（303）。
   * 戻った画面は再計算後の値を出す（値は計算器が DB から読み直す）。
   */
  { method: "POST", pattern: /^\/cell\/(pag[A-Za-z0-9]+)\/(pel[A-Za-z0-9]+)\/(rec[A-Za-z0-9]+)$/, handler: async (req, res, u, m, 文脈) => {
    const [, pid, eid, rid] = m;
    const { db, 項目, 書き込み, 骨, E, 出す } = 文脈;
    const 体 = await 体を読む(req);
    const e = db.prepare("SELECT * FROM elem WHERE page=? AND id=? AND type='cellEditor'").get(pid, eid);
    if (!e) return 出す(res, 骨("404", "<h1>その欄はありません</h1>", null), 404);
    const f = 項目.get(e.fld);
    const 戻る = (u2) => { res.writeHead(303, { location: u2.pathname + u2.search }); res.end(); };
    const 戻り = new URL(戻り先(体.get("back"), `/p/${pid}?row=${rid}`), "http://localhost");
    戻り.searchParams.delete(`msg_${eid}`); 戻り.searchParams.delete(`ok_${eid}`);
    if (!戻り.searchParams.get("row")) 戻り.searchParams.set("row", rid);
    const 断る = (文言) => { 戻り.searchParams.set(`msg_${eid}`, 文言); return 戻る(戻り); };

    const 行 = 書き込み.計算器.取る(rid);
    if (!行) return 断る(`行 ${rid} は手元にありません`);
    if (行.tbl !== (e.tbl ?? f?.tbl)) return 断る("この欄の表と行の表が違います");
    const 同期 = db.prepare("SELECT synced FROM tbl WHERE id=?").get(行.tbl)?.synced;
    if (!f) return 断る("項目の定義がありません");
    if (e.read_only) return 断る("この欄は読み取り専用です");
    if (f.is_computed) return 断る(`${f.name || f.id} は計算項目です。手で入れる項目ではありません`);
    if (同期) return 断る("同期表の項目は外部から入ってくるので書けません");
    if (!書ける型.has(f.type)) return 断る(`${f.type} は表示のみです`);
    /** 出どころが formContainer の欄は「行を作る」入力欄。既存行への書き込み口にはしない */
    { const sp = e.spec ? JSON.parse(e.spec) : {}; const 出 = db.prepare("SELECT id FROM elem WHERE page=? AND type='formContainer' AND json_extract(spec,'$.出力')=?").get(pid, sp.行の出どころ ?? ""); if (出) return 断る("この欄はフォーム（行を作る）の入力欄です。既存の行には書きません"); }

    const 値 = 値にする(文脈, f, 体);
    if (値 && typeof 値 === "object" && !Array.isArray(値) && 値.文言) return 断る(値.文言);
    const r = 書き込み.更新(rid, { [f.id]: 値 }, { 出どころ: `欄 ${pid}/${eid}` });
    if (r.文言?.length) return 断る(r.文言.join("\n"));
    戻り.searchParams.set(`ok_${eid}`, String(r.再計算した行数));
    return 戻る(戻り);
  } },

  /** GET /cell/… は書く画面へ */
  { method: "GET", pattern: /^\/cell\/(pag[A-Za-z0-9]+)\/(pel[A-Za-z0-9]+)\/(rec[A-Za-z0-9]+)$/, handler: (req, res, u, m) => {
    res.writeHead(303, { location: `/p/${m[1]}?row=${m[3]}` }); res.end();
  } },

  /**
   * GET /form/:pid/:eid  純正フォーム。serve.mjs の フォームを描く の html を受け取り、
   * 関連項目の欄（4 欄）を検索ピッカーに置き換える。POST は serve.mjs のまま通す。
   * 「絞る」は GET で同じ経路に戻るので、打ち込んだ値は URL から 値 として戻す。
   */
  { method: "GET", pattern: /^\/form\/(pag[A-Za-z0-9]+)\/(pel[A-Za-z0-9]+)$/, handler: (req, res, u, m, 文脈) => {
    const [, pid, eid] = m;
    const { db, 項目, 骨, E, 出す } = 文脈;
    const fc = db.prepare("SELECT spec FROM elem WHERE page=? AND id=? AND type='formContainer'").get(pid, eid);
    if (!fc) return 出す(res, 骨("404", "<h1>そのフォームはありません</h1>", null), 404);
    const sp = JSON.parse(fc.spec ?? "{}");
    const 値 = {};
    for (const [k, v] of u.searchParams) if (/^fld[A-Za-z0-9]+$/.test(k) && v !== "" && 項目.get(k)?.tbl === sp.作る表ID) 値[k] = v;   // 本体（serve.mjs）と同じ絞り込み
    let html = 文脈.フォームを描く(pid, eid, { 値 });
    if (!html) return 出す(res, 骨("404", "<h1>そのフォームはありません</h1>", null), 404);

    const 欄 = db.prepare("SELECT id,fld,read_only,spec FROM elem WHERE page=? AND type=?").all(pid, "cellEditor")
      .filter((x) => !x.read_only && (x.spec ? JSON.parse(x.spec) : {}).行の出どころ === sp.出力 && 項目.get(x.fld)?.type === "foreignKey");
    for (const x of 欄) {
      const f = 項目.get(x.fld);
      const 語の名前 = `q_${x.fld}`;
      /** 今の値: URL に戻された行ID → 無ければ既定値（prefilledCellValueByColumnId） */
      const 既定 = sp.既定値?.[x.fld];
      const 今 = 値[x.fld] ? [{ foreignRowId: 値[x.fld], foreignRowDisplayName: 値[x.fld] }]
        : Array.isArray(既定) ? 既定 : [];
      const 制約 = 生の要素(文脈.ROOT, pid, x.id)?.foreignRowSelectionConstraint?.filters ?? null;
      const ピッカー = 関連ピッカー(文脈, {
        名前: x.fld, 語の名前, 語: u.searchParams.get(語の名前) ?? "", f, 今, 制約, 多重: f.opts?.多重度 === "many",   // serve.mjs の POST は複数値を配列で受ける（複数値を残す）
        道筋: `/form/${pid}/${eid}`,
        /** GET で戻るときに他の欄の値も持って帰る */
        隠す: [...Object.entries(値).filter(([k]) => k !== x.fld), ...[...u.searchParams].filter(([k]) => /^q_fld/.test(k) && k !== 語の名前)],
      });
      /**
       * 純正フォームは form 要素の中なので、ピッカーの検索 form を入れ子にできない。
       * 検索欄は `formmethod=get` のボタンで同じ form から送る（外フォームの 定義から欄 と同じ手）。
       */
      const 中身 = ピッカー
        .replace(/^<form method=get action="([^"]*)"([^>]*)>/, "<div$2>")
        .replace(/<\/form>/, "</div>")
        .replace(/<input type=hidden[^>]*>/g, "")
        .replace(/<button class=btn/, `<button formmethod=get formaction="/form/${pid}/${eid}" class=btn`);
      const 的 = new RegExp(`<input name="${x.fld}"[^>]*>`);
      if (的.test(html)) html = html.replace(的, `${中身}<span class=tag style="margin-left:6px">${E(f.type)}・行IDで送る</span>`);
    }
    return 出す(res, html);
  } },
];

/** 起動時に一言。数は定義から数える（作り込みの数ではない） */
export function 準備(文脈) {
  const n = 文脈.db.prepare("SELECT count(*) c FROM elem WHERE type='cellEditor' AND read_only=0").get().c;
  console.log(`欄: read_only=0 の cellEditor ${n} 個をその場で書けるようにする（計算項目・添付は表示のみ）`);
}
