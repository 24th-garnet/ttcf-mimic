/**
 * **画面のボタンのうち、自動処理（triggerWorkflow）以外の 243 個を動かす。** 通信しない。
 *
 * ボタンは 319 個。triggerWorkflow 76 個は `db/actions.mjs` が中身を持つ。残り 243 個は
 * 定義（`elem.spec.動作の詳細`。crawl/14-layout.mjs が生の action から写す）だけで動く。
 *
 *   navigateToSelectedPage 146   /p/<行き先の画面> へのリンク（?row= の行の文脈は引き継ぐ）
 *   navigateToStaticUrl     55   URL を**行き先の種類で分ける**（下記）
 *   navigateToRowUrl        18   その行の項目（式の URL か ボタン項目 {label,url}）を読み、同じく分ける
 *   openFormModalDialog     10   純正フォーム /form/<画面>/<formContainer> へ（2 画面・2 フォーム）
 *   deleteRow                7   確認 → POST → 文脈.書き込み.消す
 *   updateRow                6   columnUpdateSet を 文脈.書き込み.更新 で当てる（6 件とも checkbox=true・set）
 *   addForeignRow            1   純正フォームで子行を作り、**親の行の関連項目に張る**（入金登録）
 *
 * ■ URL の行き先はリンクにしてよいものと、してはいけないものがある
 *
 *   airtable.com/app…/tbl…/viw…   同じ表を見せるローカル画面へ（page.tbl 一致。1 件: 在庫登録/仕入明細）
 *   web.miniextensions.com/<share> form 表に定義がある 17 種は /mform/<share>/<表> へ。`?prefill_<項目名>=値` は
 *                                 その項目の `v_<項目ID>` に直す。定義の無い share（5 種: 出荷依頼・顧客マスタ編集など）は文字で出す
 *   form.fillout.com/t/<id>?id=   form 表の `fillout:<id>` へ（2 種）
 *   hook.eu1.make.com / onrender  **リンクにしない。宛先を文字で出すだけ。** Make の webhook は GET した瞬間に
 *                                 本番の締め処理が走る（システム登録 2 件・PDF 作成ツール 2 件）
 *
 * ■ 行の文脈
 *
 * rowInput.outputId は現行では rowSelector か画面の rootRowContainer が決める行。ミミックでは URL の
 * `?row=rec…` で受け、無いときは対象の表の最新 50 行から選ぶ小さな選択肢を出す。
 * ボタンの描き手（serve.mjs の ボタンを描く）は URL を受け取らないので、画面の差し込み口で URL を控える
 * （画面を描く は 拡張.画面 を先に呼び、その後 ボタンを描く を呼ぶ。同期なので取り違えは起きない）。
 *
 * ■ 見せる条件
 *
 * updateRow 4 件・navigateToRowUrl 7 件はボタン自身に visibilityFilters を持つ（経路から降りてくる分は
 * elem.visible_when）。行があるときは両方を行に当て、合わなければ**ボタンを出さない**（現行と同じ）。
 * 判定は db/calc.mjs の 通る()。lookup は {valuesByForeignRowId} の形なので、値の並びに平らにしてから渡す
 * （平らにしないと 請求締処理ステータス | [sel…] が常に偽になる）。
 *
 * ■ 書いた内容はすべて write_log に残る（origin = `画面 <画面ID>/<要素ID> <動作>`）。現行の Airtable には一切書かない。
 */
import { parse, evaluate } from "../../db/formula.mjs";

let X = null;          // 文脈（準備で受ける）
let 今のURL = null;    // 画面を描く の最中の URL（拡張.画面 で控える）。描き手は第 4 引数の u を優先し、無いときだけこれを読む

/** 純正フォーム（formContainer）を画面IDで引く。openFormModalDialog / addForeignRow の embeddedFormButton.pageId が指す */
const 純正フォーム = new Map();
/** miniExtensions の入口。share → 親フォーム（is_child=0）。親が無ければ最初の定義 */
const フォームの入口 = new Map();
/** 表ID → その表を見せる画面（in_nav・レイアウトあり を先に） */
const 表の画面 = new Map();

export function 準備(文脈) {
  X = 文脈;
  const { db } = X;
  for (const r of db.prepare("SELECT page,id,spec FROM elem WHERE type='formContainer'").all()) {
    const sp = JSON.parse(r.spec ?? "{}");
    if (!純正フォーム.has(r.page)) 純正フォーム.set(r.page, { id: r.id, sp });
  }
  for (const r of db.prepare("SELECT share,tbl,button,is_child,spec FROM form ORDER BY share,is_child").all()) {
    const 今 = フォームの入口.get(r.share);
    if (!今 || (今.is_child && !r.is_child)) フォームの入口.set(r.share, { tbl: r.tbl, is_child: r.is_child, sp: JSON.parse(r.spec ?? "{}") });
  }
  for (const p of db.prepare("SELECT id,name,tbl,base,in_nav,has_layout,type FROM page WHERE tbl IS NOT NULL ORDER BY in_nav DESC, has_layout DESC, ord").all())
    (表の画面.get(p.tbl) ?? 表の画面.set(p.tbl, []).get(p.tbl)).push(p);
  const n = db.prepare("SELECT count(*) c FROM elem WHERE type='button' AND json_extract(spec,'$.動作')<>'triggerWorkflow'").get().c;
  const 詳細あり = db.prepare("SELECT count(*) c FROM elem WHERE type='button' AND json_extract(spec,'$.動作の詳細') IS NOT NULL").get().c;
  console.log(`ボタン: 自動処理以外 ${n}個（動作の詳細あり ${詳細あり}）／ 純正フォーム ${純正フォーム.size}画面 ／ miniExtensions 入口 ${フォームの入口.size}`);
}

/** 画面を描く の先頭で URL を控えるだけ。null を返して既定の描き方に任せる */
export const 画面 = (p, 要素, pid, u) => { 今のURL = u ?? null; return null; };

/** ─── 小さな道具 ─── */
const 詳細を読む = (sp) => sp.動作の詳細 ?? null;
const 札 = (s, 色 = "") => `<span class=tag${色 ? ` style="${色}"` : ""}>${X.E(s)}</span>`;
/**
 * **data-act は「押すところ」の印。** serve.mjs の ボタンを描く がこの印の要素だけを取り出して
 * 画面の上の帯（demo の PageHeader の右端）に並べ、残り（動作名・対象・確認文・見せる条件・門・宛先）は
 * 「このボタンの定義」の折りたたみに入れる。印を付けるだけなので、差し込み口の契約（html を返す）は変えない。
 */
/** Airtable の colorTheme。primary / secondary は ボタンの色 に無いので寄せる（実測: primary 38・secondary 63） */
const 色を引く = (theme) => X.ボタンの色[theme] ?? (theme === "primary" ? X.ボタンの色.blue : X.ボタンの色.gray);
const リンク風 = (文字, [bg, fg], href, 題 = "") => `<a class=btn data-act style="background:${bg};color:${fg};text-decoration:none" href="${X.E(href)}"${題 ? ` title="${X.E(題)}"` : ""}>${X.E(文字)}</a>`;
const 飾り = (文字, [bg, fg]) => `<span class=btn data-act style="background:${bg};color:${fg};opacity:.85">${X.E(文字)}</span>`;
const 押し風 = (文字, [bg, fg], action, 隠し) => `<form method=post data-act action="${X.E(action)}" style="display:inline">
  ${Object.entries(隠し).map(([k, v]) => `<input type=hidden name="${X.E(k)}" value="${X.E(v)}">`).join("")}
  <button class=btn style="background:${bg};color:${fg};border:0;cursor:pointer">${X.E(文字)}</button></form>`;
