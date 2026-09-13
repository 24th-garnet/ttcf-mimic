/**
 * **項目型ボタン（fld.type='button'・27 本）を押せる形にする。** 通信しない。Make・miniExtensions・Fillout には一切つながない。
 *
 * ボタン項目の値は `{label, url}` で、url は項目の設定（opts.url）の式を Airtable が評価したもの。宛先は 4 種類。
 *
 *   Make の webhook          6 本  phpbzc（棚卸表作成 ×2）・x6k39g9（選択🔗）。**GET した瞬間に本番の処理が走る**ので、
 *                                  db/actions.mjs の動作（棚卸表作成・在庫選択）に置き換えて POST で走らせる
 *   miniExtensions           15 本  締処理URL ×2・締処理解除 ×2・売上締処理 → 動作（締処理・締処理解除・売上締処理）
 *                                  編集 ×9・📣登録 → **既存行の編集フォーム**（/mform は新規作成専用なので、ここで編集版を出す）
 *   Fillout                  4 本  編集 ×3・削除ボタン → 同じく編集フォーム（Fillout は 4 本とも 1 レコードの updateRecord）
 *   項目の値がそのまま URL    4 本  ダウンロード ×3（Drive の PDF）→ /doc/<種>/<行>、ポータル → 売掛台帳の一覧へ
 *
 * ■ 差し込み口
 *
 *   経路   /fbtn                        27 本の一覧と行の選択
 *          /fbtn/<fld>/<rec>            その行でそのボタンを押す（GET 確認 → POST 実行。編集は GET フォーム → POST 更新）
 *          /fbtn/act/<鍵>[/<rec>]        画面にボタン要素が無い動作（製品在庫登録・BOM引当・システム登録…）を鍵で押す
 *          /fbtn/csv                    CSV 取込（textarea）
 *   ボタン navigateToRowUrl             10-buttons の描き手に、URL の項目がボタン項目なら「ローカルで押す」の箱を足す
 *   画面・欄  30-detail / 20-cells の描き手を包んで、?row= の行の表にボタン項目があれば「項目型ボタン」の箱を足す
 *          （一覧の列の描画は serve.mjs なので触らない）
 *
 * ■ 押せるか
 *
 * 現行は url の式が '' を返すとボタンが押せない（例: 締処理中なら 締処理URL は空、締処理済なら 入庫.編集 は空）。
 * ここでも同じ式を手元の値で評価し、空なら押せないと出す（db/formula.mjs の parse/evaluate。10-buttons と同じ）。
 *
 * ■ 書いた内容は write_log に残る（origin = `項目ボタン <fld> …`）。現行の Airtable には一切書かない。
 */
import fs from "node:fs";
import path from "node:path";
import { parse, evaluate } from "../../db/formula.mjs";
import { ボタン as 元のボタン } from "./10-buttons.mjs";

let X = null;          // 文脈
let 今のURL = null;    // 画面を描く の最中の URL（既定の描き方の画面でだけ要る）
const 登録 = new Map();       // fld → { fld, tbl, 文字, 名, 種類, … }
const 帳票の組み = new Set();  // app/doc-*.mjs が組める帳票の鍵（60-docs と同じ探し方）

/** ─── 分類の材料（ID で持つ。名前で引くと同名の表を取り違える） ─── */
const 分類 = "tblhGZ74i6sqZ79XM", 保管先 = "tblwe3kswLJfA9SsG", 売掛台帳 = "tbltny3ibbQKRiEkX", 月表 = "tblFpaCyRYS3sRbyi", PDF生成指示 = "tbldhtCdQkTBw4HGi";
const 出庫 = "tblkV3ZPRWixoUtaB", 出庫_在庫明細ID = "fldow210kASYVp4qz";
/** miniExtensions の shareId → 動作の鍵（締処理系 5 本。フォーム定義の button/webhook が根拠。db/actions.mjs の 根拠 参照） */
const 締処理の入口 = {
  cgry8fKdLABlEd20gSsC: "締処理", c3jCwKkOVJq4alrq7wp7: "締処理製造",
  xpdxnhTPtTOUJrgr2TOe: "締処理解除", BrvWHdInTQpE3AWLSBQe: "締処理解除製造",
  f7P2ORQVnPw6nTjnOUYL: "売上締処理",
};
/** Fillout 4 本のうち RecordPicker が joinArrayFields（既存の関連に足す）なのは 要因・対策 だけ（spec/fillout.json） */
const 足す形の関連 = new Set(["fillout:ocGxVFJtyDus"]);
/** 売掛台帳のポータル（miniExtensions の得意先ログイン画面）はミミックでは売掛台帳の一覧へ */
const 売掛台帳の一覧 = "pagi03paq6iDVubpE";

/**
 * ボタン項目 1 本を、url の式の形で分類する。
 * 式は `'https://…/' & RECORD_ID()` / `IF(条件,'',URL)` / `{column_value_fld…}` の 3 形（27 本すべて）。
 */
