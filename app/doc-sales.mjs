/**
 * 販売の帳票を組む。**請求書・出荷明細書・納品書・受領書。** ローカルDBの行だけで組む。外へは一切つながない。
 *
 *   app/ext/60-docs.mjs が `帳票` を読み、/docs と /doc/<種>/<鍵> に出す。
 *   組み方は app/doc.mjs（発注書）と同じ: 現行が出した実物を読み、その形をHTMLで写し、値はDBから埋める。
 *
 * ■ 請求書 — 実物 334 件（crawl/out/artifacts/販売-売掛台帳-請求書__<rec>__<得意先>-<年月>.pdf）
 *
 * 紙は **A4 縦**。PDF の末尾に「made with documint」の帯があり、Producer は Skia/PDF。
 * つまり現行は Documint のテンプレートに Airtable の値を流し込んで PDF にしている（doc.mjs の
 * 帳票の種類 が「ヘッドレスChromium」としているのは Producer だけを見た記述。実物の帯で Documint と分かる）。
 *
 * 読んだ実物: DO032-202404（1頁・2行）、DO039-202411（2頁・締日20）、DO039-202506（税区分表つき）、DO034-202608（明細0行）。
 * 形は 2024-04 → 2024-11 → 2025-06 で 3 段階変わっている。**最新（2025-06 以降）の形で組む。**
 *   2024-04: 請求書番号・発行日が空。自社住所 〒104-0061・TEL 03-6264-5788。銀行 1 行
 *   2024-11: 請求書番号「20241120_0001」・発行日あり。自社住所 〒105-0003・TEL 03-3580-3719。銀行 3 行
 *   2025-06〜: 明細の後ろに 得意先(契約先)別売上合計 / 入金 行 / 入金合計 / 今回請求額 と 税区分の小表
 *
 * 紙のどこに何が出るか（実物の印字 → DB の項目）:
 *
 *   紙の場所                 実物の例                        出どころ
 *   ─────────────────────   ─────────────────────────────   ─────────────────────────────────────────────
 *   請求書番号               20250620_0001                   **DBに無い。** 締日 YYYYMMDD + "_" + 同じ締日の台帳の中の連番（推定）
 *   発行日                   2025年06月23日                  売掛台帳.送信日時 fldsmATbQKR1Xsn7b（実物 3 件で一致）。無ければ締日の翌日
 *   請求締日                 2025年06月20日                  月 fldTgVJHIUgCFzsat の年月 × 締日設定 fld2735dv2YWHXLoN（31=月末・20=20日）
 *   〒・住所                 〒506-0002 岐阜県高山市問屋町22   得意先.郵便番号 / 住所1 / 住所2（2024-04 の実物は 住所1+住所2 を続けて印字していた）
 *   得意先名 御中            株式会社 清水弥生堂 御中          得意先.表示請求先名 fldosU81mMJ5Vm3EJ（無ければ 名称1）。敬称は実物 4 件とも「御中」
 *   (コード：DO039)          —                               得意先.取引先コード fld9JGbre6Jdq6DFV
 *   自社の名・住所・登録番号・TEL/FAX・振込銀行                   **固定文**（実物から写す。DBに無い）
 *   前回請求金額             532,526                          売掛台帳.前回請求金額 fldDHHy7dhk1MJM9s（lookup 由来で配列で来ることがある）
 *   今回入金額               532,526                          売掛台帳.今回入金額 fldbz4oviTYkin0uk
 *   繰越金額                 0                                売掛台帳.繰越金額 fldtgUXtEW751FLaz
 *   御買上額                 1,081,515                        売掛台帳.当月売掛金額 fld8BkPFzo0tcyEqk
 *   消費税                   86,522                           売掛台帳.消費税 fldFsPQm49WQNw2m5
 *   今回請求額               1,168,037                        売掛台帳.今回請求金額 fldXMz6l7XuKlhfbV
 *   明細.伝票日付            2025-05-22                       売上.計上日(請求日) fld5QHhPRdMop23kO
 *   明細.伝票NO／品番        6-010254 / O0408019              売上.売上伝票ID fld9EXtVvEZHn78y2 / 出庫.商品コード2 fld85LvfGD2Dv2xJu（無ければ 商品コード の関連の表示名）
 *   明細.品名 *              水まんこしあんM54 *              出庫.商品名 fld0bDosNoh7hyW8y。「*」は消費税率 8%（販売/商品.消費税率 fldpW7FpGl70rO19H を製品IDで引く）
 *   明細.数量                160 キロ / 8 ケース              出庫.出庫数量(端数処理選択) fldxb4hmXBbLGGx33 / ケース数入力 fld6pwTwHIrICStWy
 *   明細.単価 / 金額         388 / 62,080                     出庫.販売単価 fldUTTfrctmQ8kfoH / 販売金額 fld94jSv0TuAzAfJJ
 *   伝票NO別売上合計          64,020                           明細の 販売金額 の和（売上.販売金額 fldeGqPkQ1AwZ8WPG と一致するはず）
 *   入金 行                  2025-06-20 DO039-202506 入金-営業第二部  売掛台帳.入金日 fldh2fbf8wKqinVpo（無ければ締日）/ 売掛台帳ID / 「入金」。**部門名はDBに無い**
 *   税区分の小表             8%対象 86,522 1,081,515 1,168,037  明細を税率で分けて足す
 *
 * ■ 売掛台帳と売上の結び
 *
 * 売掛台帳→売上の関連（fldQN5yQ6a1fBhA3A・fld0f8fhTNyaskjKw）は「逆にしない」で **辺が 0 本**、売上側の逆項目も値が無い。
 * だから **得意先が同じ ∧ 売上.請求日 fld0fz2lomOQ0bBba の年月 = 台帳の月** で結ぶ。請求日は締日設定（31/20）を織り込んだ式で、
 * 20日締なら 21日以降の伝票は翌月の請求日になる。この結びで
 *   DO032-202404（月末締）  売上 1 件  58,500   = 台帳.当月売掛金額 58,500
 *   DO039-202506（20日締）  売上 11 件 1,081,515 = 台帳.当月売掛金額 1,081,515 = 実物の御買上額
 * が一致した。rollup の絞り込み（返品旗 fldbA83lv31IIaJk6 = 空）も同じ条件で当てる。
 *
 * 出庫→売上は 出庫.売上伝票 fld7MzewVUPmeQ1AV（辺 34,610 本）。売上側の逆項目 fldcfGRbbkWIos9hp は辺 0 本なので使わない。
 *
 * 明細の並びは実物では伝票NOでも日付でもない（DO039-202411: 6-005990 の次に 6-005981、6-006199 の次に 6-006196）。
 * 現行の並び規則は読めないので、当方は **伝票日付 → 伝票NO** で並べる。
 *
 * ■ 出荷明細書・納品書・受領書 — **実物が手元に無い**
 *
 * 現行は 販売/PDF生成指示 tbldhtCdQkTBw4HGi の行（出荷日1・種類番号・出力帳票{出荷明細書, 納品書・受領書}）を引き金に
 * Make が作り、Google Drive の URL を 出荷明細書 / 納品書・受領書 ボタンに戻す（3 行とも drive.google.com）。
 * 売上.出荷依頼書 fldRq9A7eLWrbdh75・納品書 fldN6HiIWsHo5H7dK の添付は 売上 6-020617 の 2 件だけ（attach 表。dl.airtable.com の URL で実物は未取得）。この 2 件を取れば列を確定できる。
 * だから列は次から決めた:
 *   PDF生成指示 の項目          出荷明細書 は「種類番号 × 出荷日」ぶんの束、納品書・受領書 は同じ束を伝票ごとに
 *   出荷依頼 Form（oMK1Ig76uM5ExRN2S1WM）の 24 項目  出荷日・引取日・納品日・運送会社・郵便番号・住所1/3・電話・FAX・
 *                                           ロット表示・賞味期限表示・ロットNO表示-納品書・賞味期限表示-納品書・金額表示・
 *                                           出荷依頼書備考・納品書備考・受領書作成
 *   出庫 の入力項目               商品名・ケース数入力・出庫数量・販売単価・販売金額・在庫明細ID（→ロットNO・賞味期限・倉庫名）
 * 実物と突き合わせていないことは 生成元 の文字列と紙の上の注記に書く。
 */
