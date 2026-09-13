/**
 * 製造の帳票を組む。**原料棚卸表・仕掛品棚卸表・製造表。** ローカルDBの行だけで組む。外へは一切つながない。
 *
 *   app/ext/60-docs.mjs が `帳票` を読み、/docs と /doc/<種>/<鍵> に出す。共通の部品（紙に載せる・数・年月日…）は
 *   app/doc-sales.mjs から借りる（doc.mjs は export していない）。
 *
 * ■ 原料棚卸表 — 実物 9 件（分類ごとに 1 枚。crawl/out/artifacts/製造-分類-原料棚卸表__<分類rec>__【本使用】TTCF原材料棚卸し.pdf）
 *
 * 紙は **A4 横**、Producer Skia/PDF（ヘッドレスChromium）。現行は 分類.棚卸表作成 ボタン（Make の webhook）が作り、分類.原料棚卸表 に添付する。
 * 読んだ実物: 05ダンボール（2 頁・原材料 19・入庫 31 行）。見出し左に 分類名、右に日付 2026-08-31、最後に 合計 行と 確認者 の枡。
 *
 *   紙の列          実物の例                 出どころ（製造/入庫 tbl3taxsMw9Vq4rJe）
 *   ────────────   ──────────────────────   ──────────────────────────────────────────────────────────
 *   （見出し左）    05ダンボール              分類 fldRtXbyHu9scCm2Q の関連の表示名（製造/分類.Name）
 *   （見出し右）    2026-08-31               **在庫残高設定日 fldOo6AF2YZlToq7i**（締処理表の日付。在庫残高 の列はこの日で計算されている）
 *   原料名          0500084 冷凍生餡5㎏×2入   原材料 fldoe1gvFBvRHy822 の関連の表示名（製造/原材料.ID = 分類2桁+連番+名）
 *   仕入先          日進化学                 仕入先 fldNQcgslCFh9eKvC の関連の表示名（211/2,178 行にしか無い。無い行は空欄。実物も空欄の行がある）
 *   期首在庫        249.00                   **期首在庫3 fldLzI9YBFUekZaBp**（前締日時点の実在庫）の原材料ごとの和。無ければ 前月末在庫 fldzCeZDwLQNtbIJW
 *   入庫日          2026-07-15               入庫日 fldGHv1M81qSaoaye
 *   入庫時数量      480.00                   入庫数量(kg) fld16kaj4lDvNVQ7G
 *   発注書NO        260709-1611              発注No fldnTWSBnxL3oaihY（発注明細→発注書 の lookup を IF で束ねた式）
 *   在庫(kg)        350.00                   **実在庫数量(kg) 在庫残高 fldaU3E5vjcur3QOR**（在庫残高設定日までの出庫を引いた残り）
 *   単価            ¥89.10                   単価 fldNaCAyqrgIMhXYd
 *   小計            ¥31,185                  月末在庫金額 fldTdoUlFbWyandqd（= 在庫残高 × 単価。0 以下なら 0）
 *   期末在庫        350.00                   原材料ごとの 在庫(kg) の和
 *   在庫評価額      ¥31,185                  原材料ごとの 小計 の和
 *   合計            11,862.00 / 11,325.00 / ¥531,592   期首在庫・期末在庫・在庫評価額 の全体の和
 *
 * どの入庫行を載せるか: 実物は「期首に残っていた lot」と「期中に入った lot」を載せ、在庫 0.00 の lot も出している
 * （0500084 の 2026-07-15 lot は 在庫 0.00 で載る）。手元の断面で判定できる形に写すと
 *   **期首在庫3 が 0 より大きい ∨ 在庫残高 の値が来ている**（在庫残高 の列は棚卸表の画面 pag74Bg4QiBcQ4vc3 が要求した 280 行にしか無い）。
 * 数字は当方の断面（2026-09-11）の 在庫残高設定日 で計算された値なので、2026-08-31 の実物とは lot が同じでも量が違う
 * （0500084 の 2026-08-26 lot: 実物 350.00 → 当方 218.00。9/1〜9/11 の出庫 132 kg ぶん）。**これは断面の差で、組みの差ではない。**
 *
 * ■ 仕掛品棚卸表 — 実物 2 件（保管先ごとに 1 枚。crawl/out/artifacts/製造-保管先-仕掛品棚卸表__<保管先rec>__2026-08-31-TTCF棚卸表.pdf）
 *
 * 紙は **A4 横**、Producer **PrinceXML 16.1**（他と別系統）。左端に保管先名を縦書きで通し、2 頁目に 確認者 の枡だけ。
 * 読んだ実物: 冷凍・冷蔵（原料名 8・行 24）、選別（原料名 15・行 27）。日付の列の見出しが **冷凍・冷蔵は「製造日」、選別は「選別日」**。
 *
 *   紙の列            実物の例        出どころ（製造/仕掛入庫 tblp0szvkXNAXWEwA）
 *   ───────────────  ─────────────   ──────────────────────────────────────────────────────────
 *   （見出し左）      冷凍・冷蔵       製造/保管先.Name。仕掛入庫.保管先 fldxsApnJ1z9leFMh の関連先は同じ 保管先 表（冷凍 rec9aqdwnrk1L7FO7・冷蔵 recVLVc7B1JfWx8Bm の行が手元に無いだけ）。直接の辺と 仕掛品.保管先 経由の和で束ねる
 *                                    仕掛品 tblMyYJNNBt3C2GKB.保管先 fldzmUt8bjZynQYjr（辺 179）→ 仕掛入庫.仕掛品名 fld31qwXm8U2hQtzx で束ねる
 *   （見出し右）      2026-08-31      在庫残高設定日 fld8me0abZZDaSIIp
 *   原料名            上白 生あん      仕掛品名 fld31qwXm8U2hQtzx の関連の表示名
 *   期首在庫          1,345.1         期首在庫3 fldXqInhMebIwc3tA の仕掛品ごとの和
 *   製造日 / 選別日   26.8.7          入庫日/仕掛生産日 fldjCjm0i9Q8Oqrwf を **YY.M.D**（ゼロ埋め無し）
 *   在庫（kg）        260.0           実在庫数量(kg)在庫残高 fldE0VvVTzBPHHYRc（小数 1 桁）
 *   単価              156.70          原材料kg単価+ fldlXymR3px8ZcqUO（小数 2 桁。¥ 無し）
 *   小計              40,743          月末在庫金額 fldaQAtyw3IQdoO3l（整数。¥ 無し）
 *   在庫合計（kg）    1,315.0         仕掛品ごとの 在庫 の和
 *   在庫評価額        209,670         仕掛品ごとの 小計 の和
 *   合計              4,295.1 / 3,233.3 / 594,929   期首・在庫合計・評価額 の全体の和
 *
 * ■ 製造表 — 実物 44 件（**JPEG**。製造/商品.製造表 fldtff1GYYc5tJJc4 の添付。名は「作業表(粒あん）2023-09-03.numbers 11.jpeg」「新作業表　漉し餡 6.jpeg」）
 *
 * 読んだ実物 3 枚（Tつぶあん-53S・漉し餡 1・白粒あん 1）は **商品ごとに人が Numbers で作った作業標準の紙**で、DB の行から出したものではない。
 * 中身は左に 配合表（品名・工程・作業方法・標準時間・豆煮No・投入/開始/終了時間・蒸気圧）、右に 原料名（品名・Lot No・仕込み量・単位・仕込者・確認・投入順序）
 * と 練釜（工程・作業方法・標準時間・練釜No・時間）、再生品・使用原料・撹拌羽根の確認・品質確認・担当者・備考欄。
 * DB にあるのは右上の **原料名の表に当たるもの**（生産指示の使用原材料＝製造/出庫）と、見出しの 品名・製造日・ロットNO・出来高 だけ。
 * 工程・作業方法・標準時間・蒸気圧 は DB のどこにも無い（商品マスタにも無い）ので、**枡だけ写して空欄にする**（現場が手で書く欄と同じ扱い）。
 *
 *   紙の場所              出どころ
 *   ───────────────────  ──────────────────────────────────────────────────────────
 *   品名                  製品生産 tblKBlEDBVxWjS5ep.製品名 fld8MS9rMjV7oLY5J（lookup）／製品 fldeUlgoD3fPI5JwE の関連（製造/商品.製品ID）
 *   製造日・ロットNO      製造日 flddd3n2fLMWxNaBR・ロットNO fldqSPHKnJEgnBo3p（S6-YYYYMMDD-連番）・生産ID fldQj3DnIBBmsroaC
 *   数量(kg)・ロット数    出来高(kg) fldUYV4rQgW2BkfnV・ロット数 fldwesf87P79NeATc・在庫計上数(kg) fldQfhzRBEdcV12BI・ケース fldR5ib95JYl9d5PJ・賞味期限 fldAbJXnphEK6fLO2
 *   原料名の表            **製造/出庫 tbldI0k3JugVOVqwU は DB に 0 行。** 生産指示編集 Form を開いて控えた 412 行（crawl/out/raw/bom/<製品生産rec>.jsonl、
 *                         fetchInitialTableIdsToLinkedTableStates の応答）から読む。品名・Lot No は 出庫検索キー fldMqso6f6cHti6ep（「発注番号-原材料名」）、
 *                         仕込み量 は 出庫数量(kg) fldo2gXW9ByTqTo77（56/412 行にしか値が無い。364 行は 0 のまま人が後で入れる）、
 *                         参考に fldlK6ore6HdZGxM7（引当 lot の実在庫。スキーマに無い項目）。使用仕掛品（tblUxvNe9NT5EFRU0）も同じ応答にある。
 *                         控えが無い生産指示は **同じ製品の直前の控え**を「配合の写し」として出す（同じ製品の 2 件で原材料の集合は 10/10 同一と確認済み）。
 *   豆(kg)・糖(kg)・仕掛豆(kg)・原材料合計・原価単価   製品生産 の rollup/式（fld58KKsqdlqGDVQY・fldcYLys8EfdRz4fp・fld9sUjoOLV9ZCWH0・fldXOE1Z47BGqU1Ia・fldxxKG2VdtuUQ6NS）
 */