const 行の道 = (pid, 行ID) => `/p/${pid}${行ID ? `?row=${encodeURIComponent(行ID)}` : ""}`;
const 押す道 = (pid, eid, 行ID = null) => `/button/${pid}/${eid}${行ID ? `?row=${encodeURIComponent(行ID)}` : ""}`;

/** 行の表示名。主項目の値を画面と同じ書式で */
function 行の名(行) {
  if (!行) return "";
  const 主 = X.db.prepare("SELECT primary_fld FROM tbl WHERE id=?").get(行.tbl)?.primary_fld;
  const v = 主 ? X.書き込み.計算器.値(行, 主, true) : null;
  const s = 主 ? X.書く(v, X.項目.get(主)) : "";
  return s || 行.id;
}

/**
 * 対象の表の最新 50 行。現行は rowSelector か URL の 1 行が決めるが、ミミックではここから選ぶ。
 * 「最新」は取り込み時刻→挿入順。ミミックで作った行（loaded が新しい）が先に来る
 */
function 行の候補(表ID, n = 50) {
  return X.db.prepare("SELECT id FROM row WHERE tbl=? ORDER BY loaded DESC, rowid DESC LIMIT ?").all(表ID, n)
    .map((r) => X.書き込み.計算器.取る(r.id)).filter(Boolean);
}

/** URL の ?row= を行の文脈にする。表が合わなければ「合わない」 */
function 文脈の行(u, 表ID) {
  const 行ID = u?.searchParams?.get("row") || null;
  if (!行ID) return { 行ID: null, 行: null, 合わない: false };
  const 行 = X.書き込み.計算器.取る(行ID);
  if (!行) return { 行ID, 行: null, 合わない: true, 文言: `行がありません: ${行ID}` };
  if (表ID && 行.tbl !== 表ID) return { 行ID, 行, 合わない: true, 文言: `この行は ${X.表.get(行.tbl)?.表示 ?? 行.tbl} の行です。ボタンの対象は ${X.表.get(表ID)?.表示 ?? 表ID}` };
  return { 行ID, 行, 合わない: false };
}

/**
 * lookup を値の並びに平らにした行。calc.mjs の 通る() は 候補() で配列と関連は読むが
 * {valuesByForeignRowId} は読まないので、ここで直してから渡す
 */
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

/** ボタンに効く見せる条件を全部集める（経路から降りてくる分 + ボタン自身の分。重複は潰す） */
function 見せる条件たち(e, 詳細) {
  const 出 = new Map();
  for (const c of e.visible_when ? JSON.parse(e.visible_when) : []) if (c?.生) 出.set(JSON.stringify(c.生), { 条件: c.生, 文: c.条件, 元: c.元の種類 });
  if (詳細?.見せる条件) { const k = JSON.stringify(詳細.見せる条件); if (!出.has(k)) 出.set(k, { 条件: 詳細.見せる条件, 文: null, 元: "button" }); }
  return [...出.values()];
}
function 出るか(行, 条件たち) {
  if (!行 || !条件たち.length) return true;
  const 平 = 平らな行(行);
  return 条件たち.every((c) => X.書き込み.計算器.通る(平, X.書き込み.条件を直す(c.条件)));
}

/** ─── URL の行き先を決める ─── */
/**
 * @returns {{種:"画面"|"mform"|"引き金"|"外部"|"空", href?:string, 表示:string, 注?:string}}
 *   画面   ローカルの画面（airtable.com の app/tbl/viw を page.tbl で引いた）
 *   mform  miniExtensions / Fillout のフォーム（form 表に定義がある）
 *   引き金 Make・onrender。**開かない**
 *   外部   その他の外部。開かない
 */
function URLの行き先(url, { 行ID = null, pid = null } = {}) {
  const s = String(url ?? "").trim();
  if (!s) return { 種: "空", 表示: "" };
  /**
   * onrender（ttcf-inventory-pdf-converter）は「日毎在庫残高」の画面を PDF にする外部サービス（2 画面のボタン「PDF作成ツール」）。
   * 手元では同じ画面を印刷用に開く（/print/<画面>）。ブラウザの印刷で PDF になる。外へは出ない
   */
  if (/onrender\.com/i.test(s)) return pid
    ? { 種: "画面", href: `/print/${pid}`, 表示: "PDF作成ツール → この画面を印刷用に開く（ブラウザで PDF に保存）", 注: "現行は onrender の変換サービスに画面を送る。手元では同じ画面を印刷用に描く" }
    : { 種: "引き金", 表示: s, 注: "onrender の変換サービス。この画面からは開きません" };
  if (X.引き金か(s)) return { 種: "引き金", 表示: s, 注: "引き金を引く宛先。この画面からは開きません（GET した瞬間に本番の処理が走る）" };
  let m;
  /** airtable.com の中。表が分かればその表を見せるローカル画面へ */
  if ((m = s.match(/^https?:\/\/airtable\.com\/(app[A-Za-z0-9]+)(?:\/(tbl[A-Za-z0-9]+))?(?:\/(viw[A-Za-z0-9]+))?/))) {
    const [, app, tbl, viw] = m;
    const 候補 = tbl ? (表の画面.get(tbl) ?? []) : X.db.prepare("SELECT id,name,tbl FROM page WHERE base=? AND in_nav=1 AND has_layout=1 ORDER BY ord").all(app);
    const p = 候補[0];
    if (p) return { 種: "画面", href: 行の道(p.id, 行ID && p.tbl && X.書き込み.計算器.取る(行ID)?.tbl === p.tbl ? 行ID : null), 表示: `${p.name}（${X.表.get(p.tbl)?.表示 ?? p.tbl ?? ""}）`, 注: viw ? `現行はビュー ${viw} を開く` : null };
    return { 種: "外部", 表示: s, 注: tbl ? `表 ${X.表.get(tbl)?.表示 ?? tbl} を見せる画面が手元にありません` : "ベースの画面が手元にありません" };
  }
  /** miniExtensions。/<share>[/<rec>][?prefill_項目名=値] */
  if ((m = s.match(/^https?:\/\/(?:web\.)?miniextensions\.com\/([A-Za-z0-9]+)(?:\/(rec[A-Za-z0-9]+)?)?\/?(?:\?(.*))?$/))) {
    const [, share, rec, q] = m;
    const f = フォームの入口.get(share);
    if (!f) return { 種: "外部", 表示: s, 注: `miniExtensions ${share} の定義が手元にありません（読み取りだけの追加取得で埋まります）` };
    const 引数 = new URLSearchParams();
    const 注 = [];
    for (const [k, v] of new URLSearchParams(q ?? "")) {
      const 名 = k.replace(/^prefill_/, "");
      const x = (f.sp.項目 ?? []).find((y) => y.name === 名 || y.id === 名);
      if (!x) { 注.push(`prefill ${名}=${v} はこのフォームの項目に無い`); continue; }
      引数.set(`v_${x.id}`, x.型 === "checkbox" ? (/^(true|1)$/i.test(v) ? "1" : "") : v);
    }
    if (rec) 注.push(`現行は行 ${rec} を開く（1 レコードずつの編集）`);
    else if (/\/$/.test(s.split("?")[0])) 注.push("行が指定されていない（式の末尾に入る列の値が空）");
    const qs = 引数.toString();
    return { 種: "mform", href: `/mform/${share}/${f.tbl}${qs ? "?" + qs : ""}`, 表示: `miniExtensions ${share} → ${X.表.get(f.tbl)?.表示 ?? f.tbl}`, 注: 注.join("。") || null };
  }
  /** Fillout。/t/<id>?id=<rec> */
  if ((m = s.match(/^https?:\/\/form\.fillout\.com\/t\/([A-Za-z0-9]+)(?:\?(.*))?$/))) {
    const [, id, q] = m;
    const f = フォームの入口.get(`fillout:${id}`);
    if (!f) return { 種: "外部", 表示: s, 注: `Fillout ${id} の定義が手元にありません` };
    const rec = new URLSearchParams(q ?? "").get("id");
    return { 種: "mform", href: `/mform/fillout:${id}/${f.tbl}`, 表示: `Fillout ${id} → ${X.表.get(f.tbl)?.表示 ?? f.tbl}`, 注: rec ? `現行は行 ${rec} を更新する` : null };
  }
  if (X.外部か(s)) return { 種: "外部", 表示: s, 注: "外部の宛先。この画面からは開きません" };
  return { 種: "外部", 表示: s };
}

