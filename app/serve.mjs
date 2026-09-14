#!/usr/bin/env node
/**
 * ミミックの画面を出す。**ローカルDBだけを読む。外へは一切つながない。**
 *
 *   node app/serve.mjs            http://localhost:8787
 *   node app/serve.mjs --port 9000
 *
 * ■ 画面は作り込まない。メタモデルから描く
 *
 * 画面ごとにコードを書くと131画面ぶんの作り込みになり、
 * 現行が画面を1つ足すたびに追随できない。だから
 * **DBに入れた定義（page / elem / fld / viw）から描く。**
 *
 *   page                画面（335件、うちレイアウトあり156件）
 *   elem                要素（2,359件、21種）
 *   elem.spec           種類ごとの設定（見せる列・列幅・確認ダイアログ・母集団…）
 *   elem.visible_when   親から継承した見せる条件
 *
 * ■ 値は検証済みの2つのエンジンを通す
 *
 *   db/query.mjs    画面のクエリ。116本中113本が Airtable の行集合と完全一致
 *   db/formula.mjs  計算項目。30項目・274,971値で Airtable の計算値と100%一致
 *
 * ■ 外へつながない
 *
 * 現行の画面には外部へ飛ぶボタンが多い（miniExtensions 33件・Make 2件・
 * onrender 2件）。**Make の webhook は GET した瞬間に本番の締め処理が走る。**
 * だからこの画面では外部のURLはリンクにせず、宛先を文字として出すだけにする。
 */
import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import { open, ROOT } from "../db/open.mjs";
import { 作る } from "../db/query.mjs";
import { 書き込み器を作る, 書いた後 } from "../db/write.mjs";
import { 動作器を作る } from "../db/actions.mjs";
import { 書く, 右寄せか, 色, ボタンの色 } from "./format.mjs";
import { 帳票の種類, 発注書を組む } from "./doc.mjs";

const PORT = Number(process.argv[process.argv.indexOf("--port") + 1]) || Number(process.env.PORT) || 8787;
const db = open();
const 実行 = 作る(db);
const 書き込み = 書き込み器を作る(db);
/**
 * **ボタンを押したときに走る処理。** `db/actions.mjs` が中身を持つ。
 * 外へは一切つながない。Make の webhook は**宛先を文字で出すだけ**にする。
 */
const 動作 = 動作器を作る(db);
/**
 * クエリエンジンは起動時に全行を読み込む（10 秒・900MB）ので、書いた後は触った行だけ差し替える。
 * 動作器は自分の書き込み器を持つので、器ごとではなく write.mjs 全体の購読（書いた後）で受ける。
 * これが無いと、作った行が一覧に出ず、消した行が一覧に残る。
 */
書いた後(({ 行たち }) => 実行.読み直す(行たち));

/** ─── 定義を読み込む ─── */
const 項目 = new Map();
for (const f of db.prepare("SELECT id,tbl,name,type,opts,is_computed FROM fld").all())
  項目.set(f.id, { ...f, opts: f.opts ? JSON.parse(f.opts) : {} });
const 表 = new Map(db.prepare("SELECT t.id,b.tab,t.name FROM tbl t JOIN base b ON b.id=t.base").all()
  .map((r) => [r.id, { tab: r.tab, name: r.name, 表示: `${r.tab}/${r.name}` }]));
const 表を名前で = new Map();
for (const [id, t] of 表) 表を名前で.set(t.表示, id);

const E = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));

/** ─── 外へ出さない ─── */
const 外部か = (u) => /^https?:\/\//i.test(String(u ?? ""));
const 引き金か = (u) => /hook[^/]*\.(make|integromat)\.com|onrender\.com/i.test(String(u ?? ""));

/** ─── ひな型 ─── */
/** 画面の様式。demo の app/globals.css の :root と components/Shell.tsx・Sidebar.tsx・DataGrid.tsx に合わせる */
const 様式 = `
:root{
  --page:#f4f4f1; --surface:#ffffff; --surface-2:#fcfcfb;
  --ink:#17181a; --ink-2:#52514e; --muted:#898781;
  --grid:#ebeae4; --baseline:#d7d6cf; --sel:#eef4fd; --chip:#f2f1ee;
  --border:rgba(17,18,20,0.08); --border-strong:rgba(17,18,20,0.12);
  --s-sales:#2a78d6; --s-cost:#eb6834; --s-profit:#1e8f4e;
  --good:#006300; --bad:#c0392b;
  --side:#1f2733; --side-ink:#cdd3dc; --side-muted:#8a93a1;
  --side-active-bg:rgba(0,0,0,0.38); --side-active-ink:#ffffff; --side-accent:#5b9bef;
}
*{box-sizing:border-box}
html,body{padding:0;margin:0}
body{background:var(--page);color:var(--ink);
  font:13px/1.5 "Hiragino Kaku Gothic ProN","Hiragino Sans","Yu Gothic Medium","Yu Gothic",Meiryo,"Noto Sans JP",system-ui,-apple-system,"Segoe UI",sans-serif;
  -webkit-font-smoothing:antialiased;text-rendering:optimizeLegibility;font-feature-settings:"palt" 1}
body.bare{background:var(--page);padding:28px 32px 64px;max-width:900px;margin:0 auto}
body.bare h1{margin-bottom:10px}
.wrap{display:flex;min-height:100vh}

/* ─── 左の濃いサイドバー（demo の Sidebar.tsx: ブランド → ベース切替 → 折りたたみ群） ─── */
aside{width:236px;flex:0 0 236px;background:var(--side);color:var(--side-ink);height:100vh;position:sticky;top:0;overflow-y:auto;display:flex;flex-direction:column}
.brand{display:flex;align-items:center;gap:8px;height:56px;padding:0 20px;flex-shrink:0}
.brand .mark{width:26px;height:26px;border-radius:6px;background:var(--side-accent);color:#fff;font-weight:700;font-size:13px;display:grid;place-items:center}
.brand .name{font-size:14px;font-weight:600;letter-spacing:.02em;color:#fff}
.bases{display:grid;grid-template-columns:1fr 1fr;gap:4px;margin:0 12px 8px;padding:4px;border-radius:10px;background:rgba(255,255,255,.06);flex-shrink:0}
a.base{display:block;text-align:center;padding:6px 4px;border-radius:6px;font-size:12px;color:var(--side-muted);text-decoration:none}
a.base:hover{color:var(--side-ink)}
a.base.on{background:var(--side-accent);color:#fff;font-weight:600}
nav{padding:0 8px 16px;flex:1}
details.grp{margin-bottom:2px}
details.grp>summary{list-style:none;cursor:pointer;display:flex;align-items:center;gap:8px;padding:7px 12px;border-radius:6px;font-size:12.5px;color:var(--side-ink)}
details.grp>summary::-webkit-details-marker{display:none}
details.grp>summary::before{content:"▸";font-size:9px;color:var(--side-muted);transition:transform .12s}
details.grp[open]>summary::before{transform:rotate(90deg)}
details.grp>summary:hover{background:rgba(255,255,255,.06)}
details.grp>a.nav{margin-left:11px;padding-left:12px;border-left:1px solid rgba(255,255,255,.12)}
.grph{padding:12px 12px 4px;font-size:10.5px;color:var(--side-muted);letter-spacing:.04em}
a.nav{display:flex;align-items:center;gap:8px;border-radius:6px;padding:7px 12px;margin-bottom:1px;color:var(--side-ink);text-decoration:none;font-size:12.5px;line-height:1.3;transition:background .12s,color .12s}
a.nav .t{flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
a.nav .n,details.grp>summary .n{font-size:10px;color:var(--side-muted);font-variant-numeric:tabular-nums}
a.nav:hover{background:rgba(255,255,255,.06)}
a.nav.on{background:var(--side-active-bg);color:var(--side-active-ink);font-weight:600}
a.nav.no{color:var(--side-muted)}
.x{font-size:10px;color:#ff9b91}

/* ─── 右。上に画面名の帯（demo の PageHeader.tsx）、その下が中身 ─── */
main{flex:1;min-width:0;display:flex;flex-direction:column}
.crumb{position:sticky;top:0;z-index:30;min-height:56px;flex-shrink:0;display:flex;align-items:center;gap:0;padding:8px 32px;
  font-size:13px;color:var(--muted);background:var(--surface);border-bottom:1px solid var(--border);flex-wrap:wrap}
.crumb .sep{margin:0 8px;color:var(--baseline)}
.crumb .up{color:var(--muted)}
.crumb .here{font-size:17px;font-weight:700;letter-spacing:-.01em;color:var(--ink)}
.crumb .here .tag{font-size:11px;font-weight:400;vertical-align:middle}
.body{flex:1;padding:24px 32px 64px}
h1{font-size:17px;font-weight:700;letter-spacing:-.01em;color:var(--ink);margin:0 0 6px}
.sub{color:var(--muted);font-size:12.5px;margin-bottom:16px}

/* ─── 箱・表・欄 ─── */
.el{background:var(--surface);border:1px solid var(--border);border-radius:10px;margin:0 0 16px;overflow:hidden}
.el .el{margin-bottom:12px}
.elh{padding:10px 14px;border-bottom:1px solid var(--border);font-weight:600;font-size:12.5px;color:var(--ink);display:flex;gap:10px;align-items:center;flex-wrap:wrap}
.tag{font-size:11px;color:var(--ink-2);background:var(--chip);border-radius:999px;padding:2px 8px;font-weight:400;white-space:nowrap}
.scroll{overflow-x:auto}
.scroll::-webkit-scrollbar{height:8px}
.scroll::-webkit-scrollbar-thumb{background:var(--baseline);border-radius:8px}
.scroll::-webkit-scrollbar-track{background:transparent}
table{border-collapse:collapse;width:max-content;min-width:100%;font-size:13px}
th,td{padding:8px 12px;text-align:left;white-space:nowrap;max-width:380px;overflow:hidden;text-overflow:ellipsis}
th{background:var(--surface);font-weight:500;font-size:11px;color:var(--muted);position:sticky;top:0;border-bottom:1px solid var(--baseline)}
td{padding:9px 12px;border-top:1px solid var(--grid);font-variant-numeric:tabular-nums}
td.r,th.r{text-align:right;font-variant-numeric:tabular-nums}
tr:hover td{background:var(--sel)}
.cells{display:grid;grid-template-columns:200px 1fr;gap:0}
.cells>div{padding:8px 14px;border-bottom:1px solid var(--grid)}
.cells .k{color:var(--muted);font-size:12px;background:var(--surface-2)}
.ro{color:var(--muted)}
.btn{display:inline-block;padding:6px 12px;border-radius:8px;font-size:12px;font-weight:600;border:1px solid var(--border);line-height:1.2}
/* 画面のボタン。demo の PageHeader の actions（暗い主ボタン 32px と枠つきの副ボタン） */
.acts{display:flex;gap:8px;align-items:center;flex-wrap:wrap}
.acts.page{margin-left:auto}
.acts .btn{height:32px;display:inline-flex;align-items:center;gap:6px;padding:0 14px;border-radius:6px;font-size:12.5px;font-weight:500;text-decoration:none}
.acts .btn.primary{background:#1a1a1c;color:#fff;border:0}
.acts .btn.primary::after{content:"›";font-size:12px;opacity:.75}
.acts .btn.primary:hover{opacity:.9}
.acts .btn.ghost{background:transparent;color:var(--ink-2);border:1px solid var(--border-strong)}
.acts form{display:inline}
.acts form .btn{cursor:pointer}
/* 定義の折りたたみ。画面に出ていた説明はここに全部入れる（消さない） */
details.defs{border-top:1px solid var(--grid);background:var(--surface-2)}
details.defs>summary{list-style:none;cursor:pointer;padding:8px 14px;font-size:11.5px;color:var(--muted);display:flex;gap:8px;align-items:center}
details.defs>summary::-webkit-details-marker{display:none}
details.defs>summary::before{content:"▸";font-size:9px}
details.defs[open]>summary::before{content:"▾"}
details.defs .def{padding:8px 14px;border-top:1px solid var(--grid);font-size:12px}
details.defs .def b{margin-right:6px}
.dlg{font-size:11.5px;color:var(--muted);margin-top:4px;white-space:pre-wrap}
.cond{font-size:11px;color:#8a6d00;background:#fdf6e3;border:1px solid rgba(138,109,0,.18);border-radius:999px;padding:2px 8px;display:inline-block;margin-top:4px}
.note{font-size:11.5px;color:var(--muted);padding:8px 14px}
.warn{background:#fdf3f2;border:1px solid rgba(192,57,43,.22);color:var(--bad);padding:10px 14px;border-radius:8px;font-size:12px;margin-bottom:12px}
.chip{display:inline-block;border-radius:999px;padding:2px 8px;font-size:11.5px}
.tnum{font-variant-numeric:tabular-nums}
a{color:#1a56db}
footer{padding:14px 0 0;color:var(--muted);font-size:11.5px;border-top:1px solid var(--border);margin-top:24px}

/* ─── 一覧の操作（app/ui.js が取り付ける。demo の DataGrid に寄せる） ─── */
.col-resizer{position:absolute;top:0;right:0;width:7px;height:100%;cursor:col-resize;user-select:none;touch-action:none}
.col-resizer:hover::after,.col-resizer:active::after{content:"";position:absolute;top:0;right:2px;width:2px;height:100%;background:var(--side-accent)}
td.stick1,th.stick1{position:sticky;left:0;z-index:2;background:var(--surface)}
th.stick1{z-index:3}
tr:hover td.stick1{background:var(--sel)}
td.stick1::after,th.stick1::after{content:"";position:absolute;top:0;right:-1px;width:1px;height:100%;background:var(--grid)}
html[data-rowheight="短い"] td,table[data-rowheight="短い"] td{padding-top:4px;padding-bottom:4px}
html[data-rowheight="高い"] td,table[data-rowheight="高い"] td{padding-top:14px;padding-bottom:14px}
.rowheight{margin-left:auto;display:flex;align-items:center;gap:4px;font-size:11.5px;color:var(--muted)}
.rowheight .lab{margin-right:2px}
.rowheight button{font:inherit;font-size:11.5px;color:var(--ink-2);background:var(--chip);border:1px solid transparent;border-radius:999px;padding:2px 9px;cursor:pointer}
.rowheight button.on{background:var(--surface);border-color:var(--border-strong);color:var(--ink);font-weight:600}
.ops{border-bottom:1px solid var(--border);background:var(--surface-2)}
.ops>summary{list-style:none;cursor:pointer;padding:8px 14px;font-size:12px;color:var(--ink-2);display:flex;gap:8px;align-items:center;flex-wrap:wrap}
.ops>summary::-webkit-details-marker{display:none}
.ops>summary::after{content:"▾";color:var(--muted);font-size:10px}
.ops[open]>summary::after{content:"▴"}
.fchip{display:inline-flex;align-items:center;gap:6px;background:var(--chip);border:1px solid var(--border);border-radius:999px;padding:3px 4px 3px 10px;font-size:11.5px;color:var(--ink-2);white-space:nowrap}
.fchip b{font-weight:600;color:var(--ink)}
.fchip .rm{display:grid;place-items:center;width:16px;height:16px;border-radius:999px;color:var(--muted);text-decoration:none;font-size:11px}
.fchip .rm:hover{background:var(--baseline);color:var(--ink)}
.ops input[type=text],.ops input:not([type]),.ops select{font:inherit;font-size:12px;padding:4px 9px;border:1px solid var(--border-strong);border-radius:8px;background:var(--surface);color:var(--ink)}
.pager{display:flex;gap:12px;align-items:center;padding:8px 14px;font-size:12px;color:var(--muted);border-top:1px solid var(--grid)}
`;