import fs from "node:fs";
import path from "node:path";

const E = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));

/** ─── 表・項目のID。名前で引くと同名で取り違えるので ID で書く ─── */
const T = {
  売掛台帳: "tbltny3ibbQKRiEkX", 売上: "tblUBK06Qb5cBQ9Tg", 出庫: "tblkV3ZPRWixoUtaB",
  得意先: "tblYYm9nV40u6y3AL", 月: "tblFpaCyRYS3sRbyi", 商品: "tbl7a8vyIotDy0XnU", 入庫: "tblBQUOzMFeLE82W8",
};
const F = {
  台帳_ID: "fldAlJGzaAi3EklGb", 台帳_得意先: "fldufkFOXP4ayCeQK", 台帳_月: "fldTgVJHIUgCFzsat", 台帳_締日設定: "fld2735dv2YWHXLoN",
  台帳_前回請求: "fldDHHy7dhk1MJM9s", 台帳_今回入金: "fldbz4oviTYkin0uk", 台帳_繰越: "fldtgUXtEW751FLaz",
  台帳_当月売掛: "fld8BkPFzo0tcyEqk", 台帳_消費税: "fldFsPQm49WQNw2m5", 台帳_今回請求: "fldXMz6l7XuKlhfbV",
  台帳_入金日: "fldh2fbf8wKqinVpo", 台帳_送信日時: "fldsmATbQKR1Xsn7b",
  得_コード: "fld9JGbre6Jdq6DFV", 得_名称1: "fldt0UEchsCJbwUhC", 得_表示請求先名: "fldosU81mMJ5Vm3EJ", 得_郵便: "fldejq51Qhhp0jB67",
  得_住所1: "fldey0vjQce5qV3zX", 得_住所2: "fldSsMxwg2XAr2cR4", 得_住所3: "fldcctlhL1Fn7GHE8", 得_電話: "fldipiTlcs1MDU2Bw", 得_FAX: "fldmq8sVGRhntooL0",
  売_ID: "fld9EXtVvEZHn78y2", 売_得意先: "fldVRxAN22bt3BYV1", 売_計上日: "fld5QHhPRdMop23kO", 売_請求日: "fld0fz2lomOQ0bBba",
  売_出荷日: "fldYBcriATvxY3NYC", 売_販売金額: "fldeGqPkQ1AwZ8WPG", 売_消費税: "fldBLGHB0mi2tvdAL", 売_返品旗: "fldbA83lv31IIaJk6",
  売_種類番号: "fldL1zhYcB9bimy9x", 売_請求先名: "fldvGCojx5BkcJ31W", 売_備考: "fld3JqbQ1tac8Jhxc",
  売_得意先名2: "fldRm0yNwmU9BcZV1", 売_郵便: "fldrXLkguSeO2tObR", 売_住所1: "fldRJg4oUMMMFJpqB", 売_住所3: "fld1FfANbpD5gcJrO",
  売_電話: "fldvziH2cP9tmEtCt", 売_FAX: "fldXfPqBEfVcskXJ8", 売_引取日: "fldxztPaRFklDkDGh", 売_納品日: "fldQjRDklIBsSTbvS",
  売_運送会社: "fldHXqr4T54TAXT8f", 売_出荷依頼書備考: "fldmItnDPa7oV49z5", 売_納品書備考: "fldoypXpj3KYvEMdo",
  売_ロット表示: "fld6Z8PlFgb9yG30X", 売_賞味期限表示: "fld7QQdYd5IZtUqSd", 売_ロット表示納: "fldRU54yqVDyV6I2I", 売_賞味期限表示納: "fld4vO293JC9So3MQ",
  売_金額表示: "fldjzPRHLWfRKZq6O", 売_敬称: "fldJoZfHxbosmoBGi", 売_受領書作成: "fldvzcMis3pNi0ObV", 売_出荷数量kg: "fldQOMLh9vWBbRzud", 売_出荷数量cs: "fldqNGFaNmxTcExoJ",
  出_売上: "fld7MzewVUPmeQ1AV", 出_ID: "fld947y7ywp8nhFx0", 出_商品名: "fld0bDosNoh7hyW8y", 出_商品コード2: "fld85LvfGD2Dv2xJu", 出_商品コード: "fldAByG8XY58yXvFm",
  出_数量: "fldxb4hmXBbLGGx33", 出_数量式: "fldW6KF4P9Avgk7Fp", 出_ケース入力: "fld6pwTwHIrICStWy", 出_単価: "fldUTTfrctmQ8kfoH", 出_金額: "fld94jSv0TuAzAfJJ",
  出_在庫明細: "fldow210kASYVp4qz", 出_ロット: "fldURLhQbmGDK0xyI", 出_賞味期限: "fld1qWZbFMeVQ1HMF", 出_倉庫名: "fldYLZR15xSxEwcaP", 出_明細備考: "fldWSny3uiUApH3Ko",
  出_区分: "fldvfVq3OloLsVRup", 出_順番: "fldyeXdoHxOYClcPH",
  商_製品ID: "fldYZBJPJSGlefqa2", 商_商品名1: "fldeihtUIQB16j1iS", 商_税率: "fldpW7FpGl70rO19H",
  出_商品名マスタ: "fld3ztrr5edhFppvo", 出_ケース数: "fldEAkJSVUlWoPV8t", 庫_端数: "fldTnOJElYjGk9iQ3",
};