import fs from "node:fs";
import path from "node:path";
import { 紙に載せる, 数, 円, 数値, 文字, 関連先ID, 年月日, 日付, 日付部 } from "./doc-sales.mjs";

const E = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));

const T = {
  入庫: "tbl3taxsMw9Vq4rJe", 仕掛入庫: "tblp0szvkXNAXWEwA", 仕掛品: "tblMyYJNNBt3C2GKB", 分類: "tblhGZ74i6sqZ79XM", 保管先: "tblwe3kswLJfA9SsG",
  製品生産: "tblKBlEDBVxWjS5ep", 商品: "tblKlBAO8mydnK5kt", 出庫: "tbldI0k3JugVOVqwU", 仕掛出庫: "tblUxvNe9NT5EFRU0",
};
const F = {
  入_入庫日: "fldGHv1M81qSaoaye", 入_数量: "fld16kaj4lDvNVQ7G", 入_単価: "fldNaCAyqrgIMhXYd", 入_発注No: "fldnTWSBnxL3oaihY",
  入_分類: "fldRtXbyHu9scCm2Q", 入_原材料: "fldoe1gvFBvRHy822", 入_仕入先: "fldNQcgslCFh9eKvC",
  原_仕入先: "fldwK3OUO412k412i",   // 原材料マスタの仕入先。実物の「仕入先」列はこちら（05ダンボール 20 品: 日進化学 17・大王 2・空 1。入庫.仕入先 だと 20 品全部 大王になった。検証 2026-09-13）
  仕入_保管先: "fldxsApnJ1z9leFMh",   // 仕掛入庫.保管先（辺 1,788。関連先は同じ 保管先 表）
  入_期首3: "fldLzI9YBFUekZaBp", 入_前月末: "fldzCeZDwLQNtbIJW", 入_在庫残高: "fldaU3E5vjcur3QOR", 入_月末金額: "fldTdoUlFbWyandqd", 入_設定日: "fldOo6AF2YZlToq7i",
  分_Name: "flds1iBejJc55lUKy", 分_締日: "fldSgGEdLD8oVRxP3",
  保_Name: "fldk4TquXO3cXUsGu", 保_締日: "fldxt8fySk0kfARqr", 仕品_保管先: "fldzmUt8bjZynQYjr", 仕品_名: "fldY459LqWakI5pyo",
  仕_日: "fldjCjm0i9Q8Oqrwf", 仕_品名: "fld31qwXm8U2hQtzx", 仕_実数: "fld48gjOEu7IFx5IU", 仕_単価: "fldlXymR3px8ZcqUO",
  仕_在庫残高: "fldE0VvVTzBPHHYRc", 仕_月末金額: "fldaQAtyw3IQdoO3l", 仕_期首3: "fldXqInhMebIwc3tA", 仕_設定日: "fld8me0abZZDaSIIp",
  生_ID: "fldQj3DnIBBmsroaC", 生_製造日: "flddd3n2fLMWxNaBR", 生_ロット: "fldqSPHKnJEgnBo3p", 生_製品: "fldeUlgoD3fPI5JwE", 生_製品名: "fld8MS9rMjV7oLY5J",
  生_出来高: "fldUYV4rQgW2BkfnV", 生_ロット数: "fldwesf87P79NeATc", 生_計上数: "fldQfhzRBEdcV12BI", 生_ケース: "fldR5ib95JYl9d5PJ", 生_賞味期限: "fldAbJXnphEK6fLO2",
  生_豆: "fld58KKsqdlqGDVQY", 生_糖: "fldcYLys8EfdRz4fp", 生_仕掛豆: "fld9sUjoOLV9ZCWH0", 生_原材料合計: "fldXOE1Z47BGqU1Ia", 生_原価単価: "fldxxKG2VdtuUQ6NS",
  商_製品ID: "fldPczwba5tbUD3VF", 商_商品名1: "fldDEsvW4stNpqbG3", 商_糖度: "fldwoTAAseUa8RcSz", 商_硬さ: "fldaQimfcQppCZGpd", 商_釜容量: "fldr6eoP7KdPRw0O3", 商_ロットkg: "fldLqOXbYgoPQcbYY",
  出_ID: "fld34AbGYx3nTtUAz", 出_日: "fldKD3VqtzIRzSIsR", 出_キー: "fldMqso6f6cHti6ep", 出_数量: "fldo2gXW9ByTqTo77", 出_実在庫: "fldlK6ore6HdZGxM7",
  仕出_ID: "fldSbgtPU8V23LGQu", 仕出_日: "fldpQlEbyhJ7f0xGJ", 仕出_数量: "fldAG50j8gq097DdK", 仕出_実在庫: "fldgsimFn6qtg3Iuw", 仕出_キー: "fldZQF7gf8m9TjzHC",
};