/**
 * navigateToRowUrl の項目の値。2 種類ある。
 *   formula   結果の文字が URL（4 項目。例 'https://web.miniextensions.com/J156…/' & RECORD_ID()）
 *   button    値は {label,url}。Airtable が返した値（snap）があればそれ、無ければ opts.url の式を評価する
 *             （計算器は button 型を計算しない。式は IF({…}=1,'', 'https://…' & RECORD_ID()) の形で、空なら押せない）
 */
function URL項目の値(行, fid) {
  const f = X.項目.get(fid);
  if (!f) return { url: null, 注: `項目 ${fid} が定義にありません` };
  const c = X.書き込み.計算器;
  if (f.type === "button") {
    const 生 = c.値(行, fid, true);
    if (生 && typeof 生 === "object" && "url" in 生) return { url: 生.url ?? null, 札: 生.label ?? f.opts?.文字 ?? null, 出どころ: "Airtable が返した値" };
    if (!f.opts?.url) return { url: null, 注: "ボタン項目に URL の式がありません" };
    try {
      const v = evaluate(parse(f.opts.url), { 値: (x) => c.値(行, x), 行ID: () => 行.id, tz: "Asia/Tokyo", 未対応: [] });
      return { url: v == null ? null : String(v), 札: f.opts.文字 ?? null, 出どころ: "式を評価" };
    } catch (e) { return { url: null, 注: `URL の式を評価できません: ${e.message}` }; }
  }
  let v = c.値(行, fid);
  if ((v == null || v === "") && f.is_computed) { try { v = c.一つ計算(行, fid); } catch { v = null; } }
  return { url: v == null ? null : String(Array.isArray(v) ? v[0] : v), 出どころ: "項目の値" };
}

/** ─── 描くときの共通の尾（動作・対象・確認・条件） ─── */
function 尾(e, sp, 詳細, 条件, 追加 = "") {
  const 表 = 詳細?.行の入力?.表 ?? sp.対象の行?.母集団の表 ?? null;
  return `${札(sp.動作 ?? "?")}
    ${表 ? 札(`対象: ${表}`) : ""}
    ${追加}
    ${詳細?.確認 ? `<div class=dlg><b>${X.E(詳細.確認.題 ?? "")}</b>\n${X.E(詳細.確認.本文 ?? "")}\n→ ${X.E(詳細.確認.進むボタン ?? "")}</div>` : ""}
    ${条件?.length ? `<div class=cond>見せる条件: ${X.E(条件.map((c) => c.条件).join(" / "))}</div>` : ""}`;
}
const 箱 = (中) => `<div style="padding:8px 12px;border-bottom:1px solid #f2f2f4">${中}</div>`;
const 定義なし = (e, sp, 色) => 箱(`${飾り(sp.文字 ?? "?", 色)} ${札(sp.動作 ?? "?")} <div class=dlg>定義に行き先がありません。<code>TTCF_PAGES_DIR=pages-20260911 node crawl/14-layout.mjs</code> → <code>node db/01-meta.mjs</code> で <code>動作の詳細</code> を入れてください</div>`);

/** 行が無いときの小さな選択肢。GET /button/<pid>/<eid>?row=… へ飛ぶ */
function 行を選ぶ欄(pid, e, sp, 色, 表ID) {
  const 候補 = 行の候補(表ID);
  if (!候補.length) return `${飾り(sp.文字 ?? "?", 色)} <div class=dlg>対象の表 ${X.E(X.表.get(表ID)?.表示 ?? 表ID)} の行が手元にありません</div>`;
  return `<form method=get action="${X.E(押す道(pid, e.id))}" style="display:inline-flex;gap:6px;align-items:center;flex-wrap:wrap">
    <select name=row style="padding:4px 6px;border:1px solid #ccd;border-radius:4px;font:inherit;max-width:280px">
      <option value="">（対象の行を選ぶ・最新${候補.length}件）</option>
      ${候補.map((r) => `<option value="${X.E(r.id)}">${X.E(行の名(r))}</option>`).join("")}
    </select>
    <button class=btn style="background:${色[0]};color:${色[1]};border:0;cursor:pointer">${X.E(sp.文字 ?? "?")}</button>
    <span class=tag>この画面は行の文脈が要る。URL に ?row=rec… を付けるか、ここで選ぶ</span></form>`;
}

/** ─── 動作ごとの描き手 ─── */
/** 行き先の画面へ。?row= の行は、行き先が同じ表の画面（か表を持たない画面）なら引き継ぐ */
function navigateToSelectedPage(e, sp, pid, { 条件, 色, u }) {
  const 詳細 = 詳細を読む(sp);
  if (!詳細) return 定義なし(e, sp, 色);
  const 先 = X.db.prepare("SELECT id,name,tbl,has_layout FROM page WHERE id=?").get(詳細.行き先の画面);
  const { 行ID, 行 } = 文脈の行(u ?? 今のURL, null);
  const 引き継ぐ = 行 && (!先?.tbl || 先.tbl === 行.tbl) ? 行ID : null;
  if (!先) return 箱(`${飾り(sp.文字 ?? "?", 色)} ${尾(e, sp, 詳細, 条件, `<div class=dlg>行き先の画面 ${X.E(詳細.行き先の画面 ?? "?")} が定義にありません</div>`)}`);
  return 箱(`${リンク風(sp.文字 ?? 先.name, 色, 行の道(先.id, 引き継ぐ), 先.name)}
    ${尾(e, sp, 詳細, 条件, `${札(`→ ${先.name}${先.has_layout ? "" : "（レイアウト未取得）"}`)}${詳細.新しい窓 ? 札("新しい窓") : ""}${引き継ぐ ? 札(`行 ${行の名(行)} を引き継ぐ`) : ""}`)}`);
}