/** ─── 固定文。実物（2024-11 以降の 3 件）から写した。DBのどこにも無い ─── */
export const 自社 = {
  名: "TTCフーズ 株式会社",
  郵便: "〒105-0003", 住所: "東京都港区西新橋2-9-1",
  登録番号: "T7010401020507",
  TEL: "03-3580-3719", FAX: "03-3580-3720",
  銀行: ["商工中金 東京支店 普通 1117360", "みずほ銀行 新橋支店 普通 4934632", "福岡銀行 伊田支店 普通 2069002"],
};
const 軽減税率の注 = "※：軽減税率8%対象商品(税率8%)";

/** ─── 値の書き方 ─── */
/** "2025年06月23日"。実物は区切りに空白を入れない（doc.mjs の発注書は空白入り。紙が違う） */
export function 年月日(v) {
  const p = 日付部(v); return p ? `${p.y}年${p.m}月${p.d}日` : "";
}
/** "2025-05-22"。明細の伝票日付はこの形 */
export function 日付(v) { const p = 日付部(v); return p ? `${p.y}-${p.m}-${p.d}` : ""; }
/** 日付の年月日を Asia/Tokyo で切り出す。値は ISO 文字列で来る */
export function 日付部(v) {
  if (!v) return null;
  const d = v instanceof Date ? v : new Date(String(v));
  if (Number.isNaN(d.getTime())) return null;
  const p = new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Tokyo", year: "numeric", month: "2-digit", day: "2-digit" })
    .formatToParts(d).reduce((a, x) => (a[x.type] = x.value, a), {});
  return { y: p.year, m: p.month, d: p.day };
}
/** 数を "1,081,515" に。桁は省略なら整数。空は "" */
export function 数(v, 桁 = 0) {
  const n = 数値(v);
  if (n == null) return "";
  const s = Math.abs(n).toFixed(桁);
  const [整, 小] = s.split(".");
  return (n < 0 ? "-" : "") + 整.replace(/\B(?=(\d{3})+(?!\d))/g, ",") + (小 ? "." + 小 : "");
}
export const 円 = (v, 桁 = 0) => { const s = 数(v, 桁); return s === "" ? "" : (s.startsWith("-") ? "-¥" + s.slice(1) : "¥" + s); };
/** lookup や rollup は配列や {valuesByForeignRowId} で来ることがある。数に潰す */
export function 数値(v) {
  if (v == null || v === "") return null;
  if (Array.isArray(v)) return v.length ? 数値(v[0]) : null;
  if (typeof v === "object") {
    if (v.valuesByForeignRowId) { const 順 = v.foreignRowIdOrder ?? Object.keys(v.valuesByForeignRowId); return 順.length ? 数値(v.valuesByForeignRowId[順[0]]) : null; }
    return null;
  }
  const n = Number(String(v).replace(/[^0-9.\-]/g, ""));
  return Number.isFinite(n) ? n : null;
}
/** 文字に潰す（lookup・関連・配列を含む） */
export function 文字(v) {
  if (v == null) return "";
  if (Array.isArray(v)) return v.map(文字).filter(Boolean).join(", ");
  if (typeof v === "object") {
    if (v.valuesByForeignRowId) { const 順 = v.foreignRowIdOrder ?? Object.keys(v.valuesByForeignRowId); return 順.map((k) => 文字(v.valuesByForeignRowId[k])).filter(Boolean).join(", "); }
    if (v.foreignRowDisplayName != null) return String(v.foreignRowDisplayName);
    if (v.foreignRowId) return String(v.foreignRowId);
    return "";
  }
  return String(v);
}
/** 関連の先の行ID（cells の [{foreignRowId}]） */
export const 関連先ID = (v) => (Array.isArray(v) ? v : v ? [v] : []).map((x) => x?.foreignRowId).filter(Boolean);
const 真 = (v) => v === true || v === 1 || v === "1";

/** ─── DB を読む。値は 文脈.書き込み.計算器.値（cells→calc→snap→implied）で読む ─── */
/**
 * 値は **生の形**（第3引数 true）で読む。既定の形は式から見た形で、関連が表示名の配列・選択肢が名前になり、
 * 関連先の行IDが消える。生なら 関連 [{foreignRowId,…}]・lookup {valuesByForeignRowId}・選択肢ID のまま来るので、
 * 行IDで辿れ、名前は 文字()／文脈.書く で直す。行ID が無いときは 取る を呼ばない（undefined を bind すると落ちる）
 */
function 器(db, 文脈) {
  const c = 文脈.書き込み.計算器;
  const 行 = (rid) => (rid ? c.取る(rid) : null);
  const 値 = (r, fid) => (r ? c.値(r, fid, true) : undefined);
  return { c, 行, 値 };
}

/**
 * 販売/商品 の 製品ID → 消費税率。実物の「*」印はこれで決める。
 * 108/110 行に 消費税率 がある。無い商品は 8 とみなす（実物 4 件・明細 60 行はすべて「*」＝8%）。
 */
let 商品表 = null;
function 商品表を作る(db, 文脈) {
  if (商品表) return 商品表;
  商品表 = { コード: new Map(), 名: new Map() };   // 製品ID → {名, 率} / 商品名1 → {コード, 率}
  const { 行, 値 } = 器(db, 文脈);
  for (const r of db.prepare("SELECT id FROM row WHERE tbl=?").all(T.商品)) {
    const x = 行(r.id); if (!x) continue;
    const 率 = 数値(値(x, F.商_税率)); const code = 文字(値(x, F.商_製品ID)); const 名 = 文字(値(x, F.商_商品名1)).trim();
    if (code) 商品表.コード.set(code, { 名, 率 });
    if (名 && !商品表.名.has(名)) 商品表.名.set(名, { コード: code, 率 });
  }
  return 商品表;
}
function 税率を引く(db, 文脈, 品番, 商品名) {
  const m = 商品表を作る(db, 文脈);
  return m.コード.get(品番)?.率 ?? m.名.get(String(商品名 ?? "").trim())?.率 ?? 8;
}