/** 値は生の形で読む（doc-sales.mjs の 器 と同じ理由: 関連先の行IDが要る） */
function 器(db, 文脈) {
  const c = 文脈.書き込み.計算器;
  return { c, 行: (rid) => (rid ? c.取る(rid) : null), 値: (r, fid) => (r ? c.値(r, fid, true) : undefined) };
}
/** "26.8.7"。仕掛品棚卸表の日付はこの形（ゼロ埋め無し・西暦下 2 桁） */
const 短い日付 = (v) => { const p = 日付部(v); return p ? `${p.y.slice(2)}.${Number(p.m)}.${Number(p.d)}` : ""; };
/** 関連の表示名。lookup で束ねて来たものも平らに */
const 名 = (v) => 文字(v);

/** 棚卸表の共通の紙。A4 横・確認者の枡 */
const 棚卸のCSS = `
.見出し{display:flex;justify-content:space-between;font-size:10pt;margin-bottom:4pt}
table.棚{font-size:8pt}
table.棚 th{background:#eee;padding:4pt 2pt}
table.棚 td{padding:2pt 3pt;border-top:1px dotted #666;border-bottom:1px dotted #666}
table.棚 td.群{border-top:1px solid #000;vertical-align:top}
table.棚 tr.頭 td{border-top:1px solid #000}
table.棚 tr.合計 td{border:1px solid #000;font-weight:600}
.確認者{width:34mm;margin:10pt 0 0 auto;border:1px solid #000}
.確認者 div:first-child{border-bottom:1px solid #000;text-align:center;padding:2pt}
.確認者 div:last-child{height:24mm}
.縦{writing-mode:vertical-rl;text-align:center;width:6mm;padding:2pt}
`;

/* ═══════════════════════════════════════════════════════════════════
 * 原料棚卸表（分類ごと）
 * ═══════════════════════════════════════════════════════════════════ */

/** 分類の行を 鍵（行ID か Name）で引く */
function 分類を引く(db, 文脈, 鍵) {
  const { 行, 値 } = 器(db, 文脈);
  if (/^rec[A-Za-z0-9]{14}$/.test(鍵)) { const r = 行(鍵); return r && r.tbl === T.分類 ? r : null; }
  for (const r of db.prepare("SELECT id FROM row WHERE tbl=?").all(T.分類)) { const x = 行(r.id); if (x && 文字(値(x, F.分_Name)) === 鍵) return x; }
  return null;
}