/** 固定の URL。行き先の種類で、開く／文字で出すを分ける */
function navigateToStaticUrl(e, sp, pid, { 条件, 色, u }) {
  const 詳細 = 詳細を読む(sp);
  const url = 詳細?.url ?? sp.url;
  const { 行ID } = 文脈の行(u ?? 今のURL, null);
  const 先 = URLの行き先(url, { 行ID, pid });
  return 箱(URLの行き先を描く(先, sp.文字 ?? "?", 色) + 尾(e, sp, 詳細, 条件, 詳細?.新しい窓 ? 札("新しい窓") : ""));
}

function URLの行き先を描く(先, 文字, 色) {
  if (先.種 === "画面" || 先.種 === "mform")
    return `${リンク風(文字, 色, 先.href, 先.表示)} ${札(`→ ${先.表示}`)}${先.注 ? `<div class=dlg>${X.E(先.注)}</div>` : ""}`;
  if (先.種 === "空") return `${飾り(文字, 色)} <div class=dlg>この行では宛先が空。現行でも押せない（式が '' を返す）</div>`;
  return `${飾り(文字, 色)} <div class=dlg>${先.種 === "引き金" ? "⚠ " : ""}${X.E(先.注 ?? "外部の宛先（開きません）")}: <code>${X.E(String(先.表示).slice(0, 160))}</code></div>`;
}

/** その行の項目に入っている URL へ。行が要る */
function navigateToRowUrl(e, sp, pid, { 条件, 色, u }) {
  const 詳細 = 詳細を読む(sp);
  if (!詳細) return 定義なし(e, sp, 色);
  const 表ID = 詳細.行の入力?.表ID ?? null;
  const 項 = X.項目.get(詳細.URLの項目);
  const 項の札 = 札(`URL の項目: ${項?.name ?? 詳細.URLの項目 ?? "?"}（${項?.type ?? "?"}）`);
  const ctx = 文脈の行(u ?? 今のURL, 表ID);
  if (ctx.合わない) return 箱(`${行を選ぶ欄(pid, e, sp, 色, 表ID)} <div class=cond>${X.E(ctx.文言)}</div> ${尾(e, sp, 詳細, 条件, 項の札)}`);
  if (!ctx.行) return 箱(`${行を選ぶ欄(pid, e, sp, 色, 表ID)} ${尾(e, sp, 詳細, 条件, 項の札)}`);
  const 条件たち = 見せる条件たち(e, 詳細);
  if (!出るか(ctx.行, 条件たち)) return 箱(`<span class=tag style="background:#f2f2f4">「${X.E(sp.文字 ?? "?")}」はこの行では出ない（見せる条件に合わない）</span> ${尾(e, sp, 詳細, 条件, 項の札)}`);
  const v = URL項目の値(ctx.行, 詳細.URLの項目);
  const 先 = URLの行き先(v.url, { 行ID: ctx.行ID });
  return 箱(`${URLの行き先を描く(先, sp.文字 ?? v.札 ?? "?", 色)} ${尾(e, sp, 詳細, 条件, `${項の札}${v.出どころ ? 札(v.出どころ) : ""}${v.注 ? `<div class=dlg>${X.E(v.注)}</div>` : ""}`)}`);
}

/** 行を消す。確認の画面（GET /button/…?row=）を経て POST で消す */
function deleteRow(e, sp, pid, { 条件, 色, u }) {
  const 詳細 = 詳細を読む(sp);
  if (!詳細) return 定義なし(e, sp, 色);
  const 表ID = 詳細.行の入力?.表ID ?? null;
  const ctx = 文脈の行(u ?? 今のURL, 表ID);
  if (ctx.合わない) return 箱(`${行を選ぶ欄(pid, e, sp, 色, 表ID)} <div class=cond>${X.E(ctx.文言)}</div> ${尾(e, sp, 詳細, 条件)}`);
  if (!ctx.行) return 箱(`${行を選ぶ欄(pid, e, sp, 色, 表ID)} ${尾(e, sp, 詳細, 条件)}`);
  if (!出るか(ctx.行, 見せる条件たち(e, 詳細))) return 箱(`<span class=tag style="background:#f2f2f4">「${X.E(sp.文字 ?? "削除")}」はこの行では出ません</span> ${尾(e, sp, 詳細, 条件)}`);
  return 箱(`${リンク風(sp.文字 ?? "削除", 色, 押す道(pid, e.id, ctx.行ID), "確認して消す")} ${札(`行 ${行の名(ctx.行)}`)} ${尾(e, sp, 詳細, 条件)}`);
}

/** updateRow の「既に押した」= 書く値が全部入っている。押した後の見え方に切り替える */
function 既に押した(行, 詳細) {
  const c = X.書き込み.計算器;
  return (詳細.書く ?? []).length > 0 && 詳細.書く.every((w) => {
    const v = c.値(行, w.項目, true);
    if (w.値 === true) return v === true || v === 1 || v === "1";
    if (w.値 === false || w.値 === null) return v == null || v === false || v === "";
    return JSON.stringify(v) === JSON.stringify(w.値);
  });
}
function 押した後(詳細, 色) {
  const a = 詳細.押した後の見え方;
  if (!a) return 飾り("（押した）", 色);
  return `${飾り(`${a.印 ? "✓ " : ""}${a.文字 ?? ""}`, 色を引く(a.色))} ${札("押した後の見え方")}`;
}

/** 行の項目を書き換える。確認があれば確認の画面、無ければその場で POST */
function updateRow(e, sp, pid, { 条件, 色, u }) {
  const 詳細 = 詳細を読む(sp);
  if (!詳細) return 定義なし(e, sp, 色);
  const 表ID = 詳細.行の入力?.表ID ?? null;
  const 何を = 札(`書く: ${(詳細.書く ?? []).map((w) => `${X.項目.get(w.項目)?.name ?? w.項目} ${w.振る舞い === "set" ? "=" : w.振る舞い} ${JSON.stringify(w.値)}`).join(", ")}`);
  const ctx = 文脈の行(u ?? 今のURL, 表ID);
  if (ctx.合わない) return 箱(`${行を選ぶ欄(pid, e, sp, 色, 表ID)} <div class=cond>${X.E(ctx.文言)}</div> ${尾(e, sp, 詳細, 条件, 何を)}`);
  if (!ctx.行) return 箱(`${行を選ぶ欄(pid, e, sp, 色, 表ID)} ${尾(e, sp, 詳細, 条件, 何を)}`);
  const 条件たち = 見せる条件たち(e, 詳細);
  if (!出るか(ctx.行, 条件たち)) return 箱(`<span class=tag style="background:#f2f2f4">「${X.E(sp.文字 ?? "?")}」はこの行では出ない（見せる条件に合わない）</span> ${尾(e, sp, 詳細, 条件, 何を)}`);
  if (既に押した(ctx.行, 詳細)) return 箱(`${押した後(詳細, 色)} ${札(`行 ${行の名(ctx.行)}`)} ${尾(e, sp, 詳細, 条件, 何を)}`);
  const ボタン = 詳細.確認?.有効
    ? リンク風(sp.文字 ?? "?", 色, 押す道(pid, e.id, ctx.行ID), "確認してから書く")
    : 押し風(sp.文字 ?? "?", 色, 押す道(pid, e.id), { row: ctx.行ID, ok: "1" });
  return 箱(`${ボタン} ${札(`行 ${行の名(ctx.行)}`)} ${尾(e, sp, 詳細, 条件, 何を)}`);
}