function 骨(題, 中, 現在, { 枠なし = false } = {}) {
  /** 帳票やフォームは現行SM・demo と同じく枠なし（サイドバーもパンくずも出さない） */
  if (枠なし) return `<!doctype html><html lang=ja><head><meta charset=utf-8>
<meta name=viewport content="width=device-width,initial-scale=1">
<title>${E(題)} — TTCF</title><style>${様式}</style></head><body class=bare>${中}<script src="/ui.js"></script></body></html>`;

  /**
   * サイドバー。demo の components/Sidebar.tsx と同じ作り（ベース切替 → 束の折りたたみ群）。
   * 中身は手元の定義から出す: base 4 タブ・bundle 8 束・page.in_nav 112 画面。
   */
  const ベースたち = db.prepare("SELECT id,tab,name FROM base ORDER BY rowid").all();
  const 今の画面 = 現在 && /^pag/.test(現在) ? db.prepare("SELECT id,tab,bundle FROM page WHERE id=?").get(現在) : null;
  const 今のタブ = 見せるタブ ?? 今の画面?.tab ?? "販売";
  const 今のベース = ベースたち.find((b) => b.tab === 今のタブ) ?? ベースたち[0];
  const 切替 = ベースたち.map((b) => `<a class="base${b.tab === 今のベース.tab ? " on" : ""}" href="${E(現在 && /^pag/.test(現在) ? `/p/${現在}?base=${encodeURIComponent(b.tab)}` : `/?base=${encodeURIComponent(b.tab)}`)}">${E(b.tab)}</a>`).join("");

  /** 束ごとの折りたたみ。今いる画面を含む束だけ開く（demo も現在地の群だけ開く） */
  const 行数 = db.prepare("SELECT count(*) c FROM row WHERE tbl=?");
  const 群 = db.prepare("SELECT id,name FROM bundle WHERE base=? ORDER BY ord").all(今のベース.id).map((b) => {
    const ps = db.prepare("SELECT id,name,tbl,has_layout FROM page WHERE bundle=? AND in_nav=1 ORDER BY ord").all(b.id);
    if (!ps.length) return "";
    const 開く = 今の画面?.bundle === b.id || 群の数(今のベース.id) === 1;
    return `<details class=grp${開く ? " open" : ""}><summary>${E(b.name)}<span class=n>${ps.length}</span></summary>` +
      ps.map((p) => {
        const n = p.tbl ? 行数.get(p.tbl)?.c ?? 0 : 0;
        return `<a class="nav${p.id === 現在 ? " on" : ""}${p.has_layout ? "" : " no"}" href="/p/${p.id}${見せるタブ ? `?base=${encodeURIComponent(今のタブ)}` : ""}">
          <span class=t>${E(p.name)}</span>${p.has_layout ? (n ? `<span class=n>${n.toLocaleString()}</span>` : "") : '<span class=x>未取得</span>'}</a>`;
      }).join("") + `</details>`;
  }).join("");

  const 横断 = [["/", "概要"], ["/forms", "入力（フォーム）"], ["/actions", "動作"], ["/gates", "門"], ["/docs", "帳票"], ["/fbtn", "項目型ボタン"]]
    .map(([h, t]) => `<a class="nav${現在 === h ? " on" : ""}" href="${h}"><span class=t>${E(t)}</span></a>`).join("");

  /**
   * 画面名は上の帯の中に太字で出す（demo の components/PageHeader.tsx）。
   * 描き手はどれも先頭に <h1> を出すので、ここで取り出して本文からは外す。
   */
  let 本文 = 中, 見出し = 題, 操作 = "";
  const m = /^\s*<h1[^>]*>([\s\S]*?)<\/h1>/.exec(中);
  if (m) { 見出し = m[1]; 本文 = 中.slice(m[0].length); }
  /** 画面ごとのボタン（<div class="acts page">）は帯の右端へ。demo の PageHeader の actions と同じ置き場 */
  本文 = 本文.replace(/<div class="acts page">([\s\S]*?)<\/div>/g, (_, x) => { 操作 += x; return ""; });
  const 道 = ["TTCF", 今の画面?.tab].filter(Boolean);
  const 粉 = 道.map((c) => `<span class=up>${E(c)}</span><span class=sep>›</span>`).join("");

  return `<!doctype html><html lang=ja><head><meta charset=utf-8>
<meta name=viewport content="width=device-width,initial-scale=1">
<title>${E(題)} — TTCF</title><style>${様式}</style></head><body><div class=wrap>
<aside>
<div class=brand><div class=mark>T</div><div class=name>TTCフーズ</div></div>
<div class=bases>${切替}</div>
<nav>${群}<div class=grph>横断</div>${横断}</nav>
</aside>
<main><div class=crumb>${粉}<span class=here>${見出し}</span>${操作 ? `<div class="acts page">${操作}</div>` : ""}</div><div class=body>${本文}<footer>ローカルDBのみを読んでいます。外部への通信はありません。</footer></div></main>
</div><script src="/ui.js"></script></body></html>`;
}
/** その base の束の数（1 つしか無いベースは開いたままにする） */
const 群の数 = (baseId) => db.prepare("SELECT count(*) c FROM bundle WHERE base=?").get(baseId).c;

/** ─── 一覧（levels / grid）─── */
/** ─── 一覧の操作（絞り込み・並べ替え・検索・CSV書き出し・頁送り）─── */

/**
 * **Airtable の Interface で利用者ができることを、定義から作る。**
 *
 * 現行では `queryContainer.endUserControls` が
 * `{isFilterEnabled, isSortEnabled, isSearchEnabled}` を持ち、
 * `presetFilters` が絞り込み棒に出ている列、`isCsvExportEnabled` が書き出しの可否である。
 *
 * 器（queryContainer）と一覧（levels / grid）は**別の canvasArea に置かれていて
 * 親子になっていない**ので、経路からは辿れない。同じ画面の器のうち
 * **表が一致するもの**を採り、1つしか無ければそれを採る（13画面だけ器が複数）。
 */
function 器を探す(pid, 表ID, spec = null) {
  const 器 = db.prepare("SELECT id,spec FROM elem WHERE page=? AND type='queryContainer'").all(pid)
    .map((r) => ({ id: r.id, sp: JSON.parse(r.spec ?? "{}") }));
  /**
   * 一覧の 段のクエリ.1.source.query.outputId と器の 出力 "query=peo…" が対応する（177 本のうち 156 が DB だけで結べる）。
   * 表の一致で結ぶと、同じ表の器が複数ある 13 画面で取り違える。まず出力IDで結び、無ければ表で結ぶ。
   */
  const 出力 = spec?.段のクエリ?.["1"]?.source?.query?.outputId ?? null;
  if (出力) {
    const 合う出力 = 器.find((x) => (Array.isArray(x.sp.出力) ? x.sp.出力 : [x.sp.出力]).some((o) => o && String(o).replace(/^[A-Za-z]+=/, "") === 出力));
    if (合う出力) return 合う出力;
  }
  if (!器.length) return null;
  const 合う = 器.find((x) => (x.sp.元?.tableId ?? x.sp.元?.表ID) === 表ID);
  return 合う ?? (器.length === 1 ? 器[0] : null);
}

/** 使える比べ方。query.mjs が実装している節だけを出す（無いものを出すと嘘になる） */
const 比べ方 = [
  ["contains", "を含む"], ["doesNotContain", "を含まない"],
  ["=", "＝"], ["!=", "≠"],
  [">", "＞"], [">=", "≧"], ["<", "＜"], ["<=", "≦"],
  ["isEmpty", "が空"], ["isNotEmpty", "が空でない"],
  ["isAnyOf", "のいずれか（カンマ区切り）"], ["isNoneOf", "のいずれでもない（カンマ区切り）"],
];
const 比べ方の名 = new Map(比べ方);
/** 値を要らない節 */
const 値なしの節 = new Set(["isEmpty", "isNotEmpty"]);

/** URLから、その一覧に対する操作を読む。要素ごとに名前を分ける（1画面に複数の一覧がある） */
function 操作を読む(u, eid) {
  const g = (k) => u.searchParams.get(`${k}_${eid}`) ?? "";
  const 節 = [];
  for (let i = 1; i <= 3; i++) {
    const f = g(`f${i}`), o = g(`o${i}`), v = g(`v${i}`);
    if (!f || !o) continue;
    if (!値なしの節.has(o) && v === "") continue;
    節.push({ 項目: f, 節: o, 値: v });
  }
  const n = Number(g("n")) || 50;
  return {
    節, 並び: g("s") || null, 昇順: g("d") !== "desc", 検索: g("q"),
    頁: Math.max(1, Number(g("p")) || 1), 件数: Math.min(500, Math.max(10, n)),
    何かある: 節.length > 0 || !!g("s") || !!g("q") || (Number(g("p")) || 1) > 1,
  };
}

/** 利用者の条件を Airtable の形に直す。**検証済みのクエリエンジンをそのまま使う** */
function 利用者の絞り込み(操作, 元の絞り込み) {
  if (!操作.節.length) return 元の絞り込み ?? null;
  const 私 = { conjunction: "and", filterSet: 操作.節.map((x) => ({ columnId: x.項目, operator: x.節, value: 値なしの節.has(x.節) ? null : x.値 })) };
  if (!元の絞り込み?.filterSet?.length) return 私;
  return { conjunction: "and", filterSet: [元の絞り込み, 私] };
}

/** 検索。**見えている列の表示文字**に対して当てる（Airtable の検索と同じ考え方） */
function 検索で絞る(行たち, 列, 語, 値を引く) {
  if (!語) return 行たち;
  const 的 = String(語).toLowerCase();
  return 行たち.filter((rid) => {
    const v = 値を引く(rid);
    return 列.some((c) => String(書く(v[c], 項目.get(c)) ?? "").toLowerCase().includes(的));
  });
}

/** URLを組み直す（1つの値だけ差し替える） */
function 道を組む(pid, eid, u, 上書き) {
  const q = new URLSearchParams(u.searchParams);
  for (const [k, v] of Object.entries(上書き)) {
    const 鍵 = `${k}_${eid}`;
    if (v === null || v === "") q.delete(鍵); else q.set(鍵, String(v));
  }
  const s = q.toString();
  return `/p/${pid}${s ? "?" + s : ""}`;
}

/** 絞り込みの節を and で束ねる。空は飛ばす */
function 束ねる(...節) {
  const xs = 節.filter((f) => f && (f.filterSet?.length || f.columnId || f.sourceColumnId));
  if (!xs.length) return null;
  if (xs.length === 1) return xs[0];
  return { conjunction: "and", filterSet: xs };
}

/**
 * 一覧の行を求める。描画とCSVで同じ道を通す。
 *
 * ■ 器（queryContainer）の固定の絞り込みは一覧に掛かっている
 *
 * 一覧（levels/grid）の spec には leafLevel.filters しか無いが、現行では同じ画面の器の staticFilters が
 * 一覧の母集団を先に絞っている（売掛一覧 pagCuLzzkAl9xnIQx: 売上登録 = ✓ かつ 請求締日 が空。実測 18,981 行）。
 * 器は 器を探す（出力IDで結ぶ）で引き、その 固定の絞り込み を and で足す。
 *
 * ■ 入口 { 行集合, 追加 }
 *
 *   行集合  Set<行ID>。row 画面の子の一覧（器の source が foreignKey、45 器）と rowSelector 配下の一覧（26 本）は
 *           「親の行の関連先だけ」を出す。渡されたら結果をその集合に絞る
 *   追加    絞り込みの節の配列。and で足す（dashboard の鎖など）
 */
function 一覧の行(e, spec, pid, 操作, { 行集合 = null, 追加 = [] } = {}) {
  const 表ID = 表.has(e.tbl) ? e.tbl : (表を名前で.get(e.tbl) ?? e.tbl);
  const 列 = spec.見せる列 ?? spec.主項目なしの列 ?? [];
  if (!表ID || !表.has(表ID)) return { 表ID, 列, 行: [], 母数: 0, 絞った後: 0, 注記: "この表の行は手元にありません" };
  const 器 = 器を探す(pid, 表ID, spec);
  const 器の固定 = 器?.sp?.固定の絞り込み ?? null;
  const 元の絞り込み = 束ねる(spec.段の設定?.leafLevel?.filters ?? spec.絞り込み ?? null, 器の固定, ...追加);
  const 並び = 操作.並び ? [{ columnId: 操作.並び, ascending: 操作.昇順 }]
    : (spec.段の設定?.leafLevel?.sorts ?? spec.並び ?? []);
  const r0 = 実行({ source: { type: "table", tableId: 表ID }, sorts: 並び, filters: 利用者の絞り込み(操作, 元の絞り込み) });
  const r = 行集合 ? { ...r0, 行: r0.行.filter((x) => 行集合.has(x)) } : r0;
  const 値を引く = (rid) => {
    const x = db.prepare("SELECT cells,calc FROM row WHERE id=?").get(rid);
    if (!x) return {};
    return { ...JSON.parse(x.calc), ...JSON.parse(x.cells) };
  };
  const 絞った = 検索で絞る(r.行, 列, 操作.検索, 値を引く);
  return { 表ID, 列, 全部: 絞った, 行: 絞った.slice((操作.頁 - 1) * 操作.件数, 操作.頁 * 操作.件数),
    母数: r.母数, 絞った後: 絞った.length, 値を引く, 注記: "" };
}