export function 原料棚卸表を組む(db, 鍵, 文脈) {
  const { 行, 値 } = 器(db, 文脈);
  const 分類 = 分類を引く(db, 文脈, 鍵); if (!分類) return null;
  const 分類名 = 文字(値(分類, F.分_Name));
  /** 分類 の関連で絞る（cells の [{foreignRowId}]。2,178 行すべてに 分類 がある） */
  const 群 = new Map();   // 原材料の表示名 → 行たち
  let 設定日 = "", 補った = 0;
  for (const r of db.prepare("SELECT id FROM row WHERE tbl=? AND json_extract(cells,'$.fldRtXbyHu9scCm2Q[0].foreignRowId')=?").all(T.入庫, 分類.id)) {
    const x = 行(r.id); if (!x) continue;
    const 期首3 = 数値(値(x, F.入_期首3));
    /** 期首在庫3 が無い lot は 前月末在庫（人が入れる number・93 行）で補う。Airtable の式にはこの補いは無いので、使った数を紙の下に書く */
    if (期首3 == null && 数値(値(x, F.入_前月末)) != null) 補った++;
    const 期首 = 期首3 ?? 数値(値(x, F.入_前月末));
    const 在庫 = 数値(値(x, F.入_在庫残高));
    if (!(期首 > 0) && 在庫 == null) continue;   // 期首にも無く、締処理の画面も要求していない lot は載らない
    const d = 日付(値(x, F.入_設定日)); if (d > 設定日) 設定日 = d;
    const k = 名(値(x, F.入_原材料)) || "（原材料なし）";
    /** 仕入先は原材料マスタの値（実物と一致）。マスタに無いときだけ入庫の仕入先で補う */
    const 原材料行 = 行(関連先ID(値(x, F.入_原材料))[0] ?? "");
    const 仕入先 = (原材料行 && 名(値(原材料行, F.原_仕入先))) || 名(値(x, F.入_仕入先));
    (群.get(k) ?? 群.set(k, []).get(k)).push({
      入庫日: 日付(値(x, F.入_入庫日)), 数量: 数値(値(x, F.入_数量)), 発注No: 文字(値(x, F.入_発注No)), 仕入先,
      期首, 在庫: 在庫 ?? 0, 単価: 数値(値(x, F.入_単価)), 小計: 数値(値(x, F.入_月末金額)) ?? Math.max(0, (在庫 ?? 0) * (数値(値(x, F.入_単価)) ?? 0)),
    });
  }
  const 原材料たち = [...群.keys()].sort();
  let 期首計 = 0, 期末計 = 0, 額計 = 0;
  const 行々 = 原材料たち.map((k) => {
    const lots = 群.get(k).sort((a, b) => a.入庫日.localeCompare(b.入庫日));
    const 期首 = lots.reduce((s, l) => s + (l.期首 ?? 0), 0), 期末 = lots.reduce((s, l) => s + l.在庫, 0), 額 = lots.reduce((s, l) => s + (l.小計 ?? 0), 0);
    期首計 += 期首; 期末計 += 期末; 額計 += 額;
    const 仕入先 = lots.map((l) => l.仕入先).find(Boolean) ?? "";
    return lots.map((l, i) => `<tr${i === 0 ? " class=頭" : ""}>
      ${i === 0 ? `<td class=群 rowspan=${lots.length}>${E(k)}</td><td class=群 rowspan=${lots.length}>${E(仕入先)}</td><td class="群 r" rowspan=${lots.length}>${E(数(期首, 2))}</td>` : ""}
      <td class=c>${E(l.入庫日)}</td><td class=r>${E(数(l.数量, 2))}</td><td class=c style="font-size:7pt">${E(l.発注No)}</td>
      <td class=r>${E(数(l.在庫, 2))}</td><td class=r>${E(円(l.単価, 2))}</td><td class=r>${E(円(l.小計))}</td>
      ${i === 0 ? `<td class="群 r" rowspan=${lots.length}>${E(数(期末, 2))}</td><td class="群 r" rowspan=${lots.length}>${E(円(額))}</td>` : ""}</tr>`).join("");
  }).join("");
  const 締日 = 日付(値(分類, F.分_締日));
  const 中 = `<div class=見出し><div>${E(分類名)}</div><div>${E(設定日 || 締日)}</div></div>
  <table class=棚><thead><tr><th style="width:20%">原料名</th><th style="width:9%">仕入先</th><th>期首在庫</th><th>入庫日</th><th>入庫時数量</th><th>発注書NO</th><th>在庫(kg)</th><th>単価</th><th>小計</th><th>期末在庫</th><th>在庫評価額</th></tr></thead>
  <tbody>${行々 || `<tr><td colspan=11 class=注>この分類には、期首に残っていた lot も締処理の画面が要求した lot も手元にありません</td></tr>`}
  <tr class=合計><td colspan=2 class=r>合計</td><td class=r>${E(数(期首計, 2))}</td><td colspan=6 style="border:0"></td><td class=r>${E(数(期末計, 2))}</td><td class=r>${E(円(額計))}</td></tr></tbody></table>
  <div class=確認者><div>確認者</div><div></div></div>
  <div class=当方>${補った ? `期首在庫3 が手元に無い ${補った} lot は 前月末在庫（入力値）で補った（当方の補い。Airtable の式には無い）。` : ""}日付は 在庫残高設定日（締処理表の値）。在庫(kg)・小計 はこの日までの出庫を引いた値で、分類.締日は ${E(締日 || "—")}。期首在庫は前締日時点の残り（期首在庫3）。</div>`;
  return 紙に載せる(`原料棚卸表 ${分類名}`, 中, { 横: true, 追加CSS: 棚卸のCSS });
}