function 分類する(f) {
  const url = String(f.opts?.url ?? "");
  const 基 = { fld: f.id, tbl: f.tbl, 文字: f.opts?.文字 ?? f.name, 名: f.name, 式: url };
  let m;
  if ((m = url.match(/hook\.[a-z0-9]+\.make\.com\/([a-z0-9]+)/))) {
    if (m[1].startsWith("phpbzc")) return { ...基, 種類: "動作", 鍵: f.tbl === 分類 ? "棚卸表作成" : "棚卸表作成仕掛", 帳票: f.tbl === 分類 ? "原料棚卸表" : "仕掛品棚卸表" };
    if (m[1].startsWith("x6k39g9")) return { ...基, 種類: "動作", 鍵: "在庫選択" };
    return { ...基, 種類: "引き金", 注: `Make ${m[1]} の置き換えが未定義` };
  }
  if ((m = url.match(/miniextensions\.com\/([A-Za-z0-9]+)/))) {
    const share = m[1];
    if (締処理の入口[share]) return { ...基, 種類: "動作", 鍵: 締処理の入口[share], share };
    const form = X.db.prepare("SELECT tbl,button FROM form WHERE share=? ORDER BY is_child LIMIT 1").get(share);
    if (!form) return { ...基, 種類: "外部", 注: `miniExtensions ${share} の定義が手元にありません` };
    /** URL の末尾が RECORD_ID() ではなく別の項目の値（販売/商品.編集 は 製造/商品 の行IDを持つ text 項目）ならその行を編集する */
    const 別 = url.match(/&\s*\{column_value_(fld[A-Za-z0-9]+)\}\s*$/);
    return { ...基, 種類: "編集", share, 表: form.tbl, ボタン: form.button, 行の項目: 別?.[1] ?? null, 続き: share === "iaGv8B0XAGfitx9bB6aU" ? "製品在庫登録" : null };
  }
  if ((m = url.match(/fillout\.com\/t\/([A-Za-z0-9]+)/))) {
    const share = `fillout:${m[1]}`;
    const form = X.db.prepare("SELECT tbl,button FROM form WHERE share=?").get(share);
    if (!form) return { ...基, 種類: "外部", 注: `Fillout ${m[1]} の定義が手元にありません` };
    return { ...基, 種類: "編集", share, 表: form.tbl, ボタン: form.button, 行の項目: null };
  }
  if ((m = url.match(/^\{column_value_(fld[A-Za-z0-9]+)\}$/))) {
    if (f.tbl === PDF生成指示) return { ...基, 種類: "帳票", 帳票: f.name, URL項目: m[1] };
    if (f.tbl === 月表) return { ...基, 種類: "帳票", 帳票: "請求書", URL項目: m[1] };
    if (f.tbl === 売掛台帳) return { ...基, 種類: "画面", 画面: 売掛台帳の一覧, URL項目: m[1] };
  }
  return { ...基, 種類: "外部", 注: "宛先の形を読めません" };
}

export function 準備(文脈) {
  X = 文脈;
  for (const f of X.項目.values()) if (f.type === "button") 登録.set(f.id, 分類する(f));
  /** 帳票の組みがあるか（60-docs と同じ探し方）。無いものは「未着手」と出す */
  const dir = path.join(X.ROOT, "app");
  for (const f of fs.readdirSync(dir).filter((x) => /^doc-.*\.mjs$/.test(x))) {
    import(path.join(dir, f)).then((m) => { for (const d of m.帳票 ?? []) 帳票の組み.add(d.鍵); }).catch(() => {});
  }
  const 数 = [...登録.values()].reduce((o, d) => (o[d.種類] = (o[d.種類] ?? 0) + 1, o), {});
  console.log(`項目型ボタン: ${登録.size}本 ${Object.entries(数).map(([k, v]) => `${k}${v}`).join("・")} → /fbtn`);
}

/** 画面を描く の先頭で URL を控えるだけ（既定の描き方の画面だけここに来る） */
export const 画面 = (p, 要素, pid, u) => { 今のURL = u ?? null; return null; };

/** ─── 小さな道具 ─── */
const E = (s) => X.E(s);
const 取る = (rid) => (rid ? X.書き込み.計算器.取る(rid) : null);
const 札 = (s, 色 = "") => `<span class=tag${色 ? ` style="${色}"` : ""}>${E(s)}</span>`;
const 箱 = (中) => `<div style="padding:8px 12px;border-bottom:1px solid #f2f2f4">${中}</div>`;
const 色 = (d) => X.ボタンの色[String(X.項目.get(d.fld)?.opts?.その他?.variant?.staticVariant ?? "").replace(/^(solid|light|text)/, "").toLowerCase()] ?? X.ボタンの色.gray;
const リンク風 = (文字, [bg, fg], href, 題 = "") => `<a class=btn style="background:${bg};color:${fg};text-decoration:none" href="${E(href)}"${題 ? ` title="${E(題)}"` : ""}>${E(文字)}</a>`;
const 飾り = (文字, [bg, fg]) => `<span class=btn style="background:${bg};color:${fg};opacity:.85">${E(文字)}</span>`;
const 道 = (fld, rid) => `/fbtn/${fld}/${encodeURIComponent(rid)}`;
const 名 = (行) => {
  if (!行) return "";
  const 主 = X.db.prepare("SELECT primary_fld FROM tbl WHERE id=?").get(行.tbl)?.primary_fld;
  const v = 主 ? X.書き込み.計算器.値(行, 主, true) : null;
  return (主 ? X.書く(v, X.項目.get(主)) : "") || 行.id;
};
/** その表を 1 行で見せる画面（詳細）。無ければ null */
const 行の画面 = (tbl) => X.db.prepare("SELECT id FROM page WHERE tbl=? AND type='row' AND has_layout=1 ORDER BY in_nav DESC, ord LIMIT 1").get(tbl)?.id ?? null;
const 行へ = (行) => { const p = 行の画面(行.tbl); return p ? `/p/${p}?row=${encodeURIComponent(行.id)}` : null; };
/** 最新の行（ミミックで作った行が先） */
const 最新の行 = (tbl, n = 30) => X.db.prepare("SELECT id FROM row WHERE tbl=? ORDER BY loaded DESC, rowid DESC LIMIT ?").all(tbl, n).map((r) => 取る(r.id)).filter(Boolean);

/**
 * ボタンの url をこの行で評価する。Airtable が返した値（snap の {label,url}）があればそれ。
 * 無ければ式を手元の値で評価する（計算器は button 型を計算しない）。空なら押せない
 */
