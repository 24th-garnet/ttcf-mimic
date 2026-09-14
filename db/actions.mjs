#!/usr/bin/env node
/**
 * **ボタンを押したときに走る処理。** 通信しない。現行Airtableには一切触れない。
 *
 * ■ この層が何を代わりにやっているか
 *
 * 現行システムのボタンは Airtable の Automation（ワークフロー）を叩く。
 * その定義は `readForWorkflows` が 403（アカウントが external・権限 none）で読めない。
 * そこで**4つの独立な証拠**を重ねて中身を決めた。
 *
 *   1. `workflowTriggerConnectionsById`  ボタン→ワークフローの**対応表そのもの**（23接続/15処理）
 *   2. ボタンの確認ダイアログ本文        **作った人自身の説明**（「明細を新しい売上伝票として複製し…」）
 *   3. 同じ画面に置かれた検証式          **押せる条件と画面に出る文言**（原文のまま再現する）
 *   4. 2つの断面の差（9/06 と 9/10）     **作られた行に埋まっている入力項目**＝処理が書いた項目
 *
 * 4だけは「押した結果」を直接見ている。だから**4と合わない推測は採らない**。
 *   例: 売掛台帳の新しい行は `得意先` と `月` の2項目だけだった。
 *       金額はすべて rollup/式なので、当月売掛作成が書くのはこの2項目である。
 *
 * ■ 確度の書き分け
 *
 *   確定    4（断面差）または3（検証式の文言が実測の画面印字と一致）で裏が取れている
 *   推定    2（本人の説明文）があるが、書いた項目そのものは見ていない
 *   未確定  対応表に載っているだけ。**この層では実行を断る**（黙って何かを書くより良い）
 */
import fs from "node:fs";
import path from "node:path";
import { 書き込み器を作る } from "./write.mjs";
import { ROOT } from "./open.mjs";
import { 本文 as bom本文 } from "./bom.mjs";

const 売上 = "tblUBK06Qb5cBQ9Tg";
const 出庫 = "tblkV3ZPRWixoUtaB";
const 振替伝票 = "tblYHadttkRzUs2RX";
const 在庫NO = "tblUl9UWNIu0ghDpJ";
const 入庫 = "tblBQUOzMFeLE82W8";
const 月表 = "tblFpaCyRYS3sRbyi";
const 売掛台帳 = "tbltny3ibbQKRiEkX";
const 単価マスタ = "tbljaQ8q5KeN1WjcM";
/**
 * ─── Make・miniExtensions の置き換えで触る表（製造・在庫登録・締処理） ───
 * **名前では引かない。** 「入庫」「出庫」「締処理」「締処理履歴」「商品」は販売と製造で同名の表が別にある（同名 7 組）。
 */
const 仕入明細 = "tblp36gGtA20YSd6X";      // 在庫登録/仕入明細（①CSV登録 で入る明細。3,639 行）
const 販売商品 = "tbl7a8vyIotDy0XnU";      // 販売/商品（入庫.商品コード の関連先）
const 製造商品 = "tblKlBAO8mydnK5kt";      // 製造/商品（製品生産.製品 の関連先。製品ID は販売/商品と同じ O0407003 の形）
const 製品生産 = "tblKBlEDBVxWjS5ep";      // 製造/製品生産（生産指示）
const 製造出庫 = "tbldI0k3JugVOVqwU";      // 製造/出庫（使用原材料＝BOM の子行。手元は 0 行、実物 412 行は crawl/out/raw/bom）
const 製造入庫 = "tbl3taxsMw9Vq4rJe";      // 製造/入庫（原材料のロット。2,178 行）
const 仕掛入庫 = "tblp0szvkXNAXWEwA", 仕掛出庫 = "tblUxvNe9NT5EFRU0", 移動伝票 = "tbl4ylZ7JpS2cMPg7", 仕掛移動伝票 = "tblXcpsgHzc8bdRaM";
const 締処理販売 = "tblXBXGzWLtC0znWB", 締処理履歴販売 = "tbldE0PBhTy5mTSrk";
const 締処理製造 = "tbl20MaFxT5PxxNUQ", 締処理履歴製造 = "tblM3TTd7NcKYQef9";
const 請求締 = "tblNFr1btd0LZMxgs";
const 分類 = "tblhGZ74i6sqZ79XM", 保管先 = "tblwe3kswLJfA9SsG";

/** 項目ID。名前が伏せられている項目があるので**IDで書く**（名前で引くと取り違える） */
const F = {
  売上_関門: "fld5awxB3ab7K504K",
  売上_売上登録: "fldjTWEHkIbq31pnS",
  売上_受注登録: "fldt4F3bdqFk5ZdzS",
  売上_月3: "fldagKR1eVzZ5Wikn",
  売上_出荷日入力: "fldYBcriATvxY3NYC",
  売上_出庫リンク: "fldcfGRbbkWIos9hp",
  売上_得意先: "fldVRxAN22bt3BYV1",
  売上_伝票区分: "fldTEeG8wTW8D6Mtx",
  /** **種類番号は fldL1zhYcB9bimy9x（number）。** 以前 fldhwUIFOpTrqZBt3（無名の rollup SUM(values)）を
   *  指していたため、締処理エラー(編集)S4/S6 の選び分けが常に S6 に落ちていた（監査 2026-09-11 で判明） */
  売上_種類番号: "fldL1zhYcB9bimy9x",
  売上_締編集S4: "fldoXDmftTStKJlWV",
  売上_締編集S6: "fldPOhUXYpaU84lYI",
  売上_返品旗: "fldbA83lv31IIaJk6",
  /** **出庫.商品コードは fldAByG8XY58yXvFm（販売/商品への関連）。** 以前の fldTgDdKqvqcmPB0H は存在しない項目で、
   *  単価検索が必ず「該当なし」になっていた（監査 2026-09-11 で判明） */
  出庫_商品コード: "fldAByG8XY58yXvFm",
  出庫_在庫反映フラグ: "fldgOknULvoHEvisE",
  出庫_売上登録エラー: "fldTuf8B77XYNavoM",
  出庫_振替登録エラー: "fldK5F8ax0TWdN60U",
  出庫_振替伝票リンク: "fldeD2hwqcgXYp7Ix",
  入庫_入庫登録エラー: "fldltyZT3NewHsWAF",
  出庫_区分: "fldvfVq3OloLsVRup",
  出庫_販売単価: "fldUTTfrctmQ8kfoH",
  出庫_在庫明細ID: "fldow210kASYVp4qz",
  出庫_単価リンク: "fldKa0TZuYhV8IQ1W",
  /** **出庫→売上の関連は fld7MzewVUPmeQ1AV（891辺）。** 売上側 fldcfGRbbkWIos9hp は
   *  `逆にしない`（unreversed）なので辺が0本で、そちらを辿ると明細が見えない */
  出庫_売上リンク: "fld7MzewVUPmeQ1AV",
  得意先_取引先コード: "fld9JGbre6Jdq6DFV",
  売掛_得意先コード: "fldrxYC0brqlY1KIO",
  月_日付: "fldcUM3tBObyt84jf",
  振替_関門: "fldXFgkGpNRB29Y1P",
  振替_振替登録: "fld4p1aygCdLr1eTH",
  振替_編集エラー: "fldlyBG3FvJwmfVfs",
  在庫NO_関門登録: "fldJRr5RsguAuGBya",
  在庫NO_関門解除: "fld9ynyNS4PapaaSp",
  在庫NO_登録: "fldouzGHlOxhevlGB",
  在庫NO_入庫リンク: "fldXmCHPdQuoyyVxt",
  入庫_入庫登録: "fldznEvelyrzAMePf",
  入庫_出庫リンク: "fld4sYaw5JSvlB971",
  入庫_在庫NOリンク: "fld7Y3EBXMLS8oCst",
  月_年月: "fldHAFjF2tqiH1Apb",
  売掛_得意先: "fldufkFOXP4ayCeQK",
  売掛_月: "fldTgVJHIUgCFzsat",
  単価_取引先: "flda0rd0XsyJoiSwe",
  単価_商品コード: "fld1YPJTPM27IiG9w",
  単価_商品ID: "fldiLk0IO6YwP1dac",
  単価_10cs: "fldOx08lsSRwSLPeD", 単価_50cs: "fldzgRlljGvdUPeMt", 単価_100cs: "fld4CAdXq0aIzNula", 単価_250cs: "fldGXo7RSPujK6tRo", 単価_500cs: "fldwNObNM3j5vJQxX",

  /** ─── 在庫登録/仕入明細（CSV の見出しと同名。fld 表から ID で引いた） ─── */
  明細_仕入NO: "fldBBEgxdi6MMyxIn", 明細_商品コード: "fldZP1SnrU2kijDC2", 明細_商品名: "fldDrj43Rtq6j0rHR",
  明細_数量1: "fldB2tAgv71chFdGP", 明細_数量2: "fldqmt9vtvtH2Es5k", 明細_原価単価: "fld7Vx7N6gN00ddKR",
  明細_ロットNO: "fldFOZQ5Mz59dfmAT", 明細_備考: "fldqHMtaMrXMlPj0q", 明細_登録済: "fld4Y3fvMmCVRmLLX", 明細_明細NO: "fldpXtJIgl6nlzXSI",
  /** ─── 販売/入庫（在庫明細） ─── */
  入庫_在庫明細ID: "fld9ylt8ltVqxSe5h", 入庫_連番: "fld22SSToFdj7xXRq", 入庫_入庫日: "fldQKPOy5gusvuFTF", 入庫_賞味期限: "fldrvZCcypnj4pG7V",
  入庫_ロットNO: "fldkqlt3Bcp1ayRXk", 入庫_仕入NO: "fldl54jC2y8pTZltl", 入庫_商品コード: "fldaUgsmOofATDhcn", 入庫_商品名: "fldT7hPZ8jDKrf8M5",
  入庫_在庫数: "fldAyHjAs41h6uPir", 入庫_単位: "fldzFhJ28GSt1VfGH", 入庫_入数: "fld72sYpMA8QbMS7H", 入庫_梱包単位: "fldcVqRRdF1IeoE8P",
  /** 原価単価1 は式 `ROUND(IF({この項目},{この項目},金額/数量))`。入力はこの無名の currency 項目に入る */
  入庫_原価単価入力: "fldvCJQ39DVIT9xR3", 入庫_倉庫: "fldwbpmRGwj42Gbpy", 入庫_締処理リンク: "fld2RbqXL4SC4wfof", 入庫_選択: "fldrEdH7CWYht3qWE",
  /** ─── 販売/在庫NO・販売/商品 ─── */
  在庫NO_在庫NO: "fldc3eeyTXFKxbvMi", 在庫NO_入庫日: "fldSQgTNMcOlkuZv0", 在庫NO_倉庫: "fldlEtxdEvljNn06l", 在庫NO_締処理リンク: "fld2jMRxAD8SSkfLA",
  商品_製品ID: "fldYZBJPJSGlefqa2", 商品_入数: "fldDanKFTsTA3zSAD",
  /** ─── 製造/製品生産 ─── */
  生産_製造日: "flddd3n2fLMWxNaBR", 生産_製品: "fldeUlgoD3fPI5JwE", 生産_製品名: "fld8MS9rMjV7oLY5J", 生産_製品コード: "fldjBaGJx0Na94EAZ",
  生産_使用原材料: "fldLkcz48xOMzKxTe", 生産_賞味期限: "fldAbJXnphEK6fLO2", 生産_在庫計上数: "fldjCxccN1UhyA7vV", 生産_在庫計上数kg: "fldQfhzRBEdcV12BI",
  生産_ケース外端数登録: "fldD1pAf9M0AguOIv", 生産_入数: "fld8WF9KnL4R0bIZ4", 生産_連番: "fldyXlWAyJrmkkm3N",
  /** 在庫登録 checkbox は無名（📣登録 Form の compute mode の確認欄。spec/confirmed-0911 §3） */
  生産_在庫登録: "fldLHlqJsIlV9lgS9", 生産_在庫登録確認: "fld73ClynxvnqaFpr", 生産_登録エラー: "fld28Z55GLa4V2qPp", 生産_締処理リンク: "fldR6xYyXLRQmNg1H",
  /** ─── 製造/出庫（BOM の子行）・製造/入庫（原材料ロット） ─── */
  製出_出庫日: "fldKD3VqtzIRzSIsR", 製出_引当: "fldV523JcpWBevMAT", 製出_数量: "fldo2gXW9ByTqTo77", 製出_製品生産: "fldGe8aWdvO452fDQ",
  製出_検索キー: "fldMqso6f6cHti6ep", 製出_締処理リンク: "fldGONFBFZq6L86Wz",
  製入_入庫日: "fldGHv1M81qSaoaye", 製入_原材料: "fldoe1gvFBvRHy822", 製入_実在庫: "fldg82dZgvmLuHj5W", 製入_出庫リンク: "fld8bOSJfcLLbIVnZ", 製入_締処理リンク: "fld1FnpiRHJ7nvGqa",
  仕掛入_日: "fldjCjm0i9Q8Oqrwf", 仕掛入_締処理リンク: "fld6Q4kKEtF3hJ1c1", 仕掛出_日: "fldpQlEbyhJ7f0xGJ", 仕掛出_締処理リンク: "fldM9v4OvgVGghQDA",
  移動_日: "fld6sFunSp4AAk1Cr", 移動_締処理リンク: "flddycdOwefgXrTKW", 仕掛移動_日: "fldWOasM6GFYIC4us", 仕掛移動_締処理リンク: "fld9ipFD5LFpLiSo2",
  /** ─── 締処理（販売・製造それぞれ 1 行の表）と 締処理履歴 ─── */
  /** 締処理→履歴 の関連（逆にしない・辺 0）。締処理.締日 = MAX(履歴.締日) はこちら側を辿るので、履歴を作ったらここにも並べる */
  締販_履歴リンク: "fldo8KiBWUjHOMS7o", 締製_履歴リンク: "fldQQ9QbZMwOPj6bt", 製商品_製品ID: "fldPczwba5tbUD3VF",
  締販_締処理中確認: "fldK01K1TWhXb1i8R", 履販_締日: "fldnVyJs5KTuaYIOv", 履販_結果: "fldfahY3wUk8TfgMq", 履販_締処理: "fldC1I2yAiLsRZTxN", 履販_日時: "fld2FtLOEhDYoRuD6",
  締製_締処理中確認: "fldWonJ7qDmZYLpaK", 履製_締日: "fld4VBL4xpQDxI6aX", 履製_結果: "fldJ8iYHs9GxtpcbT", 履製_締処理: "fldWFdeZCMgsWrSqz", 履製_日時: "fldrH8uiFh4bNdF0h",
  売上_計上日: "fld5QHhPRdMop23kO", 売上_締処理リンク: "fldUTeIBsFlF30kHN", 出庫_締処理リンク: "flddEihTUEiGuzHwJ",
  振替_振替日: "fld2jQLuSxSTZQ8IQ", 振替_締処理リンク: "fldH28MR0nenJRBuP", 売掛_締処理リンク: "fld8rVHSJ89cvD3aR",
  請求締_ID: "fldGlLzZaqaOlFj9E", 請求締_操作: "fldSwqViSKjIbyNcC",
  /** 分類の無名 checkbox。`Last Modified テスト実行` = LAST_MODIFIED_TIME(これ) が棚卸表の「作成日時」（CSV の列名） */
  分類_作成旗: "fldlnRLNr5fK2zQRt",
};