/** 売上 1 件の明細（出庫）。出庫.売上伝票 fld7MzewVUPmeQ1AV の辺を dst 側から辿る（索引 link_dst がある） */
function 明細を引く(db, 文脈, 売上ID) {
  const { 行, 値 } = 器(db, 文脈);
  let ids = db.prepare("SELECT src_row FROM link WHERE dst_row=? AND fld=? ORDER BY ord").all(売上ID, F.出_売上).map((r) => r.src_row);
  /** 辺が無いときだけ cells を舐める（ミミックが作った行は link が張られていることが多いが念のため） */
  if (!ids.length) ids = db.prepare("SELECT id FROM row WHERE tbl=? AND json_extract(cells,'$.fld7MzewVUPmeQ1AV[0].foreignRowId')=?").all(T.出庫, 売上ID).map((r) => r.id);
  const out = [];
  for (const id of ids) {
    const r = 行(id); if (!r) continue;
    /**
     * 品番と商品名は片方しか無い行が大半（商品名あり品番なし 22,384・品番あり商品名なし 12,182）。
     * 国内伝票は 商品名（入力）を、海外伝票は 商品コード2（在庫明細→商品の lookup）を持つ形。
     * 無い側は 商品名(fromマスタ) lookup → 販売/商品 の表（製品ID⇄商品名1）で補う。
     */
    const m = 商品表を作る(db, 文脈);
    let 品番 = 文字(値(r, F.出_商品コード2)) || 文字(値(r, F.出_商品コード));
    let 商品名 = 文字(値(r, F.出_商品名)) || 文字(値(r, F.出_商品名マスタ)).split(",")[0].trim();
    if (!商品名 && 品番) 商品名 = m.コード.get(品番)?.名 ?? "";
    if (!品番 && 商品名) 品番 = m.名.get(商品名.trim())?.コード ?? "";
    const 単価 = 数値(値(r, F.出_単価));
    const 数量 = 数値(値(r, F.出_数量)) ?? 数値(値(r, F.出_数量式)) ?? 0;
    /**
     * ケース数は式 ケース数 fldEAkJSVUlWoPV8t = IF(在庫明細の端数フラグ, 0, ケース数入力)。実物の「5 キロ / 0 ケース」行は
     * ケース数入力=1 だが端数フラグで 0 になっている。式の値が手元に無い行（34,570 行）は在庫明細（販売/入庫）の
     * フラグ fldTnOJElYjGk9iQ3 を見て同じ式を当てる
     */
    let ケース = 数値(値(r, F.出_ケース数));
    if (ケース == null) {
      const 庫 = 行(関連先ID(値(r, F.出_在庫明細))[0]);
      ケース = 庫 && 真(値(庫, F.庫_端数)) ? 0 : (数値(値(r, F.出_ケース入力)) ?? 0);
    }
    /** 販売金額 は式（区分 N なら 0、数量が 0 なら単価そのまま＝値引き行）。手元に無ければ同じ式で求める */
    let 金額 = 数値(値(r, F.出_金額));
    if (金額 == null) 金額 = 数量 ? (単価 ?? 0) * 数量 : (単価 ?? 0);
    out.push({
      id, 出庫ID: 文字(値(r, F.出_ID)), 品番, 商品名, 数量, ケース, 単価, 金額,
      税率: 税率を引く(db, 文脈, 品番, 商品名),
      ロット: 文字(値(r, F.出_ロット)), 賞味期限: 日付(文字(値(r, F.出_賞味期限)).split(",")[0]), 倉庫: 文字(値(r, F.出_倉庫名)),
      備考: 文字(値(r, F.出_明細備考)), 順番: 数値(値(r, F.出_順番)),
    });
  }
  out.sort((a, b) => (a.順番 ?? 1e9) - (b.順番 ?? 1e9) || a.出庫ID.localeCompare(b.出庫ID));
  return out;
}

/** 締日（月の年月と締日設定から）。31 → 月末、20 → 20 日。それ以外は月末（実測 4,704 行は 31 と 20 だけ） */
function 締日を求める(年, 月, 締日設定) {
  const y = Number(年), m = Number(月);
  const 末 = new Date(Date.UTC(y, m, 0)).getUTCDate();
  const d = Number(締日設定) === 31 ? 末 : 20;   // 売上.請求日 の式と同じ向き: 締日設定=31 → 月末、それ以外 → 20 日規則
  return `${y}-${String(m).padStart(2, "0")}-${String(d).padStart(2, "0")}`;
}
/** 「2024年04月」→ {y:"2024", m:"04"} */
const 年月を読む = (s) => { const m = String(s ?? "").match(/(\d{4})\D+(\d{1,2})/); return m ? { y: m[1], m: m[2].padStart(2, "0") } : null; };

/** ─── 共通の紙。A4。Documint の出力（実物）と同じく明朝ではなくゴシック ─── */
export function 紙に載せる(題, 中, { 横 = false, 追加CSS = "" } = {}) {
  const 幅 = 横 ? "297mm" : "210mm", 高 = 横 ? "210mm" : "297mm";
  return `<!doctype html><html lang=ja><head><meta charset=utf-8><title>${E(題)}</title><style>
@page{size:A4 ${横 ? "landscape" : "portrait"};margin:12mm 10mm}
*{box-sizing:border-box}
body{margin:0;font-family:"IPAGothic","IPAPGothic","Hiragino Kaku Gothic ProN","Yu Gothic",Meiryo,sans-serif;color:#000;background:#888;font-size:9pt}
.紙{width:${幅};min-height:${高};background:#fff;margin:10px auto;padding:12mm 10mm;position:relative}
@media print{body{background:#fff}.紙{margin:0;width:auto;min-height:0;padding:0}}
.題{text-align:center;font-size:16pt;letter-spacing:.2em;margin:0 0 8pt}
table{border-collapse:collapse;width:100%}
th,td{border:1px solid #000;padding:2pt 4pt;vertical-align:top}
th{font-weight:400;text-align:center}
td.r,th.r{text-align:right;font-variant-numeric:tabular-nums}
td.c{text-align:center}
.帯{background:#dbe9f7}
.帯th{background:#7fb2e5}
.小{font-size:8pt}
.注{font-size:8pt;color:#333}
.不明{background:#fff2f2;outline:1px dashed #c00;padding:0 2px}
.当方{margin-top:6pt;font-size:7.5pt;color:#555}
${追加CSS}
</style></head><body><div class=紙>${中}</div></body></html>`;
}
const 不明 = (v, 何) => (v !== "" && v != null) ? E(v) : `<span class=不明>${E(何)}</span>`;

/* ═══════════════════════════════════════════════════════════════════
 * 請求書
 * ═══════════════════════════════════════════════════════════════════ */

/** 売掛台帳の行を 鍵（売掛台帳ID か 行ID）で引く */
function 台帳を引く(db, 文脈, 鍵) {
  const { 行, 値 } = 器(db, 文脈);
  if (/^rec[A-Za-z0-9]{14}$/.test(鍵)) { const r = 行(鍵); return r && r.tbl === T.売掛台帳 ? r : null; }
  const hit = db.prepare("SELECT id FROM row WHERE tbl=? AND (json_extract(calc,'$.fldAlJGzaAi3EklGb')=? OR json_extract(snap,'$.fldAlJGzaAi3EklGb')=?)").get(T.売掛台帳, 鍵, 鍵);
  if (hit) return 行(hit.id);
  /** 計算値が手元に無い行（ミミックが作った直後など）は 得意先コード-年月 を組んで比べる */
  const m = 鍵.match(/^(.+)-(\d{6})$/); if (!m) return null;
  for (const r of db.prepare("SELECT id FROM row WHERE tbl=?").all(T.売掛台帳)) {
    const x = 行(r.id); if (!x) continue;
    const 得 = 行(関連先ID(値(x, F.台帳_得意先))[0]); const ym = 年月を読む(文字(値(x, F.台帳_月)));
    if (得 && ym && 文字(値(得, F.得_コード)) === m[1] && ym.y + ym.m === m[2]) return x;
  }
  return null;
}