function 宛先(d, 行) {
  const c = X.書き込み.計算器;
  const 生 = c.値(行, d.fld, true);
  if (生 && typeof 生 === "object" && "url" in 生) return { url: 生.url ?? "", 出どころ: "Airtable が返した値" };
  try {
    const v = evaluate(parse(d.式), { 値: (x) => c.値(行, x), 行ID: () => 行.id, tz: "Asia/Tokyo", 未対応: [] });
    return { url: v == null ? "" : String(v), 出どころ: "式を評価" };
  } catch (e) { return { url: "", 出どころ: `式を評価できません: ${e.message}` }; }
}
const 押せる = (d, 行) => !!宛先(d, 行).url;

/** 引数の入力欄。動作の 引数 の名で決める */
function 引数の欄(d, 行) {
  const k = d.引数;
  if (!k?.length) return "";
  return k.map((名前) => {
    if (名前 === "締日") return `<label style="display:block;margin:6px 0"><span style="display:inline-block;width:80px">締日</span><input type=date name=締日 required style="padding:5px 7px;border:1px solid #ccd;border-radius:4px;font:inherit"> <span class=tag>Airtable の締日そのまま（19 日なら 19 日）</span></label>`;
    if (名前 === "出庫行") {
      /** 引き当て先の候補: 在庫明細ID が空の出庫明細。最新 50 行 */
      const 候補 = X.db.prepare(`SELECT id FROM row WHERE tbl=? AND json_extract(cells,'$.'||?) IS NULL ORDER BY loaded DESC, rowid DESC LIMIT 50`).all(出庫, 出庫_在庫明細ID).map((r) => 取る(r.id)).filter(Boolean);
      return `<label style="display:block;margin:6px 0"><span style="display:inline-block;width:80px">出庫明細</span><select name=出庫行 required style="padding:5px 7px;border:1px solid #ccd;border-radius:4px;font:inherit;max-width:min(420px,100%)"><option value="">（引き当てる出庫明細を選ぶ・在庫明細IDが空の最新${候補.length}件）</option>${候補.map((r) => `<option value="${E(r.id)}">${E(名(r))}</option>`).join("")}</select></label>`;
    }
    if (名前 === "csv") return `<label style="display:block;margin:6px 0">CSV<br><textarea name=csv rows=8 style="width:min(720px,100%);font:12px ui-monospace,monospace;padding:6px;border:1px solid #ccd;border-radius:4px" placeholder="仕入ID,仕入NO,部門NO,計上日,…（1 行目が見出し）"></textarea></label>`;
    return `<label style="display:block;margin:6px 0"><span style="display:inline-block;width:80px">${E(名前)}</span><input name="${E(名前)}" style="padding:5px 7px;border:1px solid #ccd;border-radius:4px;font:inherit"></label>`;
  }).join("");
}

/** ─── 行の箱（詳細画面・欄の下に足す「項目型ボタン」） ─── */
function 行の箱(rid, 表ID) {
  const 行 = 取る(rid);
  if (!行 || (表ID && 行.tbl !== 表ID)) return null;
  const 定 = [...登録.values()].filter((d) => d.tbl === 行.tbl);
  if (!定.length) return null;
  const 中 = 定.map((d) => {
    const { url } = 宛先(d, 行);
    const 行き先 = 説明(d);
    if (!url && d.種類 !== "帳票") return 箱(`${飾り(d.文字, 色(d))} ${札(d.名)} <span class=tag style="background:#f2f2f4">この行では押せない（url の式が空）</span> ${札(行き先)}`);
    return 箱(`${リンク風(d.文字, 色(d), 道(d.fld, 行.id), 行き先)} ${札(d.名)} ${札(行き先)}${d.注 ? `<div class=dlg>${E(d.注)}</div>` : ""}`);
  }).join("");
  return `<div class=el><div class=elh>項目型ボタン <span class=tag>${定.length}個</span> <span class=tag>行 ${E(名(行))}</span> <span class=tag>現行は項目の url を開く。ここではローカルの動作・編集・帳票に置き換える</span></div>${中}</div>`;
}
function 説明(d) {
  if (d.種類 === "動作") return `→ 動作 ${d.鍵}${d.帳票 ? `・帳票 ${d.帳票}` : ""}`;
  if (d.種類 === "編集") return `→ 既存行の編集（${d.share} → ${X.表.get(d.表)?.表示 ?? d.表}）${d.続き ? `・続けて 動作 ${d.続き}` : ""}`;
  if (d.種類 === "帳票") { const 組 = d.帳票 === "納品書・受領書" ? 帳票の組み.has("納品書") && 帳票の組み.has("受領書") : 帳票の組み.has(d.帳票); return `→ 帳票 ${d.帳票}${組 ? "" : "（未着手）"}`; }
  if (d.種類 === "画面") return `→ 売掛台帳の一覧`;
  return d.注 ?? "外部（開かない）";
}

/** ─── ボタンの差し込み: navigateToRowUrl の下に「ローカルで押す」を足す ─── */
export const ボタン = {
  navigateToRowUrl: (e, sp, pid, ctx, 文脈) => {
    const h = 元のボタン.navigateToRowUrl(e, sp, pid, ctx, 文脈);
    const d = 登録.get(sp.動作の詳細?.URLの項目);
    /** 渡された URL を優先する。今のURL は前の要求のまま残るので、別の行のボタンを指す（検証 2026-09-13） */
    const 行 = 取る((ctx?.u ?? 今のURL)?.searchParams?.get("row"));
    if (!d || !行 || 行.tbl !== d.tbl || h == null) return h;
    const { url } = 宛先(d, 行);
    const 足 = url || d.種類 === "帳票"
      ? `${リンク風(`ローカルで押す: ${d.文字}`, 色(d), 道(d.fld, 行.id))} ${札(説明(d))}`
      : `${飾り(d.文字, 色(d))} ${札("この行では押せない（url の式が空）")} ${札(説明(d))}`;
    return h + 箱(足);
  },
};