function 分類の一覧(db, 文脈) {
  const { 行, 値 } = 器(db, 文脈);
  return db.prepare("SELECT id FROM row WHERE tbl=?").all(T.分類).map((r) => 行(r.id)).filter(Boolean)
    .map((x) => ({ 鍵の値: x.id, 表示: 文字(値(x, F.分_Name)), 補足: `締日 ${日付(値(x, F.分_締日)) || "—"}`, 順: 文字(値(x, F.分_Name)) }))
    .sort((a, b) => a.順.localeCompare(b.順));
}

/* ═══════════════════════════════════════════════════════════════════
 * 仕掛品棚卸表（保管先ごと）
 * ═══════════════════════════════════════════════════════════════════ */

function 保管先を引く(db, 文脈, 鍵) {
  const { 行, 値 } = 器(db, 文脈);
  if (/^rec[A-Za-z0-9]{14}$/.test(鍵)) { const r = 行(鍵); return r && r.tbl === T.保管先 ? r : null; }
  for (const r of db.prepare("SELECT id FROM row WHERE tbl=?").all(T.保管先)) { const x = 行(r.id); if (x && 文字(値(x, F.保_Name)) === 鍵) return x; }
  return null;
}

export function 仕掛品棚卸表を組む(db, 鍵, 文脈) {
  const { 行, 値 } = 器(db, 文脈);
  const 保管先 = 保管先を引く(db, 文脈, 鍵); if (!保管先) return null;
  const 保管先名 = 文字(値(保管先, F.保_Name));
  /** 仕掛品.保管先（辺 179 本）で仕掛品を集め、その仕掛品を指す仕掛入庫を載せる */
  const 仕掛品IDs = new Set(db.prepare("SELECT src_row FROM link WHERE fld=? AND dst_row=?").all(F.仕品_保管先, 保管先.id).map((r) => r.src_row));
  for (const r of db.prepare("SELECT id FROM row WHERE tbl=? AND json_extract(cells,'$.fldzmUt8bjZynQYjr[0].foreignRowId')=?").all(T.仕掛品, 保管先.id)) 仕掛品IDs.add(r.id);
  /**
   * 仕掛入庫.保管先（辺 1,788。選別 880・冷凍 249・冷蔵 659）の**直接の辺**も和で取る。
   * 仕掛品マスタに保管先の無い品の lot（選別で 2 件・在庫 10 と 30）が、仕掛品.保管先 経由だけだと落ちた（検証 2026-09-13）。
   * 冷凍・冷蔵の行は手元に無い（関連先は同じ 保管先 表）ので、そちらは仕掛品.保管先 経由で束ねる。
   */
  const 直接 = new Set(db.prepare("SELECT src_row FROM link WHERE fld=? AND dst_row=?").all(F.仕入_保管先, 保管先.id).map((r) => r.src_row));
  for (const r of db.prepare("SELECT id FROM row WHERE tbl=? AND json_extract(cells,'$.fldxsApnJ1z9leFMh[0].foreignRowId')=?").all(T.仕掛入庫, 保管先.id)) 直接.add(r.id);
  const 群 = new Map(); let 設定日 = "";
  for (const r of db.prepare("SELECT id FROM row WHERE tbl=? AND json_extract(cells,'$.fld31qwXm8U2hQtzx[0].foreignRowId') IS NOT NULL").all(T.仕掛入庫)) {
    const x = 行(r.id); if (!x) continue;
    const 品 = 関連先ID(値(x, F.仕_品名))[0]; if (!仕掛品IDs.has(品) && !直接.has(r.id)) continue;
    const 期首 = 数値(値(x, F.仕_期首3)); const 在庫 = 数値(値(x, F.仕_在庫残高));
    if (!(期首 > 0) && 在庫 == null) continue;
    const d = 日付(値(x, F.仕_設定日)); if (d > 設定日) 設定日 = d;
    const k = 名(値(x, F.仕_品名));
    (群.get(k) ?? 群.set(k, []).get(k)).push({
      日: 値(x, F.仕_日), 期首: 期首 ?? 0, 在庫: 在庫 ?? 0, 単価: 数値(値(x, F.仕_単価)),
      小計: 数値(値(x, F.仕_月末金額)) ?? Math.max(0, (在庫 ?? 0) * (数値(値(x, F.仕_単価)) ?? 0)),
    });
  }
  const 日の見出し = 保管先名 === "選別" ? "選別日" : "製造日";
  /** 仕掛品の並びは実物と同じく 仕掛品 表の行の順（rowid。実物 8 品の順と 8/8 一致） */
  const 品の順 = new Map(db.prepare("SELECT rowid, json_extract(cells,'$.fldY459LqWakI5pyo') n FROM row WHERE tbl=? ORDER BY rowid").all(T.仕掛品).map((r, i) => [r.n, i]));
  let 期首計 = 0, 在庫計 = 0, 額計 = 0; const 品名たち = [...群.keys()].sort((a, b) => (品の順.get(a) ?? 1e9) - (品の順.get(b) ?? 1e9));
  const 行々 = 品名たち.map((k, gi) => {
    const lots = 群.get(k).sort((a, b) => String(a.日).localeCompare(String(b.日)));
    const 期首 = lots.reduce((s, l) => s + l.期首, 0), 在庫 = lots.reduce((s, l) => s + l.在庫, 0), 額 = lots.reduce((s, l) => s + (l.小計 ?? 0), 0);
    期首計 += 期首; 在庫計 += 在庫; 額計 += 額;
    return lots.map((l, i) => `<tr${i === 0 ? " class=頭" : ""}>
      ${gi === 0 && i === 0 ? `<td class="群 縦" rowspan=${[...群.values()].reduce((s, a) => s + a.length, 0)}>${E(保管先名)}</td>` : ""}
      ${i === 0 ? `<td class="群 c" rowspan=${lots.length}>${E(k)}</td><td class="群 r" rowspan=${lots.length}>${E(数(期首, 1))}</td>` : ""}
      <td class=c style="background:#dbe4ff">${E(短い日付(l.日))}</td><td class=r style="background:#dbe4ff">${E(数(l.在庫, 1))}</td><td class=r style="background:#dbe4ff">${E(数(l.単価, 2))}</td><td class=r style="background:#dbe4ff">${E(数(Math.round(l.小計 ?? 0)))}</td>
      ${i === 0 ? `<td class="群 r" rowspan=${lots.length}>${E(数(在庫, 1))}</td><td class="群 r" rowspan=${lots.length}>${E(数(Math.round(額)))}</td>` : ""}</tr>`).join("");
  }).join("");
  const 締日 = 日付(値(保管先, F.保_締日));
  const 中 = `<div class=見出し><div style="padding-left:6mm">${E(保管先名)}</div><div>${E(設定日 || 締日)}</div></div>
  <table class=棚><thead><tr><th style="width:6mm"></th><th style="width:24%">原料名</th><th>期首在庫</th><th>${E(日の見出し)}</th><th>在庫（kg）</th><th>単価</th><th>小計</th><th>在庫合計（kg）</th><th>在庫評価額</th></tr></thead>
  <tbody>${行々 || `<tr><td colspan=9 class=注>この保管先の仕掛品に、期首に残っていた lot も締処理の画面が要求した lot も手元にありません</td></tr>`}
  <tr class=合計><td style="border:0"></td><td class=r>合計</td><td class=r>${E(数(期首計, 1))}</td><td colspan=4 style="border:0"></td><td class=r>${E(数(在庫計, 1))}</td><td class=r>${E(数(Math.round(額計)))}</td></tr></tbody></table>
  <div class=確認者><div>確認者</div><div></div></div>
  <div class=当方>日付は 在庫残高設定日。保管先.締日は ${E(締日 || "—")}。単価は 原材料kg単価+（原材料価格の和 ÷ 入庫数量）。実物（PrinceXML）は 確認者 の枡を 2 頁目に置く。</div>`;
  return 紙に載せる(`仕掛品棚卸表 ${保管先名}`, 中, { 横: true, 追加CSS: 棚卸のCSS });
}