/** その台帳に載る売上。得意先が同じ ∧ 請求日の年月が台帳の月 ∧ 返品旗が空（rollup の絞り込みと同じ） */
function 台帳の売上(db, 文脈, 得意先ID, ym) {
  const { 行, 値 } = 器(db, 文脈);
  const out = [];
  for (const r of db.prepare("SELECT id FROM row WHERE tbl=? AND json_extract(cells,'$.fldVRxAN22bt3BYV1[0].foreignRowId')=?").all(T.売上, 得意先ID)) {
    const x = 行(r.id); if (!x) continue;
    const p = 日付部(値(x, F.売_請求日)); if (!p || p.y + p.m !== ym.y + ym.m) continue;
    if (真(値(x, F.売_返品旗))) continue;
    out.push(x);
  }
  return out;
}

/** 請求書番号の連番。同じ月・同じ締日設定の台帳を得意先コード順に並べた位置（**推定**。実物 20250620_0001 / 20260831_0005 の形） */
function 請求書番号(db, 文脈, 台帳, ym, 締日設定, 締日) {
  const { 行, 値 } = 器(db, 文脈);
  const 同月 = [];
  for (const r of db.prepare("SELECT id FROM row WHERE tbl=? AND json_extract(cells,'$.fldTgVJHIUgCFzsat[0].foreignRowId')=?").all(T.売掛台帳, 関連先ID(値(台帳, F.台帳_月))[0] ?? "")) {
    const x = 行(r.id); if (!x) continue;
    if ((数値(値(x, F.台帳_締日設定)) ?? 31) !== 締日設定) continue;
    同月.push({ id: x.id, code: 文字(値(x, F.台帳_ID)) });
  }
  同月.sort((a, b) => a.code.localeCompare(b.code));
  const i = 同月.findIndex((x) => x.id === 台帳.id);
  return `${締日.replace(/-/g, "")}_${String(i + 1).padStart(4, "0")}`;
}