/** ─── 一覧 /fbtn ─── */
function 一覧を描く() {
  const 行 = [...登録.values()].map((d) => {
    const 候補 = 最新の行(d.tbl, 6);
    const 押せ = 候補.filter((r) => 押せる(d, r) || d.種類 === "帳票");
    return `<tr><td><b>${E(X.表.get(d.tbl)?.表示 ?? d.tbl)}</b><br><span class=tag>${E(d.名)}</span></td>
      <td>${飾り(d.文字, 色(d))}</td>
      <td>${E(d.種類)}</td>
      <td style="font-size:11.5px">${E(説明(d))}</td>
      <td style="font-size:11.5px"><code>${E(d.式.slice(0, 110))}</code></td>
      <td>${押せ.slice(0, 4).map((r) => `<a href="${E(道(d.fld, r.id))}">${E(名(r))}</a>`).join("<br>") || (候補.length ? `<span style="color:#888">最新 ${候補.length} 行はどれも式が空</span>` : `<span style="color:#888">行が手元にない</span>`)}</td></tr>`;
  }).join("");
  const 鍵たち = ["システム登録", "製品在庫登録", "BOM引当", "CSV取込"];
  const 中 = `<h1>項目型ボタン <span class=tag>${登録.size}本</span></h1>
  <div class=note>fld.type='button' の 27 本。現行は項目の url（Make・miniExtensions・Fillout・Drive）を開く。ここでは
  <b>Make の webhook は動作に、miniExtensions/Fillout の編集は既存行の編集フォームに、Drive の PDF は帳票に</b>置き換える。外へは一切つながない。<br>
  画面にボタン要素の無い動作: ${鍵たち.map((k) => `<a href="/fbtn/act/${E(k)}">${E(k)}</a>`).join("・")}　／　<a href="/fbtn/csv">CSV 取込（貼り付け）</a></div>
  <div class=el><div class=scroll><table><thead><tr><th>表・項目</th><th>ボタン</th><th>種類</th><th>ここでは</th><th>url の式</th><th>押せる行（最新から）</th></tr></thead><tbody>${行}</tbody></table></div></div>`;
  return X.骨("項目型ボタン", 中, null);
}

/** ─── 動作を押す画面（ボタン項目から・鍵から 共通） ─── */
function 動作の画面(d, 鍵, 行, { 結果 = null, 生 = {} } = {}) {
  const 定義 = X.動作.台帳.get(鍵);
  if (!定義) return X.骨("404", `<h1>動作 ${E(鍵)} がありません</h1>`, null);
  const 門 = 行 ? X.動作.関門を見る(行, 定義.関門を選ぶ ? 定義.関門を選ぶ(行) : 定義.関門) : [];
  const 表 = 定義.表 ? X.表.get(定義.表)?.表示 ?? 定義.表 : null;
  const 行が要る = !!定義.表 && (!定義.引数 || 定義.行が要る);
  const action = d ? 道(d.fld, 行.id) : `/fbtn/act/${encodeURIComponent(鍵)}${行 ? `/${encodeURIComponent(行.id)}` : ""}`;
  const 候補 = !行 && 定義.表 ? 最新の行(定義.表, 40) : [];
  const 中 = `<h1>${E(定義.札)} ${札(鍵)}${表 ? ` ${札(表)}` : ""}</h1>
    <div class=sub>${d ? `項目型ボタン「${E(d.文字)}」（${E(X.表.get(d.tbl)?.表示 ?? d.tbl)}.${E(d.名)}）` : "画面にボタン要素の無い動作"}${行 ? ` ・ 行 <b>${E(名(行))}</b> <span class=tag>${E(行.id)}</span>` : ""}</div>
    <div class=note><div><b>この処理は何か</b>　${E(定義.根拠)}</div>
      <div style="margin-top:4px"><b>確度</b>　${E(定義.確度)}${定義.外部 ? `　<b style="color:#a00">⚠ 現行の引き金</b> <code>${E(定義.外部)}</code>（叩きません）` : ""}</div>
      ${定義.注 ? `<div style="margin-top:4px">※ ${E(定義.注)}</div>` : ""}</div>
    ${門.length ? `<div class=warn><b>押せません（門の文言）</b><br>${門.map((g) => `・${E(g.文言)}`).join("<br>")}</div>` : ""}
    ${結果 ? 結果の箱(結果) : ""}
    ${!行 && 行が要る ? `<div class=el><div class=elh>対象の行 <span class=tag>最新 ${候補.length} 件</span></div>${候補.map((r) => 箱(`<a href="/fbtn/act/${E(鍵)}/${E(r.id)}">${E(名(r))}</a> <span class=tag>${E(r.id)}</span>`)).join("")}</div>` : ""}
    ${(行 || !行が要る) && !門.length ? `<form method=post action="${E(action)}" class=el><div class=elh>${E(定義.確認?.題 ?? 定義.札)}</div>
      <div style="padding:10px 12px">
        ${定義.確認?.本文 ? `<div class=dlg style="border:2px solid #d93025;background:#fff4f4;padding:8px 10px;margin-bottom:8px">${E(定義.確認.本文)}</div>` : ""}
        ${引数の欄(定義, 行)}
        <input type=hidden name=ok value="1">
        <button class=btn style="background:#d93025;color:#fff;border:0;cursor:pointer">${E(定義.確認?.進むボタン ?? 定義.札)}</button>
        ${行 && 行へ(行) ? `<a href="${E(行へ(行))}" style="margin-left:12px;font-size:12px">やめる（行の画面へ）</a>` : ""}</div></form>` : ""}
    <div style="margin-top:12px"><a href="/fbtn">← 項目型ボタンの一覧</a>　<a href="/actions">動作の一覧</a></div>`;
  return X.骨(`${定義.札}｜${d?.文字 ?? 鍵}`, 中, null);
}
function 結果の箱(r) {
  const 帳票リンク = (r.補足 ?? []).map((s) => String(s).match(/^帳票: (\/doc\/([^/]+)\/\S+)$/)).filter(Boolean)
    .map((m) => 帳票の組み.has(decodeURIComponent(m[2])) ? `<a href="${E(m[1])}">${E(m[2])} を開く</a>` : `<span class=tag style="background:#fde8e8;color:#a00">帳票 ${E(m[2])} は未着手（${E(m[1])}）</span>`);
  return `<div class=dlg style="border:2px solid ${r.可 ? "#0a7" : "#d93025"};background:${r.可 ? "#f2fbf7" : "#fff4f4"};padding:10px 12px">
    <b>${r.可 ? "実行しました" : "実行しませんでした"}</b>${r.文言?.length ? `\n${E(r.文言.join("\n"))}` : ""}
    ${(r.補足 ?? []).filter((s) => !/^帳票: /.test(String(s))).map((s) => `\n${E(s)}`).join("")}
    ${帳票リンク.length ? `\n${帳票リンク.join(" ")}` : ""}
    ${r.作った?.length ? `\n作った行 ${r.作った.length}件: ${r.作った.slice(0, 12).map((id) => { const 行 = 取る(id); const p = 行 && 行へ(行); return p ? `<a href="${E(p)}">${E(名(行))}</a>` : E(id); }).join(", ")}${r.作った.length > 12 ? " …" : ""}` : ""}
    ${r.変えた?.length ? `\n変えた行 ${r.変えた.length}件` : ""}${r.消した?.length ? `\n消した行 ${r.消した.length}件` : ""}</div>`;
}