/**
 * 一覧を描く。**絞り込み・並べ替え・検索・CSV書き出し・頁送りを付ける。**
 * 行の求め方は `一覧の行()` に寄せてあり、CSV書き出しと同じ道を通る。
 */
/**
 * Airtable が持っている一覧の行の高さ（実測 small 243・medium 121・xlarge 1・無し 18）を、
 * 画面の既定にする。利用者が変えたら app/ui.js が localStorage の値で上書きする（demo の RowHeightMenu と同じ）。
 */
const 行の高さの字 = (spec) => ({ small: "短い", medium: "中", large: "高い", xlarge: "高い" })[spec?.行の高さ] ?? "中";

/**
 * 当てている条件をチップで出す（demo の components/FilterChip.tsx）。× はその条件だけ外すリンク。
 * 拡張（30-detail）も同じ形を使うので 文脈 に入れてある。
 */
function 操作のチップ(pid, eid, u, 操作) {
  const 字 = (o) => 比べ方の名.get(o) ?? o;
  const 出 = [];
  操作.節.forEach((x, n) => {
    if (!x?.項目) return;
    const 消す = 道を組む(pid, eid, u, { [`f${n + 1}`]: null, [`o${n + 1}`]: null, [`v${n + 1}`]: null, p: null });
    出.push(`<span class=fchip><b>${E(項目.get(x.項目)?.name ?? x.項目)}</b> ${E(字(x.節))}${値なしの節.has(x.節) ? "" : ` ${E(x.値 ?? "")}`}<a class=rm href="${E(消す)}" title="この条件を外す">✕</a></span>`);
  });
  if (操作.検索) 出.push(`<span class=fchip><b>検索</b> ${E(操作.検索)}<a class=rm href="${E(道を組む(pid, eid, u, { q: null, p: null }))}" title="検索を外す">✕</a></span>`);
  if (操作.並び) 出.push(`<span class=fchip><b>並べ替え</b> ${E(項目.get(操作.並び)?.name ?? 操作.並び)} ${操作.昇順 ? "昇順" : "降順"}<a class=rm href="${E(道を組む(pid, eid, u, { s: null, d: null }))}" title="並べ替えを戻す">✕</a></span>`);
  return 出;
}

function 一覧を描く(e, spec, pid, u, 入口 = {}) {
  const 操作 = 操作を読む(u, e.id);
  const { 表ID, 列, 行, 全部, 母数, 絞った後, 値を引く, 注記 } = 一覧の行(e, spec, pid, 操作, 入口);
  const 器 = 器を探す(pid, 表ID, spec);
  const 許し = 器?.sp.利用者が操れるもの ?? null;
  const CSVできる = 器?.sp.CSV書き出し === true || 器?.sp.CSV === true;
  const 幅 = spec.列幅 ?? {};

  /** 絞り込み棒に出す列。現行は presetFilters の列。無ければ見せている列から選ばせる */
  const 棒の列 = (器?.sp.既定の絞り込み?.filterSet ?? []).map((x) => x.columnId).filter((c) => 項目.has(c));
  const 選べる列 = [...new Set([...棒の列, ...列])].filter((c) => 項目.has(c));

  const 選択肢 = (名, 今, xs, 空の字) =>
    `<select name="${E(名)}" style="max-width:190px">
      <option value="">${E(空の字)}</option>
      ${xs.map(([v, t]) => `<option value="${E(v)}"${String(今) === String(v) ? " selected" : ""}>${E(t)}</option>`).join("")}
    </select>`;

  const 節の行 = (i) => {
    const x = 操作.節[i - 1] ?? {};
    return `<div style="display:flex;gap:5px;align-items:center;margin-bottom:4px;flex-wrap:wrap">
      ${選択肢(`f${i}_${e.id}`, x.項目 ?? "", 選べる列.map((c) => [c, 項目.get(c)?.name ?? c]), "（項目）")}
      ${選択肢(`o${i}_${e.id}`, x.節 ?? "", 比べ方, "（比べ方）")}
      <input name="v${i}_${e.id}" value="${E(x.値 ?? "")}" placeholder="値" style="width:150px"></div>`;
  };

  const チップ = 操作のチップ(pid, e.id, u, 操作);

  /**
   * 操作の棒。**条件が無いときは畳んでおく**（demo は 1 行に収まっている）。
   * 中身は今までと同じ GET フォームなので、JS が無くても・畳んだままでも URL で動く。
   */
  const 操作の棒 = `
  <details class=ops${チップ.length ? " open" : ""}>
    <summary>${チップ.length ? チップ.join(" ") : `<span style="color:var(--muted)">絞り込み・並べ替え・検索</span>`}
      <span class=tag>${(絞った後 ?? 0).toLocaleString()} 行${母数 && 母数 !== 絞った後 ? `／全 ${母数.toLocaleString()}` : ""}</span></summary>
  <form method=get action="/p/${E(pid)}" style="padding:10px 14px;border-top:1px solid var(--grid)">
    ${[...u.searchParams].filter(([k]) => !k.endsWith(`_${e.id}`)).map(([k, v]) =>
      `<input type=hidden name="${E(k)}" value="${E(v)}">`).join("")}
    <div style="display:flex;gap:14px;flex-wrap:wrap;align-items:flex-start">
      <div>
        <div style="font-size:11px;color:var(--muted);margin-bottom:4px">絞り込み${許し && !許し.isFilterEnabled ? "（現行では利用者に開放していません）" : ""}</div>
        ${節の行(1)}${節の行(2)}${節の行(3)}
      </div>
      <div>
        <div style="font-size:11px;color:var(--muted);margin-bottom:4px">並べ替え${許し && !許し.isSortEnabled ? "（現行では非開放）" : ""}</div>
        <div style="display:flex;gap:5px;align-items:center">
          ${選択肢(`s_${e.id}`, 操作.並び ?? "", 選べる列.map((c) => [c, 項目.get(c)?.name ?? c]), "（画面の既定）")}
          ${選択肢(`d_${e.id}`, 操作.昇順 ? "asc" : "desc", [["asc", "昇順"], ["desc", "降順"]], "昇順")}
        </div>
      </div>
      <div>
        <div style="font-size:11px;color:var(--muted);margin-bottom:4px">検索${許し && !許し.isSearchEnabled ? "（現行では非開放）" : ""}</div>
        <input name="q_${E(e.id)}" value="${E(操作.検索)}" placeholder="見えている列を探す" style="width:170px">
      </div>
      <div>
        <div style="font-size:11px;color:var(--muted);margin-bottom:4px">1頁の件数</div>
        ${選択肢(`n_${e.id}`, 操作.件数, [[25, "25"], [50, "50"], [100, "100"], [200, "200"], [500, "500"]], "50")}
      </div>
      <div style="align-self:flex-end;display:flex;gap:6px">
        <button class=btn style="background:var(--side-accent);color:#fff;border:0;cursor:pointer" type=submit>当てる</button>
        ${操作.何かある ? `<a class=btn style="background:var(--chip);color:var(--ink-2);text-decoration:none" href="/p/${E(pid)}">外す</a>` : ""}
        <a class=btn style="background:var(--chip);color:var(--ink-2);text-decoration:none"
          href="/csv/${E(pid)}/${E(e.id)}${u.search}">CSV${CSVできる ? "" : "（現行では非開放）"}</a>
      </div>
    </div>
  </form></details>`;

  /** 見出しは押すと並べ替わる */
  const 見出し = 列.map((c) => {
    const f = 項目.get(c);
    const w = 幅[c] ? ` style="min-width:${Math.round(幅[c] / 1.51)}px"` : "";
    const 今か = 操作.並び === c;
    const 次 = 今か && 操作.昇順 ? "desc" : "asc";
    return `<th class="${右寄せか(f) ? "r" : ""}"${w}>
      <a href="${E(道を組む(pid, e.id, u, { s: c, d: 次, p: null }))}"
        style="color:inherit;text-decoration:none">${E(f?.name ?? c)}${今か ? (操作.昇順 ? " ▲" : " ▼") : ""}</a></th>`;
  }).join("");

  const 本体 = 行.map((rid) => {
    const v = 値を引く ? 値を引く(rid) : {};
    return "<tr>" + 列.map((c) => {
      const f = 項目.get(c);
      return `<td class="${右寄せか(f) ? "r" : ""}">${E(書く(v[c], f))}</td>`;
    }).join("") + "</tr>";
  }).join("");

  const 最後の頁 = Math.max(1, Math.ceil((絞った後 ?? 0) / 操作.件数));
  const 頁送り = 最後の頁 <= 1 ? "" : `<div style="padding:8px 12px;display:flex;gap:8px;align-items:center;font-size:12px">
    ${操作.頁 > 1 ? `<a href="${E(道を組む(pid, e.id, u, { p: 操作.頁 - 1 }))}">← 前</a>` : '<span style="color:#bbb">← 前</span>'}
    <span>${操作.頁} / ${最後の頁} 頁</span>
    ${操作.頁 < 最後の頁 ? `<a href="${E(道を組む(pid, e.id, u, { p: 操作.頁 + 1 }))}">次 →</a>` : '<span style="color:#bbb">次 →</span>'}
    <span style="color:#6b6f76">（${((操作.頁 - 1) * 操作.件数 + 1).toLocaleString()}〜${Math.min(操作.頁 * 操作.件数, 絞った後).toLocaleString()} 件目）</span></div>`;

  const 編集 = spec.編集できるか?.canUpdateAllVisibleCells;
  /** 見出しは表名と行数だけ（demo の一覧は画面名だけ）。要素型・列数・編集可否・行の高さは折りたたみへ */
  const 一覧の定義 = `<details class=defs><summary>この一覧の定義</summary><div class=def>
    <span class=tag>${e.type}</span>
    <span class=tag>${列.length}列</span>
    ${編集 ? '<span class=tag>編集できる</span>' : '<span class=tag>読み取り専用</span>'}
    ${spec.行の高さ ? `<span class=tag>行の高さ ${spec.行の高さ}（Airtable の設定）</span>` : ""}
    ${器 ? `<span class=tag>器 ${E(器.id)}</span>` : ""}
    ${表ID ? `<span class=tag>表 ${E(表ID)}</span>` : ""}
  </div></details>`;
  return `<div class=el><div class=elh>${E(表.get(表ID)?.表示 ?? e.tbl ?? "?")}
    <span class=tag>${(絞った後 ?? 0).toLocaleString()}行${絞った後 !== 母数 ? `（全${母数.toLocaleString()}件から絞り込み）` : ""}</span></div>
    ${操作の棒}
    ${注記 ? `<div class=note>${E(注記)}</div>` : ""}
    <div class=scroll><table data-rowheight="${E(行の高さの字(spec))}"><thead><tr>${見出し}</tr></thead><tbody>${本体}</tbody></table></div>
    ${頁送り}${一覧の定義}</div>`;
}