/** 純正フォームを開く（現行はモーダル。ここでは /form の画面へ） */
function openFormModalDialog(e, sp, pid, { 条件, 色, u }) {
  const 詳細 = 詳細を読む(sp);
  if (!詳細) return 定義なし(e, sp, 色);
  const fp = 詳細.埋め込みフォーム?.画面;
  const fc = fp ? 純正フォーム.get(fp) : null;
  if (!fc) return 箱(`${飾り(sp.文字 ?? "?", 色)} ${尾(e, sp, 詳細, 条件, `<div class=dlg>フォームの画面 ${X.E(fp ?? "?")} に formContainer がありません</div>`)}`);
  const 無効 = 詳細.埋め込みフォーム?.有効 === false;
  return 箱(`${無効 ? 飾り(sp.文字 ?? "?", 色) : リンク風(sp.文字 ?? fc.sp.ボタン ?? "?", 色, `/form/${fp}/${fc.id}`, fc.sp.題 ?? "")}
    ${尾(e, sp, 詳細, 条件, `${札(`→ 純正フォーム「${fc.sp.題 ?? ""}」 ${fc.sp.動作 ?? ""} ${fc.sp.作る表 ?? 詳細.表 ?? ""}`)}${無効 ? 札("現行では無効") : ""}`)}`);
}

/** 親の行に子行を足す。純正フォームで作り、親の関連項目に張る。行（親）が要る */
function addForeignRow(e, sp, pid, { 条件, 色, u }) {
  const 詳細 = 詳細を読む(sp);
  if (!詳細) return 定義なし(e, sp, 色);
  const 親の表 = 詳細.親の行?.表ID ?? null;
  const fp = 詳細.埋め込みフォーム?.画面;
  const fc = fp ? 純正フォーム.get(fp) : null;
  const 何を = `${札(`作る: ${詳細.表 ?? 詳細.表ID}`)}${札(`親の ${X.項目.get(詳細.関連の項目)?.name ?? 詳細.関連の項目} に張る`)}${詳細.既存を選べる ? 札("既存の行も選べる") : 札("新しい行だけ")}`;
  if (!fc) return 箱(`${飾り(sp.文字 ?? "?", 色)} ${尾(e, sp, 詳細, 条件, `${何を}<div class=dlg>フォームの画面 ${X.E(fp ?? "?")} に formContainer がありません</div>`)}`);
  const ctx = 文脈の行(u ?? 今のURL, 親の表);
  if (ctx.合わない) return 箱(`${行を選ぶ欄(pid, e, sp, 色, 親の表)} <div class=cond>${X.E(ctx.文言)}</div> ${尾(e, sp, 詳細, 条件, 何を)}`);
  if (!ctx.行) return 箱(`${行を選ぶ欄(pid, e, sp, 色, 親の表)} ${尾(e, sp, 詳細, 条件, 何を)}`);
  /** 現行では section の見せる条件（在庫締処理ステータス isEmpty かつ 請求締処理ステータス に 締済 を含まない）の下にある。締済の台帳には出さない */
  if (!出るか(ctx.行, 見せる条件たち(e, 詳細))) return 箱(`<span class=tag style="background:#f2f2f4">「${X.E(sp.文字 ?? "?")}」はこの行では出ません</span> ${尾(e, sp, 詳細, 条件, 何を)}`);
  return 箱(`${リンク風(sp.文字 ?? fc.sp.ボタン ?? "?", 色, `${押す道(pid, e.id)}/form?row=${encodeURIComponent(ctx.行ID)}`, fc.sp.題 ?? "")} ${札(`親: ${行の名(ctx.行)}`)} ${尾(e, sp, 詳細, 条件, 何を)}`);
}

export const ボタン = { navigateToSelectedPage, navigateToStaticUrl, navigateToRowUrl, deleteRow, updateRow, openFormModalDialog, addForeignRow };

/** ─── 経路 ─── */
const 要素を引く = (pid, eid) => {
  const e = X.db.prepare("SELECT * FROM elem WHERE page=? AND id=? AND type='button'").get(pid, eid);
  if (!e) return null;
  const sp = JSON.parse(e.spec ?? "{}");
  return { e, sp, 詳細: 詳細を読む(sp), p: X.db.prepare("SELECT id,name FROM page WHERE id=?").get(pid) };
};
const 転送 = (res, 先) => { res.writeHead(302, { location: 先 }); res.end(); };
const ない = (res, 何) => X.出す(res, X.骨("404", `<h1>${X.E(何)}はありません</h1>`, null), 404);

/** 行を選ぶ画面（?row= 無しで /button/… に来たとき）。updateRow は行ごとに 出る／押した も出す */
function 行を選ぶ画面(pid, eid, x, 表ID, 文言 = null) {
  const { e, sp, 詳細, p } = x;
  const 候補 = 行の候補(表ID);
  const 条件たち = 見せる条件たち(e, 詳細);
  const 行 = 候補.map((r) => {
    const 出る = 出るか(r, 条件たち);
    const 押済 = 詳細.種類 === "updateRow" && 既に押した(r, 詳細);
    return `<tr><td><code>${X.E(行の名(r))}</code> <span class=tag>${X.E(r.id)}</span></td>
      <td>${!出る ? '<span style="color:#888">出ない（見せる条件）</span>' : 押済 ? `<span style="color:#0a7">${X.E(詳細.押した後の見え方?.文字 ?? "押した")}</span>` : '<span style="color:#0a7">出る</span>'}</td>
      <td style="text-align:right">${出る && !押済 ? `<a class=btn style="background:${色を引く(sp.色)[0]};color:${色を引く(sp.色)[1]};text-decoration:none" href="${X.E(押す道(pid, eid, r.id))}">${X.E(sp.文字 ?? "?")}</a>` : ""}</td></tr>`;
  }).join("");
  const 中 = `<h1>${X.E(sp.文字 ?? "?")} ${札(sp.動作 ?? "")} ${札(X.表.get(表ID)?.表示 ?? 表ID ?? "?")}</h1>
    <div class=sub>${X.E(p?.name ?? pid)} のボタン。現行は画面が受け取った 1 行（rootRowContainer / rowSelector）に対して押す。ここでは対象の表の最新 ${候補.length} 行から選ぶ</div>
    ${文言 ? `<div class=warn>${X.E(文言)}</div>` : ""}
    ${詳細.確認 ? `<div class=dlg><b>${X.E(詳細.確認.題 ?? "")}</b>\n${X.E(詳細.確認.本文 ?? "")}</div>` : ""}
    ${条件たち.length ? `<div class=cond>見せる条件: ${X.E(条件たち.map((c) => c.文 ?? JSON.stringify(c.条件)).join(" / "))}</div>` : ""}
    <div class=el><div class=elh>対象の行 <span class=tag>最新 ${候補.length} 件</span></div>
      <div class=scroll><table><thead><tr><th>行</th><th>この行では</th><th></th></tr></thead><tbody>${行 || `<tr><td colspan=3 class=note>手元に行がありません</td></tr>`}</tbody></table></div></div>
    <div style="margin-top:12px"><a href="/p/${X.E(pid)}">← ${X.E(p?.name ?? pid)}</a></div>`;
  return X.骨(`${sp.文字 ?? "?"}｜${p?.name ?? pid}`, 中, null);
}