/** ─── 既存行の編集フォーム（miniExtensions / Fillout） ─── */
/** 手元の値 → フォームの入力値（外フォームを描く の v_ の形。関連は行ID、選択は名前、日付は YYYY-MM-DD、checkbox は "1"） */
function 入力の形(f, v) {
  if (v == null) return "";
  const t = f.type;
  if (t === "foreignKey") return Array.isArray(v) ? (v[0]?.foreignRowId ?? "") : "";
  if (t === "select" || t === "multiSelect") { const 表 = f.opts?.選択肢ID ?? {}; const x = Array.isArray(v) ? v[0] : v; return 表[x] ?? String(x ?? ""); }
  if (t === "checkbox") return v === true || v === 1 ? "1" : "";
  if (t === "date") { const m = String(v).match(/^(\d{4}-\d{2}-\d{2})/); return m ? m[1] : String(v); }
  if (Array.isArray(v)) return String(v[0] ?? "");
  if (typeof v === "object") return "";
  return String(v);
}
const フォーム = (d) => { const r = X.db.prepare("SELECT * FROM form WHERE share=? AND tbl=?").get(d.share, d.表); return r ? { ...r, sp: JSON.parse(r.spec ?? "{}") } : null; };
const フォームの項 = (f) => { const 出す = new Set(f.sp.出す項目 ?? []); return (f.sp.項目 ?? []).filter((x) => x.id && X.項目.has(x.id) && (!出す.size || 出す.has(x.id))); };
/** 編集する行。販売/商品.編集 は URL の末尾が 製造/商品 の行ID（text 項目の値） */
function 編集の行(d, 行) {
  if (!d.行の項目) return 行;
  const v = X.書き込み.計算器.値(行, d.行の項目, true);
  const 先 = 取る(String(Array.isArray(v) ? v[0] : v ?? "").trim());
  return 先 && 先.tbl === d.表 ? 先 : null;
}
function 編集フォーム(d, 行, u, 状態 = {}) {
  const f = フォーム(d);
  const 先 = 編集の行(d, 行);
  if (!f) return X.骨("404", `<h1>フォーム ${E(d.share)} の定義がありません</h1>`, null);
  if (!先) return X.骨("編集", `<h1>${E(d.文字)}</h1><div class=warn>編集する行が決まりません（${E(d.行の項目 ? `項目 ${d.行の項目} の値が ${X.表.get(d.表)?.表示 ?? d.表} の行IDでない` : "行がありません")}）</div>`, null);
  /** 既定は行の値。POST で戻ってきた値（v_）があればそれを優先する */
  const u2 = new URL(`http://x/mform/${d.share}/${d.表}`);
  for (const [k, v] of u.searchParams) if (/^q_/.test(k)) u2.searchParams.set(k, v);
  for (const x of フォームの項(f)) {
    const 戻り = u.searchParams.get(`v_${x.id}`);
    u2.searchParams.set(`v_${x.id}`, 戻り ?? 入力の形(X.項目.get(x.id), X.書き込み.計算器.値(先, x.id, true)));
  }
  let html = X.外フォームを描く(d.share, d.表, u2, 状態);
  if (!html) return X.骨("404", `<h1>フォーム ${E(d.share)} を描けません</h1>`, null);
  /** 送り先を編集の経路に。絞る（GET）も同じ経路に戻す */
  html = html.split(`action="/mform/${d.share}/${d.表}"`).join(`action="${道(d.fld, 行.id)}"`)
    .split(`formaction="/mform/${d.share}/${d.表}"`).join(`formaction="${道(d.fld, 行.id)}"`);
  const 注 = `<div class=el><div class=note><b>既存の行を編集</b>　${E(X.表.get(先.tbl)?.表示 ?? 先.tbl)} <code>${E(名(先))}</code> <span class=tag>${E(先.id)}</span>
    　保存すると <b>書き込み.更新</b>（行を作らない）。項目型ボタン「${E(d.文字)}」（${E(X.表.get(d.tbl)?.表示 ?? d.tbl)}.${E(d.名)}）の置き換え
    ${足す形の関連.has(d.share) ? "<br>この Fillout の関連（要因対策）は<b>既存の関連に足す</b>（joinArrayFields）" : ""}
    ${d.続き ? `<br>保存したら <a href="/fbtn/act/${E(d.続き)}/${E(先.id)}">動作 ${E(d.続き)}</a> へ（📣登録 の在庫登録 checkbox を Make が拾う部分）` : ""}
    ${行へ(先) ? `<br><a href="${E(行へ(先))}">行の画面へ</a>` : ""}</div></div>`;
  return html.replace("</h1>", `</h1>${注}`);
}
/** POST の値 → 書く値。外フォームの値（serve.mjs）と同じ直し方だが、更新なので「空にした」も書く */
function 編集の値(d, f, 先, 生) {
  const 値 = {};
  for (const x of フォームの項(f)) {
    if (x.計算 || x.読み取り専用) continue;
    const fld = X.項目.get(x.id);
    const v = 生[`v_${x.id}`];
    if (fld.type === "checkbox") { 値[x.id] = v === "1" || v === "on"; continue; }
    if (v === undefined) continue;                       // 欄が無かった（描かれていない）
    if (fld.type === "foreignKey") {
      if (v === "") continue;                            // 選び直していない → 触らない（多重の関連を 1 つに潰さない）
      const r = 取る(v); if (!r) continue;
      const 形 = [{ foreignRowId: v, foreignRowDisplayName: 名(r) }];
      const 今 = X.書き込み.計算器.値(先, x.id, true);
      値[x.id] = 足す形の関連.has(d.share) && Array.isArray(今) ? [...今.filter((y) => y?.foreignRowId && y.foreignRowId !== v), ...形] : 形;
      continue;
    }
    if (v === "") { 値[x.id] = null; continue; }
    if (fld.type === "number") { 値[x.id] = Number(v); continue; }
    if (fld.type === "select" || fld.type === "multiSelect") {
      const 表 = fld.opts?.選択肢ID ?? {};
      const id = Object.entries(表).find(([, n]) => n === v)?.[0] ?? v;
      値[x.id] = fld.type === "multiSelect" ? [id] : id; continue;
    }
    if (fld.type === "date" && /^\d{4}-\d{2}-\d{2}$/.test(v)) { 値[x.id] = `${v}T00:00:00.000Z`; continue; }
    値[x.id] = v;
  }
  return 値;
}