/** 区分の選択肢ID（K=返品）。**名前ではなくIDで持つ** */
const 区分K = "selWAwVBwZJ74JnAa";
/** 選択肢ID（fld.opts.選択肢ID から）。同じ名の選択肢が販売と製造の履歴で別IDなので分けて持つ */
const 選択肢 = {
  単位_KGS: "selFUpFIVRjvpqbEF", 梱包_CASES: "selO7dIhapPbitRFz", 生産_登録済: "sel8Xf7dSZUaTk847",
  履販_済: "seldbmBxfk1r4n06r", 履販_解除: "selAx16w9zTYYSgkx", 履販_中: "seloy8VtpjlkiZzpN",
  履製_済: "selJgVXv9wLdqhre6", 履製_解除: "sel8haj51Caz66Icq", 履製_中: "selXYC532BGtkER28",
};
/**
 * 備考の地名 → 倉庫名。S4（海外品）のシステム登録は倉庫を**備考の地名**で決める
 * （断面差 102 行: 博多 46・東京 23・大阪 9・仙台 6。spec/confirmed-0911 §5）。倉庫表は手元に行が無いので、
 * 名前は 入庫.倉庫 の関連の表示名から行IDに直す（倉庫の行を探す）。
 */
const 備考の地名と倉庫 = { 博多: "083-三菱倉庫 福岡支店", 東京: "005-二葉（東京）", 大阪: "072-東武（大阪）", 仙台: "084-エムシーアール 仙台倉庫" };
/** S6（田川工場の製品）の入庫先。S6 入庫 3,527 行の倉庫 */
const 九州支店 = "003-九州支店";
/** Make の webhook。**絶対に叩かない。** ここに書くのは「何を置き換えたか」を示すためだけ（db/15-coverage が数える） */
const MAKE = {
  システム登録: "https://hook.eu1.make.com/tskq6eevlnp5sxt6wob8nydesk9slteu",
  選択: "https://hook.eu1.make.com/x6k39g9whjf1x2tolybwat1lfhcrgvtf?record_id=",
  棚卸表作成: "https://hook.eu1.make.com/phpbzcbivq6y6fotg7pibr51sregx48s?record_id=&table_id=",
  締処理解除製造: "https://hook.eu1.make.com/6wyq2e2m94qqjuya7bv2a5dcclmxsi7c?record_id=",
  締処理解除販売: "https://hook.eu1.make.com/15clpqyxrfa4ztw8h78z8fe0qicyvnw5?record_id=",
  当月売掛作成: "https://hook.eu1.make.com/xkg523xuxbc9i942d5ddw8sqjp86u16t",
};

/** ─── 日付の道具。**JSTで切る**（既存の 年月にする と同じ理由） ─── */
const JST = "Asia/Tokyo";
const 今日 = () => {
  const p = new Intl.DateTimeFormat("en-CA", { timeZone: JST, year: "numeric", month: "2-digit", day: "2-digit" })
    .formatToParts(new Date()).reduce((o, x) => (o[x.type] = x.value, o), {});
  return `${p.year}-${p.month}-${p.day}`;
};
/** 時刻なしの date 項目の形。既存行の 入庫日 は `2026-09-07T00:00:00.000Z`（JSTの深夜ではなく Z の深夜） */
const 日付だけ = (ymd) => `${ymd}T00:00:00.000Z`;
/** 時刻あり・Asia/Tokyo の date 項目の形。仕入明細.計上日 は CSV `8/31/2026 00:00` → `2026-08-30T15:00:00.000Z`（実測 S4-003458-19） */
const JSTの深夜 = (ymd) => new Date(`${ymd}T00:00:00+09:00`).toISOString();
const ymdに = (v) => { const s = Array.isArray(v) ? v[0] : v; const m = s ? String(s).match(/^(\d{4})-(\d{2})-(\d{2})/) : null; return m ? `${m[1]}-${m[2]}-${m[3]}` : null; };
const yymmdd = (ymd) => ymd.replace(/-/g, "").slice(2);
const 空白を除く = (s) => String(s ?? "").replace(/[\s　]/g, "");