export function 請求書を組む(db, 鍵, 文脈) {
  const { 行, 値 } = 器(db, 文脈);
  const 台帳 = 台帳を引く(db, 文脈, 鍵); if (!台帳) return null;
  const 得意先 = 行(関連先ID(値(台帳, F.台帳_得意先))[0]);
  const ym = 年月を読む(文字(値(台帳, F.台帳_月))) ?? { y: "", m: "" };
  const 締日設定 = 数値(値(台帳, F.台帳_締日設定)) ?? 31;
  const 締日 = ym.y ? 締日を求める(ym.y, ym.m, 締日設定) : "";
  const 台帳ID = 文字(値(台帳, F.台帳_ID)) || 鍵;
  const 送信 = 値(台帳, F.台帳_送信日時);
  const 発行日 = 送信 ? 日付(送信) : (締日 ? 日付(new Date(new Date(締日 + "T00:00:00Z").getTime() + 86400e3)) : "");
  /** 請求書番号は 2024-11 以降の様式。実物 DO032-202404 は番号・発行日が空欄なので、それより前は空にする */
  const 番号 = 締日 && 締日 >= "2024-11-01" ? 請求書番号(db, 文脈, 台帳, ym, 締日設定, 締日) : "";

  const 名 = 得意先 ? (文字(値(得意先, F.得_表示請求先名)) || 文字(値(得意先, F.得_名称1))) : "";
  const コード = 得意先 ? 文字(値(得意先, F.得_コード)) : 台帳ID.split("-")[0];
  const 郵便 = 得意先 ? 文字(値(得意先, F.得_郵便)) : "";
  const 住所 = 得意先 ? [文字(値(得意先, F.得_住所1)), 文字(値(得意先, F.得_住所2)), 文字(値(得意先, F.得_住所3))].filter(Boolean) : [];
  /** 2024-04 の実物は 住所1 と 住所2 が同じ文で二重に印字されていた。同じ行は 1 回にする */
  const 住所行 = [...new Set(住所)];

  const 売上たち = 得意先 ? 台帳の売上(db, 文脈, 得意先.id, ym) : [];
  const 伝票 = 売上たち.map((s) => ({
    id: s.id, 伝票ID: 文字(値(s, F.売_ID)), 日付: 日付(値(s, F.売_計上日)),
    販売金額: 数値(値(s, F.売_販売金額)), 明細: 明細を引く(db, 文脈, s.id),
  })).sort((a, b) => a.日付.localeCompare(b.日付) || a.伝票ID.localeCompare(b.伝票ID));

  /**
   * 台帳の計算値（snap/calc）が手元に無い行が 1,346/4,704 ある。**無い値を 0 に潰さない**（検証 2026-09-13: 31/75 枚が全 0 の要約表で注記なし）。
   * 無いものは 不明 の印で出し、明細から組める 御買上 だけ「当方の計算」と明示して補う。計算用の数は 0 で続ける
   */
  const 生 = { 前回: 数値(値(台帳, F.台帳_前回請求)), 入金: 数値(値(台帳, F.台帳_今回入金)), 繰越: 数値(値(台帳, F.台帳_繰越)), 御買上: 数値(値(台帳, F.台帳_当月売掛)), 消費税: 数値(値(台帳, F.台帳_消費税)), 今回請求: 数値(値(台帳, F.台帳_今回請求)) };
  const 明細の和 = 伝票.reduce((s, d) => s + d.明細.reduce((t, x) => t + (x.金額 ?? 0), 0), 0);
  const 前回 = 生.前回 ?? 0, 入金 = 生.入金 ?? 0, 繰越 = 生.繰越 ?? (生.前回 != null && 生.入金 != null ? 前回 - 入金 : 0);
  const 御買上 = 生.御買上 ?? (伝票.some((d) => d.明細.length) ? 明細の和 : 0), 消費税 = 生.消費税 ?? 0, 今回請求 = 生.今回請求 ?? (繰越 + 御買上 + 消費税);
  const 欠け = Object.entries(生).filter(([, v]) => v == null).map(([k]) => k);
  /** 要約表の 1 升。無い値は印、明細から補った 御買上 は「当方の計算」と明示 */
  const 金 = (名, 値) => 生[名] != null ? E(数(値)) : (名 === "御買上" && 伝票.some((d) => d.明細.length) ? `<span class=当方 title="台帳の当月売掛金額が手元に無いので明細の和">${E(数(値))}</span>` : `<span class=不明 title="台帳の計算値が手元に無い">—</span>`);
  /** 税区分の小表。明細を税率で分ける。消費税は台帳の rollup（売上.消費税 の和）を税率の割合で配る＝実物は 8% だけの得意先ばかりで確認できていない */
  const 税抜 = { 10: 0, 8: 0 };
  for (const d of 伝票) for (const x of d.明細) 税抜[x.税率 === 10 ? 10 : 8] += x.金額 ?? 0;
  const 税 = { 10: 0, 8: 0 };
  if (税抜[10] && !税抜[8]) 税[10] = 消費税; else if (税抜[8] && !税抜[10]) 税[8] = 消費税;
  else { 税[10] = Math.round(税抜[10] * 0.1); 税[8] = 消費税 - 税[10]; }
  const 入金日 = 値(台帳, F.台帳_入金日) ? 日付(値(台帳, F.台帳_入金日)) : 締日;

  const 明細行 = 伝票.map((d) => {
    const 行々 = d.明細.length ? d.明細.map((x) => `<tr>
      <td>${E(d.日付)}</td>
      <td>${E(d.伝票ID)}<br>${E(x.品番)}</td>
      <td>${E(x.商品名)}${x.税率 === 8 ? "　　*" : ""}</td>
      <td>${x.数量 ? `${E(数(x.数量))} キロ` : "0"}<br>${E(数(x.ケース))} ケース</td>
      <td class=r>${E(数(x.単価))}</td>
      <td class=r>${E(数(x.金額))}</td></tr>`).join("")
      : `<tr><td>${E(d.日付)}</td><td>${E(d.伝票ID)}</td><td colspan=3 class=注>明細（出庫）の辺が手元にありません</td><td class=r>${E(数(d.販売金額))}</td></tr>`;
    const 小計 = d.明細.length ? d.明細.reduce((t, x) => t + (x.金額 ?? 0), 0) : (d.販売金額 ?? 0);
    return 行々 + `<tr class=帯><td colspan=5 class=小>伝票NO別売上合計：${E(d.伝票ID)}　|　${E(名)}</td><td class=r>${E(数(小計))}</td></tr>`;
  }).join("");

  const 中 = `<div class=題>請求書</div>
  <div style="display:flex;justify-content:space-between;align-items:flex-start">
    <div style="width:55%;padding-top:14pt">
      <div class=小>${E(郵便 ? (郵便.startsWith("〒") ? 郵便 : "〒" + 郵便) : "")}</div>
      ${住所行.map((x) => `<div class=小>${E(x)}</div>`).join("")}
      <div style="font-size:12pt;margin-top:6pt">${不明(名, "得意先の行が手元にありません")} 御中</div>
      <div class=小>(コード：${E(コード)})</div>
    </div>
    <div style="width:42%">
      <div class=小>請求書番号：<span title="DBに無い。締日＋同じ締日の台帳の連番（推定）">${E(番号)}</span></div>
      <div class=小>発行日：${E(年月日(発行日))}</div>
      <div class=小>請求締日：${E(年月日(締日))}</div>
      <div style="margin-top:14pt" class=小>${E(自社.郵便)}${E(自社.住所)}</div>
      <div>${E(自社.名)}</div>
      <div class=小>登録番号：${E(自社.登録番号)}</div>
      <div class=小>電話：${E(自社.TEL)}</div>
      <div class=小>FAX：${E(自社.FAX)}</div>
      <div class=小 style="margin-top:8pt">(振込銀行)</div>
      ${自社.銀行.map((x) => `<div class=小>${E(x)}</div>`).join("")}
    </div>
  </div>
  <div class=注 style="margin:10pt 0 4pt 20pt">${E(軽減税率の注)}</div>
  <table style="margin-top:4pt"><thead><tr class=帯th>
    <th>前回請求金額</th><th>今回入金額</th><th>繰越金額</th><th>御買上額</th><th>消費税</th><th>今回請求額</th></tr></thead>
    <tbody><tr><td class=c>${金("前回", 前回)}</td><td class=c>${金("入金", 入金)}</td><td class=c>${金("繰越", 繰越)}</td><td class=c>${金("御買上", 御買上)}</td><td class=c>${金("消費税", 消費税)}</td><td class=c>${金("今回請求", 今回請求)}</td></tr></tbody></table>
    ${欠け.length ? `<div class=当方>台帳の計算値が手元に無い: ${E(欠け.join("・"))}（この台帳は Airtable の計算値を取っていない 1,346 行のひとつ。空欄は値が無いこと、—は不明を表す）</div>` : ""}
  <table style="margin-top:10pt"><thead><tr class=帯th>
    <th style="width:13%;text-align:left">伝票日付</th><th style="width:17%;text-align:left">伝票NO／品番</th><th style="text-align:left">品名</th><th style="width:16%;text-align:left">数量</th><th style="width:11%;text-align:left">単価</th><th style="width:13%;text-align:left">金額</th></tr></thead>
    <tbody>${明細行}
    <tr class=帯><td colspan=5 class=小>得意先(契約先)別売上合計：　|　${E(名)}</td><td class=r>${E(数(明細の和 || 御買上))}</td></tr>
    ${入金 ? `<tr><td>${E(入金日)}</td><td>${E(台帳ID)}</td><td>入金<span class=当方 title="部門名はDBに無い">（部門名は手元に無い）</span></td><td></td><td></td><td class=r>${E(数(入金))}</td></tr>` : ""}
    <tr class=帯><td colspan=5 class=小>入金合計：　|　${E(名)}</td><td class=r>${E(数(入金))}</td></tr>
    <tr class=帯><td colspan=5 class=小>今回請求額：　|　${E(名)}</td><td class=r>${E(数(今回請求))}</td></tr>
    </tbody></table>
  <table style="margin-top:12pt;width:56%"><thead><tr class=帯th><th>税区分</th><th>消費税</th><th>金額(税抜)</th><th>金額(税込)</th></tr></thead>
    <tbody>
      <tr><td class=c>10%対象</td><td class=r>${E(数(税[10]))}</td><td class=r>${E(数(税抜[10]))}</td><td class=r>${E(数(税抜[10] + 税[10]))}</td></tr>
      <tr><td class=c>8%対象</td><td class=r>${E(数(税[8]))}</td><td class=r>${E(数(税抜[8]))}</td><td class=r>${E(数(税抜[8] + 税[8]))}</td></tr>
    </tbody></table>
  ${Math.abs(明細の和 - 御買上) > 0.5 && 伝票.some((d) => d.明細.length) ? `<div class=当方>当方の検算: 明細の和 ${E(数(明細の和))} と台帳の当月売掛金額 ${E(数(御買上))} が合いません（手元に無い明細か、締日をまたぐ伝票）</div>` : ""}`;
  return 紙に載せる(`請求書 ${台帳ID}`, 中);
}