/**
 * ─── 帳票へ ───
 * ボタン項目の行（PDF生成指示・月）と、帳票の組み（app/doc-sales.mjs）の鍵は 1:1 ではない。
 *   出荷明細書    鍵 = 出荷日 YYYY-MM-DD[-種類番号]   ← PDF生成指示.出荷日1 × 種類番号（doc-sales も同じ切り方）
 *   納品書・受領書 鍵 = 売上伝票ID                     ← その出荷日×種類番号の売上伝票を並べ、伝票ごとに 納品書／受領書 へ
 *   請求書        鍵 = 売掛台帳ID                     ← 月.年月 の売掛台帳を並べる
 */
const 売上 = "tblUBK06Qb5cBQ9Tg", 売上_出荷日 = "fldYBcriATvxY3NYC", 売上_種類番号 = "fldL1zhYcB9bimy9x", 売上_伝票ID = "fld9EXtVvEZHn78y2", 売上_得意先 = "fldVRxAN22bt3BYV1";
const 台帳_ID = "fldAlJGzaAi3EklGb", 台帳_月 = "fldTgVJHIUgCFzsat", 月_年月 = "fldHAFjF2tqiH1Apb", PDF_出荷日1 = "fldHSoXbqcbeygxPt", PDF_種類番号 = "fldRr8ojzWUnZob2S";
function 帳票へ(d, 行) {
  const c = X.書き込み.計算器;
  const 未 = (鍵) => `<div class=warn>帳票「${E(鍵)}」の組みは未着手（app/doc-*.mjs に無い）</div>`;
  if (d.tbl === PDF生成指示) {
    const 日 = String(c.値(行, PDF_出荷日1, true) ?? "").slice(0, 10);
    const 種 = String(c.値(行, PDF_種類番号) ?? "");
    if (!/^\d{4}-\d{2}-\d{2}$/.test(日)) return { html: `<div class=warn>出荷日1 が空なので帳票の対象が決まりません</div>` };
    if (d.帳票 === "出荷明細書") {
      if (!帳票の組み.has("出荷明細書")) return { html: 未("出荷明細書") };
      return { 転送: `/doc/${encodeURIComponent("出荷明細書")}/${日}${/^[46]$/.test(種) ? `-${種}` : ""}` };
    }
    /** 納品書・受領書: その出荷日×種類番号の売上伝票ごと */
    const 伝票 = X.db.prepare(`SELECT id FROM row WHERE tbl=? AND substr(json_extract(cells,'$.'||?),1,10)=?`).all(売上, 売上_出荷日, 日)
      .map((r) => 取る(r.id)).filter((x) => x && (!/^[46]$/.test(種) || String(c.値(x, 売上_種類番号) ?? "") === 種));
    const 行たち = 伝票.map((x) => { const k = String(c.値(x, 売上_伝票ID) ?? x.id); const 得 = c.値(x, 売上_得意先); return `<tr><td><code>${E(k)}</code></td><td>${E(Array.isArray(得) ? 得[0] ?? "" : 得 ?? "")}</td><td>${["納品書", "受領書"].map((種類) => 帳票の組み.has(種類) ? `<a href="/doc/${encodeURIComponent(種類)}/${encodeURIComponent(k)}">${E(種類)}</a>` : `<span class=tag>${E(種類)} 未着手</span>`).join("　")}</td></tr>`; }).join("");
    return { html: `<div class=el><div class=elh>出荷日 ${E(日)}${種 ? ` ・ 種類番号 ${E(種)}` : ""} の売上伝票 <span class=tag>${伝票.length} 件</span></div>
      <div class=scroll><table><thead><tr><th>売上伝票ID</th><th>得意先</th><th>帳票</th></tr></thead><tbody>${行たち || `<tr><td colspan=3 class=note>その日の売上伝票が手元にありません</td></tr>`}</tbody></table></div></div>` };
  }
  if (d.tbl === 月表) {
    const 年月 = String(c.値(行, 月_年月, true) ?? "");
    if (!帳票の組み.has("請求書")) return { html: 未("請求書") };
    const 台帳 = X.db.prepare(`SELECT id FROM row WHERE tbl=? AND json_extract(cells,'$.'||?||'[0].foreignRowDisplayName')=?`).all(売掛台帳, 台帳_月, 年月).map((r) => 取る(r.id)).filter(Boolean);
    const 行たち = 台帳.map((x) => { const k = String(c.値(x, 台帳_ID) ?? x.id); return `<tr><td><a href="/doc/${encodeURIComponent("請求書")}/${encodeURIComponent(k)}"><code>${E(k)}</code></a></td><td>${E(名(x))}</td></tr>`; }).join("");
    return { html: `<div class=el><div class=elh>${E(年月)} の売掛台帳 <span class=tag>${台帳.length} 件</span> <span class=tag>現行は月ぶんの請求書 PDF をまとめてダウンロード</span></div>
      <div class=scroll><table><thead><tr><th>売掛台帳ID → 請求書</th><th>台帳</th></tr></thead><tbody>${行たち || `<tr><td colspan=2 class=note>この月の売掛台帳が手元にありません</td></tr>`}</tbody></table></div></div>` };
  }
  return 帳票の組み.has(d.帳票) ? { 転送: `/doc/${encodeURIComponent(d.帳票)}/${encodeURIComponent(行.id)}` } : { html: 未(d.帳票) };
}