function 保管先の一覧(db, 文脈) {
  const { 行, 値 } = 器(db, 文脈);
  return db.prepare("SELECT id FROM row WHERE tbl=?").all(T.保管先).map((r) => 行(r.id)).filter(Boolean)
    .map((x) => ({ 鍵の値: x.id, 表示: 文字(値(x, F.保_Name)), 補足: `締日 ${日付(値(x, F.保_締日)) || "—"}` }));
}

/* ═══════════════════════════════════════════════════════════════════
 * 製造表（製品生産 1 件）
 * ═══════════════════════════════════════════════════════════════════ */

/** 生産指示編集 Form の控え（crawl/out/raw/bom）。製品生産の行ID → {出庫:[…], 仕掛出庫:[…]}。起動後に一度だけ読む */
let 控え = null;
function 控えを読む(ROOT) {
  if (控え) return 控え;
  控え = new Map();
  const dir = path.join(ROOT, "crawl", "out", "raw", "bom");
  if (!fs.existsSync(dir)) return 控え;
  for (const f of fs.readdirSync(dir).filter((x) => x.endsWith(".jsonl"))) {
    const rid = f.replace(/\.jsonl$/, ""); const 出庫 = [], 仕掛出庫 = []; let 製品 = null;
    try {
      for (const line of fs.readFileSync(path.join(dir, f), "utf8").split("\n")) {
        if (!line || !/fetchInitialTableIdsToLinkedTableStates/.test(line)) continue;
        const o = JSON.parse(line); let b; try { b = JSON.parse(o.body); } catch { continue; }
        const d = b?.result?.data ?? {};
        /** 同じ応答に 製品（製造/商品）の行が 1 件入っている。製品生産の行が 製品 の関連を持たないとき（9/14 以降の 18 行）はこれで製品を知る */
        for (const pid of Object.keys(d[T.商品]?.recordIdsToAirtableRecords ?? {})) 製品 ??= pid;
        for (const r of Object.values(d[T.出庫]?.recordIdsToAirtableRecords ?? {})) {
          const f2 = r.fields ?? {}; const キー = String(f2[F.出_キー] ?? "");
          /** 出庫検索キー は「発注番号-原材料名」。発注番号は YYMMDD-NNNN。lot 無しは先頭が「-」 */
          const m = キー.match(/^(\d{6}-\d{4})?-(.*)$/);
          出庫.push({ id: r.id, 出庫ID: f2[F.出_ID], 日: f2[F.出_日], lot: m ? (m[1] ?? "") : "", 原材料: m ? m[2] : キー,
            数量: 数値(f2[F.出_数量]), 実在庫: 数値(f2[F.出_実在庫]) });
        }
        for (const r of Object.values(d[T.仕掛出庫]?.recordIdsToAirtableRecords ?? {})) {
          const f2 = r.fields ?? {}; const キー = String(f2[F.仕出_キー] ?? ""); const m = キー.match(/^(\d{6}-\d{4})?-(.*)$/);
          仕掛出庫.push({ id: r.id, 出庫ID: f2[F.仕出_ID], 日: f2[F.仕出_日], lot: m ? (m[1] ?? "") : "", 原材料: m ? m[2] : キー,
            数量: 数値(f2[F.仕出_数量]), 実在庫: 数値(f2[F.仕出_実在庫]) });
        }
      }
    } catch (e) { console.error(`製造表: 控え ${f} を読めません: ${e.message}`); }
    出庫.sort((a, b) => String(a.出庫ID).localeCompare(String(b.出庫ID)));
    控え.set(rid, { 出庫, 仕掛出庫, 製品 });
  }
  return 控え;
}