/** 確認の画面。文言は定義（confirmationModal*）のまま */
function 確認の画面(pid, eid, x, 行, { 結果 = null } = {}) {
  const { sp, 詳細, p } = x;
  const 確認 = 詳細.確認 ?? { 題: sp.文字 ?? "", 本文: null, 進むボタン: sp.文字 ?? "実行" };
  const 中 = `<h1>${X.E(sp.文字 ?? "?")} ${札(sp.動作 ?? "")} ${札(X.表.get(行.tbl)?.表示 ?? 行.tbl)}</h1>
    <div class=sub>${X.E(p?.name ?? pid)} ・ 行 <code>${X.E(行の名(行))}</code> <span class=tag>${X.E(行.id)}</span></div>
    ${詳細.種類 === "updateRow" ? `<div class=note>書く: ${X.E((詳細.書く ?? []).map((w) => `${X.項目.get(w.項目)?.name ?? w.項目} ${w.振る舞い === "set" ? "=" : w.振る舞い} ${JSON.stringify(w.値)}`).join(", "))}</div>` : ""}
    ${詳細.種類 === "deleteRow" && !詳細.確認 ? `<div class=note>現行のこのボタンには確認文が無い（押した瞬間に消える）。ミミックでは GET で消さないので、ここで一度止める</div>` : ""}
    ${詳細.種類 === "deleteRow" && Object.keys(行.snap ?? {}).length ? `<div class=warn><b>Airtable から写した行です。</b>消すと正解の値（snap）と関連の辺もこの DB から消えます。write_log の before に行全体を残すので戻せますが、答え合わせの母数は減ります</div>` : ""}
    <div class=dlg style="border:2px solid #d93025;background:#fff4f4;padding:10px 12px">
      <b>${X.E(確認.題 ?? "")}</b>\n${X.E(確認.本文 ?? "")}
      <form method=post action="${X.E(押す道(pid, eid))}" style="margin-top:8px;display:flex;gap:10px;align-items:center">
        <input type=hidden name=row value="${X.E(行.id)}"><input type=hidden name=ok value="1">
        <button class=btn style="background:#d93025;color:#fff;border:0;cursor:pointer">${X.E(確認.進むボタン ?? "はい")}</button>
        <a href="${X.E(行の道(pid, 行.id))}" style="font-size:12px">やめる</a></form></div>
    ${結果 ?? ""}
    <div style="margin-top:12px"><a href="${X.E(行の道(pid, 行.id))}">← ${X.E(p?.name ?? pid)}</a></div>`;
  return X.骨(`${確認.題 ?? sp.文字 ?? "確認"}｜${p?.name ?? pid}`, 中, null);
}

/** 押した結果の画面 */
function 結果の画面(pid, eid, x, { 可, 文言 = [], 行ID = null, 行の名前 = "", 補足 = "" }) {
  const { sp, 詳細, p } = x;
  const 記録 = 行ID ? X.db.prepare("SELECT seq,at,action,origin FROM write_log WHERE row=? ORDER BY seq DESC LIMIT 3").all(行ID) : [];
  const 戻り = 詳細.種類 === "deleteRow" ? `/p/${pid}` : 行の道(pid, 行ID);
  const 中 = `<h1>${X.E(sp.文字 ?? "?")} ${札(sp.動作 ?? "")}</h1>
    <div class=sub>${X.E(p?.name ?? pid)}${行の名前 ? ` ・ 行 <code>${X.E(行の名前)}</code>` : ""}${行ID ? ` <span class=tag>${X.E(行ID)}</span>` : ""}</div>
    <div class=dlg style="border:2px solid ${可 ? "#0a7" : "#d93025"};background:${可 ? "#f2fbf7" : "#fff4f4"};padding:10px 12px">
      <b>${可 ? "実行しました" : "実行しませんでした"}</b>${文言.length ? `\n${X.E(文言.join("\n"))}` : ""}${補足 ? `\n${補足}` : ""}
      ${可 && 詳細.種類 === "updateRow" ? `\n${押した後(詳細, 色を引く(sp.色))}` : ""}</div>
    ${記録.length ? `<div class=el><div class=elh>write_log</div><div class=note>${記録.map((r) => `#${r.seq} ${X.E(r.at)} ${X.E(r.action)} ${X.E(r.origin ?? "")}`).join("<br>")}</div></div>` : ""}
    <div style="margin-top:12px"><a href="${X.E(戻り)}">← ${X.E(p?.name ?? pid)}</a></div>`;
  return X.骨(`${sp.文字 ?? "?"}｜${p?.name ?? pid}`, 中, null);
}

/**
 * GET /button/<画面>/<要素>[?row=rec…]
 *   行が要る動作で row が無い       → 行を選ぶ画面
 *   deleteRow                        → 確認の画面
 *   updateRow                        → 出ない行なら断る。確認ありなら確認の画面、無しでも GET では書かない（POST へ）
 *   navigateToRowUrl                 → 行の URL を決めて、開けるなら 302、開けないなら文字で出す
 *   navigate系・openForm・addForeignRow → 行き先へ 302
 */