/** ─── 経路 ─── */
const ない = (res, 何) => X.出す(res, X.骨("404", `<h1>${E(何)}はありません</h1><div style="margin-top:12px"><a href="/fbtn">← 項目型ボタンの一覧</a></div>`, null), 404);
const 転送 = (res, 先) => { res.writeHead(302, { location: 先 }); res.end(); };

function 引く(m) {
  const d = 登録.get(m[1]);
  const 行 = 取る(decodeURIComponent(m[2]));
  return { d, 行, 合う: !!d && !!行 && 行.tbl === d.tbl };
}

async function 押す(req, res, u, m) {
  const { d, 行, 合う } = 引く(m);
  if (!d) return ない(res, "そのボタン項目");
  if (!行) return ない(res, "その行");
  if (!合う) return X.出す(res, X.骨("合わない", `<h1>${E(d.文字)}</h1><div class=warn>行 ${E(行.id)} は ${E(X.表.get(行.tbl)?.表示 ?? 行.tbl)} の行。このボタンは ${E(X.表.get(d.tbl)?.表示 ?? d.tbl)} のもの</div>`, null), 400);
  const { url, 出どころ } = 宛先(d, 行);

  if (d.種類 === "画面") return 転送(res, `/p/${d.画面}?row=${encodeURIComponent(行.id)}`);
  if (d.種類 === "帳票") {
    const 先 = 帳票へ(d, 行);
    if (先.転送) return 転送(res, 先.転送);
    return X.出す(res, X.骨(d.帳票, `<h1>${E(d.文字)}: ${E(d.帳票)}</h1>
      <div class=sub>${E(X.表.get(d.tbl)?.表示 ?? d.tbl)} ・ 行 ${E(名(行))} <span class=tag>${E(行.id)}</span></div>
      ${先.html ?? ""}
      <div class=el>${箱(url ? `現行の宛先（Make が Drive に置いた PDF。開かない）: <code>${E(url)}</code> ${札(出どころ)}` : `現行の宛先は空（${E(X.項目.get(d.URL項目)?.name ?? d.URL項目)} が空＝Make がまだ PDF を置いていない）`)}</div>
      <div style="margin-top:12px"><a href="/fbtn">← 一覧</a>${行へ(行) ? `　<a href="${E(行へ(行))}">行の画面へ</a>` : ""}　<a href="/docs">帳票の一覧</a></div>`, null));
  }
  if (!url) return X.出す(res, X.骨(d.文字, `<h1>${E(d.文字)}</h1><div class=sub>${E(X.表.get(d.tbl)?.表示 ?? d.tbl)}.${E(d.名)} ・ 行 ${E(名(行))}</div>
    <div class=warn>この行では押せない。現行でも url の式 <code>${E(d.式.slice(0, 200))}</code> が空を返す（${E(出どころ)}）</div>
    <div style="margin-top:12px"><a href="/fbtn">← 一覧</a>${行へ(行) ? `　<a href="${E(行へ(行))}">行の画面へ</a>` : ""}</div>`, null));

  if (d.種類 === "動作") {
    if (req.method === "GET") return X.出す(res, 動作の画面(d, d.鍵, 行));
    const 生 = await X.本文を読む(req);
    const 定義 = X.動作.台帳.get(d.鍵);
    const 引数 = {}; for (const k of 定義?.引数 ?? []) if (生[k] != null && 生[k] !== "") 引数[k] = 生[k];
    const r = X.動作.押す(d.鍵, 行.id, { 確認済み: 生.ok === "1", 出どころ: `項目ボタン ${d.fld} ${d.鍵}`, 引数 });
    return X.出す(res, 動作の画面(d, d.鍵, 取る(行.id) ?? 行, { 結果: r.確認待ち ? { 可: false, 文言: ["確認してから押してください"] } : r }), r.可 ? 200 : 400);
  }
  if (d.種類 === "編集") {
    if (req.method === "GET") return X.出す(res, 編集フォーム(d, 行, u));
    const 生 = await X.本文を読む(req);
    const f = フォーム(d), 先 = 編集の行(d, 行);
    if (!f || !先) return ない(res, "その編集フォーム");
    const 値 = 編集の値(d, f, 先, 生);
    const r = X.書き込み.更新(先.id, 値, { 出どころ: `項目ボタン ${d.fld} ${d.share}`, フォーム: `mx:${d.share}|${d.表}|${f.button}` });
    /** 入れた値を URL に戻して、直すときに打ち直さなくてよいようにする（外フォームと同じ） */
    const u2 = new URL(`http://x${u.pathname}`);
    if (r.文言?.length) for (const [k, v] of Object.entries(生)) if (/^[vq]_/.test(k)) u2.searchParams.set(k, Array.isArray(v) ? v[0] : v);
    return X.出す(res, 編集フォーム(d, 行, u2, r.文言?.length ? { 文言: r.文言 } : { 成功: { 行ID: 先.id, 再計算した行数: r.再計算した行数 } }), r.文言?.length ? 400 : 200);
  }
  return X.出す(res, X.骨(d.文字, `<h1>${E(d.文字)}</h1><div class=warn>${E(d.注 ?? "外部の宛先。開きません")}: <code>${E(url)}</code></div>`, null));
}