/**
 * 製品生産の製品（製造/商品 の行ID）。製品 の関連は 2,208/2,226 行にあるが、9/14 以降に作られた 18 行には無い。
 * その行でも 製品名 lookup fld8MS9rMjV7oLY5J は来ていて、lookup の鍵（valuesByForeignRowId）が製品の行IDなのでそこから取る
 */
function 製品IDを引く(値, 生産) {
  const a = 関連先ID(値(生産, F.生_製品))[0]; if (a) return a;
  const lk = 値(生産, F.生_製品名); const ks = lk && typeof lk === "object" && lk.valuesByForeignRowId ? (lk.foreignRowIdOrder ?? Object.keys(lk.valuesByForeignRowId)) : [];
  return ks[0] ?? null;
}

function 製品生産を引く(db, 文脈, 鍵) {
  const { 行 } = 器(db, 文脈);
  if (/^rec[A-Za-z0-9]{14}$/.test(鍵)) { const r = 行(鍵); return r && r.tbl === T.製品生産 ? r : null; }
  const hit = db.prepare("SELECT id FROM row WHERE tbl=? AND (json_extract(calc,'$.fldQj3DnIBBmsroaC')=? OR json_extract(snap,'$.fldQj3DnIBBmsroaC')=?)").get(T.製品生産, 鍵, 鍵);
  return hit ? 行(hit.id) : null;
}

export function 製造表を組む(db, 鍵, 文脈) {
  const { 行, 値 } = 器(db, 文脈);
  const 生産 = 製品生産を引く(db, 文脈, 鍵); if (!生産) return null;
  const 製品ID = 製品IDを引く(値, 生産); const 商品 = 行(製品ID);
  const 品名 = 名(値(生産, F.生_製品名)) || (商品 ? 文字(値(商品, F.商_商品名1)) : "") || 名(値(生産, F.生_製品));
  const 製品コード = 名(値(生産, F.生_製品)) || (商品 ? 文字(値(商品, F.商_製品ID)) : "");
  const 生産ID = 文字(値(生産, F.生_ID)) || 生産.id;

  /** 原料名の表。自分の控え → 無ければ同じ製品の直前（製造日が最も近い）の控えを配合の写しとして */
  const 全控え = 控えを読む(文脈.ROOT);
  let 配合 = 全控え.get(生産.id), 写し元 = null;
  if (!配合 && 製品ID) {
    const 自分の日 = String(値(生産, F.生_製造日) ?? "");
    const 候補 = [];
    for (const [rid, k] of 全控え) { const x = 行(rid); if (x && (k.製品 ?? 製品IDを引く(値, x)) === 製品ID) 候補.push({ rid, 日: String(値(x, F.生_製造日) ?? ""), ID: 文字(値(x, F.生_ID)) || rid }); }
    候補.sort((a, b) => Math.abs(new Date(a.日) - new Date(自分の日)) - Math.abs(new Date(b.日) - new Date(自分の日)));
    if (候補.length) { 配合 = 全控え.get(候補[0].rid); 写し元 = 候補[0].ID; }
  }
  const 原料行 = (配合 ? [...配合.出庫.map((x) => ({ ...x, 種: "原材料" })), ...配合.仕掛出庫.map((x) => ({ ...x, 種: "仕掛品" }))] : []);
  const 仕込み合計 = 原料行.reduce((s, x) => s + (x.数量 ?? 0), 0);

  const 空 = (n) => Array.from({ length: n }, () => `<tr><td style="height:16pt"></td><td></td><td></td><td>開始時間</td><td class=c>：</td><td></td></tr><tr><td style="height:16pt"></td><td></td><td></td><td>終了時間</td><td class=c>：</td><td></td></tr>`).join("");
  const 中 = `<div style="display:flex;gap:6mm;font-size:8.5pt">
    <div style="flex:1 1 50%">
      <table><tr><th style="width:12mm">配合表</th><th>品名</th><th style="width:26mm">ロットNO</th><th style="width:18mm">数量(kg)</th><th style="width:16mm">作業者</th></tr>
        <tr><td></td><td style="font-size:12pt;height:24pt">${E(品名)}<span class=小>　${E(製品コード)}</span></td><td class=c>${E(文字(値(生産, F.生_ロット)))}</td><td class="r">${E(数(数値(値(生産, F.生_出来高)), 2))}</td><td></td></tr></table>
      <table style="margin-top:4pt"><tr><th>工程</th><th style="width:44%">作業方法</th><th>標準時間<br>(分)</th><th colspan=2>豆煮No（　　　）</th><th>蒸気圧<br>(Mpa)</th></tr>${空(7)}
        <tr><td colspan=3 rowspan=2 class=注>異常（時間の逸脱や小豆の煮豆状態）があった場合、上司に報告し対処した方法を備考欄に記載する事。</td><td>合計時間</td><td class=c>時間　　分</td><td></td></tr><tr><td>品質確認</td><td class=c>良　・　不</td><td></td></tr>
        <tr><td colspan=3></td><td>担当者</td><td colspan=2></td></tr><tr><td colspan=3></td><td>練釜No</td><td colspan=2></td></tr></table>
      <div class=注 style="margin-top:4pt">工程・作業方法・標準時間・蒸気圧 は DB のどこにも無い（実物は商品ごとに人が Numbers で作った作業標準）。枡だけ写した。</div>
    </div>
    <div style="flex:1 1 50%">
      <table><tr><th>製造日</th><td class=c>${E(年月日(値(生産, F.生_製造日)))}</td><th>生産ID</th><td class=c>${E(生産ID)}</td><th>ロット数</th><td class=c>${E(数(数値(値(生産, F.生_ロット数))))}</td></tr>
        <tr><th>出来高(kg)</th><td class=r>${E(数(数値(値(生産, F.生_出来高)), 2))}</td><th>在庫計上数(kg)</th><td class=r>${E(数(数値(値(生産, F.生_計上数)), 2))}</td><th>ケース</th><td class=r>${E(数(数値(値(生産, F.生_ケース))))}</td></tr>
        <tr><th>賞味期限</th><td class=c>${E(年月日(値(生産, F.生_賞味期限)))}</td><th>豆(kg) / 糖(kg) / 仕掛豆(kg)</th><td class=r colspan=3>${E(数(数値(値(生産, F.生_豆))))} / ${E(数(数値(値(生産, F.生_糖))))} / ${E(数(数値(値(生産, F.生_仕掛豆)), 2))}　　原材料合計 ${E(円(数値(値(生産, F.生_原材料合計))))}　原価単価 ${E(円(数値(値(生産, F.生_原価単価)), 2))}</td></tr></table>
      <table style="margin-top:4pt"><tr><th style="width:12mm">原料名</th><th>品　名</th><th style="width:24mm">Lot No</th><th style="width:16mm">仕込み量</th><th style="width:9mm">単位</th><th style="width:14mm">仕込者</th><th style="width:10mm">確認☑</th><th style="width:12mm">投入順序</th></tr>
        ${原料行.length ? 原料行.map((x, i) => `<tr>${i === 0 ? `<td rowspan=${原料行.length}></td>` : ""}<td>${E(x.原材料)}${x.種 === "仕掛品" ? "<span class=小>（仕掛品）</span>" : ""}</td><td class=c>${E(x.lot)}</td><td class=r>${x.数量 ? E(数(x.数量, 2)) : ""}</td><td class=c>kg</td><td></td><td></td><td class=c>${"①②③④⑤⑥⑦⑧⑨⑩⑪⑫⑬⑭⑮⑯⑰⑱⑲⑳"[i] ?? i + 1}</td></tr>`).join("")
          : `<tr><td></td><td colspan=7 class=注>使用原材料の控えが手元にありません（製造/出庫 は DB に 0 行。控えは 40 件の生産指示ぶん）</td></tr>`}
        <tr><td></td><td class=c>仕込み合計</td><td></td><td class=r>${E(数(仕込み合計, 2))}</td><td class=c>kg</td><td colspan=3></td></tr></table>
      ${写し元 ? `<div class=注>原料名の表は同じ製品の生産指示 ${E(写し元)} の控えを配合の写しとして出した（この生産指示自身の控えは無い）。</div>` : ""}
      ${配合 && 原料行.some((x) => x.数量 == null) ? `<div class=注>仕込み量が空の行は、現行でも 出庫数量(kg) が 0 のまま（412 行中 364 行）。人が後で入れる。</div>` : ""}
      <table style="margin-top:4pt"><tr><th>工程</th><th style="width:40%">作業方法</th><th>標準時間<br>(分)</th><th colspan=2>練釜No（　　　）</th><th>作業者</th></tr>${空(5)}
        <tr><td colspan=3 class=c>Bx　±1で検収し終了</td><td>練り合計時間</td><td class=c>：</td><td></td></tr>
        <tr><td>硬さ</td><td class=c>良　・　不</td><td>品質確認</td><td class=c>良　・　不</td><td colspan=2>Bx（糖度）</td></tr>
        <tr><td>最終温度（℃）</td><td></td><td>担当者</td><td></td><td colspan=2></td></tr>
        <tr><td colspan=6 style="height:30pt;vertical-align:top">備考欄</td></tr></table>
    </div></div>`;
  return 紙に載せる(`製造表 ${生産ID}`, 中, { 横: true });
}