function GETで押す(req, res, u, m) {
  const [, pid, eid] = m;
  const x = 要素を引く(pid, eid);
  if (!x) return ない(res, "その要素");
  const { e, sp, 詳細 } = x;
  if (!詳細) return X.出す(res, X.骨("定義なし", `<h1>定義に行き先がありません</h1><div class=note>node crawl/14-layout.mjs → node db/01-meta.mjs</div>`, null), 500);
  const 色 = 色を引く(sp.色);
  switch (詳細.種類) {
    case "navigateToSelectedPage": {
      const { 行ID, 行 } = 文脈の行(u, null);
      const 先 = X.db.prepare("SELECT id,tbl FROM page WHERE id=?").get(詳細.行き先の画面);
      if (!先) return ない(res, "行き先の画面");
      return 転送(res, 行の道(先.id, 行 && (!先.tbl || 先.tbl === 行.tbl) ? 行ID : null));
    }
    case "navigateToStaticUrl": {
      const 先 = URLの行き先(詳細.url ?? sp.url, { 行ID: u.searchParams.get("row"), pid });
      if (先.href) return 転送(res, 先.href);
      return X.出す(res, X.骨(sp.文字 ?? "宛先", `<h1>${X.E(sp.文字 ?? "")}</h1><div class=el>${箱(URLの行き先を描く(先, sp.文字 ?? "?", 色))}</div><div style="margin-top:12px"><a href="/p/${X.E(pid)}">← 戻る</a></div>`, null));
    }
    case "openFormModalDialog": {
      const fc = 純正フォーム.get(詳細.埋め込みフォーム?.画面);
      return fc ? 転送(res, `/form/${詳細.埋め込みフォーム.画面}/${fc.id}`) : ない(res, "そのフォーム");
    }
    case "addForeignRow": {
      const ctx = 文脈の行(u, 詳細.親の行?.表ID);
      if (!ctx.行 || ctx.合わない) return X.出す(res, 行を選ぶ画面(pid, eid, x, 詳細.親の行?.表ID, ctx.文言 ?? null));
      return 転送(res, `${押す道(pid, eid)}/form?row=${encodeURIComponent(ctx.行ID)}`);
    }
    case "navigateToRowUrl": case "deleteRow": case "updateRow": {
      const 表ID = 詳細.行の入力?.表ID ?? null;
      const ctx = 文脈の行(u, 表ID);
      if (!ctx.行 || ctx.合わない) return X.出す(res, 行を選ぶ画面(pid, eid, x, 表ID, ctx.文言 ?? null));
      const 条件たち = 見せる条件たち(e, 詳細);
      if (!出るか(ctx.行, 条件たち)) return X.出す(res, 行を選ぶ画面(pid, eid, x, 表ID, `行 ${行の名(ctx.行)} ではこのボタンは出ません（見せる条件: ${条件たち.map((c) => c.文 ?? JSON.stringify(c.条件)).join(" / ")}）`));
      if (詳細.種類 === "navigateToRowUrl") {
        const v = URL項目の値(ctx.行, 詳細.URLの項目);
        const 先 = URLの行き先(v.url, { 行ID: ctx.行ID });
        if (先.href) return 転送(res, 先.href);
        return X.出す(res, X.骨(sp.文字 ?? "宛先", `<h1>${X.E(sp.文字 ?? "")}</h1><div class=sub>行 ${X.E(行の名(ctx.行))}</div><div class=el>${箱(URLの行き先を描く(先, sp.文字 ?? "?", 色) + (v.注 ? `<div class=dlg>${X.E(v.注)}</div>` : ""))}</div><div style="margin-top:12px"><a href="${X.E(行の道(pid, ctx.行ID))}">← 戻る</a></div>`, null));
      }
      if (詳細.種類 === "updateRow" && 既に押した(ctx.行, 詳細)) return X.出す(res, 結果の画面(pid, eid, x, { 可: true, 行ID: ctx.行ID, 行の名前: 行の名(ctx.行), 文言: ["この行は既に押してあります（書く値が全部入っている）"] }));
      return X.出す(res, 確認の画面(pid, eid, x, ctx.行));
    }
    default:
      return X.出す(res, X.骨("未対応", `<h1>${X.E(詳細.種類 ?? "?")} はこの拡張の担当ではありません</h1><div class=note>triggerWorkflow は /do/${X.E(pid)}/${X.E(eid)} へ</div>`, null), 400);
  }
}

/**
 * POST /button/<画面>/<要素>  body: row=rec…&ok=1
 *   deleteRow  ok=1 で 文脈.書き込み.消す。無ければ確認の画面に戻す
 *   updateRow  見せる条件に合う行だけ。確認ありで ok 無しなら確認の画面。columnUpdateSet を 更新 で当てる
 *              updateBehavior は 6 件とも "set"。他の振る舞いは現行に実例が無いので**断る**（黙って書かない）
 */
async function POSTで押す(req, res, u, m) {
  const [, pid, eid] = m;
  const x = 要素を引く(pid, eid);
  if (!x) return ない(res, "その要素");
  const { e, sp, 詳細 } = x;
  if (!詳細) return ない(res, "その動作の定義");
  const 生 = await X.本文を読む(req);
  const 行ID = 生.row || null;
  const 出どころ = `画面 ${pid}/${eid} ${詳細.種類}`;
  if (!["deleteRow", "updateRow"].includes(詳細.種類)) return X.出す(res, 結果の画面(pid, eid, x, { 可: false, 文言: [`${詳細.種類} は POST で押すものではありません`] }), 400);
  const 表ID = 詳細.行の入力?.表ID ?? null;
  const ctx = 文脈の行(new URL(`http://x/?row=${encodeURIComponent(行ID ?? "")}`), 表ID);
  if (!ctx.行 || ctx.合わない) return X.出す(res, 結果の画面(pid, eid, x, { 可: false, 行ID, 文言: [ctx.文言 ?? "対象の行を指定してください"] }), 400);
  const 名前 = 行の名(ctx.行);
  const 条件たち = 見せる条件たち(e, 詳細);
  if (!出るか(ctx.行, 条件たち)) return X.出す(res, 結果の画面(pid, eid, x, { 可: false, 行ID, 行の名前: 名前, 文言: ["この行ではボタンが出ないので押せません（見せる条件に合わない）"] }), 400);
  const 確認が要る = 詳細.種類 === "deleteRow" ? true : !!詳細.確認?.有効;
  if (確認が要る && 生.ok !== "1") return X.出す(res, 確認の画面(pid, eid, x, ctx.行));

  if (詳細.種類 === "deleteRow") {
    const r = X.書き込み.消す(ctx.行ID, { 出どころ });
    const 可 = !(r.文言?.length);
    /** write_log は行IDで引けるので、消えた後も記録が読める */
    return X.出す(res, 結果の画面(pid, eid, x, { 可, 行ID: ctx.行ID, 行の名前: 名前, 文言: r.文言 ?? [], 補足: 可 ? `計算し直した行 ${r.再計算した行数}` : "" }), 可 ? 200 : 400);
  }
  /** updateRow */
  if (既に押した(ctx.行, 詳細)) return X.出す(res, 結果の画面(pid, eid, x, { 可: false, 行ID: ctx.行ID, 行の名前: 名前, 文言: ["既に押してあります（書く値が全部入っている）"] }));
  const 値 = {};
  for (const w of 詳細.書く ?? []) {
    if (w.振る舞い !== "set") return X.出す(res, 結果の画面(pid, eid, x, { 可: false, 行ID: ctx.行ID, 行の名前: 名前, 文言: [`updateBehavior「${w.振る舞い}」は現行に実例が無く意味を確かめていないので書きません`] }), 400);
    値[w.項目] = w.値;   // 値は Airtable の符号化のまま（checkbox は true、選択は選択肢ID）
  }
  if (詳細.続く動作) return X.出す(res, 結果の画面(pid, eid, x, { 可: false, 行ID: ctx.行ID, 行の名前: 名前, 文言: [`secondaryAction ${JSON.stringify(詳細.続く動作)} は未対応（6 件とも null のはず）`] }), 400);
  const r = X.書き込み.更新(ctx.行ID, 値, { 出どころ });
  const 可 = !(r.文言?.length);
  return X.出す(res, 結果の画面(pid, eid, x, { 可, 行ID: ctx.行ID, 行の名前: 名前, 文言: r.文言 ?? [], 補足: 可 ? `計算し直した行 ${r.再計算した行数}` : "" }), 可 ? 200 : 400);
}

/**
 * addForeignRow のフォーム。GET /button/<画面>/<要素>/form?row=<親の行>
 *
 * 純正フォーム（formContainer）を serve.mjs の フォームを描く で描く。フォームには親への関連項目の欄が無い
 * （入金登録の欄は 入金日・手数料・今回入金額 の 3 つ）ので、親は URL の ?row= で持ち回り、
 * 保存時にこちらで張る。**張るのは親側の関連項目（foreignColumnId。売掛台帳.fldMgvOGTsgLGc3JT）**で、
 * 売掛台帳の rollup 2 本（今回入金額・手数料）はこの関連を辿って集める。新しい行の側の逆側の項目
 * （販売/Table.fld7ImJlDZ4ZwyrZw）にも親を入れる。どちらも「逆にしない」関連で辺 0 なので、両側に書かないと片方から見えない。
 *
 * フォームを描く はクエリの既定値を受けないので（引数 値 で受ける）、送られた値の整え方は
 * serve.mjs の 値を整える と同じにする（number → Number、checkbox → 真偽、date → ISO）。
 */