/** 鍵で押す（ボタン要素の無い動作）。GET は行の選択か確認、POST は実行 */
async function 鍵で押す(req, res, u, m) {
  const 鍵 = decodeURIComponent(m[1]);
  const 定義 = X.動作.台帳.get(鍵);
  if (!定義) return ない(res, `動作 ${鍵}`);
  const 行 = m[2] ? 取る(decodeURIComponent(m[2])) : null;
  if (m[2] && !行) return ない(res, "その行");
  if (行 && 定義.表 && 行.tbl !== 定義.表) return X.出す(res, X.骨("合わない", `<h1>${E(定義.札)}</h1><div class=warn>行 ${E(行.id)} は ${E(X.表.get(行.tbl)?.表示 ?? 行.tbl)} の行。この動作は ${E(X.表.get(定義.表)?.表示 ?? 定義.表)} のもの</div>`, null), 400);
  if (req.method === "GET") return X.出す(res, 動作の画面(null, 鍵, 行));
  const 生 = await X.本文を読む(req);
  /** 確認の無い動作でも ok=1 を要求する。ok=0 で BOM引当 が走った（検証 2026-09-13） */
  if (生.ok !== "1") return X.出す(res, 動作の画面(null, 鍵, 行, { 結果: { 可: false, 文言: ["確認してから押してください（ok=1）"] } }), 400);
  const 引数 = {}; for (const k of 定義.引数 ?? []) if (生[k] != null && 生[k] !== "") 引数[k] = 生[k];
  const r = X.動作.押す(鍵, 行?.id ?? null, { 確認済み: 生.ok === "1", 出どころ: `項目ボタン(鍵) ${鍵}`, 引数 });
  return X.出す(res, 動作の画面(null, 鍵, 行 ? 取る(行.id) ?? 行 : null, { 結果: r.確認待ち ? { 可: false, 文言: ["確認してから押してください"] } : r }), r.可 ? 200 : 400);
}

/**
 * 仕上げ: 画面の HTML ができた後に「ローカルで押す」の箱を足す（serve.mjs の 拡張.仕上げ）。
 * 以前は 30-detail の画面フックと 20-cells の欄フックを配列の中で包み替えていたが、その口ができたので外した。
 * 行つきの画面（?row=）で、その行の表に項目型ボタンがあれば footer の前に 1 回だけ出す。
 */
export const 仕上げ = [(html, p, u) => {
  const rid = u?.searchParams?.get("row");
  if (!rid || typeof html !== "string" || html.includes("data-fbtn-box")) return html;
  const 箱 = 行の箱(rid, null);
  if (!箱) return html;
  const 印 = `<div data-fbtn-box>${箱}</div>`;
  return html.includes("<footer>") ? html.replace("<footer>", 印 + "<footer>") : html.replace("</body>", 印 + "</body>");
}];

export const 経路 = [
  { method: "GET", pattern: /^\/fbtn$/, handler: (req, res) => X.出す(res, 一覧を描く()) },
  { pattern: /^\/fbtn\/csv$/, handler: (req, res, u) => 鍵で押す(req, res, u, [null, "CSV取込", null]) },
  { pattern: /^\/fbtn\/act\/([^/]+)(?:\/([^/]+))?$/, handler: (req, res, u, m) => 鍵で押す(req, res, u, m) },
  /** /actions の「押す」は要素の無い動作を /do/-/<鍵> に飛ばす（serve.mjs 既存の穴）。ここで受ける */
  { pattern: /^\/do\/-\/([^/]+)$/, handler: (req, res, u, m) => 鍵で押す(req, res, u, [null, m[1], null]) },
  { pattern: /^\/fbtn\/(fld[A-Za-z0-9]+)\/([^/]+)$/, handler: (req, res, u, m) => 押す(req, res, u, m) },
];