/** 一覧: 売掛台帳。月の新しい順 → 台帳ID。60-docs が 300 件で切る */
function 請求書の一覧(db, 文脈) {
  const { 行, 値 } = 器(db, 文脈);
  const out = [];
  for (const r of db.prepare("SELECT id FROM row WHERE tbl=?").all(T.売掛台帳)) {
    const x = 行(r.id); if (!x) continue;
    const id = 文字(値(x, F.台帳_ID)); const ym = 年月を読む(文字(値(x, F.台帳_月)));
    const 額 = 数値(値(x, F.台帳_今回請求));
    out.push({ 鍵の値: id || x.id, 表示: `${id || x.id}　${文字(値(x, F.台帳_得意先))}`, 補足: `今回請求額 ${額 == null ? "—" : 数(額)}`, 順: (ym ? ym.y + ym.m : "000000") + (id || "") });
  }
  out.sort((a, b) => b.順.localeCompare(a.順));
  return out;
}

/* ═══════════════════════════════════════════════════════════════════
 * 出荷明細書・納品書・受領書（実物なし）
 * ═══════════════════════════════════════════════════════════════════ */

const 実物なしの注 = "※ この紙は現行の実物（Google Drive に出る PDF）と突き合わせていない。列は PDF生成指示・出荷依頼 Form・出庫の項目から決めた。";

/** 売上の行を 売上伝票ID か 行ID で引く */
function 売上を引く(db, 文脈, 鍵) {
  const { 行 } = 器(db, 文脈);
  if (/^rec[A-Za-z0-9]{14}$/.test(鍵)) { const r = 行(鍵); return r && r.tbl === T.売上 ? r : null; }
  const hit = db.prepare("SELECT id FROM row WHERE tbl=? AND (json_extract(calc,'$.fld9EXtVvEZHn78y2')=? OR json_extract(snap,'$.fld9EXtVvEZHn78y2')=?)").get(T.売上, 鍵, 鍵);
  return hit ? 行(hit.id) : null;
}

/** 売上 1 件の宛先。出荷依頼 Form が売上に書いた住所（郵便番号・住所1・住所3…）を優先し、無ければ得意先マスタ */
function 宛先(db, 文脈, s) {
  const { 行, 値 } = 器(db, 文脈);
  const 得 = 行(関連先ID(値(s, F.売_得意先))[0]);
  const g = (fs, fg) => 文字(値(s, fs)) || (得 ? 文字(値(得, fg)) : "");
  return {
    名: 文字(値(s, F.売_得意先名2)) || (得 ? (文字(値(得, F.得_表示請求先名)) || 文字(値(得, F.得_名称1))) : "") || 文字(値(s, F.売_請求先名)),
    コード: 得 ? 文字(値(得, F.得_コード)) : "",
    郵便: g(F.売_郵便, F.得_郵便), 住所1: g(F.売_住所1, F.得_住所1), 住所3: g(F.売_住所3, F.得_住所3),
    電話: g(F.売_電話, F.得_電話), FAX: g(F.売_FAX, F.得_FAX),
    敬称: 文脈.書く(値(s, F.売_敬称), 文脈.項目.get(F.売_敬称)) || "御中",
  };
}

/** 出荷明細書。鍵 = 出荷日 YYYY-MM-DD（末尾に -4 / -6 で種類番号を絞れる。PDF生成指示 の 出荷日1 × 種類番号 と同じ切り方） */
export function 出荷明細書を組む(db, 鍵, 文脈) {
  const { 行, 値 } = 器(db, 文脈);
  const m = String(鍵).match(/^(\d{4}-\d{2}-\d{2})(?:-([46]))?$/); if (!m) return null;
  const 日 = m[1], 種類 = m[2] ? Number(m[2]) : null;
  const 売上たち = [];
  for (const r of db.prepare("SELECT id FROM row WHERE tbl=? AND substr(json_extract(cells,'$.fldYBcriATvxY3NYC'),1,10)=?").all(T.売上, 日)) {
    const x = 行(r.id); if (!x) continue;
    if (種類 && 数値(値(x, F.売_種類番号)) !== 種類) continue;
    売上たち.push(x);
  }
  if (!売上たち.length) return null;
  const 行々 = [];
  for (const s of 売上たち.sort((a, b) => 文字(値(a, F.売_ID)).localeCompare(文字(値(b, F.売_ID))))) {
    const 宛 = 宛先(db, 文脈, s);
    const 明細 = 明細を引く(db, 文脈, s.id);
    const ロット = 真(値(s, F.売_ロット表示)), 期限 = 真(値(s, F.売_賞味期限表示));
    if (!明細.length) 行々.push(`<tr><td>${E(文字(値(s, F.売_ID)))}</td><td>${E(宛.名)}</td><td colspan=8 class=注>明細（出庫）が手元にありません</td></tr>`);
    for (const x of 明細) 行々.push(`<tr>
      <td>${E(文字(値(s, F.売_ID)))}</td><td>${E(宛.名)}</td><td>${E(x.品番)}</td><td>${E(x.商品名)}</td>
      <td>${ロット || x.ロット ? E(x.ロット) : ""}</td><td>${期限 || x.賞味期限 ? E(x.賞味期限) : ""}</td>
      <td class=r>${E(数(x.数量))}</td><td class=r>${E(数(x.ケース))}</td><td>${E(x.倉庫)}</td>
      <td class=小>${E([文字(値(s, F.売_運送会社)), 文字(値(s, F.売_出荷依頼書備考)), x.備考].filter(Boolean).join(" / "))}</td></tr>`);
  }
  const 中 = `<div class=題>出荷明細書</div>
  <div style="display:flex;justify-content:space-between"><div>出荷日　${E(年月日(日))}${種類 ? `　　種類 ${種類}（${種類 === 4 ? "海外" : "国内"}）` : ""}</div><div class=小>${E(自社.名)}　${E(自社.TEL)}</div></div>
  <table style="margin-top:8pt"><thead><tr class=帯th><th>伝票NO</th><th>得意先</th><th>品番</th><th>品名</th><th>ロットNO</th><th>賞味期限</th><th>数量(kg)</th><th>ケース</th><th>出庫倉庫</th><th>備考</th></tr></thead><tbody>${行々.join("")}</tbody></table>
  <div class=注 style="margin-top:8pt">${E(実物なしの注)}</div>`;
  return 紙に載せる(`出荷明細書 ${日}`, 中, { 横: true });
}