function 製品生産の一覧(db) {
  return db.prepare("SELECT id, coalesce(json_extract(calc,'$.fldQj3DnIBBmsroaC'), json_extract(snap,'$.fldQj3DnIBBmsroaC')) k, json_extract(cells,'$.flddd3n2fLMWxNaBR') d, json_extract(cells,'$.fldeUlgoD3fPI5JwE[0].foreignRowDisplayName') p FROM row WHERE tbl=? ORDER BY d DESC, k DESC LIMIT 300").all(T.製品生産)
    .map((r) => ({ 鍵の値: r.k ?? r.id, 表示: `${r.k ?? r.id}　${r.p ?? ""}`, 補足: r.d ? String(r.d).slice(0, 10) : "" }));
}

export const 帳票 = [
  { 鍵: "原料棚卸表", 名: "原料棚卸表", 紙: "A4 横", 実物: 9, 生成元: "Make（分類.棚卸表作成）→ ヘッドレスChromium（Skia/PDF）→ 分類.原料棚卸表 に添付",
    一覧: 分類の一覧, 組む: 原料棚卸表を組む },
  { 鍵: "仕掛品棚卸表", 名: "仕掛品棚卸表", 紙: "A4 横", 実物: 2, 生成元: "Make（保管先.棚卸表作成）→ PrinceXML 16.1 → 保管先.仕掛品棚卸表 に添付",
    一覧: 保管先の一覧, 組む: 仕掛品棚卸表を組む },
  { 鍵: "製造表", 名: "製造表（作業表）", 紙: "横（JPEG）", 実物: 44, 生成元: "商品ごとの作業標準（Numbers → JPEG）。行から出したものではない。当方は製品生産＋使用原材料の控えで原料名の表を埋める",
    一覧: 製品生産の一覧, 組む: 製造表を組む },
];