function 親の注(詳細, 親, 追加 = "") {
  return `<div class=el><div class=note><b>親の行</b> ${X.E(X.表.get(親.tbl)?.表示 ?? 親.tbl)} <code>${X.E(行の名(親))}</code> <span class=tag>${X.E(親.id)}</span><br>
    保存すると親の <b>${X.E(X.項目.get(詳細.関連の項目)?.name ?? 詳細.関連の項目)}</b> にこの行が張られます（addForeignRow）${追加}</div></div>`;
}
function 子フォームを描く(pid, eid, x, 親, 状態 = {}, 追加 = "") {
  const { 詳細 } = x;
  const fp = 詳細.埋め込みフォーム?.画面, fc = 純正フォーム.get(fp);
  if (!fc) return null;
  let html = X.フォームを描く(fp, fc.id, 状態);
  if (!html) return null;
  /** フォームを描く は差し込み口を持たないので、form の直前に親の注を入れる（印は serve.mjs の固定文字列） */
  const 印 = "<form method=post class=el>";
  html = html.includes(印) ? html.replace(印, 親の注(詳細, 親, 追加) + 印) : html.replace("</h1>", `</h1>${親の注(詳細, 親, 追加)}`);
  /** 「画面に戻る」はフォームの画面ではなく押した画面へ */
  return html.replace(`href="/p/${fp}"`, `href="${行の道(pid, 親.id)}"`);
}
function 子の値を整える(生, 欄) {
  const out = {};
  for (const xx of 欄) {
    const f = X.項目.get(xx.fld);
    let v = 生[xx.fld];
    if (v === undefined || v === "") continue;
    if (f?.type === "number") v = Number(v);
    else if (f?.type === "checkbox") v = v === "on" || v === "true" || v === "1";
    else if (f?.type === "date" && /^\d{4}-\d{2}-\d{2}$/.test(v)) v = `${v}T00:00:00.000Z`;
    out[xx.fld] = v;
  }
  return out;
}
async function 子フォーム(req, res, u, m) {
  const [, pid, eid] = m;
  const x = 要素を引く(pid, eid);
  if (!x || x.詳細?.種類 !== "addForeignRow") return ない(res, "そのフォーム");
  const { 詳細 } = x;
  const ctx = 文脈の行(u, 詳細.親の行?.表ID);
  if (!ctx.行 || ctx.合わない) return X.出す(res, 行を選ぶ画面(pid, eid, x, 詳細.親の行?.表ID, ctx.文言 ?? "親の行を選んでください"));
  /** 見せる条件に合わない親（締済の売掛台帳）には GET も POST も断る。updateRow と同じ扱い */
  if (!出るか(ctx.行, 見せる条件たち(x.e, 詳細))) return X.出す(res, 行を選ぶ画面(pid, eid, x, 詳細.親の行?.表ID, `行 ${行の名(ctx.行)} ではこのボタンは出ません（見せる条件に合わない）`), 400);
  const fp = 詳細.埋め込みフォーム?.画面, fc = 純正フォーム.get(fp);
  if (!fc) return ない(res, "そのフォーム");
  if (req.method === "GET") { const h = 子フォームを描く(pid, eid, x, ctx.行); return h ? X.出す(res, h) : ない(res, "そのフォーム"); }

  const 生 = await X.本文を読む(req);
  const 欄 = X.db.prepare("SELECT id,fld,read_only,spec FROM elem WHERE page=? AND type='cellEditor'").all(fp)
    .filter((y) => JSON.parse(y.spec ?? "{}").行の出どころ === fc.sp.出力 && !y.read_only);
  const 値 = 子の値を整える(生, 欄);
  const 表ID = 詳細.表ID ?? fc.sp.作る表ID;
  const 出どころ = `画面 ${pid}/${eid} addForeignRow`;
  const 関連 = X.項目.get(詳細.関連の項目);
  const 逆側 = 関連?.opts?.逆側の項目 ?? null;
  const 親の形 = [{ foreignRowId: ctx.行.id, foreignRowDisplayName: 行の名(ctx.行) }];
  if (逆側 && X.項目.get(逆側)?.tbl === 表ID) 値[逆側] = 親の形;
  const r = X.書き込み.作る(表ID, 値, { 出どころ, 既定: fc.sp.既定値 ?? null, フォーム: `native:${fp}|${fc.id}` });
  if (!r.行ID) return X.出す(res, 子フォームを描く(pid, eid, x, ctx.行, { 値: 生, 文言: r.文言 }) ?? "", 400);

  /** 親側の関連項目に足す（置き換えない）。手元の値（cells→calc→snap→implied）に無い分は増やせない */
  const 今 = X.書き込み.計算器.値(ctx.行, 詳細.関連の項目, true);
  const 既存 = Array.isArray(今) ? 今.filter((y) => y?.foreignRowId && y.foreignRowId !== r.行ID) : [];
  const 新 = X.書き込み.計算器.取る(r.行ID);
  const r2 = X.書き込み.更新(ctx.行.id, { [詳細.関連の項目]: [...既存, { foreignRowId: r.行ID, foreignRowDisplayName: 行の名(新) }] }, { 出どころ });
  const 追加 = r2.文言?.length ? `<br><b style="color:#a00">親に張れませんでした: ${X.E(r2.文言.join(" / "))}</b>`
    : `<br>親に張りました（親と、親を集めている行 ${r2.再計算した行数} 行を計算し直し）`;
  return X.出す(res, 子フォームを描く(pid, eid, x, X.書き込み.計算器.取る(ctx.行.id), { 成功: r }, 追加) ?? "");
}

/** onrender の置き換え（到達度の根拠。db/15-coverage.mjs が読む） */
export const 置き換え = { onrender: "/print/<pag>: 同じ画面を印刷用に描き、ブラウザの印刷で PDF にする" };

export const 経路 = [
  /** 印刷用: 画面をそのまま描き、印刷用の様式と自動の印刷ダイアログを足す */
  { method: "GET", pattern: /^\/print\/(pag[A-Za-z0-9]+)$/, handler: (req, res, u, m) => {
      const h = X.画面を描く(m[1], u);
      if (!h) return ない(res, "その画面");
      const 印刷 = `<style media=print>a[href]{color:inherit;text-decoration:none}.btn,form,.cond,.dlg{display:none!important}</style><script>addEventListener("load",()=>setTimeout(()=>print(),300))</script>`;
      return X.出す(res, h.includes("</head>") ? h.replace("</head>", 印刷 + "</head>") : 印刷 + h);
    } },
  { method: "GET", pattern: /^\/button\/(pag[A-Za-z0-9]+)\/(pel[A-Za-z0-9]+)$/, handler: (req, res, u, m) => GETで押す(req, res, u, m) },
  { method: "POST", pattern: /^\/button\/(pag[A-Za-z0-9]+)\/(pel[A-Za-z0-9]+)$/, handler: (req, res, u, m) => POSTで押す(req, res, u, m) },
  { pattern: /^\/button\/(pag[A-Za-z0-9]+)\/(pel[A-Za-z0-9]+)\/form$/, handler: (req, res, u, m) => 子フォーム(req, res, u, m) },
];