/** 納品書・受領書。鍵 = 売上伝票ID。受領書 は同じ中身で題と受領印の欄が違う */
function 納品書系を組む(db, 鍵, 文脈, 題) {
  const { 値 } = 器(db, 文脈);
  const s = 売上を引く(db, 文脈, 鍵); if (!s) return null;
  const 宛 = 宛先(db, 文脈, s);
  const 明細 = 明細を引く(db, 文脈, s.id);
  const ロット = 真(値(s, F.売_ロット表示納)), 期限 = 真(値(s, F.売_賞味期限表示納)), 金額 = 真(値(s, F.売_金額表示));
  const 合計 = 明細.reduce((t, x) => t + (x.金額 ?? 0), 0);
  const 伝票ID = 文字(値(s, F.売_ID));
  const 中 = `<div class=題>${E(題)}</div>
  <div style="display:flex;justify-content:space-between;align-items:flex-start">
    <div style="width:55%;padding-top:8pt">
      <div class=小>${E(宛.郵便 ? (宛.郵便.startsWith("〒") ? 宛.郵便 : "〒" + 宛.郵便) : "")}</div>
      <div class=小>${E(宛.住所1)}</div>${宛.住所3 ? `<div class=小>${E(宛.住所3)}</div>` : ""}
      <div style="font-size:12pt;margin-top:6pt">${不明(宛.名, "得意先が手元にありません")} ${E(宛.敬称)}</div>
      <div class=小>(コード：${E(宛.コード)})　TEL ${E(宛.電話)}　FAX ${E(宛.FAX)}</div>
    </div>
    <div style="width:42%">
      <div class=小>伝票NO：${E(伝票ID)}</div>
      <div class=小>出荷日：${E(年月日(値(s, F.売_出荷日)))}</div>
      ${値(s, F.売_納品日) ? `<div class=小>納品日：${E(年月日(値(s, F.売_納品日)))}</div>` : ""}
      ${値(s, F.売_引取日) ? `<div class=小>引取日：${E(年月日(値(s, F.売_引取日)))}</div>` : ""}
      ${文字(値(s, F.売_運送会社)) ? `<div class=小>運送会社：${E(文字(値(s, F.売_運送会社)))}</div>` : ""}
      <div style="margin-top:10pt" class=小>${E(自社.郵便)}${E(自社.住所)}</div>
      <div>${E(自社.名)}</div>
      <div class=小>登録番号：${E(自社.登録番号)}</div>
      <div class=小>電話：${E(自社.TEL)}　FAX：${E(自社.FAX)}</div>
    </div>
  </div>
  <div style="margin-top:8pt">下記の通り納品${題 === "受領書" ? "いたしましたので、ご確認のうえご署名・ご捺印をお願い申し上げます" : "いたします"}。</div>
  <table style="margin-top:6pt"><thead><tr class=帯th><th>品番</th><th>品名</th>${ロット ? "<th>ロットNO</th>" : ""}${期限 ? "<th>賞味期限</th>" : ""}<th>数量(kg)</th><th>ケース</th>${金額 ? "<th>単価</th><th>金額</th>" : ""}</tr></thead>
    <tbody>${明細.length ? 明細.map((x) => `<tr><td>${E(x.品番)}</td><td>${E(x.商品名)}${x.税率 === 8 ? "　*" : ""}</td>${ロット ? `<td>${E(x.ロット)}</td>` : ""}${期限 ? `<td>${E(x.賞味期限)}</td>` : ""}<td class=r>${E(数(x.数量))}</td><td class=r>${E(数(x.ケース))}</td>${金額 ? `<td class=r>${E(数(x.単価))}</td><td class=r>${E(数(x.金額))}</td>` : ""}</tr>`).join("")
      : `<tr><td colspan=8 class=注>明細（出庫）が手元にありません</td></tr>`}
    ${金額 ? `<tr class=帯><td colspan=${5 + (ロット ? 1 : 0) + (期限 ? 1 : 0)} class=r>合計</td><td class=r>${E(数(合計))}</td></tr>` : ""}</tbody></table>
  ${文字(値(s, F.売_納品書備考)) ? `<div style="margin-top:6pt;border:1px solid #000;padding:4pt;min-height:30pt"><b>備考</b><br>${E(文字(値(s, F.売_納品書備考)))}</div>` : ""}
  ${題 === "受領書" ? `<div style="display:flex;justify-content:flex-end;margin-top:12pt"><table style="width:40%"><tr><th>受領日</th><th>受領印</th></tr><tr><td style="height:50pt"></td><td></td></tr></table></div>` : ""}
  <div class=注 style="margin-top:8pt">${E(実物なしの注)}　表示の有無（ロットNO・賞味期限・金額）は 売上 のチェック欄（ロットNO表示-納品書・賞味期限表示-納品書・金額表示）に従う。</div>`;
  return 紙に載せる(`${題} ${伝票ID}`, 中);
}

/** 一覧: 出荷日ごと（新しい順）。売上 の 出荷日（入力日）を日で束ねる */
function 出荷日の一覧(db) {
  return db.prepare("SELECT substr(json_extract(cells,'$.fldYBcriATvxY3NYC'),1,10) d, count(*) n FROM row WHERE tbl=? AND json_extract(cells,'$.fldYBcriATvxY3NYC') IS NOT NULL GROUP BY d ORDER BY d DESC LIMIT 300").all(T.売上)
    .map((r) => ({ 鍵の値: r.d, 表示: r.d, 補足: `伝票 ${r.n} 件` }));
}
/** 一覧: 売上伝票（新しい順）。売上伝票ID は 種類-連番 なので文字の降順で新しい順になる（連番は作成順） */
function 売上の一覧(db) {
  return db.prepare("SELECT id, coalesce(json_extract(calc,'$.fld9EXtVvEZHn78y2'), json_extract(snap,'$.fld9EXtVvEZHn78y2')) k, json_extract(cells,'$.fldVRxAN22bt3BYV1[0].foreignRowDisplayName') c, substr(json_extract(cells,'$.fldYBcriATvxY3NYC'),1,10) d FROM row WHERE tbl=? AND k IS NOT NULL ORDER BY substr(k,3) DESC LIMIT 300").all(T.売上)
    .map((r) => ({ 鍵の値: r.k, 表示: `${r.k}　${r.c ?? ""}`, 補足: r.d ?? "" }));
}

export const 帳票 = [
  { 鍵: "請求書", 名: "請求書", 紙: "A4 縦", 実物: 334, 生成元: "Documint（PDF末尾の帯「made with documint」。Producer は Skia/PDF）",
    一覧: 請求書の一覧, 組む: 請求書を組む },
  { 鍵: "出荷明細書", 名: "出荷明細書", 紙: "A4 横", 実物: 0, 生成元: "Make → Google Drive（PDF生成指示.出荷明細書 ボタンの URL）。実物と突き合わせていない",
    一覧: (db) => 出荷日の一覧(db), 組む: 出荷明細書を組む },
  { 鍵: "納品書", 名: "納品書", 紙: "A4 縦", 実物: 0, 生成元: "Make → Google Drive（PDF生成指示.納品書・受領書）。実物と突き合わせていない",
    一覧: (db) => 売上の一覧(db), 組む: (db, 鍵, 文脈) => 納品書系を組む(db, 鍵, 文脈, "納品書") },
  { 鍵: "受領書", 名: "受領書", 紙: "A4 縦", 実物: 0, 生成元: "Make → Google Drive（PDF生成指示.納品書・受領書）。実物と突き合わせていない",
    一覧: (db) => 売上の一覧(db), 組む: (db, 鍵, 文脈) => 納品書系を組む(db, 鍵, 文脈, "受領書") },
];