/** CSV書き出し。**画面で見えているとおりの文字**を出す（表示形を揃える） */
function 一覧のCSV(pid, eid, u) {
  const e = db.prepare("SELECT * FROM elem WHERE page=? AND id=?").get(pid, eid);
  if (!e || !["levels", "grid"].includes(e.type)) return null;
  const spec = e.spec ? JSON.parse(e.spec) : {};
  const 操作 = 操作を読む(u, eid);
  const { 列, 全部, 値を引く } = 一覧の行(e, spec, pid, { ...操作, 頁: 1, 件数: 1e9 });
  const 逃がす = (x) => {
    const t = String(x ?? "");
    return /[",\n\r]/.test(t) ? `"${t.replace(/"/g, '""')}"` : t;
  };
  const 行 = [列.map((c) => 逃がす(項目.get(c)?.name ?? c)).join(",")];
  for (const rid of 全部 ?? []) {
    const v = 値を引く ? 値を引く(rid) : {};
    行.push(列.map((c) => 逃がす(書く(v[c], 項目.get(c)))).join(","));
  }
  const p = db.prepare("SELECT name FROM page WHERE id=?").get(pid);
  /** Excel が文字化けしないように BOM を付ける */
  return { 名: `${(p?.name ?? pid).replace(/[\\/:*?"<>|]/g, "_")}.csv`, 中身: "﻿" + 行.join("\r\n") + "\r\n" };
}

/** ─── 入力欄（cellEditor）─── */
function 欄を描く(要素, 画面, pid = 画面.id, u = new URL("http://x/"), { 見出し = null } = {}) {
  for (const f of 拡張.欄) { const h = f(要素, 画面, pid, u, 文脈, { 見出し }); if (h != null) return h; }
  const 行ID = 画面.画面の行 ? null : null;   // 行は渡されていない。定義だけ出す
  const 中 = 要素.map((e) => {
    const sp = e.spec ? JSON.parse(e.spec) : {};
    const f = 項目.get(e.fld) ?? null;
    const 名 = e.label || f?.name || e.fld;
    const 条件 = e.visible_when ? JSON.parse(e.visible_when) : null;
    return `<div class=k>${E(名)}${e.read_only ? ' <span class="tag">読み取り専用</span>' : ""}</div>
      <div>${f ? `<span class=tag>${f.type}</span>` : ""}
      ${条件?.length ? `<div class=cond>見せる条件: ${E(条件.map((c) => c.条件).join(" / "))}</div>` : ""}</div>`;
  }).join("");
  /** row 画面では節（section）ごとに呼ばれる。節の名を箱の見出しにすると現行と同じ見え方になる */
  return `<div class=el><div class=elh>${E(見出し ?? "入力欄")} <span class=tag>${要素.length}個</span></div><div class=cells>${中}</div></div>`;
}

/**
 * ─── 門（押せるかを決める式）───
 *
 * 現行は「押せるか」を式で持っている。空文字なら通り、
 * 何か入っていればその文字がそのまま利用者に出る。
 * どの式がどのボタンの門かは定義に書かれていないので、
 * **同じ画面に読み取り専用の欄として置かれていること**で結び付ける（db/09-gates.mjs）。
 *
 * 母集団の行それぞれに門を当てて、「何行が押せるか」を出す。
 * これが機能としての「押せるかどうか」である。
 */
const 門の表 = (() => {
  const p = path.join(ROOT, "spec", "gates.json");
  if (!fs.existsSync(p)) return new Map();
  const m = new Map();
  for (const x of JSON.parse(fs.readFileSync(p, "utf8"))) if (x.門?.length) m.set(`${x.画面}|${x.ボタン}`, x);
  return m;
})();

function 門を当てる(pid, eid, sp) {
  const g = 門の表.get(`${pid}|${eid}`);
  if (!g) return null;
  /** 母集団の行を出す。無ければ対象の表の全行 */
  const 表ID = g.対象の表ID;
  if (!表ID) return { 門: g.門, 行数: null };
  /**
   * **保存済みの値を読むのではなく、自分で計算する。**
   * 取得できた行は「既に通った行」ばかりなので、保存済みの門はほぼ空。
   * それを読むと「全行が通る」としか出ず、門が効いていることを確かめられない。
   * 写す側は自分で計算しなければならないので、ここで計算する。
   * 参照先が未取得の行は「判定できない」に分ける（数に混ぜると誤診する）。
   */
  const rows = db.prepare("SELECT id,tbl,cells,calc,snap FROM row WHERE tbl=? LIMIT 3000").all(表ID);
  const 結果 = { 門: g.門, 見た: rows.length, 通る: 0, 弾かれる: 0, 判定できず: 0, 文言の数: new Map() };
  for (const r of rows) {
    const e = { id: r.id, tbl: r.tbl, cells: JSON.parse(r.cells), calc: JSON.parse(r.calc), snap: JSON.parse(r.snap ?? "{}") };
    let 弾く = false, 不能 = false;
    for (const x of g.門) {
      const 記録 = {};
      const v = 書き込み.計算器.一つ計算(e, x.項目, 記録);
      if (記録.未取得) { 不能 = true; continue; }
      if (v != null && v !== "" && !(typeof v === "object" && v.エラー)) {
        弾く = true;
        for (const m of String(v).split(/(?<=。)/)) {
          const t = m.trim();
          if (t) 結果.文言の数.set(t, (結果.文言の数.get(t) ?? 0) + 1);
        }
      }
    }
    if (不能 && !弾く) 結果.判定できず++;
    else if (弾く) 結果.弾かれる++;
    else 結果.通る++;
  }
  return 結果;
}

/** ─── ボタン ─── */
/**
 * ボタンを描く。**押すところと定義を分ける**（demo の PageHeader は帯の右にボタンだけを出す）。
 *
 *   押すところ  `data-act` の印が付いた要素（a / span / form）。`<div class="acts …">` に横並びで出す
 *   定義        動作名・対象の表・確認の文言・見せる条件・宛先 URL・押せるかを決める式とその結果。
 *               **一つも消さず**「このボタンの定義」の折りたたみに入れる
 *
 * @param 画面の true なら 骨() が帯の右端へ持ち上げる（画面ごとのボタン）。
 *               false は行や節の文脈に置いたままにする（30-detail が節の中で呼ぶ）
 */
function ボタンを描く(要素, pid, u = new URL("http://x/"), { 画面の = false } = {}) {
  /** html から `data-act` の要素を取り出す。残りが定義 */
  const 分ける = (html) => {
    const 操作 = [...String(html).matchAll(/<(a|span|form|button)\b[^>]*\bdata-act\b[\s\S]*?<\/\1>/g)].map((m) => m[0]);
    let 残り = String(html);
    for (const x of 操作) 残り = 残り.replace(x, "");
    return { 操作, 残り };
  };
  const 操作たち = [], 定義たち = [];
  for (const e of 要素) {
    const sp = e.spec ? JSON.parse(e.spec) : {};
    const 門 = 門を当てる(pid, e.id, sp);
    const [bg, fg] = ボタンの色[sp.色] ?? ボタンの色.gray;
    const 条件 = e.visible_when ? JSON.parse(e.visible_when) : null;
    const url = sp.url;
    const 危険 = 引き金か(url);
    /** deleteRow は確認の文言を持つのに isConfirmationModalEnabled が付かない（7 個中 6 個）。14-layout が 動作の詳細.確認 に文言だけ残している */
    const 確認 = sp.確認 ?? sp.動作の詳細?.確認 ?? null;
    const p = db.prepare("SELECT name FROM page WHERE id=?").get(pid);
    const d = 動作.要素から(e.id, p?.name ?? null);
    /** 拡張がその動作を描けるなら任せる（navigate 系・updateRow・deleteRow・フォームを開く…） */
    if (!d && 拡張.ボタン.has(sp.動作)) {
      const h = 拡張.ボタン.get(sp.動作)(e, sp, pid, { 門, 条件, 色: [bg, fg], u }, 文脈);
      if (h != null) { const x = 分ける(h); 操作たち.push(...x.操作); if (x.残り.trim()) 定義たち.push(`<div class=def>${x.残り}</div>`); continue; }
    }
    操作たち.push(d
      ? `<a class="btn primary" data-act href="/do/${E(pid)}/${E(e.id)}" title="${E(`${sp.動作 ?? ""}／${d.確度}`)}">${E(sp.文字 ?? d.札)}</a>`
      : `<span class="btn ghost" data-act title="${E(sp.動作 ?? "")}">${E(sp.文字 ?? "?")}</span>`);
    定義たち.push(`<div class=def>
      <b>${E(sp.文字 ?? d?.札 ?? "?")}</b>
      <span class=tag>${E(sp.動作 ?? "?")}</span>
      ${d ? `<span class=tag style="background:#e7f3ff;color:#0b5ea8">動く（${E(d.確度)}）</span>` : ""}
      ${sp.対象の行?.母集団の表 ? `<span class=tag>対象: ${E(sp.対象の行.母集団の表)}</span>` : ""}
      ${確認 ? `<div class=dlg><b>${E(確認.題)}</b>\n${E(確認.本文 ?? "")}\n→ ${E(確認.進むボタン ?? "")}</div>` : ""}
      ${sp.対象の行?.母集団 ? `<div class=dlg>母集団: ${E(sp.対象の行.母集団)}</div>` : ""}
      ${条件?.length ? `<div class=cond>見せる条件: ${E(条件.map((c) => c.条件).join(" / "))}</div>` : ""}
      ${url ? `<div class=dlg>${危険 ? "⚠ 引き金を引く宛先。この画面からは開きません: " : 外部か(url) ? "外部の宛先（開きません）: " : "宛先: "}<code>${E(String(url).slice(0, 160))}</code></div>` : ""}
      ${門 ? `<div style="margin-top:6px;padding:6px 8px;background:var(--surface-2);border-radius:6px">
        <div style="font-size:11.5px;color:var(--ink-2)"><b>押せるかを決める式</b>: ${門.門.map((g) => E(g.名)).join(" / ")}</div>
        ${門.見た != null ? `<div style="font-size:11.5px;margin-top:3px">対象の表 ${門.見た}行に当てた結果 —
          <span style="color:var(--good)">通る ${門.通る}</span> ／ <span style="color:var(--bad)">弾かれる ${門.弾かれる}</span>${門.判定できず ? ` ／ <span style="color:var(--muted)">参照先が未取得で判定できず ${門.判定できず}</span>` : ""}</div>` : ""}
        ${門.文言の数?.size ? `<div style="font-size:11.5px;margin-top:3px">出る文言:<br>` +
          [...門.文言の数].sort((a, b) => b[1] - a[1]).slice(0, 6)
            .map(([m, n]) => `　「${E(m)}」 ${n}行`).join("<br>") + `</div>` : ""}
      </div>` : ""}
    </div>`);
  }
  const 定義 = `<details class=defs><summary>このボタンの定義 <span class=tag>${要素.length}件</span></summary>${定義たち.join("")}</details>`;
  return `<div class="acts${画面の ? " page" : ""}">${操作たち.join("")}</div>${定義}`;
}

/** 純正フォームへの入口を画面に出す */
function フォームの入口(pid) {
  const fs2 = db.prepare("SELECT id,spec FROM elem WHERE page=? AND type=?").all(pid, "formContainer");
  if (!fs2.length) return "";
  return `<div class=el><div class=elh>入力（行を作る） <span class=tag>${fs2.length}件</span></div>` +
    fs2.map((x) => { const sp = JSON.parse(x.spec ?? "{}");
      return `<div style="padding:8px 12px;border-bottom:1px solid #f2f2f4">
        <a class=btn style="background:#2d7ff9;color:#fff;text-decoration:none" href="/form/${E(pid)}/${E(x.id)}">${E(sp.ボタン ?? "作成")}</a>
        <span class=tag style="margin-left:8px">${E(sp.動作)} → ${E(sp.作る表)}</span>
        <span class=tag>必須 ${(sp.必須 ?? []).length}</span></div>`; }).join("") + `</div>`;
}

/** ─── 画面 ─── */
function 画面を描く(pid, u = new URL("http://x/")) {
  const p = db.prepare("SELECT * FROM page WHERE id=?").get(pid);
  if (!p) return null;
  const 要素 = db.prepare("SELECT * FROM elem WHERE page=? ORDER BY depth, type").all(pid);
  if (!要素.length) {
    return 骨(p.name ?? pid, `<h1>${E(p.name)}</h1><div class=sub>${E(p.tab)} / ${E(p.layout_kind ?? "")}</div>
      <div class=warn>この画面のレイアウトは取得できていません。<br>
      現行では ${E(p.name)} として存在しますが、応答の本文が完了せず定義が手元にありません。</div>`, pid);
  }
  const 種 = (t) => 要素.filter((e) => e.type === t);
  /** 拡張が画面ごと描き替えるなら、それを使う（レコード詳細など） */
  const 仕上げる = (html) => { for (const f of 拡張.仕上げ) { const h = f(html, p, u, 文脈); if (typeof h === "string") html = h; } return html; };
  for (const f of 拡張.画面) { const h = f(p, 要素, pid, u, 文脈); if (h != null) return 仕上げる(h); }
  let 中 = `<h1>${E(p.name)}</h1><div class=sub>${E(p.tab)}${p.bundle ? ` / ${E(db.prepare("SELECT name FROM bundle WHERE id=?").get(p.bundle)?.name ?? "")}` : ""}
     ・${E(p.layout_kind ?? "")}${p.variant ? `・${E(p.variant)}` : ""}・要素 ${要素.length}個</div>`;

  /** 単一レコード画面は、どの表の1行に対する画面かを出す */
  const rrc = db.prepare("SELECT tbl FROM page WHERE id=?").get(pid);
  /** dashboard 型は拡張（40-dash）が面の順（帯 → 数字 → 図 → 一覧）に描く。ここで一覧を先に出すと集計の上に来て現行と逆になる */
  if (p.layout_kind !== "dashboard") for (const e of [...種("levels"), ...種("grid")]) 中 += 一覧を描く(e, e.spec ? JSON.parse(e.spec) : {}, pid, u);
  const 欄 = 種("cellEditor");
  if (欄.length) 中 += 欄を描く(欄, p, pid, u);
  中 += フォームの入口(pid);
  const b = 種("button");
  if (b.length) 中 += ボタンを描く(b, pid, u, { 画面の: true });
  /** 拡張が描ける型は拡張に任せる */
  for (const e of 要素) if (拡張.要素.has(e.type)) { const h = 拡張.要素.get(e.type)(e, e.spec ? JSON.parse(e.spec) : {}, pid, u, 文脈); if (h) 中 += h; }
  const 他 = 要素.filter((e) => !["levels", "grid", "cellEditor", "button", "section", "sectionGridRow", "queryContainer", "recordContainer"].includes(e.type) && !拡張.要素.has(e.type));
  if (他.length) 中 += `<div class=el><div class=elh>その他の要素</div>` +
    他.map((e) => `<div class=note><b>${E(e.type)}</b>${e.label ? ` 〈${E(e.label)}〉` : ""}${e.tbl ? ` — ${E(表.get(e.tbl)?.表示 ?? e.tbl)}` : ""}</div>`).join("") + `</div>`;
  return 仕上げる(骨(p.name ?? pid, 中, pid));
}

/**
 * ─── 純正フォーム（行を作る）───
 *
 * 7件ある。**画面の作り込みではなく定義から描く。**
 *   requiredColumnIds        必須（項目名の右に *）
 *   prefilledCellValueByColumnId  既定値（dynamicCurrentDateValue は今日）
 *   visibilityFilters        **項目ごと**の見せる条件（section とは形が違う）
 *   その入力欄は cellEditor で、`source.row.outputId` が formContainer の出力と一致するもの
 */
function 入力欄の型(f) {
  const t = f?.type;
  if (t === "date") return "date";
  if (t === "number" || t === "currency") return "number";
  if (t === "checkbox") return "checkbox";
  return "text";
}

function フォームを描く(pid, eid, { 値 = {}, 文言 = [], 成功 = null, 注 = "" } = {}) {
  const p = db.prepare("SELECT * FROM page WHERE id=?").get(pid);
  const e = db.prepare("SELECT * FROM elem WHERE page=? AND id=?").get(pid, eid);
  if (!p || !e || e.type !== "formContainer") return null;
  const sp = JSON.parse(e.spec ?? "{}");
  const 必須 = new Set((sp.必須 ?? []).map((x) => x.id));
  /** 入力欄は cellEditor。出力IDで紐づける */
  const 欄 = db.prepare("SELECT id,fld,label,read_only,spec FROM elem WHERE page=? AND type=?").all(pid, "cellEditor")
    .filter((x) => { const s2 = x.spec ? JSON.parse(x.spec) : {}; return s2.行の出どころ === sp.出力; });

  const 中 = 欄.map((x) => {
    const f = 項目.get(x.fld);
    const 名 = x.label || f?.name || x.fld;
    const 既定 = sp.既定値?.[x.fld];
    const v = 値[x.fld] ?? (既定?.specialValue === "dynamicCurrentDateValue" ? "" : 既定 ?? "");
    const 表示 = typeof v === "object" ? (v?.[0]?.foreignRowDisplayName ?? JSON.stringify(v)) : v;
    const 条件 = sp.項目ごとの見せる条件?.[x.fld];
    if (x.read_only) {
      return `<div class=k>${E(名)} <span class=tag>読み取り専用</span></div>
        <div class=ro>${E(表示)}${既定 ? ' <span class=tag>既定値</span>' : ""}</div>`;
    }
    return `<div class=k>${E(名)}${必須.has(x.fld) ? ' <span style="color:#c00">*</span>' : ""}</div>
      <div><input name="${E(x.fld)}" type="${入力欄の型(f)}" value="${E(表示)}"
        style="width:min(360px,100%);padding:4px 7px;border:1px solid #ccc;border-radius:4px;font:inherit">
        ${f ? `<span class=tag style="margin-left:6px">${f.type}</span>` : ""}
        ${既定?.specialValue === "dynamicCurrentDateValue" ? '<span class=tag>既定: 今日</span>' : ""}
        ${条件 ? `<div class=cond>この項目を見せる条件あり</div>` : ""}</div>`;
  }).join("");

  /**
   * 欄に無い関連項目の既定値（addForeignRow が渡す親の行など）は hidden で持ち回る。
   * 入金登録 pag8viZ0mEJ9zzMsR の入力欄は 入金日・手数料・今回入金額 だけで、親（売掛台帳）の欄が無い。
   * 作る表の関連項目に限る（他の鍵は無視）。
   */
  const 隠す = Object.entries(値)
    .filter(([k]) => !欄.some((x) => x.fld === k) && 項目.get(k)?.tbl === sp.作る表ID && 項目.get(k)?.type === "foreignKey")
    .map(([k, v]) => {
      const ids = (Array.isArray(v) ? v : String(v).split(",")).map((y) => (y && typeof y === "object" ? y.foreignRowId : String(y).trim())).filter(Boolean);
      return { k, 名: 項目.get(k).name, 形: 関連の形にする(ids) };
    })
    .filter((h) => h.形.length);
  const 隠し = 隠す.map((h) => h.形.map((y) => `<input type=hidden name="${E(h.k)}" value="${E(y.foreignRowId)}">`).join("")
    + `<div class=k>${E(h.名)} <span class=tag>関連・この画面から渡された</span></div><div class=ro>${h.形.map((y) => E(y.foreignRowDisplayName)).join("、")}</div>`).join("");

  const 中身 = `<h1>${E(sp.題 ?? "入力")}</h1>
    <div class=sub>${E(p.tab)}/${E(p.name)} ・ ${E(sp.動作)} → ${E(sp.作る表)}</div>
    ${文言.length ? `<div class=warn><b>保存できません</b><br>${文言.map((m) => E(m)).join("<br>")}</div>` : ""}
    ${成功 ? `<div class=el><div class=note style="color:#0a0">保存しました。行 ${E(成功.行ID)}　計算し直した行 ${成功.再計算した行数}</div></div>` : ""}
    ${注}
    <form method=post class=el>
      <div class=elh>${E(sp.作る表)} <span class=tag>入力欄 ${欄.length}</span>
        <span class=tag>必須 ${必須.size}</span></div>
      <div class=cells>${中}${隠し}</div>
      <div style="padding:10px 12px"><button class=btn style="background:#2d7ff9;color:#fff;cursor:pointer"
        type=submit>${E(sp.ボタン ?? "作成")}</button>
        <a href="/p/${E(pid)}" style="margin-left:12px;font-size:12px">画面に戻る</a></div>
    </form>
    <div class=el><div class=elh>この入力に効く決まり</div>
      <div class=note>必須: ${[...必須].map((x) => E(項目.get(x)?.name ?? x)).join(", ") || "なし"}<br>
      既定値: ${Object.keys(sp.既定値 ?? {}).map((x) => E(項目.get(x)?.name ?? x)).join(", ") || "なし"}<br>
      書いた内容は write_log に残ります。<b>現行のAirtableには一切書きません。</b></div></div>`;
  /** フォームはフォームだけの画面（現行SM・demo の app/form/[id] と同じ。サイドバーも一覧も出さない） */
  return 骨(sp.題 ?? "入力", 中身, pid, { 枠なし: true });
}

/** 行IDの並びを関連の値の形 [{foreignRowId, foreignRowDisplayName}] にする。表示名は相手の主項目（外フォームの値 と同じ） */
function 関連の形にする(ids) {
  const out = [];
  for (const rid of ids ?? []) {
    const r = db.prepare("SELECT tbl,cells,calc FROM row WHERE id=?").get(rid);
    if (!r) continue;
    const 主 = db.prepare("SELECT primary_fld FROM tbl WHERE id=?").get(r.tbl)?.primary_fld;
    const cv = { ...JSON.parse(r.calc), ...JSON.parse(r.cells) };
    out.push({ foreignRowId: rid, foreignRowDisplayName: 主 ? String(書く(cv[主], 項目.get(主)) ?? "") : rid });
  }
  return out;
}

/**
 * 送られてきた値を項目の型に合わせる。**外フォームの値 と同じ形にする**（同じDBに 2 つの形を混ぜない）。
 *   foreignKey   行ID（複数可・カンマ区切り可）→ [{foreignRowId, foreignRowDisplayName}]。
 *                式の 式から見た形 は foreignRowDisplayName を持つ物しか表示名に直さないので、文字列のままだと式が rec… を見る。
 *                行IDでないものは、相手の主項目の表示名と完全一致する行が 1 つだけあればそれを採る。無ければ元の文字列を残す
 *   select       名前 → 選択肢ID（名前のまま入れると 選択肢の順 の並びと 名前に直す の比較が合わない）
 *   date         "2026-09-12" → "2026-09-12T00:00:00.000Z"
 *   同じ鍵が複数来る（<select multiple>・多重の関連）と配列で届く（本文を読む）。単値の型は最後の 1 つを採る
 */
function 値を整える(生, 欄) {
  const out = {};
  for (const x of 欄) {
    const f = 項目.get(x.fld);
    let v = 生[x.fld];
    if (Array.isArray(v)) v = v.filter((s) => s !== "" && s != null);
    if (v === undefined || v === "" || (Array.isArray(v) && !v.length)) continue;
    if (f?.type === "number") v = Number(Array.isArray(v) ? v[v.length - 1] : v);
    else if (f?.type === "checkbox") { const s = Array.isArray(v) ? v[v.length - 1] : v; v = s === "on" || s === "true" || s === "1" || s === true; }
    else if (f?.type === "foreignKey") {
      const 語 = (Array.isArray(v) ? v : String(v).split(",")).map((s) => String(s).trim()).filter(Boolean);
      const ids = 語.filter((s) => /^rec[A-Za-z0-9]{14}$/.test(s));
      for (const s of 語) {
        if (/^rec[A-Za-z0-9]{14}$/.test(s)) continue;
        const c = 候補を引く(関連先(x.fld), s, 5).候補.filter((y) => y.名 === s);
        if (c.length === 1) ids.push(c[0].行);
      }
      const 形 = 関連の形にする(ids);
      if (!形.length) { if (語.length === 1 && !ids.length) out[x.fld] = 語[0]; continue; }   // 解けないときは元の文字列を残す
      v = 形;
    } else if (f?.type === "select" || f?.type === "multiSelect") {
      const 表2 = f.opts?.選択肢ID ?? {};
      const 直す = (s) => (表2[s] !== undefined ? s : (Object.entries(表2).find(([, n]) => n === s)?.[0] ?? s));
      v = f.type === "multiSelect" ? (Array.isArray(v) ? v : [v]).map(直す) : 直す(Array.isArray(v) ? v[v.length - 1] : v);
    } else {
      if (Array.isArray(v)) v = v[v.length - 1];
      if (f?.type === "date" && /^\d{4}-\d{2}-\d{2}$/.test(String(v))) v = `${v}T00:00:00.000Z`;
    }
    out[x.fld] = v;
  }
  return out;
}

/**
 * ─── 門を試す ───
 *
 * 門は「参照先の項目が揃っていないと判定できない」。
 * 手元の行は画面が要求した列しか持たないので、既存の行では大半が判定できない。
 * **写す側が自分で持つデータなら判定できる。** それを確かめられるようにする。
 *
 * 門の式が参照する項目を欄として出し、値を入れると門の結果が出る。
 * 空なら通る。何か出れば、それがそのまま利用者に見える文言である。
 */
function 門を試す画面(fid, { 値 = {} } = {}) {
  const r = db.prepare("SELECT r.fld,r.tbl,r.messages,r.formula,r.refs,f.name,b.tab,t.name tn FROM rule r JOIN fld f ON f.id=r.fld JOIN tbl t ON t.id=r.tbl JOIN base b ON b.id=t.base WHERE r.fld=?").get(fid);
  if (!r) return null;
  const 参照 = JSON.parse(r.refs ?? "[]");
  const 文言 = JSON.parse(r.messages);

  /** 仮の行を組んで門を計算する */
  const 仮 = { id: "試し", tbl: r.tbl, cells: {}, calc: {}, 新しい行: true };
  for (const [k, v] of Object.entries(値)) {
    if (v === "") continue;
    const f = 項目.get(k);
    仮.cells[k] = f?.type === "number" ? Number(v) : f?.type === "checkbox" ? (v === "on") : v;
  }
  const 記録 = {};
  const 結果 = Object.keys(値).length ? 書き込み.計算器.一つ計算(仮, fid, 記録) : undefined;

  const 欄 = 参照.map((x) => {
    const f = 項目.get(x.id);
    const 計算項目 = f?.is_computed;
    return `<div class=k>${E(f?.name ?? x.名 ?? x.id)}${計算項目 ? ' <span class=tag>計算項目</span>' : ""}</div>
      <div>${計算項目
        ? `<span class=ro>この項目は計算で決まります（${E(f.type)}）。手で入れる項目ではありません</span>`
        : `<input name="${E(x.id)}" type="${入力欄の型(f)}" value="${E(値[x.id] ?? "")}"
            style="width:min(320px,100%);padding:4px 7px;border:1px solid #ccc;border-radius:4px;font:inherit">
           <span class=tag style="margin-left:6px">${E(f?.type ?? "?")}</span>`}</div>`;
  }).join("");

  const 中 = `<h1>門を試す: ${E(r.name ?? fid)}</h1>
    <div class=sub>${E(r.tab)}/${E(r.tn)} ・ 参照 ${参照.length}項目 ・ 文言 ${文言.length}種</div>
    <div class=el><div class=elh>この式が出す文言（式の中の順）</div>
      <div class=note>${文言.map((m) => `「${E(m)}」`).join("<br>")}</div></div>
    <form method=post class=el>
      <div class=elh>参照する項目に値を入れる</div>
      <div class=cells>${欄}</div>
      <div style="padding:10px 12px"><button class=btn style="background:#2d7ff9;color:#fff;cursor:pointer" type=submit>門に当てる</button></div>
    </form>
    ${結果 !== undefined ? `<div class=el><div class=elh>結果</div>
      <div style="padding:10px 12px">${記録.未取得 ? '<div class=cond>参照先の一部が埋まっていないため、判定は参考値です</div>' : ""}
      ${結果 == null || 結果 === "" ? '<div style="color:#0a7;font-weight:600">通ります（門は空）</div>'
        : `<div class=warn style="margin:0"><b>弾かれます</b><br>${E(String(結果)).replace(/。/g, "。<br>")}</div>`}</div></div>` : ""}
    <div class=el><div class=elh>式</div><div class=note style="white-space:pre-wrap;font-family:ui-monospace,monospace;font-size:11.5px">${E(読める式(r.formula))}</div></div>`;
  return 骨(`門: ${r.name ?? fid}`, 中, null);
}

/** 式を読める形に。項目IDを名前に直す */
function 読める式(f) {
  return String(f ?? "")
    .replace(/\{column_value_(fld[A-Za-z0-9]+)\}/g, (_, id) => `{${項目.get(id)?.name || id}}`)
    .replace(/(^|[^{\w])(column_value_(fld[A-Za-z0-9]+))/g, (_, p, __, id) => `${p}{${項目.get(id)?.name || id}}`)
    .replace(/\{column_modified_time_(fld[A-Za-z0-9]+)\}/g, (_, id) => `LAST_MODIFIED_TIME({${項目.get(id)?.name || id}})`);
}

/** 門の一覧 */
function 門の一覧() {
  const 語 = /エラー|できません|してください|ください|不足|負です|なければ|未入力|必要|重複|一致しません|未作成|済みです|有り/;
  const rs = db.prepare("SELECT r.fld,r.tbl,r.messages,r.formula,r.refs,f.name,b.tab,t.name tn FROM rule r JOIN fld f ON f.id=r.fld JOIN tbl t ON t.id=r.tbl JOIN base b ON b.id=t.base").all();
  const 門 = rs.filter((r) => JSON.parse(r.messages).some((m) => 語.test(m)) && /\bIF\s*\(/.test(String(r.formula)));
  const 行 = 門.sort((a, b) => JSON.parse(b.messages).length - JSON.parse(a.messages).length).map((r) => {
    const ms = JSON.parse(r.messages).filter((m) => 語.test(m));
    return `<tr><td>${E(r.tab)}/${E(r.tn)}</td><td>${E(r.name ?? "無名")}</td>
      <td class=r>${ms.length}</td><td>${E(ms.slice(0, 2).map((m) => `「${m}」`).join(""))}</td>
      <td><a href="/gate/${E(r.fld)}">試す</a></td></tr>`;
  }).join("");
  return 骨("門の一覧", `<h1>押せるかを決める式（門）</h1>
    <div class=sub>70式のうち、利用者に文言を出し条件分岐を持つもの ${門.length}本</div>
    <div class=el><div class=scroll><table data-rowheight="${E(行の高さの字(null))}"><thead><tr><th>表</th><th>項目</th><th class=r>文言</th><th>文言の例</th><th></th></tr></thead>
    <tbody>${行}</tbody></table></div></div>`, null);
}

/**
 * ─── 帳票 ───
 *
 * CSVの値で組む。**関連の辺が未取得**なので、明細は
 * 発注明細.発注番号 = 発注書.発注No で結ぶ。
 */
function CSVの行を名前で(file, 条件 = null) {
  const 名 = new Map(db.prepare("SELECT id,name FROM fld WHERE name IS NOT NULL").all().map((r) => [r.id, r.name]));
  const out = [];
  for (const r of db.prepare("SELECT cells,extra FROM csv_row WHERE file=?").all(file)) {
    const o = {};
    for (const [k, v] of Object.entries(JSON.parse(r.cells))) o[名.get(k) ?? k] = v;
    if (r.extra) for (const [k, v] of Object.entries(JSON.parse(r.extra))) o[k] = v;
    if (!条件 || 条件(o)) out.push(o);
  }
  return out;
}

function 帳票の一覧() {
  const 発注 = CSVの行を名前で("TTCFInterface__発注書.csv");
  const 明細 = CSVの行を名前で("TTCFInterface__発注明細.csv");
  const 明細数 = new Map();
  for (const x of 明細) if (x.発注番号) 明細数.set(x.発注番号, (明細数.get(x.発注番号) ?? 0) + 1);
  /**
   * **発注書と発注明細の紐付けが手元に無い。**
   * 関連の辺は未取得（0件）、CSVは別々のビュー出力で共通の鍵が無い。
   * 明細の `発注番号` は仕入先側の番号（S6-240-047 の形）で、
   * 発注No（240321-0178 の形）とは一致0件だった。
   * だから明細の有無で絞らず全件出し、明細は「未取得」と明示する。
   */
  const 行 = 発注.slice(0, 60)
    .map((x) => `<tr><td><a href="/doc/発注書/${encodeURIComponent(x.発注No)}">${E(x.発注No)}</a></td>
      <td>${E(x.発注日 ?? "")}</td><td>${E(x.仕入先 ?? "")}</td><td>${E(x.納品場所 ?? "")}</td>
      <td class=r>${明細数.get(x.発注No)}</td></tr>`).join("");
  const 種 = 帳票の種類.map((k) => `<tr><td>${E(k.名)}</td><td class=r>${k.実物}</td><td>${E(k.生成元)}</td><td>${E(k.紙)}</td>
    <td>${k.鍵 === "発注書" ? "組める" : "未実装"}</td></tr>`).join("");
  return 骨("帳票", `<h1>帳票</h1>
    <div class=sub>現行が出した実物1,057件から逆算した組みを、DBの値で埋めます</div>
    <div class=el><div class=elh>帳票の種類</div><div class=scroll><table>
      <thead><tr><th>帳票</th><th class=r>実物</th><th>生成元</th><th>紙</th><th>いまの状態</th></tr></thead>
      <tbody>${種}</tbody></table></div></div>
    <div class=el><div class=elh>発注書 <span class=tag>${発注.length}件</span>
      <span class=tag>先頭60件</span>
      <span class=tag style="background:#fff2f2;color:#a00">明細の紐付けは未取得</span></div>
      <div class=note>発注書と発注明細を結ぶ関連の辺が取得できていません（0件）。
      明細の「発注番号」は仕入先側の番号で、発注Noとは別体系です（一致0件）。
      読み取りだけの追加取得で埋まります。</div><div class=scroll><table>
      <thead><tr><th>発注No</th><th>発注日</th><th>仕入先</th><th>納品場所</th><th class=r>明細</th></tr></thead>
      <tbody>${行}</tbody></table></div></div>`, null);
}

function 帳票を出す(種, 鍵) {
  if (種 !== "発注書") return null;
  const 親 = CSVの行を名前で("TTCFInterface__発注書.csv", (o) => String(o.発注No) === String(鍵))[0];
  if (!親) return null;
  const 明細 = CSVの行を名前で("TTCFInterface__発注明細.csv", (o) => String(o.発注番号) === String(鍵));
  return 発注書を組む(親, 明細);
}

/** ─── 索引 ─── */
function 索引を描く() {
  const n = db.prepare("SELECT count(*) c FROM page WHERE has_layout=1").get().c;
  const 行 = db.prepare("SELECT count(*) c FROM row").get().c;
  const csv = db.prepare("SELECT count(*) c FROM csv_row").get().c;
  return 骨("索引", `<h1>TTCF ミミック</h1>
    <div class=sub>ローカルDBのメタモデルから画面を描いています</div>
    <div class=el><div class=elh>いま入っているもの</div>
    <div class=cells>
      <div class=k>表 / 項目</div><div>${db.prepare("SELECT count(*) c FROM tbl").get().c} / ${db.prepare("SELECT count(*) c FROM fld").get().c}（計算項目 ${db.prepare("SELECT count(*) c FROM fld WHERE is_computed=1").get().c}）</div>
      <div class=k>画面 / 要素</div><div>${db.prepare("SELECT count(*) c FROM page").get().c}（レイアウトあり ${n}） / ${db.prepare("SELECT count(*) c FROM elem").get().c}</div>
      <div class=k>行</div><div>クロール ${行.toLocaleString()} ／ クライアント提供CSV ${csv.toLocaleString()}</div>
      <div class=k>検証</div><div>計算 274,971値で100%一致（正解は書き換えない断面 <code>row.snap</code>）<br>
        クエリ 116本中113本が行集合まで一致・並び 65/65<br>
        書き込み 12/12 ／ 動作 ${動作.一覧().length}件で27/27</div>
    </div></div>
    <div class=el><div class=elh>見るもの</div>
      <div class=note><a href="/actions">動作（押すと走る処理）</a> — ${動作.一覧().length}件。行を選んで実際に押せます<br>
      <a href="/gates">押せるかを決める式（門）の一覧</a> — 27本。値を入れて結果を確かめられます<br>
      <a href="/docs">帳票</a> — 実物1,057件から逆算した組み</div></div>
    <div class=el><div class=elh>作っていないもの</div>
      <div class=note>・帳票の生成（実物1,057件は手元にありますが生成側は未実装）<br>
      ・外部サービス自体の挙動（Make 6・Fillout 4・onrender 1・拡張機能1）。
        <b>Make の webhook は叩きません</b>——叩くと本番の締め処理が走ります<br>
      ・見た目の寸法（機能の一致を先に置いています）</div></div>`, "/");
}


/** ─── 動作（ボタンを押す） ─── */

/**
 * 押す前の画面。**対象の行を選ばせて、関門の結果を先に見せる。**
 * 現行は画面が既に1行に絞り込まれている（rootRowContainer）が、
 * ミミックでは行を選べるようにして、**どの行が弾かれるか**を見えるようにした。
 */
function 動作の画面(pid, eid, { 選んだ = null, 結果 = null, 確認待ち = null } = {}) {
  const p = db.prepare("SELECT id,name FROM page WHERE id=?").get(pid);
  const d = 動作.要素から(eid, p?.name ?? null);
  if (!d) return null;
  const c = 動作.計算器;
  const t = d.表 ? 表.get(d.表) : null;

  /** 候補の行。関門の結果つきで最大60行 */
  const 行たち = [];
  if (d.表) {
    const 主 = db.prepare("SELECT primary_fld FROM tbl WHERE id=?").get(d.表)?.primary_fld;
    for (const r of db.prepare("SELECT id FROM row WHERE tbl=? LIMIT 3000").all(d.表)) {
      const e = c.取る(r.id);
      if (!e) continue;
      const 関門 = d.関門を選ぶ ? d.関門を選ぶ(e) : d.関門;
      const ひ = 動作.関門を見る(e, 関門);
      const k = 主 ? (e.cells[主] ?? e.calc[主] ?? r.id) : r.id;
      行たち.push({ 行: r.id, 鍵: typeof k === "object" ? r.id : String(k), 文言: ひ.map((x) => x.文言) });
      if (行たち.length >= 60) break;
    }
    行たち.sort((a, b) => a.文言.length - b.文言.length || String(b.鍵).localeCompare(String(a.鍵)));
  }

  const 表示 = (xs) => xs.map((x) => `<tr${x.行 === 選んだ ? ' style="background:#fffbe6"' : ""}>
      <td><code>${E(x.鍵)}</code></td>
      <td>${x.文言.length ? `<span style="color:#a00">${E(x.文言.join(""))}</span>` : `<span style="color:#0a7">通る</span>`}</td>
      <td style="text-align:right">${x.文言.length ? "" :
        `<form method=post action="/do/${E(pid)}/${E(eid)}" style="display:inline">
           <input type=hidden name=row value="${E(x.行)}">
           ${d.確認 ? "" : '<input type=hidden name=ok value="1">'}
           <button class=btn style="background:#2d7ff9;color:#fff;border:0;cursor:pointer">${E(d.札)}</button>
         </form>`}</td></tr>`).join("");

  const 中 = `
  <h1>${E(d.札)}${t ? ` <span class=tag>${E(t.表示)}</span>` : ""}</h1>
  <div class=note>
    <div><b>この処理は何か</b>　${E(d.根拠)}</div>
    <div style="margin-top:4px"><b>確度</b>　${E(d.確度)}
      ${d.自動処理?.length ? `　<b>現行の自動処理</b> <code>${d.自動処理.map(E).join(", ")}</code>` : ""}
      ${d.要素?.length ? `　<b>ボタン要素</b> <code>${d.要素.map(E).join(", ")}</code>` : ""}</div>
    ${d.関門?.length ? `<div style="margin-top:4px"><b>押せるかを決める式</b>　${d.関門.map((f) => `<a href="/gate/${E(f)}">${E(項目.get(f)?.name ?? f)}</a>`).join(" / ")}</div>` : ""}
    ${d.関門を選ぶ ? `<div style="margin-top:4px"><b>押せるかを決める式</b>　行の種類番号で分岐（4=海外 / 6=国内）</div>` : ""}
    ${d.外部 ? `<div style="margin-top:4px;color:#a00"><b>⚠ 現行の引き金</b>　<code>${E(d.外部)}</code>　この画面からは叩きません（叩くと本番の締め処理が走ります）</div>` : ""}
    ${d.注 ? `<div style="margin-top:4px">※ ${E(d.注)}</div>` : ""}
  </div>
  ${確認待ち ? `<div class=dlg style="border:2px solid #d93025;background:#fff4f4">
      <b>${E(確認待ち.題)}</b>\n${E(確認待ち.本文 ?? "")}
      <form method=post action="/do/${E(pid)}/${E(eid)}" style="margin-top:8px">
        <input type=hidden name=row value="${E(選んだ ?? "")}">
        <input type=hidden name=ok value="1">
        <button class=btn style="background:#d93025;color:#fff;border:0;cursor:pointer">${E(確認待ち.進むボタン ?? "はい")}</button>
      </form></div>` : ""}
  ${結果 ? `<div class=dlg style="border:2px solid ${結果.可 ? "#0a7" : "#d93025"};background:${結果.可 ? "#f2fbf7" : "#fff4f4"}">
      ${結果.可 ? "<b>実行しました</b>" : "<b>実行しませんでした</b>"}
      ${結果.文言?.length ? `\n${E(結果.文言.join("\n"))}` : ""}
      ${結果.作った?.length ? `\n作った行 ${結果.作った.length}件: ${E(結果.作った.join(", "))}` : ""}
      ${結果.変えた?.length ? `\n変えた行 ${結果.変えた.length}件` : ""}
      ${結果.消した?.length ? `\n消した行 ${結果.消した.length}件` : ""}</div>` : ""}
  ${d.引数?.length ? `<div class=el><div class=elh>引数</div><form method=post action="/do/${E(pid)}/${E(eid)}" style="padding:10px 12px">
      <input type=hidden name=ok value="1">
      ${d.引数.map((k) => `<label style="display:block;margin-bottom:6px"><span style="display:inline-block;width:80px">${E(k)}</span>
        <input name="${E(k)}" style="padding:5px 7px;border:1px solid #ccd;border-radius:4px"></label>`).join("")}
      <button class=btn style="background:#2d7ff9;color:#fff;border:0;cursor:pointer">${E(d.札)}</button></form></div>` : ""}
  ${d.表 ? `<div class=el><div class=elh>対象の行 <span class=tag>先頭${行たち.length}件・関門を通るものを上に</span></div>
    <table><thead><tr><th>行</th><th>関門</th><th></th></tr></thead><tbody>${表示(行たち)}</tbody></table></div>` : ""}
  <div style="margin-top:12px"><a href="/p/${E(pid)}">← ${E(p?.name ?? pid)}</a>　<a href="/actions">動作の一覧</a></div>`;
  return 骨(`${d.札}｜${p?.name ?? pid}`, 中, null);
}

/** 動作の一覧。**何が動いて何が動かないか**を1枚で見せる */
function 動作の一覧() {
  const l = 動作.一覧();
  const 置き場 = new Map();
  for (const x of l) for (const eid of x.要素) {
    for (const r of db.prepare("SELECT page FROM elem WHERE id=?").all(eid)) {
      const k = `${x.鍵}|${r.page}`;
      if (!置き場.has(k)) 置き場.set(k, { 鍵: x.鍵, 画面: r.page, 要素: eid });
    }
  }
  const 行 = l.map((x) => {
    const 場 = [...置き場.values()].filter((y) => y.鍵 === x.鍵);
    return `<tr>
      <td><b>${E(x.札)}</b><br><span class=tag>${E(x.鍵)}</span></td>
      <td>${x.表 ? E(表.get(x.表)?.表示 ?? x.表) : "—"}</td>
      <td>${x.確度 === "確定" ? '<span style="color:#0a7">確定</span>' : `<span style="color:#b8860b">${E(x.確度)}</span>`}</td>
      <td>${(x.関門 ?? []).map((f) => `<a href="/gate/${E(f)}">${E(項目.get(f)?.name ?? f)}</a>`).join("<br>") || (x.関門を選ぶ ? "行で分岐" : "—")}</td>
      <td>${x.確認 ? `<div class=dlg style="margin:0"><b>${E(x.確認.題)}</b>\n${E(x.確認.本文 ?? "")}</div>` : "—"}</td>
      <td>${場.map((y) => `<a href="/do/${E(y.画面)}/${E(y.要素)}">押す</a>`).join("<br>")
        || (x.引数 ? `<a href="/do/-/${E(x.鍵)}">押す</a>` : "画面未採取")}</td>
      <td style="font-size:11.5px;color:#4a4f57">${E(x.根拠)}${x.注 ? `<br>※ ${E(x.注)}` : ""}</td></tr>`;
  }).join("");
  return 骨("動作", `<h1>ボタンを押すと走る処理 <span class=tag>${l.length}件</span></h1>
  <div class=note><b>現行の中身はどう決めたか</b>　Airtableの自動処理の定義は <code>readForWorkflows</code> が403で読めない。
  代わりに4つの独立な証拠を重ねた。<br>
  ① <code>workflowTriggerConnectionsById</code>（ボタン→自動処理の対応表そのもの・23接続/15処理）<br>
  ② ボタンの確認ダイアログ本文（作った人自身の説明）<br>
  ③ 同じ画面に置かれた検証式（押せる条件と画面に出る文言。文言は原文のまま出す）<br>
  ④ <b>2つの断面の差</b>（クライアント提供CSV 2026-09-06 と こちらのクロール 2026-09-10。
     その4日間にクライアントがテストしているので、<b>作られた行に埋まっている入力項目＝処理が書いた項目</b>）<br>
  ④だけが「押した結果」を直接見ている。<b>④と合わない推測は採っていない。</b></div>
  <table><thead><tr><th>処理</th><th>表</th><th>確度</th><th>関門</th><th>確認</th><th></th><th>根拠</th></tr></thead><tbody>${行}</tbody></table>`, "/actions");
}

/** ─── miniExtensions のフォーム（現行の入力面の本体）─── */

/**
 * **現行システムの入力はほぼ全部 miniExtensions のフォームである。**
 * 定義は `form` 表に入っている（別々の shareId 20件・定義30件）。
 * `db/write.mjs` は**フォームごとの必須・一意・項目ごとの検証・既定値**を実装済みなので、
 * ここは「定義から画面を作って write.mjs に渡す」だけでよい。
 *
 * 現行との違いを1つだけ意図的に変えている。
 * 現行は保存を押してから**約12秒後**に検証エラーが返る（録画 f019→f026 で実測）。
 * こちらは押した時点で返す。**遅いことを写す意味がない。**
 */
const 関連先 = (fid) => 項目.get(fid)?.opts?.関連先 ?? null;

/** 表の候補（関連項目のピッカー用）。主項目の表示値で引く */
function 候補を引く(表ID, 語, 上限 = 300) {
  if (!表ID || !表.has(表ID)) return { 件数: 0, 候補: [] };
  const 主 = db.prepare("SELECT primary_fld FROM tbl WHERE id=?").get(表ID)?.primary_fld;
  const 全 = db.prepare("SELECT id,cells,calc FROM row WHERE tbl=?").all(表ID);
  const 的 = String(語 ?? "").trim().toLowerCase();
  const 出 = [];
  for (const r of 全) {
    const v = { ...JSON.parse(r.calc), ...JSON.parse(r.cells) };
    const 名 = 主 ? String(書く(v[主], 項目.get(主)) ?? "") : r.id;
    if (的 && !名.toLowerCase().includes(的)) continue;
    出.push({ 行: r.id, 名: 名 || r.id });
  }
  出.sort((a, b) => a.名.localeCompare(b.名, "ja", { numeric: true }));
  return { 件数: 出.length, 候補: 出.slice(0, 上限), 全部の数: 全.length };
}

/** 型ごとの入力欄 */
function 定義から欄(x, 値, u, 道) {
  const nm = `v_${x.id}`;
  const 枠 = 'style="padding:5px 7px;border:1px solid #ccd;border-radius:4px;font:inherit"';
  if (x.計算 || x.読み取り専用 || /^(formula|rollup|lookup|count|autoNumber|createdTime|lastModifiedTime)$/.test(x.型 ?? "")) {
    return `<div class=ro>${E(値 ?? "")}<span class=tag style="margin-left:6px">${E(x.型)}・保存後に計算されます</span></div>`;
  }
  if (x.型 === "multipleRecordLinks") {
    const 先 = 関連先(x.id);
    const 語 = u.searchParams.get(`q_${x.id}`) ?? "";
    const { 件数, 候補, 全部の数 } = 候補を引く(先, 語);
    const 今 = String(値 ?? "");
    return `<div>
      <div style="display:flex;gap:5px;align-items:center;flex-wrap:wrap;margin-bottom:4px">
        <input name="q_${E(x.id)}" value="${E(語)}" placeholder="🔍 ${E(表.get(先)?.表示 ?? "候補")}を探す" ${枠} style="padding:5px 7px;border:1px solid #ccd;border-radius:4px;font:inherit;width:210px">
        <button formmethod=get formaction="${E(道)}" class=btn style="background:#eef0f4;color:#333;border:0;cursor:pointer">絞る</button>
        <span class=tag>${件数.toLocaleString()}件${語 ? `／全${(全部の数 ?? 0).toLocaleString()}件` : ""}</span>
      </div>
      <select name="${E(nm)}" ${枠} style="padding:5px 7px;border:1px solid #ccd;border-radius:4px;font:inherit;max-width:min(420px,100%)">
        <option value="">（選んでいません）</option>
        ${候補.map((c) => `<option value="${E(c.行)}"${今 === c.行 ? " selected" : ""}>${E(c.名)}</option>`).join("")}
      </select>
      ${件数 > 候補.length ? `<div class=cond>候補が多いので先頭${候補.length}件だけ出しています。絞ってください</div>` : ""}
      ${先 && !表.has(先) ? `<div class=cond>相手の表 ${E(先)} の行が手元にありません</div>` : ""}</div>`;
  }
  if (x.型 === "singleSelect" || x.型 === "multipleSelects") {
    const 肢 = x.選択肢 ?? [];
    return `<select name="${E(nm)}" ${枠}>
      <option value="">（選んでいません）</option>
      ${肢.map((o) => `<option value="${E(o)}"${String(値) === String(o) ? " selected" : ""}>${E(o)}</option>`).join("")}
    </select>${肢.length ? "" : '<span class=tag>選択肢が手元にありません</span>'}`;
  }
  if (x.型 === "checkbox") {
    return `<input type=checkbox name="${E(nm)}" value="1"${値 === "1" || 値 === true ? " checked" : ""}>`;
  }
  if (x.型 === "multilineText") {
    return `<textarea name="${E(nm)}" rows=3 ${枠} style="padding:5px 7px;border:1px solid #ccd;border-radius:4px;font:inherit;width:min(420px,100%)">${E(値 ?? "")}</textarea>`;
  }
  if (x.型 === "multipleAttachments") {
    return `<div class=ro>添付は写していません<span class=tag style="margin-left:6px">現行に5,688件</span></div>`;
  }
  const t = x.型 === "date" ? "date" : x.型 === "dateTime" ? "datetime-local"
    : /^(number|currency|percent|duration|rating)$/.test(x.型 ?? "") ? "number" : "text";
  return `<input name="${E(nm)}" type="${t}" value="${E(値 ?? "")}" ${枠} style="padding:5px 7px;border:1px solid #ccd;border-radius:4px;font:inherit;width:min(300px,100%)">`;
}

/** フォームを引く。鍵は (shareId, 表ID) */
function フォームを引く(share, tbl) {
  const r = db.prepare("SELECT * FROM form WHERE share=? AND tbl=?").get(share, tbl);
  if (!r) return null;
  return { ...r, sp: JSON.parse(r.spec ?? "{}") };
}

function 外フォームを描く(share, tbl, u, { 文言 = [], 成功 = null } = {}) {
  const f = フォームを引く(share, tbl);
  if (!f) return null;
  /** **`出す項目` に入っているものだけ画面に出す。** write.mjs の制約も同じ基準 */
  const 出す = new Set(f.sp.出す項目 ?? []);
  const 項 = (f.sp.項目 ?? []).filter((x) => x.id && 項目.has(x.id) && (!出す.size || 出す.has(x.id)));
  const 道 = `/mform/${share}/${tbl}`;
  const 値 = (id) => u.searchParams.get(`v_${id}`) ?? "";
  const 子 = db.prepare("SELECT share,tbl,button,spec FROM form WHERE share=? AND tbl<>?").all(share, tbl);

  const 欄 = 項.map((x) => {
    const 名 = x.name || 項目.get(x.id)?.name || x.id;
    return `<div class=k>${E(名)}${x.必須 ? ' <span style="color:#c00">*</span>' : ""}
        ${x.一意にする ? ' <span class=tag>一意</span>' : ""}${x.主項目 ? ' <span class=tag>主項目</span>' : ""}</div>
      <div>${定義から欄(x, 値(x.id), u, 道)}
        ${x.説明 ? `<div class=cond>${E(x.説明)}</div>` : ""}
        ${x.見せる条件 ? `<div class=cond>出す条件: ${E(x.見せる条件)}</div>` : ""}
        ${x.検証 ? `<div class=cond>検証: ${E(x.検証)}${x.エラーの文言 ? ` → 「${E(x.エラーの文言)}」` : ""}</div>` : ""}
        ${x.既定値 != null ? `<div class=cond>既定値: ${E(JSON.stringify(x.既定値))}</div>` : ""}</div>`;
  }).join("");

  const 中身 = `<h1>${E(f.place && f.place !== "?/? " ? f.place.replace(/^\?\/\?\s*/, "") : (表.get(tbl)?.表示 ?? tbl))}</h1>
    <div class=sub>miniExtensions フォーム ・ ${E(表.get(tbl)?.表示 ?? tbl)} ・ shareId <code>${E(share)}</code></div>
    ${文言.length ? `<div class=warn><b>次の項目を修正してください:</b><br>${文言.map((m) => "・" + E(m)).join("<br>")}</div>` : ""}
    ${成功 ? `<div class=el><div class=note style="color:#0a0"><b>保存しました。</b> 行 ${E(成功.行ID)}　計算し直した行 ${成功.再計算した行数}
      ${f.success ? `<br>現行はこの後「${E(f.success)}」と出ます` : ""}
      ${f.webhook ? `<br><b>⚠ 現行はこの後 ${E(f.webhook)} を呼びます。こちらからは呼びません</b>` : ""}</div></div>` : ""}
    <form method=post action="${E(道)}" class=el>
      <div class=elh>${E(f.button && f.button !== "?" ? f.button : "保存")} → ${E(表.get(tbl)?.表示 ?? tbl)}
        <span class=tag>入力欄 ${項.length}</span>
        <span class=tag>必須 ${項.filter((x) => x.必須).length}</span>
        ${f.access ? `<span class=tag>${E(f.access)}</span>` : ""}</div>
      <div class=cells>${欄}</div>
      <div style="padding:10px 12px"><button class=btn style="background:#7c4dff;color:#fff;border:0;cursor:pointer"
        type=submit>${E(f.button && f.button !== "?" ? f.button : "保存")}</button>
        <a href="/forms" style="margin-left:12px;font-size:12px">フォームの一覧へ</a></div>
    </form>
    ${子.length ? `<div class=el><div class=elh>同じ入口の子フォーム <span class=tag>${子.length}</span></div>
      ${子.map((c) => `<div style="padding:7px 12px;border-bottom:1px solid #f2f2f4">
        <a href="/mform/${E(c.share)}/${E(c.tbl)}">${E(表.get(c.tbl)?.表示 ?? c.tbl)}</a>
        <span class=tag style="margin-left:6px">${E(c.button ?? "")}</span>
        <span class=tag>項目 ${(JSON.parse(c.spec ?? "{}").項目 ?? []).length}</span></div>`).join("")}</div>` : ""}
    <div class=el><div class=elh>この入力に効く決まり</div><div class=note>
      保存後の挙動: ${E(f.after ?? "—")}${f.success ? ` ／ 文言「${E(f.success)}」` : ""}<br>
      ${f.webhook ? `<b style="color:#a00">現行は保存後に ${E(f.webhook)} を呼びます。この画面からは呼びません。</b><br>` : ""}
      書いた内容は write_log に残ります。<b>現行のAirtableには一切書きません。</b></div></div>`;
  return 骨(f.place?.replace(/^\?\/\?\s*/, "") || 表.get(tbl)?.表示 || tbl, 中身, "/forms", { 枠なし: true });
}

/** フォームの一覧。**現行の入力面ぜんぶへの入口** */
function フォームの一覧を描く() {
  const 全 = db.prepare("SELECT * FROM form ORDER BY share, is_child").all();
  const 束 = new Map();
  for (const f of 全) (束.get(f.share) ?? 束.set(f.share, []).get(f.share)).push(f);
  const 純正 = db.prepare(`SELECT e.page,e.id,e.spec,p.name pn,b.name bn FROM elem e JOIN page p ON p.id=e.page
    LEFT JOIN bundle b ON b.id=p.bundle WHERE e.type='formContainer'`).all();
  return 骨("フォーム", `<h1>入力の入口 <span class=tag>miniExtensions ${全.length} ／ 純正 ${純正.length}</span></h1>
  <div class=note>現行システムの入力面はほぼ全部 miniExtensions のフォームである。
  定義（項目・必須・一意・項目ごとの検証・既定値・見せる条件・保存後の挙動）を <code>form</code> 表に写してあり、
  検証は <code>db/write.mjs</code> が当てる。<b>保存しても現行のAirtableには書かない。</b></div>
  <div class=el><div class=elh>miniExtensions フォーム <span class=tag>${束.size}入口</span></div>
  <table><thead><tr><th>入口（shareId）</th><th>表</th><th>ボタン</th><th>項目</th><th>必須</th><th>置き場</th><th>保存後</th><th></th></tr></thead><tbody>
  ${[...束].flatMap(([share, fs2]) => fs2.map((f, i) => {
    const sp = JSON.parse(f.spec ?? "{}");
    const 項 = sp.項目 ?? [];
    return `<tr>
      <td>${i === 0 ? `<code>${E(share)}</code>` : `<span style="color:#bbb">└</span>`}${f.is_child ? ' <span class=tag>子</span>' : ""}</td>
      <td>${E(表.get(f.tbl)?.表示 ?? f.tbl)}</td>
      <td>${E(f.button ?? "")}</td>
      <td class=r>${項.length}</td>
      <td class=r>${項.filter((x) => x.必須).length}</td>
      <td style="font-size:11.5px">${E(String(f.place ?? "").replace(/^\?\/\?\s*/, ""))}</td>
      <td style="font-size:11.5px">${E(f.after ?? "")}${f.webhook ? ' <span class=tag style="color:#a00">webhook</span>' : ""}</td>
      <td><a href="/mform/${E(f.share)}/${E(f.tbl)}">開く</a></td></tr>`;
  })).join("")}
  </tbody></table></div>
  <div class=el><div class=elh>純正フォーム（Interface の formContainer） <span class=tag>${純正.length}</span></div>
  <table><thead><tr><th>画面</th><th>束</th><th>作る表</th><th>入力欄</th><th></th></tr></thead><tbody>
  ${純正.map((e) => { const sp = JSON.parse(e.spec ?? "{}");
    return `<tr><td>${E(e.pn)}</td><td>${E(e.bn ?? "（束なし）")}</td><td>${E(sp.作る表 ?? "")}</td>
      <td class=r>${(sp.必須 ?? []).length}必須</td>
      <td><a href="/form/${E(e.page)}/${E(e.id)}">開く</a></td></tr>`; }).join("")}
  </tbody></table></div>`, "/forms");
}

/** 送られた値を型に合わせて直す */
function 外フォームの値(生, 項) {
  const 値 = {};
  for (const x of 項) {
    if (x.計算 || x.読み取り専用) continue;
    const v = 生[`v_${x.id}`];
    if (x.型 === "checkbox") { 値[x.id] = v === "1"; continue; }
    if (v == null || v === "") continue;
    if (x.型 === "multipleRecordLinks") {
      const r = db.prepare("SELECT tbl FROM row WHERE id=?").get(v);
      if (!r) continue;
      const 主 = db.prepare("SELECT primary_fld FROM tbl WHERE id=?").get(r.tbl)?.primary_fld;
      const x2 = db.prepare("SELECT cells,calc FROM row WHERE id=?").get(v);
      const cv = { ...JSON.parse(x2.calc), ...JSON.parse(x2.cells) };
      値[x.id] = [{ foreignRowId: v, foreignRowDisplayName: String(書く(cv[主], 項目.get(主)) ?? "") }];
      continue;
    }
    if (/^(number|currency|percent|duration|rating)$/.test(x.型 ?? "")) { 値[x.id] = Number(v); continue; }
    if (x.型 === "singleSelect" || x.型 === "multipleSelects") {
      /** 選択肢は名前で来る。選択肢IDに直す */
      const o = 項目.get(x.id)?.opts ?? {};
      const 表2 = o.選択肢ID ?? {};
      const id = Object.entries(表2).find(([, n]) => n === v)?.[0];
      値[x.id] = id ?? v;
      continue;
    }
    if (x.型 === "date" && /^\d{4}-\d{2}-\d{2}$/.test(v)) { 値[x.id] = `${v}T00:00:00.000Z`; continue; }
    値[x.id] = v;
  }
  return 値;
}

/**
 * ─── 拡張（app/ext/*.mjs）───
 *
 * serve.mjs 本体を触らずに、要素の描き手・ボタンの動作・入力欄・経路を足す。
 * 各ファイルは次の形を export する（どれも省略可）:
 *   要素:  { <要素の型>: (要素, spec, pid, u, 文脈) => html | null }
 *   ボタン: { <動作>: (要素, spec, pid, { 門, 条件, 色 }, 文脈) => html | null }
 *   欄:   (要素たち, 画面, pid, u, 文脈) => html | null            cellEditor をまとめて描く
 *   画面:  (画面, 要素たち, pid, u, 文脈) => html | null            画面ごと描き替える
 *   経路:  [{ method, pattern: RegExp, handler(req, res, u, m, 文脈) }]
 * 文脈には DB・定義・エンジン・描き手を渡す。**外へつながないのは同じ。**
 */
/** サイドバーで選んでいるベース（?base=販売）。骨() が読む。要求ごとに入れ替える */
let 見せるタブ = null;
const 拡張 = { 要素: new Map(), ボタン: new Map(), 欄: [], 画面: [], 経路: [], 仕上げ: [] };
/** 本文を読む。同じ鍵が複数回来たら（<select multiple>・多重の関連）配列にする。1 つなら文字列のまま */
const 複数値を残す = (体) => { const q = new URLSearchParams(体); const o = {}; for (const k of new Set(q.keys())) { const a = q.getAll(k); o[k] = a.length > 1 ? a : a[0]; } return o; };
const 本文を読む = (req) => new Promise((ok) => { let 体 = ""; req.on("data", (d) => { 体 += d; if (体.length > 4e6) req.destroy(); }); req.on("end", () => ok(複数値を残す(体))); });
const 文脈 = {
  db, ROOT, 項目, 表, 表を名前で, E, 骨, 書く, 右寄せか, 色, ボタンの色, 外部か, 引き金か,
  実行, 書き込み, 動作, 帳票の種類, 本文を読む, 計算器: 書き込み.計算器,
  一覧を描く, 一覧の行, 一覧のCSV, 操作を読む, 利用者の絞り込み, 検索で絞る, 道を組む, 器を探す,
  門を当てる, ボタンを描く, 欄を描く, フォームの入口, 画面を描く, フォームを描く, 外フォームを描く, 候補を引く, 関連の形にする, 値を整える,
  操作のチップ,
  索引を描く, 動作の画面, 帳票を出す, 拡張,
  出す: (res, html, code = 200) => { res.writeHead(code, { "content-type": "text/html; charset=utf-8" }); res.end(html); },
};
{
  const dir = path.join(ROOT, "app", "ext");
  const files = fs.existsSync(dir) ? fs.readdirSync(dir).filter((f) => f.endsWith(".mjs")).sort() : [];
  for (const f of files) {
    try {
      const m = await import(path.join(dir, f));
      for (const [k, v] of Object.entries(m.要素 ?? {})) 拡張.要素.set(k, v);
      for (const [k, v] of Object.entries(m.ボタン ?? {})) 拡張.ボタン.set(k, v);
      if (m.欄) 拡張.欄.push(m.欄);
      if (m.画面) 拡張.画面.push(m.画面);
      for (const r of m.経路 ?? []) 拡張.経路.push(r);
      for (const f of m.仕上げ ?? []) 拡張.仕上げ.push(f);   // (html, 画面, u, 文脈) => html。後ろの拡張が前の出力に足す
      if (typeof m.準備 === "function") m.準備(文脈);
    } catch (e) { console.error(`拡張 ${f} を読めません: ${e.message}`); }
  }
  if (files.length) console.log(`拡張 ${files.length}本: 要素${拡張.要素.size} ボタン${拡張.ボタン.size} 欄${拡張.欄.length} 画面${拡張.画面.length} 経路${拡張.経路.length} 仕上げ${拡張.仕上げ.length}`);
}

/** ─── サーバ ─── */
http.createServer((req, res) => {
  const u = new URL(req.url, "http://localhost");
  見せるタブ = u.searchParams.get("base");
  const 出す = (html, code = 200) => { res.writeHead(code, { "content-type": "text/html; charset=utf-8" }); res.end(html); };
  try {
    for (const r of 拡張.経路) {
      if (r.method && r.method !== req.method) continue;
      const m = u.pathname.match(r.pattern);
      if (m) { const out = r.handler(req, res, u, m, 文脈); if (out && typeof out.catch === "function") out.catch((e) => { console.error(e); if (!res.headersSent) 出す(骨("エラー", `<h1>エラー</h1><pre>${E(e.stack ?? e.message)}</pre>`, null), 500); }); return; }
    }
    /** 一覧の操作感（列幅・固定列・行の高さ）。骨() が読む。中身は app/ui.js */
    if (u.pathname === "/ui.js") {
      const p = path.join(ROOT, "app", "ui.js");
      res.writeHead(200, { "content-type": "text/javascript; charset=utf-8", "cache-control": "no-cache" });
      return res.end(fs.readFileSync(p));
    }
    if (u.pathname === "/") return 出す(索引を描く());
    if (u.pathname === "/gates") return 出す(門の一覧());
    if (u.pathname === "/actions") return 出す(動作の一覧());
    if (u.pathname === "/forms") return 出す(フォームの一覧を描く());

    /** miniExtensions フォーム。鍵は (shareId, 表ID) */
    const mf = u.pathname.match(/^\/mform\/([A-Za-z0-9_:-]+)\/(tbl[A-Za-z0-9]+)$/);   // share は fillout:<id> の形もある
    if (mf) {
      const [, share, tbl] = mf;
      if (req.method === "GET") { const h = 外フォームを描く(share, tbl, u); return h ? 出す(h) : 出す(骨("404", "<h1>そのフォームはありません</h1>", null), 404); }
      if (req.method === "POST") {
        let 体 = "";
        req.on("data", (d) => { 体 += d; if (体.length > 1e6) req.destroy(); });
        req.on("end", () => {
          const 生 = Object.fromEntries(new URLSearchParams(体));
          const f = フォームを引く(share, tbl);
          if (!f) return 出す(骨("404", "<h1>そのフォームはありません</h1>", null), 404);
          const 出すべき = new Set(f.sp.出す項目 ?? []);
          const 項 = (f.sp.項目 ?? []).filter((x) => x.id && (!出すべき.size || 出すべき.has(x.id)));
          const 値 = 外フォームの値(生, 項);
          const r = 書き込み.作る(tbl, 値, {
            出どころ: `mxフォーム ${share}/${tbl}`,
            フォーム: `mx:${share}|${tbl}|${f.button}`,
          });
          /** 入れた値をURLに戻して、直すときに打ち直さなくてよいようにする */
          const q = new URLSearchParams();
          for (const [k, v] of Object.entries(生)) if (/^[vq]_/.test(k)) q.set(k, v);
          const u2 = new URL(`http://x${u.pathname}?${q}`);
          出す(外フォームを描く(share, tbl, r.行ID ? new URL(`http://x${u.pathname}`) : u2,
            r.行ID ? { 成功: r } : { 文言: r.文言 }));
        });
        return;
      }
    }
    const am = u.pathname.match(/^\/do\/([^/]+)\/([^/]+)$/);
    if (am) {
      const [, pid, eid] = am;
      if (req.method === "GET") { const h = 動作の画面(pid, eid); return h ? 出す(h) : 出す(骨("404", "<h1>その動作はありません</h1>", null), 404); }
      if (req.method === "POST") {
        let 体 = "";
        req.on("data", (dd) => { 体 += dd; if (体.length > 1e6) req.destroy(); });
        req.on("end", () => {
          const 生 = Object.fromEntries(new URLSearchParams(体));
          const p = db.prepare("SELECT name FROM page WHERE id=?").get(pid);
          const d = 動作.要素から(eid, p?.name ?? null);
          if (!d) return 出す(骨("404", "<h1>その動作はありません</h1>", null), 404);
          const 引数 = {};
          for (const k of d.引数 ?? []) if (生[k] != null) 引数[k] = 生[k];
          const r = 動作.押す(d.鍵, 生.row || null, { 確認済み: 生.ok === "1", 出どころ: `画面 ${pid}/${eid}`, 引数 });
          出す(動作の画面(pid, eid, { 選んだ: 生.row || null, 結果: r.確認待ち ? null : r, 確認待ち: r.確認待ち ?? null }));
        });
        return;
      }
    }
    if (u.pathname === "/docs") return 出す(帳票の一覧());
    const dm = u.pathname.match(/^\/doc\/([^/]+)\/(.+)$/);
    if (dm) {
      const h = 帳票を出す(decodeURIComponent(dm[1]), decodeURIComponent(dm[2]));
      return h ? 出す(h) : 出す(骨("404", "<h1>その帳票はありません</h1>", null), 404);
    }
    const gm = u.pathname.match(/^\/gate\/(fld[A-Za-z0-9]+)$/);
    if (gm) {
      if (req.method === "GET") { const h = 門を試す画面(gm[1]); return h ? 出す(h) : 出す(骨("404", "<h1>その門はありません</h1>", null), 404); }
      if (req.method === "POST") {
        let 体 = "";
        req.on("data", (d) => { 体 += d; if (体.length > 1e6) req.destroy(); });
        req.on("end", () => 出す(門を試す画面(gm[1], { 値: Object.fromEntries(new URLSearchParams(体)) })));
        return;
      }
    }
    const m = u.pathname.match(/^\/p\/(pag[A-Za-z0-9]+)$/);
    if (m) { const h = 画面を描く(m[1], u); return h ? 出す(h) : 出す(骨("見つかりません", "<h1>その画面はありません</h1>", null), 404); }

    /** 一覧のCSV書き出し。画面と同じ絞り込み・並び・検索を当てて出す */
    const cm = u.pathname.match(/^\/csv\/(pag[A-Za-z0-9]+)\/(pel[A-Za-z0-9]+)$/);
    if (cm) {
      const r = 一覧のCSV(cm[1], cm[2], u);
      if (!r) return 出す(骨("404", "<h1>その一覧はありません</h1>", null), 404);
      res.writeHead(200, {
        "content-type": "text/csv; charset=utf-8",
        "content-disposition": `attachment; filename*=UTF-8''${encodeURIComponent(r.名)}`,
      });
      return res.end(r.中身);
    }

    const fm = u.pathname.match(/^\/form\/(pag[A-Za-z0-9]+)\/(pel[A-Za-z0-9]+)$/);
    if (fm) {
      const [, pid, eid] = fm;
      if (req.method === "GET") {
        /** クエリの fld… は既定値（addForeignRow が親の行を渡す）。作る表の項目に限る */
        const sp0 = JSON.parse(db.prepare("SELECT spec FROM elem WHERE page=? AND id=?").get(pid, eid)?.spec ?? "{}");
        const 値 = {};
        for (const [k, v] of u.searchParams) if (/^fld[A-Za-z0-9]+$/.test(k) && v !== "" && 項目.get(k)?.tbl === sp0.作る表ID) 値[k] = v;
        const h = フォームを描く(pid, eid, { 値 }); return h ? 出す(h) : 出す(骨("404", "<h1>そのフォームはありません</h1>", null), 404);
      }
      if (req.method === "POST") {
        let 体 = "";
        req.on("data", (d) => { 体 += d; if (体.length > 1e6) req.destroy(); });
        req.on("end", () => {
          const 生 = 複数値を残す(体);
          const e = db.prepare("SELECT spec FROM elem WHERE page=? AND id=?").get(pid, eid);
          const sp = JSON.parse(e?.spec ?? "{}");
          const 欄 = db.prepare("SELECT id,fld,read_only,spec FROM elem WHERE page=? AND type=?").all(pid, "cellEditor")
            .filter((x) => { const s2 = x.spec ? JSON.parse(x.spec) : {}; return s2.行の出どころ === sp.出力; })
            .filter((x) => !x.read_only);
          /** 欄に無い関連項目（addForeignRow の親など）は hidden で来る。作る表の関連項目に限る */
          const 隠し = Object.keys(生).filter((k) => /^fld[A-Za-z0-9]+$/.test(k) && !欄.some((x) => x.fld === k) && 項目.get(k)?.tbl === sp.作る表ID && 項目.get(k)?.type === "foreignKey").map((k) => ({ fld: k }));
          const 値 = 値を整える(生, [...欄, ...隠し]);
          const r = 書き込み.作る(sp.作る表ID, 値, {
            出どころ: `純正フォーム ${pid}/${eid}`, 既定: sp.既定値,
            フォーム: `native:${pid}|${eid}`,
          });
          出す(フォームを描く(pid, eid, r.行ID ? { 成功: r } : { 値, 文言: r.文言 }));
        });
        return;
      }
    }
    出す(骨("見つかりません", "<h1>404</h1>", null), 404);
  } catch (e) {
    出す(骨("落ちました", `<h1>落ちました</h1><pre>${E(e.stack)}</pre>`, null), 500);
  }
/**
 * 待ち受ける口。既定はこれまでどおり全部（手元での使い方を変えない）。
 * 常駐サーバでは deploy の入口が HOST=127.0.0.1 を渡すので、外から直接は届かず、
 * Basic 認証をかけた受付しか通れなくなる。
 */
}).listen(PORT, process.env.HOST || "0.0.0.0", () => console.log(`http://${process.env.HOST || "localhost"}:${PORT}  （ローカルDBのみ・外部通信なし）`));