export function 動作器を作る(db) {
  const w = 書き込み器を作る(db);
  const c = w.計算器;
  const 項目 = c.項目;

  const 関連先 = (fid) => 項目.get(fid)?.opts?.関連先 ?? null;
  const 逆側 = (fid) => 項目.get(fid)?.opts?.逆側の項目 ?? null;
  const 辿る = db.prepare("SELECT dst_row FROM link WHERE src_row=? AND fld=? ORDER BY ord");
  const 逆に辿る = db.prepare("SELECT src_row FROM link WHERE dst_row=? AND fld=? ORDER BY ord");

  /** 関連の先の行ID。**逆にしない関連（unreversed）は片側にしか辺が無い**ので両方見る */
  function 先の行(行ID, 関連項目) {
    const a = 辿る.all(行ID, 関連項目).map((r) => r.dst_row);
    if (a.length) return a;
    const 逆 = 逆側(関連項目);
    return 逆 ? 逆に辿る.all(行ID, 逆).map((r) => r.src_row) : [];
  }

  /** 関連を書くための形。write.mjs は `[{foreignRowId, …}]` を受ける */
  function 関連の形(xs) {
    return (Array.isArray(xs) ? xs : [xs]).filter(Boolean).map((rid) => {
      const r = c.取る(rid);
      const 主 = r && db.prepare("SELECT primary_fld FROM tbl WHERE id=?").get(r.tbl)?.primary_fld;
      const 名 = 主 ? (r.cells[主] ?? r.calc[主] ?? "") : "";
      return { foreignRowId: rid, foreignRowDisplayName: typeof 名 === "string" ? 名 : String(名 ?? "") };
    });
  }

  /**
   * 関門（ゲート）を見る。
   * **判定は「式の結果が空でないこと」**。現行システムの文言をそのまま返す。
   * 文言を作り直さない——作り直すと現場の人が覚えている文と変わってしまう。
   */
  function 関門を見る(e, 関門たち) {
    const 出 = [];
    for (const fid of 関門たち ?? []) {
      if (!項目.has(fid)) continue;
      const v = c.一つ計算(e, fid);
      const s = v == null ? "" : String(Array.isArray(v) ? v.join("") : v).trim();
      if (s) 出.push({ 項目ID: fid, 項目: 項目.get(fid)?.name ?? "無名", 文言: s });
    }
    return 出;
  }

  /** ─── 台帳 ─── */
  const 台帳 = new Map();
  const 定義 = (d) => 台帳.set(d.鍵, d);

  定義({
    鍵: "売上登録", 札: "登録／売上登録", 表: 売上,
    要素: ["pelMItXqgPsEZiINe"], 自動処理: ["wflwCcVC5iJZBwp5I"],
    画面: ["海外売上入力", "海外売上入力 受注管理有り", "国内売上入力"],
    関門: [F.売上_関門], 確認: null, 確度: "確定",
    子の関門: (e) => 先の行(e.id, F.売上_出庫リンク).map((行) => ({ 行, 関門: [F.出庫_売上登録エラー] })),
    根拠: "検証式 fld5awxB3ab7K504K の8節が実測の画面印字と順序まで一致。明細側は 出庫.売上登録エラー。書く先は 売上登録 と、明細の 在庫反映フラグ（登録済の売上の明細 35,228行が全部 true、編集中の40行だけ空——画面の所属から確定）",
    走る: (e) => [
      { 種: "更新", 行: e.id, 値: { [F.売上_売上登録]: true } },
      /** 明細の在庫反映フラグ。論理在庫の rollup 4本が =true で絞っているので、これが無いと在庫が動かない */
      ...先の行(e.id, F.売上_出庫リンク).map((rid) => ({ 種: "更新", 行: rid, 値: { [F.出庫_在庫反映フラグ]: true } })),
    ],
  });

  定義({
    鍵: "受注登録", 札: "受注登録", 表: 売上,
    要素: ["pel5TRMdqWKTkkmSn", "pelxSmAATPx2je8ck"], 自動処理: ["wflpsYZsq7uGajKmB"],
    画面: ["国内売上入力", "海外売上入力 受注管理有り"],
    関門: [F.売上_関門], 確認: null, 確度: "確定",
    根拠: "受注一覧の絞り込みは 受注登録=true ∧ 月3あり。画面の所属から真偽を決めると、受注登録=true の20行は全部 月3あり・売上登録なし、売上登録=true の19,584行は全部 月3なし・受注登録なし。受注状態と売上状態は排他で、月3 は受注登録が張り、売上登録／伝票変換が外す",
    走る: (e) => {
      const 手順 = [{ 種: "更新", 行: e.id, 値: { [F.売上_受注登録]: true } }];
      const 月 = 年月にする(e.cells[F.売上_出荷日入力] ?? e.calc[F.売上_出荷日入力]);
      if (月) 手順.push({ 種: "月を張る", 行: e.id, 年月: 月 });
      return 手順;
    },
  });

  定義({
    鍵: "売上伝票変換", 札: "売上伝票変換", 表: 売上,
    要素: ["pelaEYXPxmi0okx7R"], 自動処理: ["wflzJcbwjxltD3Fst"],
    画面: ["運用-受注登録"],
    関門: [], 関門を選ぶ: (e) => [種類番号(e) === 4 ? F.売上_締編集S4 : F.売上_締編集S6],
    確認: { 題: "売上伝票変換", 本文: "売上伝票に戻します。", 進むボタン: "はい、続けます。" },
    確度: "確定",
    根拠: "確認ダイアログ本文『売上伝票に戻します。』＋画面が受注登録=trueの行だけを見せている。受注状態の2項目を外す",
    走る: (e) => [
      { 種: "更新", 行: e.id, 値: { [F.売上_受注登録]: false } },
      { 種: "関連を外す", 行: e.id, 項目: F.売上_月3 },
    ],
  });

  定義({
    鍵: "売上編集", 札: "編集", 表: 売上,
    要素: ["pelaEYXPxmi0okx7R"], 自動処理: ["wfldiSaQZK1lSWnBn"],
    画面: ["運用-read only"],
    関門: [], 関門を選ぶ: (e) => [種類番号(e) === 4 ? F.売上_締編集S4 : F.売上_締編集S6],
    確認: { 題: "売上編集", 本文: "売上登録が解除されます。\n解除後は売上入力ページをご確認ください。\n続けますか？", 進むボタン: "はい、続けます。" },
    確度: "確定",
    根拠: "確認ダイアログが『売上登録が解除されます。』と明言している。明細の在庫反映フラグも外す（編集中の明細40行は全部空なので、解除で空に戻ると読む——ここだけ推定）",
    走る: (e) => [
      { 種: "更新", 行: e.id, 値: { [F.売上_売上登録]: false } },
      ...先の行(e.id, F.売上_出庫リンク).map((rid) => ({ 種: "更新", 行: rid, 値: { [F.出庫_在庫反映フラグ]: false } })),
    ],
  });

  定義({
    鍵: "売上削除", 札: "削除", 表: 売上,
    要素: ["pel6lmLCEdn1ZzlRr"], 自動処理: ["wflSqh1i9EoghVI7M"],
    画面: ["海外売上入力", "国内売上入力", "海外売上入力 受注管理有り"],
    関門: [], 確認: { 題: "削除しますか？", 本文: "この操作は取り消せません。", 進むボタン: "はい、削除します。" },
    確度: "確定",
    根拠: "同じ要素IDが振替画面では振替伝票を消す。売上画面では別ワークフローなので対象表が売上になる。明細も消えることは実データで確認: 販売/出庫 35,268行のうち売上リンクあり 34,610・親が無い孤児 0。9/10→9/11 に消えた出庫4行は親が残っている（明細だけの削除）",
    走る: (e) => [
      /** 明細（出庫）を先に消す。親を消すと明細が孤児になる */
      ...先の行(e.id, F.売上_出庫リンク).map((rid) => ({ 種: "消す", 行: rid })),
      { 種: "消す", 行: e.id },
    ],
  });

  定義({
    鍵: "コピー", 札: "コピー", 表: 売上,
    要素: ["pelCzR32yB3Ucrs97", "peljPHbOe4pubwUaE"], 自動処理: ["wflR7AbJxHhQq0D5Y"],
    画面: ["6売上入力→一覧"],
    関門: [],
    確認: { 題: "この伝票をコピーしますか？", 本文: "明細を新しい売上伝票として複製し、現在庫から引き当てます。\n押下後は、売上入力ページへ戻ってください。", 進むボタン: "コピーを作成する" },
    確度: "推定",
    根拠: "確認ダイアログ本文がそのまま仕様。実データでは同じ得意先・同じ明細内容の伝票の組1,518（18,088伝票）で在庫明細IDが同じもの346・違うもの16,077——『現在庫から引き直す』と矛盾しない。コピー由来と手入力を区別する印が無いので確定にはしない",
    走る: (e) => [{ 種: "伝票を複製", 行: e.id, 返品: false }],
  });

  定義({
    鍵: "返品", 札: "返品", 表: 売上,
    要素: ["pel8pTpM3d2xu5www"], 自動処理: ["wflGKKib2ObLU5Ekx"],
    画面: ["6売上入力→一覧"],
    関門: [],
    確認: { 題: "返品を登録しますか？", 本文: "この売上をコピーし、返品分（区分K・マイナス）を反映した売上伝票を作成します。\n押下後は、売上入力ページへ戻ってください。", 進むボタン: "返品を作成する" },
    確度: "確定",
    根拠: "確認ダイアログ『区分K・マイナス』＋実データ: 販売/出庫 35,268行で販売金額<0 は353行。うち341行が『販売単価が負・出庫数量0・ケース0・在庫明細なし』（値引き・返品の赤伝）、12行が『数量負・ケース負・単価正』（実物の返品、9行は在庫明細あり）。ボタンは前者を作る。後者は手入力の形",
    走る: (e) => [{ 種: "伝票を複製", 行: e.id, 返品: true }],
  });

  定義({
    鍵: "単価検索", 札: "単価検索", 表: 売上,
    /**
     * **海外側の要素にも接続がある。**
     * 以前「pelQn7MyEDwDu7xhZ には接続が無いので押しても何も起きない」と書いたが誤り。
     * ベース単位の応答（23件）しか読んでいなかったためで、画面ごとの応答を合算すると
     * 76件あり、その中に wtcMvnULqGzOWYpSE → wflNPRoPrhqK1gsP9（有効）が入っている。
     * 2026-09-10 と 2026-09-11 の両断面で同じなので、後から足されたものでもない。
     */
    要素: ["pelH8ozMxKbiPExX4", "pelQn7MyEDwDu7xhZ"], 自動処理: ["wflNPRoPrhqK1gsP9"],
    画面: ["国内売上入力", "海外売上入力"],
    関門: [], 確認: null, 確度: "確定（鍵）",
    根拠: "鍵は (取引先, 商品ID) の関連の対。単価表『取引先別商品別単価』は 取引先(関連)・商品ID(関連)・10/50/100/250/500c/s の5段階を持ち、出庫.単価リンク(fldKa0TZuYhV8IQ1W) を張ると 5 本の lookup と 顧客別単価(fld7R0lHYT8AYYcDU: ケース数入力で段を選ぶ IF 式) が動く。国内専用（対のある得意先は D/E コードのみ、海外伝票の対は 0）。実データ: 出庫 12,224 行のうち対あり 9,781、販売単価が段階価格と一致 3,650（2024: 20%・2025: 30%・2026: 76%）。専用の検証式は無い（全76表走査で0件）",
    走る: (e) => {
      const 得意先 = 先の行(e.id, F.売上_得意先)[0] ?? null;
      return 先の行(e.id, F.売上_出庫リンク).map((rid) => ({ 種: "単価を引く", 行: rid, 得意先 }));
    },
    注: "国内・海外の両画面にあり、どちらも同じ自動処理 wflNPRoPrhqK1gsP9 に繋がっている（接続6件・すべて有効）。未確定なのは『販売単価に段階価格を転記するか』だけ。ここでは転記せず、顧客別単価（式）を画面に出すに留める。詳細画面「運用-編集」は選択経由でしか開けず、単価リスト・顧客別単価の実値は 26 行すべて unauthorized で読めなかった（2026-09-11）",
  });

  定義({
    鍵: "振替登録", 札: "登録", 表: 振替伝票,
    要素: ["pelUjap0qqq7qjGoj"], 自動処理: ["wflGYrMTFKQNWSaFT"],
    画面: ["振替出庫入力", "振替入庫入力"],
    関門: [F.振替_関門], 確認: null, 確度: "確定",
    子の関門: (e) => 振替の出庫(e.id).map((行) => ({ 行, 関門: [F.出庫_振替登録エラー] })),
    根拠: "検証式 fldXFgkGpNRB29Y1P の4節が実測の画面印字『振替日にエラーがあります。入庫倉庫が選択されていません。振替明細が登録されていません。』と一致。明細側は 出庫.振替登録エラー",
    走る: (e) => [
      { 種: "更新", 行: e.id, 値: { [F.振替_振替登録]: true } },
      ...振替の出庫(e.id).map((rid) => ({ 種: "更新", 行: rid, 値: { [F.出庫_在庫反映フラグ]: true } })),
    ],
  });

  定義({
    鍵: "振替編集", 札: "編集", 表: 振替伝票,
    要素: ["pel4amQJmlMucrxKe"], 自動処理: ["wflK9j2dyiFK9YQut"],
    画面: ["出庫/倉庫移動"],
    関門: [F.振替_編集エラー], 確認: null, 確度: "確定",
    根拠: "登録の逆向き。同じ checkbox を両ボタンで往復させている",
    走る: (e) => [{ 種: "更新", 行: e.id, 値: { [F.振替_振替登録]: false } }],
  });

  定義({
    鍵: "振替削除", 札: "削除", 表: 振替伝票,
    要素: ["pel6lmLCEdn1ZzlRr"], 自動処理: ["wflRTRVcDgSEKW3p3"],
    画面: ["振替入庫入力", "振替出庫入力"],
    関門: [], 確認: { 題: "削除しますか？", 本文: "この操作は取り消せません。", 進むボタン: "はい、削除します。" },
    確度: "推定",
    根拠: "振替画面に置かれた『削除』。対象表は画面の rootRowContainer が振替伝票",
    走る: (e) => [{ 種: "消す", 行: e.id }],
  });

  定義({
    鍵: "一括在庫登録", 札: "一括在庫登録", 表: 在庫NO,
    要素: ["pel9errYQmBUvJDsj"], 自動処理: ["wflPErD2M9i3kNysy"],
    画面: ["Record Detail"],
    関門: [F.在庫NO_関門登録],
    子の関門: (e) => 配下の入庫(e.id).map((行) => ({ 行, 関門: [F.入庫_入庫登録エラー] })),
    確認: { 題: "一括在庫登録", 本文: "在庫No分を一括登録しますか?", 進むボタン: "はい、続けます。" },
    確度: "確定",
    根拠: "検証式 fldJRr5RsguAuGBya の2節（入庫日／倉庫）＋未登録明細数 fldpLT4CQs0Nnx6Oz が数える対象がそのまま処理対象",
    走る: (e) => [
      { 種: "更新", 行: e.id, 値: { [F.在庫NO_登録]: true } },
      ...配下の入庫(e.id).map((rid) => ({ 種: "更新", 行: rid, 値: { [F.入庫_入庫登録]: true } })),
    ],
  });

  定義({
    鍵: "登録解除", 札: "登録解除", 表: 在庫NO,
    要素: ["pelCfaDOxd0Ew4piP"], 自動処理: ["wflIutCfZcEGLROsd"],
    画面: ["在庫一覧 Read only"],
    関門: [F.在庫NO_関門解除],
    確認: { 題: "入庫登録解除", 本文: "入庫登録を解除しますか？\n仕入Noの中で、すでに在庫引当がされている在庫明細は、登録解除されません。", 進むボタン: "はい、続けます。" },
    確度: "確定",
    根拠: "確認ダイアログが『すでに在庫引当がされている在庫明細は、登録解除されません』と部分解除を明言している",
    走る: (e) => {
      const 手順 = [{ 種: "更新", 行: e.id, 値: { [F.在庫NO_登録]: false } }];
      for (const rid of 配下の入庫(e.id)) {
        /** **引当済み（出庫リンクあり）の明細は落とさない。** ダイアログの但し書きそのもの */
        if (先の行(rid, F.入庫_出庫リンク).length) continue;
        手順.push({ 種: "更新", 行: rid, 値: { [F.入庫_入庫登録]: false } });
      }
      return 手順;
    },
  });

  定義({
    鍵: "在庫登録", 札: "在庫登録", 表: 入庫,
    要素: ["pelemmo2sNX91SqpW"], 自動処理: ["wflQL277ocdxK4yZR"],
    画面: ["在庫登録時詳細"],
    関門: [], 確認: { 題: "在庫登録", 本文: "在庫登録しますか？", 進むボタン: "はい、続けます。" },
    確度: "確定",
    根拠: "断面差: 販売/入庫に102行が作られ、埋まっていた入力項目は11項目（仕入NO・商品コード・入庫日・倉庫・在庫(入庫)数・ロットNO・賞味期限・入数・単位・梱包単位・商品名）。登録はその明細1件ぶん",
    走る: (e) => {
      const 手順 = [{ 種: "更新", 行: e.id, 値: { [F.入庫_入庫登録]: true } }];
      /** 親の在庫NOも立てる（一括在庫登録の単票版） */
      for (const rid of 先の行(e.id, F.入庫_在庫NOリンク)) 手順.push({ 種: "更新", 行: rid, 値: { [F.在庫NO_登録]: true } });
      return 手順;
    },
  });

  定義({
    鍵: "行削除", 札: "削除", 表: null,
    要素: ["pelujFMKboMOgqQhY"], 自動処理: ["wflOhEfRZY4Wjwahy"],
    画面: ["Record Detail"],
    関門: [], 確認: { 題: "削除しますか？", 本文: "この操作は取り消せません。", 進むボタン: "はい、削除します。" },
    確度: "確定",
    根拠: "確認ダイアログが『この操作は取り消せません。』。対象は押した画面の行そのもの",
    走る: (e) => [{ 種: "消す", 行: e.id }],
  });

  定義({
    鍵: "当月売掛作成", 札: "当月売掛作成", 表: 売掛台帳,
    要素: [], 自動処理: [], 外部: "https://hook.eu1.make.com/xkg523xuxbc9i942d5ddw8sqjp86u16t",
    画面: ["請求締"],
    関門: [], 確認: { 題: "当月売掛作成", 本文: "対象月の売掛台帳を作成します。", 進むボタン: "はい、続けます。" },
    確度: "確定",
    根拠: "断面差: 売掛台帳に17行が作られ、**埋まっていた入力項目は『得意先』と『月』の2つだけ**。金額9項目はすべて rollup/式。現行の引き金は Make の webhook（`?date=` に対象日を渡す）",
    引数: ["年月"],
    走る: (e, { 年月 } = {}) => [{ 種: "売掛台帳を作る", 年月 }],
    注: "現行の webhook URL は**絶対に叩かない**。叩くと本番の締め処理が走る",
  });

  /**
   * ─── Make・miniExtensions・Fillout に出していた処理の置き換え ───
   *
   * ここから下は Airtable の自動処理ではなく、**外のサービスがやっていた処理**をローカルの動作にしたもの。
   * 現行の引き金（Make の webhook）は GET した瞬間に本番の処理が走るので、絶対に叩かない。
   * 中身は 4 つの独立な証拠（断面差・フォーム定義・式が見ている項目・画面の所属）で決め、確度を書き分ける。
   *
   * ■ 「締処理でロックする」とは何か
   *
   * 締処理の式はどれも **締処理表への関連を rollup で辿って締日を得る**（13 本の関連すべてに rollup/lookup が付く）。
   *   売上.締処理エラー(編集)S4/S6 → fldoNM2JEyTub6r0R = MAX(締処理.締日) via 売上→締処理 fldUTeIBsFlF30kHN
   *   入庫.入庫登録エラー          → fld9ae2e4SRBybnMb via 入庫→締処理 fld2RbqXL4SC4wfof
   *   製品生産・製造/入庫・出庫・仕掛入庫・仕掛出庫・移動伝票・仕掛移動伝票 の 登録エラー／締処理表示 も同じ形
   * つまり**式に出る項目＝関連項目が書き先**で、締処理の実体は「履歴に締日を足すこと」と「伝票を締処理表の 1 行に結ぶこと」の 2 つ。
   * 手元の DB ではこの関連が 13 本とも辺 0（どの画面にも列として出ないので要求 0）。締める はその月の伝票に関連を張り、解く は外す。
   * 過去分の穴埋めは別工程（データ）。
   */
  定義({
    鍵: "システム登録", 札: "システム登録（S4 海外品）", 表: 仕入明細,
    要素: ["pelSfadQNVc1K1Wcr", "pelaPMiWQ9yGfELnr"], 自動処理: [], 外部: MAKE.システム登録,
    画面: ["システム登録対象", "Untitled"],
    関門: [], 確認: { 題: "在庫登録", 本文: "TTCF販売に在庫登録されます。\nよろしいですか？", 進むボタン: "はい、続けます。" },
    確度: "確定",
    引数: ["仕入NO"],
    根拠: "断面差（2026-09-06→09-10）: 販売/入庫 102 行と 在庫登録/仕入明細 55 行の突き合わせで 38 組が明細行数＝入庫行数・数量合計一致。**CSV 1 明細＝1 ロット＝1 入庫。** 写し方は 仕入NO・商品コード・商品名 そのまま／ロットNO←賞味期限ロットNO(YYYYMMDD)／賞味期限←ロットNO(YYYY/MM/DD)／在庫(入庫)数←数量1／原価単価1←原価単価／単位 KGS・梱包単位 CASES（102/102）／入数は商品マスタ（20 が 97/102）／入庫日は押した日／倉庫は備考の地名（博多 46・東京 23・大阪 9・仙台 6）。在庫NO は 仕入NO と同名の 1 行（在庫NO 572 行は全部 S4-）。画面「システム登録対象」の固定絞り込みは 登録済=空 ∧ 商品DB あり ∧ 重複確認=OK なので、登録済 を立てて対象から外す。入庫登録 は立てない——それは次の 一括在庫登録 の仕事（新しい入庫 6 行は 入庫登録 空・在庫NO.登録 空で見つかった）",
    走る: (e, { 仕入NO } = {}) => [{ 種: "仕入明細を入庫に写す", 仕入NO: 仕入NO || e.cells?.[F.明細_仕入NO] || null }],
    注: "新しい入庫・在庫NO には 締処理表への関連も張る（在庫登録時詳細で読めた新規 6 行の 入庫登録エラー が締日を参照できていた＝作成時に結ばれている。ここだけ推定）。在庫明細ID（式 CREATED_TIME＋連番）は手元の計算器が作成時刻を持たないので、yymmdd-6桁連番 を値として入れる",
  });

  定義({
    鍵: "製品在庫登録", 札: "在庫登録（S6 自社製品 → 販売/入庫）", 表: 製品生産,
    要素: [], 自動処理: [], 外部: null,
    画面: ["在庫登録後", "Record Detail"],
    関門: [F.生産_登録エラー], 確認: { 題: "在庫登録", 本文: null, 進むボタン: "保存" },   // 現行に確認文は無い（📣登録 Form のボタン「保存」）。本文を作らない
    確度: "推定",
    根拠: "仕入NO が S6- の 販売/入庫 3,527 行のうち 2,434 行が 製造/製品生産 と「商品×賞味期限×数量」で対になった（spec/confirmed-0911 §9）。商品コード・商品名←製品／賞味期限←賞味期限／在庫(入庫)数←在庫計上数（ケース外端数登録なら kg の入力値）／ロットNO←`S6-YYYYMMDD-連番`／仕入NO←`S6-`＋連番 6 桁／入庫日←製造日／倉庫←003-九州支店／入数←製品生産.入数。**製造/製品生産 1 件＝1 入庫。** 引き金は 📣登録 Form（iaGv8B0X…）の compute 欄 fldLHlqJsIlV9lgS9（項目説明に「Makeで使うときは…」）で、登録済 2,192 行は全部 在庫登録確認=登録済",
    走る: (e) => [{ 種: "製品を入庫に写す", 行: e.id }],
    注: "確度を 推定 に下げた根拠（検証 2026-09-13）: S6 の入庫 3,527 行を 仕入NO で束ねると 2,193 件、うち 998 件は入庫が 2〜6 行（同じロットNO で入庫日違い）。入庫日=製造日 は 2,492/3,524（71%）。1 件＝1 入庫・入庫日＝製造日 は多数例で、分割登録の規則は未確定。Make のシナリオ本体（URL 無しの監視型）は読めない。変換規則は 2,434 対で確定、引き金の欄は Form 定義から。S6 の入庫には 在庫NO の親が無いので 入庫登録 を立てる（入庫登録 true 8,379／空 6 の空 6 は全部 S4 の新規）",
  });

  定義({
    鍵: "在庫選択", 札: "選択（在庫明細を出庫明細に引き当てる）", 表: 入庫,
    要素: [], 自動処理: [], 外部: MAKE.選択,
    画面: ["在庫選択時Veiw"],
    関門: [], 確認: null, 確度: "推定",
    引数: ["出庫行"], 行が要る: true,   // 引数があっても対象の行（在庫明細）は必須
    根拠: "ボタン項目 入庫.選択🔗 の宛先は Make（?record_id=在庫明細）。入庫.選択 checkbox は 362 行で要求され全部空＝押した瞬間だけ立つ一時欄。詳細画面「在庫選択時Veiw」（sidesheet）は 入庫 1 行の下に『出庫』の一覧（在庫反映フラグ=true ∧ 売上か振替あり）を置く構成で、在庫明細を選んで出庫明細に結ぶ画面と読める。出庫.在庫明細ID（fldow210kASYVp4qz → 入庫）が唯一の結び先。押した前後の断面が無いので推定",
    走る: (e, { 出庫行 } = {}) => [{ 種: "在庫を引き当てる", 入庫行: e.id, 出庫行: 出庫行 || null }],
    注: "現行は編集中の出庫明細（画面が選んでいる 1 行）に張る。ミミックでは 出庫行 を引数で受ける。入庫側の 出庫 関連（fld4sYaw5JSvlB971。論理在庫の rollup 4 本が辿る）にも同じ辺を書く——逆にしない関連なので片側だけでは在庫が動かない",
  });

  定義({
    鍵: "締処理", 札: "締処理（販売）", 表: 締処理販売,
    要素: [], 自動処理: [], 外部: null,
    画面: ["締処理"],
    関門: [], 確認: { 題: "締処理", 本文: null, 進むボタン: "締処理実行" },   // 現行の確認文は無い（miniExtensions のボタン文字だけ）。ミミックの補足は 注 に
    確度: "推定",
    引数: ["締日"],
    根拠: "ボタン項目 締処理URL → miniExtensions cgry8fKdLABlEd20gSsC（ボタン「締処理実行」・成功文「締処理が実行されました。」・prefill 締処理=1）。フォームが書くのは 締処理履歴.締日 1 項目と 締処理 への関連。締処理.締日 = MAX(履歴.締日 where 結果 in 締処理済/締処理中) で、売上・入庫・在庫NO・振替・売掛台帳 の式はこの表への関連を rollup で辿る（fldoNM2JEyTub6r0R・fld9ae2e4SRBybnMb・fld9rpM9YeAD4llkj・fld33dEFpF68YOloL・fldAdshwrdPLJk5eK）。結果を 締処理済 にするのが誰か（Make か人か）は読めない",
    走る: (e, { 締日 } = {}) => [{ 種: "締める", 側: "販売", 締日: 締日 || null }],
    注: "確認文は現行に無い（ボタン「締処理実行」だけ）。締日は Airtable 自身の値のまま（19 日なら 19 日。+1 しない）。ロック＝関連ではない（関連は作成時から全行にある）。既にある履歴の 締処理中 があれば断る（締処理URL の式が空になる条件）",
  });

  定義({
    鍵: "締処理製造", 札: "締処理（製造）", 表: 締処理製造,
    要素: [], 自動処理: [], 外部: null,
    画面: ["締処理"],
    関門: [], 確認: { 題: "締処理", 本文: null, 進むボタン: "締処理実行" },   // 同上
    確度: "推定",
    引数: ["締日"],
    根拠: "ボタン項目 締処理URL → miniExtensions c3jCwKkOVJq4alrq7wp7（同じ作り）。製造側 7 表の 登録エラー は `日付 <= 締日(rollup) AND IS_AFTER(CREATED_TIME, 締処理日時(rollup))` で、締日・締処理日時とも 締処理表への関連を辿る。締処理.締日 = MAX(履歴.締日 where 結果 in 締処理済/締処理中)",
    走る: (e, { 締日 } = {}) => [{ 種: "締める", 側: "製造", 締日: 締日 || null }],
    注: "販売と同じ。履歴の 締処理日時（CREATED_TIME の式）は手元の計算器が作成時刻を持たないので、値として入れる",
  });

  定義({
    鍵: "締処理解除", 札: "締処理解除（販売）", 表: 締処理履歴販売,
    要素: [], 自動処理: [], 外部: MAKE.締処理解除販売,
    画面: ["締処理履歴"],
    関門: [], 確認: { 題: "締処理解除", 本文: null, 進むボタン: "解除実行" },   // 現行の確認文は無い
    確度: "推定",
    根拠: "ボタン項目 締処理解除 → miniExtensions xpdxnhTPtTOUJrgr2TOe（ボタン「解除実行」・成功文「締処理が解除されました。」）。フォーム定義の webhook が『締処理結果 is 締処理解除 のとき Make 15clpq… を GET』なので、フォームが書くのは 締処理結果=締処理解除、続きを Make がやる。ボタンの式は `AND({New}, 締処理結果='締処理済')` で、New = 結果が済/中 ∧ 締日が締処理.締日と一致＝**最新の履歴だけ**解除できる",
    走る: (e) => [{ 種: "締めを解く", 側: "販売", 行: e.id }],
    注: "確認文は現行に無い（ボタン「解除実行」だけ）。Make が書くものは読めないが、履歴の 締処理結果 を 締処理解除 にすれば rollup の締日が前回に戻る。伝票側の関連は触らない",
  });

  定義({
    鍵: "締処理解除製造", 札: "締処理解除（製造）", 表: 締処理履歴製造,
    要素: [], 自動処理: [], 外部: MAKE.締処理解除製造,
    画面: ["締処理履歴"],
    関門: [], 確認: { 題: "締処理解除", 本文: null, 進むボタン: "解除実行" },   // 現行の確認文は無い
    確度: "推定",
    根拠: "ボタン項目 締処理解除 → miniExtensions BrvWHdInTQpE3AWLSBQe。webhook は『締処理結果 is 締処理解除 のとき Make 6wyq2e… を GET』。販売と同じ作り",
    走る: (e) => [{ 種: "締めを解く", 側: "製造", 行: e.id }],
  });

  定義({
    鍵: "売上締処理", 札: "売上締処理（請求締）", 表: 請求締,
    要素: [], 自動処理: [], 外部: MAKE.当月売掛作成,
    画面: ["請求締"],
    関門: [], 確認: { 題: "売上締処理", 本文: null, 進むボタン: "作成" },   // 現行の確認文は無い
    確度: "推定",
    根拠: "ボタン項目 売上締処理 → miniExtensions f7P2ORQVnPw6nTjnOUYL（置き場「当月売掛作成」・ボタン「作成」）。フォームが出す入力欄は 締処理操作 checkbox（fldSwqViSKjIbyNcC）だけで、ステータス = IF({締処理操作},'締処理済',…)。フォーム定義の webhook は 当月売掛作成 と同じ Make xkg523…（?date= 付き・締処理日時タイムスタンプが空のとき）。だから中身は『締処理操作を立てる』＋『当月売掛作成』",
    走る: (e) => [{ 種: "売上を締める", 行: e.id }],
    注: "ボタンの式 `IF({締解除可否判定}=1, URL, '')` の判定は 売掛台帳→請求締 の関連（手元は辺 0）を辿るので、ここでは 締処理操作 が既に立っていれば断るだけにする",
  });

  定義({
    鍵: "棚卸表作成", 札: "棚卸表作成（原料棚卸表）", 表: 分類,
    要素: [], 自動処理: [], 外部: MAKE.棚卸表作成,
    画面: ["分類"],
    関門: [], 確認: null, 確度: "推定",
    根拠: "ボタン項目 分類.棚卸表作成 → Make phpbzc…?record_id=&table_id=tblhGZ74i6sqZ79XM。行には 原料棚卸表（添付 PDF・9 行全部に『【本使用】TTCF原材料棚卸し.pdf』）と無名の checkbox fldlnRLNr5fK2zQRt・その LAST_MODIFIED_TIME（提供 CSV 棚卸表.csv の列名は「作成日時」）がある。Make は PDF を作って添付し、checkbox を触って作成日時を残すと読む",
    走る: (e) => [{ 種: "更新", 行: e.id, 値: { [F.分類_作成旗]: true } }, { 種: "知らせる", 文言: `帳票: /doc/原料棚卸表/${e.id}` }],
    注: "PDF の組みは帳票の工程（app/doc-*.mjs）。無ければ画面側が「未着手」と出す",
  });

  定義({
    鍵: "棚卸表作成仕掛", 札: "棚卸表作成（仕掛品棚卸表）", 表: 保管先,
    要素: [], 自動処理: [], 外部: MAKE.棚卸表作成,
    画面: ["保管先"],
    関門: [], 確認: null, 確度: "推定",
    根拠: "ボタン項目 保管先.棚卸表作成 → 同じ Make に table_id=tblwe3kswLJfA9SsG。行には 仕掛品棚卸表（添付 PDF『2026-08-31-TTCF棚卸表.pdf』）だけで、作成日時を残す欄は無い。書く項目が無いので帳票へのリンクを返すだけ",
    走る: (e) => [{ 種: "知らせる", 文言: `帳票: /doc/仕掛品棚卸表/${e.id}` }],
  });

  定義({
    鍵: "BOM引当", 札: "生産指示保存（使用原材料を引き当てる）", 表: 製品生産,
    要素: [], 自動処理: [], 外部: null,
    画面: ["Record Detail"],
    関門: [F.生産_登録エラー], 確認: null, 確度: "確定（原材料）／ロットは推定",
    根拠: "生産指示編集 Form（bi3ZpgT4GJaZPlNHYu27）を 40 件開いて 製造/出庫 412 行を控えた（crawl/24-bom.mjs → crawl/out/raw/bom）。**同じ製品の 2 件で原材料の集合は 10/10 同一**、ロットまで同一 3・原材料は同じでロットが違う 7。412 行のうち 364 行は出庫数量 0。製造/商品には原材料への関連が無く、レシピは直前の生産指示にしかない。→ 保存時に同じ製品の前回の使用原材料を写し、ロットは現在の原材料在庫（実在庫>0 の最新の 製造/入庫）に張り替え、数量は 0",
    走る: (e) => [{ 種: "使用原材料を写す", 行: e.id }],
    注: "誰が作るか（Make の監視型か）は読めないが、規則は 412 行で裏取り済み。出庫日は製造日（404/412 が製造日の 1 日前に見えるのは timeZone client の描き方）。前回の生産指示は手元の 製造/出庫 行 → 無ければ crawl/out/raw/bom の 412 行から引く",
  });

  定義({
    鍵: "CSV取込", 札: "①CSV登録（仕入明細の取り込み）", 表: 仕入明細,
    要素: ["pelE10A5x9myuNv3N"], 自動処理: [], 外部: null,
    画面: ["Untitled"],
    関門: [], 確認: null, 確度: "確定",
    引数: ["csv"],
    根拠: "ボタン ①CSV登録 は Airtable の CSV import block（viwTjNnDSv5p123Eb?blocks=bli2N9gyVRn1q6m2m）を開く。取り込む形は 提供 CSV『CSV アップロード.csv』の見出し 18 列（仕入ID・仕入NO・部門NO・計上日・インボイス日・備考・区分・商品コード・商品名・数量1・数量2・円貨金額・原価単価・原価合計・明細NO・明細連番・ロットNO・賞味期限ロットNO）。見出しは 在庫登録/仕入明細 の項目名と 18/18 一致。日付は `8/31/202600:00` の形で JST の深夜（実測 S4-003458-19: `8/31/2026`→`2026-08-30T15:00:00.000Z`）、金額は `¥1,306,334`・数量は `7,860`",
    走る: (e, { csv } = {}) => [{ 種: "CSVを取り込む", csv: csv ?? "" }],
    注: "式の列（仕入ID・賞味期限ロットNO）は読み飛ばす。重複は弾かない（Airtable の import も弾かず、重複確認 の lookup が後で拾う）",
  });

  /** ─── 補助 ─── */
  function 種類番号(e) {
    const v = e.cells[F.売上_種類番号] ?? e.calc[F.売上_種類番号];
    return Number(Array.isArray(v) ? v[0] : v) || null;
  }
  /** 振替伝票の明細（出庫）。振替伝票側の関連は辺0なので、出庫.振替伝票 から逆に辿る */
  function 振替の出庫(振替行) {
    return 逆に辿る.all(振替行, F.出庫_振替伝票リンク).map((r) => r.src_row);
  }
  function 配下の入庫(在庫NO行) {
    const a = 先の行(在庫NO行, F.在庫NO_入庫リンク);
    return a.length ? a : 逆に辿る.all(在庫NO行, F.入庫_在庫NOリンク).map((r) => r.src_row);
  }
  /** 日付から「2026年09月」を作る。**JSTで切る**（UTCで切ると月末が前月になる） */
  function 年月にする(v) {
    const s = Array.isArray(v) ? v[0] : v;
    if (!s) return null;
    const d = new Date(s);
    if (Number.isNaN(d.getTime())) return null;
    const p = new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Tokyo", year: "numeric", month: "2-digit" })
      .formatToParts(d).reduce((o, x) => (o[x.type] = x.value, o), {});
    return `${p.year}年${p.month}月`;
  }
  /**
   * 月表の日付を補う。
   * **既存34行すべてでこの日付が採取できていない**（どの画面にも出ていない）。
   * 空のままだと 月.YYYYMM = `DATETIME_FORMAT({日付},'YYYYMM')` が空になり、
   * 売掛台帳IDが `DO176-` のように尻切れになる。年月からその月の1日を入れる。
   * 推測ではなく、既存4,697行の売掛台帳IDがこの導出と完全一致することで裏が取れている。
   */
  function 月の日付を補う(月行) {
    const e = c.取る(月行);
    if (!e || e.cells[F.月_日付] != null) return false;
    const m = String(e.cells[F.月_年月] ?? "").match(/^(\d{4})年(\d{1,2})月$/);
    if (!m) return false;
    w.更新(月行, { [F.月_日付]: `${m[1]}-${String(m[2]).padStart(2, "0")}-01T00:00:00.000Z` },
      { 出どころ: "動作:月の日付を年月から補う" });
    return true;
  }

  function 月の行を探すか作る(年月) {
    const r = db.prepare(`SELECT id FROM row WHERE tbl=? AND json_extract(cells,'$.'||?)=?`).get(月表, F.月_年月, 年月);
    if (r) { 月の日付を補う(r.id); return r.id; }
    /**
     * **月表には日付項目もある**（fldcUM3tBObyt84jf）。
     * これを入れないと 月.YYYYMM = `DATETIME_FORMAT({日付},'YYYYMM')` が空になり、
     * 売掛台帳IDが `-` になる。既存34行ではこの日付が採取できていないので、
     * 年月から**その月の1日**を作って入れる。
     */
    const m = String(年月).match(/^(\d{4})年(\d{1,2})月$/);
    const 値 = { [F.月_年月]: 年月 };
    if (m) 値[F.月_日付] = `${m[1]}-${String(m[2]).padStart(2, "0")}-01T00:00:00.000Z`;
    const 出 = w.作る(月表, 値, { 出どころ: "動作:月マスタ自動作成" });
    return 出.行ID;
  }

  /** ─── 手順の実行 ─── */
  function 手順を走らせる(手順, 出どころ) {
    const 文言 = [], 作った = [], 消した = [], 変えた = [], 補足 = [];
    /** 複合の手順の返りを束ねる。文言があれば実行しなかった扱い、補足は情報 */
    const 束ねる = (出) => { 文言.push(...(出.文言 ?? [])); 作った.push(...(出.作った ?? [])); 変えた.push(...(出.変えた ?? [])); 補足.push(...(出.補足 ?? [])); };
    for (const s of 手順) {
      if (s.種 === "知らせる") { 補足.push(s.文言); continue; }
      if (s.種 === "断る") { 文言.push(s.文言); continue; }
      if (s.種 === "仕入明細を入庫に写す") { 束ねる(仕入明細を入庫に写す(s.仕入NO, 出どころ)); continue; }
      if (s.種 === "製品を入庫に写す") { 束ねる(製品を入庫に写す(s.行, 出どころ)); continue; }
      if (s.種 === "在庫を引き当てる") { 束ねる(在庫を引き当てる(s.入庫行, s.出庫行, 出どころ)); continue; }
      if (s.種 === "締める") { 束ねる(締める(s.側, s.締日, 出どころ)); continue; }
      if (s.種 === "締めを解く") { 束ねる(締めを解く(s.側, s.行, 出どころ)); continue; }
      if (s.種 === "売上を締める") { 束ねる(売上を締める(s.行, 出どころ)); continue; }
      if (s.種 === "使用原材料を写す") { 束ねる(使用原材料を写す(s.行, 出どころ)); continue; }
      if (s.種 === "CSVを取り込む") { 束ねる(CSVを取り込む(s.csv, 出どころ)); continue; }
      if (s.種 === "更新") {
        const r = w.更新(s.行, s.値, { 出どころ });
        if (r.文言?.length) 文言.push(...r.文言); else 変えた.push(s.行);
      } else if (s.種 === "消す") {
        const r = w.消す(s.行, { 出どころ });
        if (r.文言?.length) 文言.push(...r.文言); else 消した.push(s.行);
      } else if (s.種 === "関連を外す") {
        const r = w.更新(s.行, { [s.項目]: [] }, { 出どころ });
        if (r.文言?.length) 文言.push(...r.文言); else 変えた.push(s.行);
      } else if (s.種 === "月を張る") {
        const 月行 = 月の行を探すか作る(s.年月);
        const r = w.更新(s.行, { [F.売上_月3]: 関連の形([月行]) }, { 出どころ });
        if (r.文言?.length) 文言.push(...r.文言); else 変えた.push(s.行);
      } else if (s.種 === "単価を引く") {
        const 引いた = 単価を引く(s.行, s.得意先, 出どころ);
        if (引いた) 変えた.push(s.行); else 文言.push(`${s.行}: 単価マスタに該当がありません`);
      } else if (s.種 === "伝票を複製") {
        const 出 = 伝票を複製(s.行, s.返品, 出どころ);
        文言.push(...出.文言); 作った.push(...出.作った);
      } else if (s.種 === "売掛台帳を作る") {
        const 出 = 売掛台帳を作る(s.年月, 出どころ);
        文言.push(...出.文言); 作った.push(...出.作った);
      } else {
        文言.push(`未実装の手順: ${s.種}`);
      }
    }
    return { 文言, 作った, 消した, 変えた, 補足 };
  }

  /**
   * 単価マスタから引く。得意先×商品コードで1行を探し、出庫.単価リンクを張る。
   * 単価そのものは lookup（10c/s〜500c/s の5段階）なので**張るだけで値が出る**。
   */
  function 単価を引く(出庫行, 得意先行, 出どころ) {
    const e = c.取る(出庫行);
    if (!e) return false;
    const コード = e.cells[F.出庫_商品コード] ?? e.calc[F.出庫_商品コード];
    /** 関連項目なので `[{foreignRowId, foreignRowDisplayName}]`。表示名が製品ID（O0407003 など） */
    const 品行 = Array.isArray(コード) ? (コード[0]?.foreignRowId ?? null) : null;
    const コ = String(Array.isArray(コード) ? (コード[0]?.foreignRowDisplayName ?? "") : (コード ?? "")).trim();
    if (!品行 && !コ) return false;
    /**
     * **鍵は (取引先, 商品ID) の関連の対。** 単価表 427 行のうち 200 行はテキストの取引先コード・商品コードが空で、
     * 関連だけが入っている（2026-09-11 断面）。関連IDの対は 422/423 で一意（重複 1 対だけ）。
     * テキストのコードは関連が無い行（4 行）のための予備。
     */
    const 一致 = [];
    for (const r of db.prepare(`SELECT id,cells FROM row WHERE tbl=?`).all(単価マスタ)) {
      const c2 = JSON.parse(r.cells);
      const 先 = c2[F.単価_取引先]?.[0]?.foreignRowId ?? null, 品 = c2[F.単価_商品ID]?.[0]?.foreignRowId ?? null;
      const 品合 = 品行 && 品 ? 品 === 品行 : String(c2[F.単価_商品コード] ?? "").trim() === コ && !!コ;
      if (!品合) continue;
      if (得意先行) { if (先 ? 先 !== 得意先行 : !先の行(r.id, F.単価_取引先).includes(得意先行)) continue; }
      一致.push(r.id);
    }
    if (!一致.length) return false;
    const 出 = w.更新(出庫行, { [F.出庫_単価リンク]: 関連の形([一致[0]]) }, { 出どころ });
    return !出.文言?.length;
  }

  /**
   * 売上伝票を複製する。コピーと返品で**違うのは明細の作り方だけ**。
   *   コピー: 区分・単価をそのまま。在庫明細ID（引当）は張り直さない＝空のまま作り、
   *           引当は現在庫から改めて行う運用（ダイアログ本文どおり）
   *   返品  : 区分を K、販売単価をマイナスにする。区分Kは在庫を引当しない
   * 新しい伝票の売上登録・受注登録は立てない（押下後に売上入力画面で登録し直す）。
   */
  function 伝票を複製(売上行, 返品, 出どころ) {
    const e = c.取る(売上行);
    if (!e) return { 文言: ["その行はありません"], 作った: [] };
    const 写す = [F.売上_得意先, F.売上_伝票区分, F.売上_種類番号, F.売上_出荷日入力];
    const 値 = {};
    for (const fid of 写す) {
      const v = e.cells[fid];
      if (v !== undefined && v !== null && !(Array.isArray(v) && !v.length)) 値[fid] = v;
    }
    if (返品) 値[F.売上_返品旗] = true;
    const 親 = w.作る(売上, 値, { 出どころ });
    if (親.文言?.length) return { 文言: 親.文言, 作った: [] };
    const 作った = [親.行ID];
    for (const rid of 先の行(売上行, F.売上_出庫リンク)) {
      const m = c.取る(rid);
      if (!m) continue;
      const 明細 = {};
      for (const [fid, v] of Object.entries(m.cells)) {
        if (項目.get(fid)?.is_computed) continue;
        /** 引当は引き継がない。**元のロットを二重に引き当ててしまう** */
        if (fid === F.出庫_在庫明細ID) continue;
        if (fid === F.出庫_売上リンク) continue;
        明細[fid] = v;
      }
      明細[F.出庫_売上リンク] = 関連の形([親.行ID]);
      if (返品) {
        明細[F.出庫_区分] = 区分K;
        const 単価 = Number(明細[F.出庫_販売単価] ?? 0);
        if (Number.isFinite(単価) && 単価 > 0) 明細[F.出庫_販売単価] = -単価;
      }
      const 子 = w.作る(出庫, 明細, { 出どころ });
      if (子.文言?.length) return { 文言: 子.文言, 作った };
      作った.push(子.行ID);
    }
    return { 文言: [], 作った };
  }

  /**
   * 当月売掛作成。**書くのは『得意先』と『月』の2項目だけ**（断面差でそう出た）。
   * 対象の得意先は「その月に売上がある得意先」。既にある組み合わせは作らない。
   */
  function 売掛台帳を作る(年月, 出どころ) {
    if (!年月) return { 文言: ["年月を指定してください（例 2026年10月）"], 作った: [] };
    const 月行 = 月の行を探すか作る(年月);
    const ある = new Set();
    for (const r of db.prepare("SELECT id FROM row WHERE tbl=?").all(売掛台帳)) {
      const 月 = 先の行(r.id, F.売掛_月), 得 = 先の行(r.id, F.売掛_得意先);
      if (月.includes(月行) && 得.length) ある.add(得[0]);
    }
    /** その月に売上がある得意先を集める */
    const 対象 = new Set();
    for (const r of db.prepare("SELECT id FROM row WHERE tbl=?").all(売上)) {
      const s = c.取る(r.id);
      if (!s) continue;
      if (年月にする(s.cells[F.売上_出荷日入力] ?? s.calc[F.売上_出荷日入力]) !== 年月) continue;
      const 得 = 先の行(r.id, F.売上_得意先)[0];
      if (得 && !ある.has(得)) 対象.add(得);
    }
    const 作った = [], 文言 = [];
    for (const 得 of 対象) {
      const 値 = { [F.売掛_得意先]: 関連の形([得]), [F.売掛_月]: 関連の形([月行]) };
      /**
       * **売掛台帳の得意先コード（text）は一度も採取できていない**項目だが、空ではない。
       * 売掛台帳ID = `CONCATENATE({得意先コード},'-',{月のYYYYMM})` で、
       * 既存4,697行すべてが `得意先.取引先コード + '-' + 年月のYYYYMM` と一致した
       * （不一致0）。だから得意先の取引先コードを写す。
       */
      const コード = c.取る(得)?.cells[F.得意先_取引先コード];
      if (コード != null && コード !== "") 値[F.売掛_得意先コード] = コード;
      const 出 = w.作る(売掛台帳, 値, { 出どころ });
      if (出.文言?.length) 文言.push(...出.文言); else 作った.push(出.行ID);
    }
    if (!対象.size) 文言.push(`${年月} に売上のある得意先で、売掛台帳が未作成のものはありません`);
    return { 文言, 作った };
  }

  /** ═══ Make・miniExtensions の置き換え（中身） ═══ */

  /** 表の全行を読む（cells だけ）。走査は一度に済ませたいところで使う */
  const 表の行 = (表ID) => db.prepare("SELECT id,cells FROM row WHERE tbl=?").all(表ID).map((r) => ({ id: r.id, cells: JSON.parse(r.cells) }));
  const 関連の先ID = (v) => (Array.isArray(v) ? v[0]?.foreignRowId ?? null : null);
  const 関連の表示名 = (v) => (Array.isArray(v) ? String(v[0]?.foreignRowDisplayName ?? "") : "");
  /** lookup の {valuesByForeignRowId} や配列を先頭の値に平らにする */
  const 先頭 = (v) => (Array.isArray(v) ? v[0] ?? null : v);
  /** 計算器の 値（cells→calc→snap→implied、選択肢は名前、lookup は平ら）を先頭の 1 値で読む */
  const 値を読む = (e, fid) => 先頭(c.値(e, fid));

  /**
   * 倉庫の行を名前で探す。**倉庫表（tblsnSABsv8NniRCJ）は手元に行が無い**（どの画面にも一覧が無い）。
   * 入庫.倉庫 の関連が持つ表示名（16 倉庫・8,385 行）から 名前→行ID を起こす。空白の全角半角は無視する
   */
  let 倉庫の索引 = null;
  function 倉庫の行を探す(名) {
    if (!倉庫の索引) {
      倉庫の索引 = new Map();
      for (const r of db.prepare(`SELECT DISTINCT json_extract(cells,'$.'||?||'[0].foreignRowId') rid, json_extract(cells,'$.'||?||'[0].foreignRowDisplayName') nm FROM row WHERE tbl=? AND json_extract(cells,'$.'||?) IS NOT NULL`)
        .all(F.入庫_倉庫, F.入庫_倉庫, 入庫, F.入庫_倉庫)) if (r.rid && r.nm) 倉庫の索引.set(空白を除く(r.nm), r.rid);
    }
    return 倉庫の索引.get(空白を除く(名)) ?? null;
  }
  /** 倉庫の関連の形。表示名は現行のまま（索引から逆に引く） */
  function 倉庫の関連(名) {
    const rid = 倉庫の行を探す(名);
    if (!rid) return null;
    const nm = [...倉庫の索引.entries()].find(([, v]) => v === rid)?.[0] ?? 名;
    return [{ foreignRowId: rid, foreignRowDisplayName: nm }];
  }
  /** 販売/商品 を 製品ID（O0407003 など）で引く */
  function 商品の行(製品ID) {
    const k = String(製品ID ?? "").trim();
    if (!k) return null;
    return db.prepare(`SELECT id FROM row WHERE tbl=? AND json_extract(cells,'$.'||?)=?`).get(販売商品, F.商品_製品ID, k)?.id ?? null;
  }
  /** 締処理表の唯一の行（販売・製造それぞれ 1 行。表示名は "1"） */
  function 締処理の行(表ID) {
    return db.prepare("SELECT id FROM row WHERE tbl=? ORDER BY rowid LIMIT 1").get(表ID)?.id ?? null;
  }
  /**
   * 次に採られる autoNumber を覗く。**採らない**（作る が採る）。
   * 在庫明細ID = CONCATENATE(DATETIME_FORMAT(CREATED_TIME(),'YYMMDD'),'-',RIGHT('000000'&連番,6)) の式は
   * 手元の計算器に作成時刻が無く `-009108` の形になるので、正しい値を作って入れる（注に書いた）
   */
  const 次の連番 = (fid) => db.prepare("SELECT next FROM counter WHERE fld=?").get(fid)?.next ?? null;
  const 在庫明細IDを作る = (ymd) => { const n = 次の連番(F.入庫_連番); return n == null ? null : `${yymmdd(ymd)}-${String(n).padStart(6, "0")}`; };
  /** 締処理表への関連。新しい在庫行は作成時に結ばれている（在庫登録時詳細で読めた新規 6 行が締日を参照できた） */
  const 締処理の関連 = (表ID) => { const rid = 締処理の行(表ID); return rid ? [{ foreignRowId: rid, foreignRowDisplayName: "1" }] : null; };

  /**
   * ロットNO の文字（`2027/08/10`・`2027-8-1`）を賞味期限に読む。
   * 明細.賞味期限ロットNO の式 `DATETIME_FORMAT({ロットNO},'YYYYMMDD')` と同じ解釈。読めなければ null（式は 'ERROR'）
   */
  function ロットを日付に(s) {
    const m = String(s ?? "").trim().match(/^(\d{4})[\/\-.](\d{1,2})[\/\-.](\d{1,2})$/);
    if (!m) return null;
    return `${m[1]}-${m[2].padStart(2, "0")}-${m[3].padStart(2, "0")}`;
  }

  /**
   * S4（海外品）: 在庫登録/仕入明細 → 販売/在庫NO 1 行 + 販売/入庫 明細ごと 1 行。
   * 対象は「システム登録対象」画面の絞り込み（登録済=空）に合う、同じ仕入NO の明細。
   */
  function 仕入明細を入庫に写す(仕入NO, 出どころ) {
    const 出 = { 文言: [], 作った: [], 変えた: [], 補足: [] };
    if (!仕入NO) { 出.文言.push("仕入NO を指定してください（例 S4-003461）。対象の明細行を選んでも同じです"); return 出; }
    const 明細 = 表の行(仕入明細).filter((r) => String(r.cells[F.明細_仕入NO] ?? "").trim() === String(仕入NO).trim());
    if (!明細.length) { 出.文言.push(`仕入NO ${仕入NO} の明細がありません`); return 出; }
    const 対象 = 明細.filter((r) => !r.cells[F.明細_登録済] && String(r.cells[F.明細_商品コード] ?? "").trim());
    if (!対象.length) { 出.文言.push(`仕入NO ${仕入NO} の明細 ${明細.length} 行は全部 登録済 です（または商品コードが空）`); return 出; }
    const 日 = 今日();

    /** 倉庫は備考の地名。行ごとに見るが、仕入NO 単位で 1 倉庫なので先頭で決めて 在庫NO にも入れる */
    const 地名の倉庫 = (r) => {
      const 備考 = String(r.cells[F.明細_備考] ?? "");
      const 地 = Object.keys(備考の地名と倉庫).find((k) => 備考.includes(k));
      return 地 ? { 地, 倉庫名: 備考の地名と倉庫[地], 関連: 倉庫の関連(備考の地名と倉庫[地]) } : { 地: null, 倉庫名: null, 関連: null };
    };
    const 先頭の倉庫 = 地名の倉庫(対象[0]);
    if (!先頭の倉庫.関連) { 出.文言.push(`備考「${対象[0].cells[F.明細_備考] ?? ""}」から倉庫を決められません（地名 博多・東京・大阪・仙台 のどれでもない、または倉庫の行が手元に無い）`); return 出; }

    /** 在庫NO は 仕入NO と同名の 1 行。あれば使う（在庫NO 572 行の在庫NO は全部一意） */
    let 在庫NO行 = db.prepare(`SELECT id FROM row WHERE tbl=? AND json_extract(cells,'$.'||?)=?`).get(在庫NO, F.在庫NO_在庫NO, 仕入NO)?.id ?? null;
    if (!在庫NO行) {
      const 値 = { [F.在庫NO_在庫NO]: 仕入NO, [F.在庫NO_入庫日]: 日付だけ(日), [F.在庫NO_倉庫]: 先頭の倉庫.関連 };
      const 締 = 締処理の関連(締処理販売); if (締) 値[F.在庫NO_締処理リンク] = 締;
      const r = w.作る(在庫NO, 値, { 出どころ });
      if (r.文言?.length) { 出.文言.push(...r.文言); return 出; }
      在庫NO行 = r.行ID; 出.作った.push(r.行ID);
    }
    const 在庫NOの関連 = [{ foreignRowId: 在庫NO行, foreignRowDisplayName: 仕入NO }];

    for (const r of 対象) {
      const 倉 = 地名の倉庫(r);
      if (!倉.関連) { 出.文言.push(`${仕入NO}-${r.cells[F.明細_明細NO] ?? "?"}: 備考「${r.cells[F.明細_備考] ?? ""}」から倉庫を決められません`); continue; }
      const 商品 = 商品の行(r.cells[F.明細_商品コード]);
      if (!商品) { 出.文言.push(`${仕入NO}-${r.cells[F.明細_明細NO] ?? "?"}: 商品コード ${r.cells[F.明細_商品コード]} が 販売/商品 にありません`); continue; }
      const 賞味 = ロットを日付に(r.cells[F.明細_ロットNO]);
      if (!賞味) { 出.文言.push(`${仕入NO}-${r.cells[F.明細_明細NO] ?? "?"}: ロットNO「${r.cells[F.明細_ロットNO] ?? ""}」を日付として読めません（賞味期限ロットNO が ERROR になる行）`); continue; }
      const 商品行 = c.取る(商品);
      const 入数 = Number(商品行?.cells[F.商品_入数]);
      const 値 = {
        [F.入庫_仕入NO]: 仕入NO,
        [F.入庫_商品コード]: [{ foreignRowId: 商品, foreignRowDisplayName: String(r.cells[F.明細_商品コード]).trim() }],
        [F.入庫_商品名]: r.cells[F.明細_商品名] ?? "",
        [F.入庫_入庫日]: 日付だけ(日),
        [F.入庫_倉庫]: 倉.関連,
        [F.入庫_在庫数]: Number(r.cells[F.明細_数量1]) || 0,
        [F.入庫_単位]: 選択肢.単位_KGS, [F.入庫_梱包単位]: 選択肢.梱包_CASES,
        [F.入庫_ロットNO]: 賞味.replace(/-/g, ""),
        [F.入庫_賞味期限]: 日付だけ(賞味),
        [F.入庫_在庫NOリンク]: 在庫NOの関連,
      };
      if (Number.isFinite(入数) && 入数 > 0) 値[F.入庫_入数] = 入数;
      const 単価 = Number(r.cells[F.明細_原価単価]); if (Number.isFinite(単価) && 単価 !== 0) 値[F.入庫_原価単価入力] = 単価;
      const 締 = 締処理の関連(締処理販売); if (締) 値[F.入庫_締処理リンク] = 締;
      const id = 在庫明細IDを作る(日); if (id) 値[F.入庫_在庫明細ID] = id;
      const 作 = w.作る(入庫, 値, { 出どころ });
      if (作.文言?.length) { 出.文言.push(...作.文言); continue; }
      出.作った.push(作.行ID);
      const 更 = w.更新(r.id, { [F.明細_登録済]: true }, { 出どころ });
      if (更.文言?.length) 出.文言.push(...更.文言); else 出.変えた.push(r.id);
    }
    /** 在庫NO 側の関連（逆にしない）にも入庫を並べる。未登録明細数 count・入庫数量 rollup はこちら側を辿る */
    const 子 = 出.作った.filter((id) => c.取る(id)?.tbl === 入庫);
    if (子.length) {
      const 今 = c.値(c.取る(在庫NO行), F.在庫NO_入庫リンク, true);
      const 既存 = Array.isArray(今) ? 今.filter((x) => x?.foreignRowId) : [];
      const r2 = w.更新(在庫NO行, { [F.在庫NO_入庫リンク]: [...既存, ...関連の形(子)] }, { 出どころ });
      if (r2.文言?.length) 出.文言.push(...r2.文言);
    }
    出.補足.push(`仕入NO ${仕入NO}: 明細 ${対象.length} 行 → 入庫 ${子.length} 行（在庫NO ${在庫NO行}）。続きは 一括在庫登録（在庫NO の行で押す）`);
    return 出;
  }

  /** S6（田川工場の製品）: 製造/製品生産 1 件 → 販売/入庫 1 行 */
  function 製品を入庫に写す(生産行, 出どころ) {
    const 出 = { 文言: [], 作った: [], 変えた: [], 補足: [] };
    const e = c.取る(生産行);
    if (!e) { 出.文言.push("その行はありません"); return 出; }
    if (c.値(e, F.生産_在庫登録) === true || 値を読む(e, F.生産_在庫登録確認) === "登録済") { 出.文言.push("この生産指示は既に在庫登録済みです（在庫登録確認=登録済）"); return 出; }
    const 製品コード = 値を読む(e, F.生産_製品コード) || 関連の表示名(e.cells[F.生産_製品]);
    const 商品 = 商品の行(製品コード);
    if (!商品) { 出.文言.push(`製品 ${製品コード || "(空)"} が 販売/商品 にありません`); return 出; }
    const 製造日 = ymdに(c.値(e, F.生産_製造日, true));
    if (!製造日) { 出.文言.push("製造日が空です"); return 出; }
    /** 在庫(入庫)数 ← 在庫計上数（ケース×入数）。ケース外端数登録なら kg の入力値そのまま（端数込み） */
    const 端数込み = c.値(e, F.生産_ケース外端数登録) === true;
    const kg = Number(c.値(e, F.生産_在庫計上数kg)), 計上 = Number(c.値(e, F.生産_在庫計上数));
    let 数 = 端数込み ? kg : 計上;
    /**
     * 在庫計上数 = ケース×入数、ケース = FLOOR(kg/入数) は 製造/商品 の lookup を辿る。手元で作った生産指示では
     * その lookup（fldf7pPPDCWd0CbSJ）が計算できず 0 になることがある。そのときは kg の入力値で代える（端数込みと同じ形）
     */
    if (!(数 > 0) && kg > 0) { 数 = kg; 出.補足.push("在庫計上数の式が手元で 0 になるので 在庫計上数(kg) の入力値を使いました"); }
    if (!Number.isFinite(数) || 数 <= 0) { 出.文言.push("在庫計上数が 0 です（📣登録 で 出来高・在庫計上数(kg) を入れてから）"); return 出; }
    const 連番 = Number(c.値(e, F.生産_連番, true));
    if (!Number.isFinite(連番)) { 出.文言.push("生産指示の連番（autoNumber）が手元にありません"); return 出; }
    const 日 = 今日();
    const 入数 = Number(c.値(e, F.生産_入数)) || Number(c.取る(商品)?.cells[F.商品_入数]) || null;
    const 値 = {
      [F.入庫_仕入NO]: `S6-${String(連番).padStart(6, "0")}`,
      [F.入庫_商品コード]: [{ foreignRowId: 商品, foreignRowDisplayName: String(製品コード) }],
      [F.入庫_商品名]: 値を読む(e, F.生産_製品名) ?? "",
      [F.入庫_賞味期限]: c.値(e, F.生産_賞味期限, true) ?? null,
      [F.入庫_在庫数]: 数,
      /** ロットNO の式は `S6-YYYYMMDD(在庫登録 checkbox の最終更新)-連番`。押した日がその日 */
      [F.入庫_ロットNO]: `S6-${日.replace(/-/g, "")}-${連番}`,
      [F.入庫_入庫日]: 日付だけ(製造日),
      [F.入庫_倉庫]: 倉庫の関連(九州支店),
      [F.入庫_単位]: 選択肢.単位_KGS, [F.入庫_梱包単位]: 選択肢.梱包_CASES,
      [F.入庫_入庫登録]: true,
    };
    if (!値[F.入庫_倉庫]) { 出.文言.push(`倉庫 ${九州支店} の行が手元にありません`); return 出; }
    if (値[F.入庫_賞味期限] == null) delete 値[F.入庫_賞味期限];
    if (入数) 値[F.入庫_入数] = 入数;
    const 締 = 締処理の関連(締処理販売); if (締) 値[F.入庫_締処理リンク] = 締;
    const id = 在庫明細IDを作る(日); if (id) 値[F.入庫_在庫明細ID] = id;
    const 作 = w.作る(入庫, 値, { 出どころ });
    if (作.文言?.length) { 出.文言.push(...作.文言); return 出; }
    出.作った.push(作.行ID);
    const 更 = w.更新(生産行, { [F.生産_在庫登録]: true, [F.生産_在庫登録確認]: 選択肢.生産_登録済 }, { 出どころ });
    if (更.文言?.length) 出.文言.push(...更.文言); else 出.変えた.push(生産行);
    出.補足.push(`販売/入庫 ${値[F.入庫_在庫明細ID] ?? 作.行ID}（${値[F.入庫_仕入NO]}・${値[F.入庫_ロットNO]}・${数}）を作りました`);
    return 出;
  }

  /** 在庫明細（入庫）を出庫明細に引き当てる。両側の関連に書く（逆にしない関連） */
  function 在庫を引き当てる(入庫行, 出庫行, 出どころ) {
    const 出 = { 文言: [], 作った: [], 変えた: [], 補足: [] };
    if (!出庫行) { 出.文言.push("引き当てる出庫明細（出庫行）を指定してください"); return 出; }
    if (!入庫行) { 出.文言.push("引き当てる在庫明細（入庫行）を指定してください"); return 出; }   // 行なしで c.取る(undefined) が SQLite の bind で落ちた（検証 2026-09-13）
    const 明 = c.取る(出庫行), 在 = c.取る(入庫行);
    if (!明 || 明.tbl !== 出庫) { 出.文言.push(`${出庫行} は 販売/出庫 の行ではありません`); return 出; }
    if (!在 || 在.tbl !== 入庫) { 出.文言.push(`${入庫行} は 販売/入庫 の行ではありません`); return 出; }
    if (先の行(出庫行, F.出庫_在庫明細ID).length) { 出.文言.push("この出庫明細には既に在庫明細が引き当てられています"); return 出; }
    const r1 = w.更新(出庫行, { [F.出庫_在庫明細ID]: 関連の形([入庫行]) }, { 出どころ });
    if (r1.文言?.length) { 出.文言.push(...r1.文言); return 出; }
    出.変えた.push(出庫行);
    const 今 = c.値(在, F.入庫_出庫リンク, true);
    const 既存 = Array.isArray(今) ? 今.filter((x) => x?.foreignRowId && x.foreignRowId !== 出庫行) : [];
    const r2 = w.更新(入庫行, { [F.入庫_出庫リンク]: [...既存, ...関連の形([出庫行])] }, { 出どころ });
    if (r2.文言?.length) 出.文言.push(...r2.文言); else 出.変えた.push(入庫行);
    return 出;
  }

  /**
   * 締処理の側ごとの設定。**対象 は「式が締処理表への関連を辿っている表」だけ**（13 本すべてに rollup/lookup が付く）。
   * 日付項目は各表の 締処理対象／登録エラー の式が締日と比べている項目
   */
  const 締の設定 = {
    販売: {
      締処理表: 締処理販売, 履歴表: 締処理履歴販売, 履歴リンク: F.締販_履歴リンク, 締日: F.履販_締日, 結果: F.履販_結果, 締処理: F.履販_締処理, 日時: F.履販_日時,
      済: 選択肢.履販_済, 中: 選択肢.履販_中, 解除: 選択肢.履販_解除,
      対象: [
        { 表: 売上, 日付: F.売上_計上日, 関連: F.売上_締処理リンク },       // 締処理対象・締処理エラー(編集)S4/S6
        { 表: 入庫, 日付: F.入庫_入庫日, 関連: F.入庫_締処理リンク },       // 入庫登録エラー「入庫日は締日より後でなければなりません。」
        { 表: 在庫NO, 日付: F.在庫NO_入庫日, 関連: F.在庫NO_締処理リンク }, // 在庫登録エラー
        { 表: 振替伝票, 日付: F.振替_振替日, 関連: F.振替_締処理リンク },   // 振替編集エラー「締処理済みです。」
      ],
      月で対象: { 表: 売掛台帳, 月: F.売掛_月, 関連: F.売掛_締処理リンク },   // 請求締.締解除可否判定 が lookup で辿る
    },
    製造: {
      締処理表: 締処理製造, 履歴表: 締処理履歴製造, 履歴リンク: F.締製_履歴リンク, 締日: F.履製_締日, 結果: F.履製_結果, 締処理: F.履製_締処理, 日時: F.履製_日時,
      済: 選択肢.履製_済, 中: 選択肢.履製_中, 解除: 選択肢.履製_解除,
      対象: [
        { 表: 製品生産, 日付: F.生産_製造日, 関連: F.生産_締処理リンク },
        { 表: 製造入庫, 日付: F.製入_入庫日, 関連: F.製入_締処理リンク },
        { 表: 製造出庫, 日付: F.製出_出庫日, 関連: F.製出_締処理リンク },
        { 表: 仕掛入庫, 日付: F.仕掛入_日, 関連: F.仕掛入_締処理リンク },
        { 表: 仕掛出庫, 日付: F.仕掛出_日, 関連: F.仕掛出_締処理リンク },
        { 表: 移動伝票, 日付: F.移動_日, 関連: F.移動_締処理リンク },
        { 表: 仕掛移動伝票, 日付: F.仕掛移動_日, 関連: F.仕掛移動_締処理リンク },
      ],
      月で対象: null,
    },
  };
  /** 履歴のうち 締日 の rollup が数えるもの（結果 in 済/中）。除く で自分を外せる */
  function 締日の一覧(設定, 除く = null) {
    return 表の行(設定.履歴表)
      .filter((r) => r.id !== 除く && [設定.済, 設定.中].includes(r.cells[設定.結果]))
      .map((r) => ymdに(r.cells[設定.締日])).filter(Boolean).sort();
  }
  /** (前, 後] の日付の行に締処理表への関連を張る／外す。張るのは空の行だけ、外すのは締処理表を指す行だけ */
  function 関連を張り替える(設定, 締処理行, 前, 後, 張る, 出どころ) {
    const 変えた = [];
    for (const t of 設定.対象) {
      for (const r of 表の行(t.表)) {
        const d = ymdに(r.cells[t.日付]);
        if (!d || d <= (前 ?? "") || d > 後) continue;
        const 今 = 関連の先ID(r.cells[t.関連]);
        if (張る ? 今 : 今 !== 締処理行) continue;
        const x = w.更新(r.id, { [t.関連]: 張る ? [{ foreignRowId: 締処理行, foreignRowDisplayName: "1" }] : [] }, { 出どころ });
        if (!x.文言?.length) 変えた.push(r.id);
      }
    }
    if (設定.月で対象) {
      const 年月 = `${後.slice(0, 4)}年${後.slice(5, 7)}月`;
      for (const r of 表の行(設定.月で対象.表)) {
        if (関連の表示名(r.cells[設定.月で対象.月]) !== 年月) continue;
        const 今 = 関連の先ID(r.cells[設定.月で対象.関連]);
        if (張る ? 今 : 今 !== 締処理行) continue;
        const x = w.更新(r.id, { [設定.月で対象.関連]: 張る ? [{ foreignRowId: 締処理行, foreignRowDisplayName: "1" }] : [] }, { 出どころ });
        if (!x.文言?.length) 変えた.push(r.id);
      }
    }
    return 変えた;
  }
  /**
   * 締処理表の行に、それを指す履歴を全部並べる。
   * 締処理.締日 = MAX(履歴.締日 where 結果 in 済/中) は **締処理→履歴 の関連（逆にしない・辺 0）** を辿るので、
   * 履歴側だけ結んでも計算器（db/calc.mjs の 集める は前向きの辺しか見ない）は締日を出せない。
   * 揃えないと、締めた直後も 締処理表示／締処理エラー の式が古い締日（snap）のまま動く
   */
  function 履歴の関連を揃える(設定, 締処理行, 出どころ) {
    const 履歴 = 表の行(設定.履歴表).filter((r) => 関連の先ID(r.cells[設定.締処理]) === 締処理行).map((r) => r.id);
    const 今 = (c.値(c.取る(締処理行), 設定.履歴リンク, true) ?? []).map((x) => x?.foreignRowId).filter(Boolean);
    if (履歴.length === 今.length && 履歴.every((x) => 今.includes(x))) return false;
    const r = w.更新(締処理行, { [設定.履歴リンク]: 関連の形(履歴) }, { 出どころ });
    return !r.文言?.length;
  }
  /** 締める: 履歴に (締日, 締処理済, 締処理→1) を足し、その月の伝票を締処理表に結ぶ */
  function 締める(側, 締日, 出どころ) {
    const 出 = { 文言: [], 作った: [], 変えた: [], 補足: [] };
    const 設定 = 締の設定[側];
    const d = ymdに(締日);
    if (!d) { 出.文言.push("締日を YYYY-MM-DD で指定してください（Airtable の締日そのまま。+1 しない）"); return 出; }
    const 締処理行 = 締処理の行(設定.締処理表);
    if (!締処理行) { 出.文言.push(`締処理表 ${設定.締処理表} の行が手元にありません`); return 出; }
    if (表の行(設定.履歴表).some((r) => r.cells[設定.結果] === 設定.中)) { 出.文言.push("締処理中の履歴があります（現行でも 締処理URL の式が空になり押せません）"); return 出; }
    const 前回 = 締日の一覧(設定).at(-1) ?? null;
    if (前回 && d <= 前回) { 出.文言.push(`締日 ${d} は前回の締日 ${前回} より後でなければなりません`); return 出; }
    const 値 = { [設定.締日]: 日付だけ(d), [設定.結果]: 設定.済, [設定.締処理]: [{ foreignRowId: 締処理行, foreignRowDisplayName: "1" }], [設定.日時]: new Date().toISOString() };
    const r = w.作る(設定.履歴表, 値, { 出どころ });
    if (r.文言?.length) { 出.文言.push(...r.文言); return 出; }
    出.作った.push(r.行ID);
    履歴の関連を揃える(設定, 締処理行, 出どころ);
    /**
     * 伝票側の関連は張らない。**関連は締処理と無関係に作成時から全行にある**
     * （製造/入庫.在庫残高設定日＝締処理リンク経由の rollup が snap に 217 行、うち最新締日より後の入庫 75 行中 66 行、2020〜21 年の行にもある。検証 2026-09-13）。
     * 締め＝履歴が増えて 締日/締処理日時 の rollup（MAX）が動き、各表の 登録エラー の式が以後の編集を弾くこと。
     */
    出.補足.push(`${側}の締処理: 締日 ${d}（前回 ${前回 ?? "なし"}）。履歴を 1 行作成。伝票のロックは 登録エラー の式（締日・締処理日時の rollup）が担う`);
    return 出;
  }
  /** 解く: 最新の 締処理済 の履歴だけ。結果を 締処理解除 にし、その月の伝票から関連を外す */
  function 締めを解く(側, 履歴行, 出どころ) {
    const 出 = { 文言: [], 作った: [], 変えた: [], 補足: [] };
    const 設定 = 締の設定[側];
    const e = c.取る(履歴行);
    if (!e || e.tbl !== 設定.履歴表) { 出.文言.push("締処理履歴の行を指定してください"); return 出; }
    const d = ymdに(e.cells[設定.締日]);
    const 最新 = 締日の一覧(設定).at(-1) ?? null;
    if (e.cells[設定.結果] !== 設定.済 || !d || d !== 最新) { 出.文言.push("解除できるのは最新の締処理済みの履歴だけです（現行のボタンの式 `AND({New}, 締処理結果='締処理済')` と同じ）"); return 出; }
    const 締処理行 = 締処理の行(設定.締処理表);
    履歴の関連を揃える(設定, 締処理行, 出どころ);
    const r = w.更新(履歴行, { [設定.結果]: 設定.解除 }, { 出どころ });
    if (r.文言?.length) { 出.文言.push(...r.文言); return 出; }
    出.変えた.push(履歴行);
    const 前 = 締日の一覧(設定, 履歴行).at(-1) ?? null;
    /** 伝票側の関連は外さない（締める と同じ理由。外すとその行は以後どの締日も見られなくなる） */
    出.補足.push(`${側}の締処理解除: 締日 ${d} → 前回 ${前 ?? "なし"} に戻る（履歴の結果を 締処理解除 に。rollup の締日が前回に戻る）`);
    return 出;
  }
  /** 請求締の 売上締処理: 締処理操作 を立て、その月の 当月売掛作成 を走らせる */
  function 売上を締める(請求締行, 出どころ) {
    const 出 = { 文言: [], 作った: [], 変えた: [], 補足: [] };
    const e = c.取る(請求締行);
    if (!e || e.tbl !== 請求締) { 出.文言.push("請求締の行を指定してください"); return 出; }
    if (c.値(e, F.請求締_操作) === true) { 出.文言.push("締処理済みです（締処理操作が既に立っています）"); return 出; }
    const r = w.更新(請求締行, { [F.請求締_操作]: true }, { 出どころ });
    if (r.文言?.length) { 出.文言.push(...r.文言); return 出; }
    出.変えた.push(請求締行);
    const m = String(e.cells[F.請求締_ID] ?? "").match(/^(\d{4})年(\d{1,2})月/);
    if (!m) { 出.補足.push(`請求締ID「${e.cells[F.請求締_ID] ?? ""}」から年月が読めないので売掛台帳は作りません`); return 出; }
    const 年月 = `${m[1]}年${String(m[2]).padStart(2, "0")}月`;
    const 台 = 売掛台帳を作る(年月, 出どころ);
    出.作った.push(...台.作った);
    出.補足.push(...台.文言, `${年月} の売掛台帳 ${台.作った.length} 行を作りました`);
    return 出;
  }

  /**
   * BOM: 同じ製品の前回の生産指示の使用原材料を写す。
   * 前回は (1) 手元の 製造/出庫（ミミックが作った行）、(2) crawl/out/raw/bom の 412 行 の順に探す。
   * 手元の 製造/出庫 は 0 行なので当面は (2)。読むだけで、DB には写さない（データの工程の仕事）。
   */
  let BOMの控え = null;
  function BOMを読む() {
    if (BOMの控え) return BOMの控え;
    BOMの控え = [];
    let index = [];
    try { index = JSON.parse(bom本文(ROOT, "index.json") ?? ""); } catch { return BOMの控え; }
    for (const x of index) {
      const m = String(x.主 ?? "").match(/^(\d{8})-([^-]+)-(\d+)$/);
      if (!m) continue;
      const 子 = [];
      if (x.出庫行 > 0) {
        const 本文 = bom本文(ROOT, `${x.id}.jsonl`); if (本文 == null) continue;
        for (const 行 of 本文.split("\n")) {
          if (!行.includes("fetchInitialTableIdsToLinkedTableStates") || !行.includes(製造出庫)) continue;
          let o; try { o = JSON.parse(JSON.parse(行).body); } catch { continue; }
          const 掘る = (v) => {
            if (!v || typeof v !== "object") return;
            if (v[製造出庫]?.recordIdsToAirtableRecords) for (const r of Object.values(v[製造出庫].recordIdsToAirtableRecords)) 子.push({ id: r.id, 検索キー: r.fields?.[F.製出_検索キー] ?? "", 数量: r.fields?.[F.製出_数量] ?? 0 });
            for (const y of Object.values(v)) 掘る(y);
          };
          掘る(o);
        }
      }
      BOMの控え.push({ 生産行: x.id, 製造日: `${m[1].slice(0, 4)}-${m[1].slice(4, 6)}-${m[1].slice(6, 8)}`, 製品コード: m[2], 連番: Number(m[3]), 子 });
    }
    return BOMの控え;
  }
  /** 出庫検索キー = CONCATENATE({発注番号},'-',{原材料名})。発注番号は `260826-1674` の形か空 */
  const 検索キーの原材料名 = (s) => String(s ?? "").replace(/^(\d{6}-\d{4})?-/, "").trim();
  /** 原材料名で、実在庫 > 0 の最新の 製造/入庫（ロット）を探す。原材料の表示名は `0200207 GNグラニュー糖`（コード＋空白＋名） */
  function 最新のロット(原材料名) {
    let 良 = null;
    for (const r of 表の行(製造入庫)) {
      const 名 = 関連の表示名(r.cells[F.製入_原材料]).replace(/^\S+\s+/, "");
      if (名 !== 原材料名) continue;
      const e = c.取る(r.id);
      const 在庫 = Number(c.値(e, F.製入_実在庫));
      if (!(在庫 > 0)) continue;
      const d = ymdに(r.cells[F.製入_入庫日]) ?? "";
      if (!良 || d > 良.d) 良 = { id: r.id, d, 表示: 関連の表示名(r.cells[F.製入_原材料]) };
    }
    return 良;
  }
  function 使用原材料を写す(生産行, 出どころ) {
    const 出 = { 文言: [], 作った: [], 変えた: [], 補足: [] };
    const e = c.取る(生産行);
    if (!e) { 出.文言.push("その行はありません"); return 出; }
    if (先の行(生産行, F.生産_使用原材料).length || 逆に辿る.all(生産行, F.製出_製品生産).length) { 出.文言.push("この生産指示には既に使用原材料があります"); return 出; }
    let 製品 = 先の行(生産行, F.生産_製品)[0] ?? 関連の先ID(e.cells[F.生産_製品]);
    let 製品コード = 値を読む(e, F.生産_製品コード) || 関連の表示名(e.cells[F.生産_製品]);
    const 製造日 = ymdに(c.値(e, F.生産_製造日, true));
    /**
     * 新しい生産指示 34 行は手元に 製品 の関連が無い（どの一覧にも列として出ていない）。
     * 控えの 生産ID（`20260918-O0416031-2456`）の真ん中が製品コードなので、そこから 製造/商品 を引いて関連を補う
     */
    if (!製品) {
      const 控 = BOMを読む().find((x) => x.生産行 === 生産行);
      const 行 = 控 ? db.prepare(`SELECT id FROM row WHERE tbl=? AND json_extract(cells,'$.'||?)=?`).get(製造商品, F.製商品_製品ID, 控.製品コード)?.id : null;
      if (行) {
        const r = w.更新(生産行, { [F.生産_製品]: [{ foreignRowId: 行, foreignRowDisplayName: 控.製品コード }] }, { 出どころ });
        if (!r.文言?.length) { 製品 = 行; 製品コード = 控.製品コード; 出.変えた.push(生産行); 出.補足.push(`製品 ${控.製品コード} を控えの生産ID から補いました`); }
      }
    }
    if (!製品 || !製造日) { 出.文言.push("製品と製造日が要ります（生産指示編集 Form の必須 2 項目）"); return 出; }

    /** (1) 手元の 製造/出庫 を持つ同じ製品の生産指示（自分以外・製造日が新しい順） */
    let 元 = null;
    const 同じ製品 = 表の行(製品生産).filter((r) => r.id !== 生産行 && 関連の先ID(r.cells[F.生産_製品]) === 製品)
      .map((r) => ({ id: r.id, d: ymdに(r.cells[F.生産_製造日]) ?? "" })).sort((a, b) => (a.d < b.d ? 1 : -1));
    for (const r of 同じ製品) {
      const 子 = 逆に辿る.all(r.id, F.製出_製品生産).map((x) => c.取る(x.src_row)).filter(Boolean);
      if (子.length) { 元 = { 出どころ: `手元の生産指示 ${r.id}（${r.d}）`, 子: 子.map((x) => ({ 原材料名: 関連の表示名(x.cells[F.製出_引当]).replace(/^\S+\s+/, "") || 検索キーの原材料名(c.値(x, F.製出_検索キー)) })) }; break; }
    }
    /** (2) 控え。自分自身の実物があればそれが一番近い（Airtable には既に子がある行） */
    if (!元) {
      const 候補 = BOMを読む().filter((x) => x.子.length && (x.生産行 === 生産行 || x.製品コード === 製品コード))
        .sort((a, b) => (a.生産行 === 生産行 ? -1 : b.生産行 === 生産行 ? 1 : a.製造日 < b.製造日 ? 1 : -1));
      if (候補.length) 元 = { 出どころ: `控え ${候補[0].生産行}（${候補[0].製造日}・${候補[0].子.length} 行）`, 子: 候補[0].子.map((x) => ({ 原材料名: 検索キーの原材料名(x.検索キー) })) };
    }
    if (!元) { 出.文言.push(`製品 ${製品コード} の前回の生産指示に使用原材料が見つかりません（手元の 製造/出庫 と控え 412 行のどちらにも無い）`); return 出; }

    const 締 = 締処理の関連(締処理製造);
    const 作った = [], ロット無し = [];
    for (const 子 of 元.子) {
      if (!子.原材料名) continue;
      const ロット = 最新のロット(子.原材料名);
      const 値 = { [F.製出_出庫日]: 日付だけ(製造日), [F.製出_数量]: 0, [F.製出_製品生産]: 関連の形([生産行]) };
      if (ロット) 値[F.製出_引当] = [{ foreignRowId: ロット.id, foreignRowDisplayName: 関連の表示名(c.取る(ロット.id).cells[F.製入_原材料]) || ロット.表示 }];
      else ロット無し.push(子.原材料名);
      if (締) 値[F.製出_締処理リンク] = 締;
      const r = w.作る(製造出庫, 値, { 出どころ });
      if (r.文言?.length) { 出.文言.push(...r.文言); continue; }
      作った.push(r.行ID);
      /** 製造/入庫 側の 出庫 関連（逆にしない）。出庫数量(kg) の rollup はこちらを辿る */
      if (ロット) {
        const 在 = c.取る(ロット.id);
        const 今 = c.値(在, F.製入_出庫リンク, true);
        const 既存 = Array.isArray(今) ? 今.filter((x) => x?.foreignRowId) : [];
        w.更新(ロット.id, { [F.製入_出庫リンク]: [...既存, ...関連の形([r.行ID])] }, { 出どころ });
      }
    }
    出.作った.push(...作った);
    if (作った.length) {
      const r = w.更新(生産行, { [F.生産_使用原材料]: 関連の形(作った) }, { 出どころ });
      if (r.文言?.length) 出.文言.push(...r.文言); else 出.変えた.push(生産行);
    }
    出.補足.push(`使用原材料 ${作った.length} 行を ${元.出どころ} から写しました（数量 0・出庫日 ${製造日}）${ロット無し.length ? `。在庫のあるロットが無い原材料 ${ロット無し.length}: ${ロット無し.join("・")}` : ""}`);
    return 出;
  }

  /** ─── CSV ─── */
  /** RFC4180 風に読む。db/06-csv.mjs の 読む と同じ（そちらは script なので export していない） */
  function CSVを読む(text) {
    const 行 = [];
    let 場 = [], 語 = "", q = false, i = 0;
    const s = String(text ?? "").replace(/^﻿/, "");
    while (i < s.length) {
      const ch = s[i];
      if (q) { if (ch === '"') { if (s[i + 1] === '"') { 語 += '"'; i += 2; continue; } q = false; i++; continue; } 語 += ch; i++; continue; }
      if (ch === '"') { q = true; i++; continue; }
      if (ch === ",") { 場.push(語); 語 = ""; i++; continue; }
      if (ch === "\r") { i++; continue; }
      if (ch === "\n") { 場.push(語); 行.push(場); 場 = []; 語 = ""; i++; continue; }
      語 += ch; i++;
    }
    if (語 !== "" || 場.length) { 場.push(語); 行.push(場); }
    return 行;
  }
  /** 提供 CSV の癖: 日付 `8/31/202600:00`（M/D/YYYY に 00:00 が連結）→ JST の深夜。`2026-08-31` も受ける */
  function CSVの日付(s) {
    const t = String(s ?? "").trim();
    let m = t.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})/);
    if (m) return `${m[3]}-${m[1].padStart(2, "0")}-${m[2].padStart(2, "0")}`;
    m = t.match(/^(\d{4})[-\/](\d{1,2})[-\/](\d{1,2})/);
    if (m) return `${m[1]}-${m[2].padStart(2, "0")}-${m[3].padStart(2, "0")}`;
    return null;
  }
  const CSVの数 = (s) => { const n = Number(String(s ?? "").replace(/[¥,\s]/g, "")); return Number.isFinite(n) ? n : null; };
  function CSVを取り込む(csv, 出どころ) {
    const 出 = { 文言: [], 作った: [], 変えた: [], 補足: [] };
    const 行 = CSVを読む(csv);
    if (行.length < 2) { 出.文言.push("CSV の本文が空です（1 行目が見出し、2 行目から明細）"); return 出; }
    const 見出し = 行[0].map((x) => x.trim());
    const 名前で = new Map();
    for (const f of 項目.values()) if (f.tbl === 仕入明細 && f.name && !名前で.has(f.name)) 名前で.set(f.name, f);
    const 列 = 見出し.map((h) => 名前で.get(h) ?? null);
    const 読み飛ばし = 見出し.filter((h, i) => !列[i] || 列[i].is_computed);
    let 重複 = 0;
    const ある = new Set(表の行(仕入明細).map((r) => `${r.cells[F.明細_仕入NO] ?? ""}|${r.cells[F.明細_明細NO] ?? ""}`));
    for (const r of 行.slice(1)) {
      if (!r.some((x) => x.trim() !== "")) continue;
      const 値 = {};
      見出し.forEach((h, i) => {
        const f = 列[i]; const v = (r[i] ?? "").trim();
        if (!f || f.is_computed || v === "") return;
        if (f.type === "date") { const d = CSVの日付(v); if (d) 値[f.id] = f.opts?.時刻あり ? JSTの深夜(d) : 日付だけ(d); return; }
        if (f.type === "number") { const n = CSVの数(v); if (n != null) 値[f.id] = n; return; }
        if (f.type === "checkbox") { 値[f.id] = /^(1|true|checked|○)$/i.test(v); return; }
        値[f.id] = v;
      });
      if (!Object.keys(値).length) continue;
      const k = `${値[F.明細_仕入NO] ?? ""}|${値[F.明細_明細NO] ?? ""}`;
      if (ある.has(k)) 重複++;
      const x = w.作る(仕入明細, 値, { 出どころ });
      if (x.文言?.length) 出.文言.push(...x.文言); else 出.作った.push(x.行ID);
    }
    出.補足.push(`取り込み ${出.作った.length} 行${重複 ? `（既にある 仕入NO-明細NO と重なるもの ${重複}。重複確認 の lookup が拾う）` : ""}${読み飛ばし.length ? `。読み飛ばした列: ${読み飛ばし.join("・")}` : ""}`);
    return 出;
  }

  /** ─── 入口 ─── */
  function 一覧() {
    return [...台帳.values()].map((d) => ({
      鍵: d.鍵, 札: d.札, 表: d.表, 画面: d.画面, 確度: d.確度,
      要素: d.要素, 自動処理: d.自動処理, 確認: d.確認, 関門: d.関門, 根拠: d.根拠, 注: d.注 ?? null,
      外部: d.外部 ?? null, 引数: d.引数 ?? null,
    }));
  }

  /** 画面のボタン要素IDから動作を引く。**同じ要素IDが画面によって別処理**なので画面も見る */
  function 要素から(要素ID, 画面名 = null) {
    const 候補 = [...台帳.values()].filter((d) => d.要素.includes(要素ID));
    if (候補.length <= 1) return 候補[0] ?? null;
    return 候補.find((d) => 画面名 && d.画面?.some((n) => 画面名.includes(n))) ?? null;
  }

  /**
   * 押す。
   *   1. 対象の行を取る（無ければ断る）
   *   2. 関門を見る。文言が出たら**何も書かずに断る**
   *   3. 確認が要るのに未確認なら、確認文を返して止まる
   *   4. 手順を走らせる（write.mjs 経由なので write_log と再計算が付く）
   */
  function 押す(鍵, 行ID, { 確認済み = false, 出どころ = null, 引数 = {} } = {}) {
    const d = 台帳.get(鍵);
    if (!d) return { 可: false, 文言: [`知らない動作です: ${鍵}`] };
    if (d.確度 === "未確定") return { 可: false, 文言: [`${d.札}: 中身が確定していないので実行しません`] };

    let e = null;
    if (行ID) {
      e = c.取る(行ID);
      if (!e) return { 可: false, 文言: [`行がありません: ${行ID}`] };
      if (d.表 && e.tbl !== d.表) return { 可: false, 文言: [`${d.札} は ${d.表} の行にしか使えません`] };
    } else if (d.表 && (!d.引数 || d.行が要る)) {   // 引数つきでも 行が要る:true の動作は行が無ければ断る
      return { 可: false, 文言: [`${d.札}: 対象の行を指定してください`] };
    }

    const 関門たち = d.関門を選ぶ && e ? d.関門を選ぶ(e) : d.関門;
    const ひっかかり = e ? 関門を見る(e, 関門たち) : [];
    /**
     * **明細側の門。** 伝票の門（得意先・出荷日…）だけ見て明細の門（在庫が足りない・区分…）を
     * 落としていたため、在庫が足りなくても売上登録が通っていた（監査 2026-09-11）。
     * 現行の画面は 出庫.売上登録エラー を rollup で伝票側に集めて出す。ここでは子行ごとに評価して束ねる。
     */
    if (e && d.子の関門) for (const { 行, 関門 } of d.子の関門(e)) { const c2 = c.取る(行); if (c2) ひっかかり.push(...関門を見る(c2, 関門)); }
    if (ひっかかり.length) return { 可: false, 関門: ひっかかり, 文言: ひっかかり.map((x) => x.文言) };

    if (d.確認 && !確認済み) return { 可: false, 確認待ち: d.確認, 文言: [] };

    const 手順 = d.走る(e ?? {}, 引数);
    const 出 = 手順を走らせる(手順, 出どころ ?? `動作:${鍵}`);
    return { 可: !出.文言.length, 動作: d.鍵, 確度: d.確度, ...出 };
  }

  return { 一覧, 要素から, 押す, 関門を見る, 月の日付を補う, 台帳, 書き込み器: w, 計算器: c };
}
