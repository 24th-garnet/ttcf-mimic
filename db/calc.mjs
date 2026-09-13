/**
 * 計算項目を評価する。**照合（04-recalc）と書き込み（write）で同じコードを使う。**
 *
 *   import { 計算器を作る } from "./db/calc.mjs";
 *   const c = 計算器を作る(db);
 *   c.一行を計算(行);              その行の計算項目を全部求める
 *   c.再計算([行ID…]);             指定した行とその影響先を計算し直す
 *   c.影響する行(行ID);            その行を集めている行（rollup/lookup の親）
 *
 * ■ なぜ切り出すか
 *
 * 照合側と書き込み側で別に書くと、**必ずずれる。**
 * 照合で100%一致していても、書き込み後の値が違えば意味がない。
 * 検証済みの評価（30項目・274,971値で Airtable の計算値と一致）をそのまま使う。
 *
 * ■ 評価の要点（照合で確かめた規則）
 *
 *   入力値と計算結果を分ける        cells は入力、calc は計算結果
 *   選択項目は式の中では名前        セル値は選択肢ID。式は名前で比べる
 *   lookup は生の値をそのまま       名前に直すと外れる
 *   lookup の形                    {valuesByForeignRowId, foreignRowIdOrder}
 *   選択項目の lookup は配列で包む
 *   チェックボックスは未チェックが来ない → false として扱う
 *   暦の計算は UTC。時間帯は書式と YEAR/MONTH/DAY にだけ効く
 *   壊れた式（formulaError）は評価しない
 *
 * ■ 「未取得の項目を見た」を報告する
 *
 * 手元の行は「その列を要求した画面」からしか値を持たない。
 * 要求されていない列を参照した式の結果は、**信用できない。**
 * 照合では分母から外し、書き込みでは「この値は手元のデータでは決まらない」と分かるように、
 * `一つ計算` は第3引数に箱を渡すと `{未取得:true}` を立てる。
 */
import { parse, evaluate } from "./formula.mjs";

const 計算できない = new Set(["autoNumber", "createdTime", "button"]);

export function 計算器を作る(db, { tz = "UTC", clientTz = "Asia/Tokyo" } = {}) {
  /** ─── 定義 ─── */
  const 項目 = new Map();
  for (const f of db.prepare("SELECT id,tbl,name,type,formula,opts,is_computed FROM fld").all())
    項目.set(f.id, { ...f, opts: f.opts ? JSON.parse(f.opts) : {} });
  const 順序 = db.prepare("SELECT fld FROM calc_order ORDER BY seq").all().map((r) => r.fld);
  const 表の計算項目 = new Map();
  for (const fid of 順序) {
    const f = 項目.get(fid);
    if (!f || !f.is_computed || 計算できない.has(f.type) || f.opts?.式のエラー) continue;
    (表の計算項目.get(f.tbl) ?? 表の計算項目.set(f.tbl, []).get(f.tbl)).push(fid);
  }
  const 選択肢 = new Map();
  for (const f of 項目.values()) {
    let 表 = f.opts?.選択肢ID;
    if (!表 && f.opts?.その他?.choices) {
      const ch = f.opts.その他.choices;
      表 = Object.fromEntries((f.opts.その他.choiceOrder ?? Object.keys(ch)).map((id) => [id, ch[id]?.name]).filter(([, n]) => n != null));
    }
    if (表) 選択肢.set(f.id, 表);
  }
  const 木 = new Map();
  const 式の木 = (fid) => {
    if (!木.has(fid)) {
      const f = 項目.get(fid);
      try { 木.set(fid, f?.formula ? parse(f.formula) : null); }
      catch { 木.set(fid, null); }
    }
    return 木.get(fid);
  };
  const 時間帯 = (f) => { const z = f.opts?.時間帯; return !z ? tz : z === "client" ? clientTz : z; };
  const 名前に直す = (fid, v) => {
    const m = 選択肢.get(fid);
    if (!m || v == null) return v;
    return Array.isArray(v) ? v.map((x) => m[x] ?? x) : (m[v] ?? v);
  };
  /**
   * **式が lookup を参照したときは、値の並びを渡す。**
   * lookup の**持ち方**は `{valuesByForeignRowId, foreignRowIdOrder}`（Airtableと同じ形に
   * 揃えてある）だが、**式から見たときは値の配列**である。
   * 平らにしないと CONCATENATE がこの物をそのまま文字にしてしまい、
   * 売掛台帳IDが `DO176-{"valuesByForeignRowId":…}` になった。
   * 並びは `foreignRowIdOrder` に従う（Airtableの並び）。
   */
  const 式から見た形 = (v) => {
    if (v == null || typeof v !== "object") return v;
    if (Array.isArray(v)) return v.flatMap((x) => { const y = 式から見た形(x); return Array.isArray(y) ? y : [y]; });
    if (v.valuesByForeignRowId) {
      const 順 = v.foreignRowIdOrder ?? Object.keys(v.valuesByForeignRowId);
      return 順.flatMap((k) => { const y = 式から見た形(v.valuesByForeignRowId[k]); return Array.isArray(y) ? y : [y]; })
        .filter((x) => x != null);
    }
    /**
     * **式が関連項目を参照したときは、関連先の表示名になる。**
     * 持ち方は `{foreignRowId, foreignRowDisplayName}` だが、式から見えるのは表示名だけ。
     * 実例: 発注明細.発注検索キー は末尾に発注書の表示名（`240510-0231`）を出す。
     */
    if (v.foreignRowDisplayName !== undefined) return v.foreignRowDisplayName ?? "";
    return v;
  };

  /**
   * ─── どの行にどの列を要求したか ───
   * 「値が無い」と「要求していない」は別物。
   */
  const 全行要求 = new Set(), 一部要求 = new Map();
  for (const x of db.prepare(`
    SELECT q.fld, count(*) n, (SELECT count(*) FROM row WHERE tbl=f.tbl) 表の行数
    FROM requested q JOIN fld f ON f.id=q.fld GROUP BY q.fld`).all()) {
    if (x.n >= x.表の行数) 全行要求.add(x.fld); else 一部要求.set(x.fld, new Set());
  }
  if (一部要求.size) {
    const ph = [...一部要求.keys()].map(() => "?").join(",");
    for (const r of db.prepare(`SELECT fld,row FROM requested WHERE fld IN (${ph})`).all(...一部要求.keys()))
      一部要求.get(r.fld)?.add(r.row);
  }
  const 要求された = (fid, rid) => 全行要求.has(fid) || (一部要求.get(fid)?.has(rid) ?? false);

  /** ─── 行の読み書き ─── */
  const 読む = db.prepare("SELECT id,tbl,cells,calc,snap,implied,src,loaded FROM row WHERE id=?");
  const 書く = db.prepare("UPDATE row SET calc=? WHERE id=?");
  const 前向き = db.prepare("SELECT dst_row FROM link WHERE src_row=? AND fld=? ORDER BY ord");
  const 逆向き = db.prepare("SELECT src_row,fld FROM link WHERE dst_row=?");

  const 取る = (rid) => {
    const r = 読む.get(rid);
    if (!r) return null;
    /**
     * 作成時刻は**ミミックで作った行にだけ**持たせる（row.loaded が作成時刻）。
     * Airtable 由来の行の createdTime は偽値なので渡さない（メモ「行データの時刻には罠が3つ」）。
     * CREATED_TIME() を使う式 14 本（入庫.在庫明細ID・締処理履歴.締処理日時・登録エラー…）が新しい行で空にならないため。
     */
    const 作成時刻 = /^ミミックの入力/.test(r.src ?? "") && r.loaded ? r.loaded : null;
    return { id: r.id, tbl: r.tbl, cells: JSON.parse(r.cells), calc: JSON.parse(r.calc), snap: JSON.parse(r.snap ?? "{}"), implied: JSON.parse(r.implied ?? "{}"), ...(作成時刻 ? { 作成時刻 } : {}) };
  };

  /** いま評価している最中に未取得の項目を見たか */
  let 箱 = null;

  function 値(e, fid, 生 = false) {
    if (e.cells[fid] !== undefined) return 生 ? e.cells[fid] : 式から見た形(名前に直す(fid, e.cells[fid]));
    if (e.calc[fid] !== undefined) return 生 ? e.calc[fid] : 式から見た形(名前に直す(fid, e.calc[fid]));
    /** こちらで作れない項目（autoNumber など）は Airtable が返した値を使う */
    if (e.snap?.[fid] !== undefined) return 生 ? e.snap[fid] : 式から見た形(名前に直す(fid, e.snap[fid]));
    /**
     * **画面の所属から分かった値**（db/16-implied.mjs）。値は来ていないが真偽は決まっている。
     * 例: 売上登録 checkbox はどの一覧にも列として出ないが、「売上登録=true」で絞る画面に
     * 出ている 19,589 行は true と分かる。これを引かないと、締処理対象・登録ステータス・
     * 論理在庫（在庫反映フラグ=true で絞る rollup 4本）が全部空になる。
     */
    if (e.implied?.[fid] !== undefined) return 生 ? e.implied[fid] : 式から見た形(名前に直す(fid, e.implied[fid]));
    /** 手元に無い。要求されていなければ「未取得」＝この結果は信用できない */
    if (箱 && !要求された(fid, e.id) && !e.新しい行 && e.implied?.[fid] === undefined) 箱.未取得 = true;
    if (項目.get(fid)?.type === "checkbox") return false;
    return null;
  }

  /** 絞り込みを1行に当てる（rollup / lookup / count の filters） */
  function 通る(e, filters) {
    if (!filters?.filterSet?.length) return true;
    const 判定 = (f) => {
      if (f.filterSet) return 通る(e, f);
      const v = 値(e, f.columnId, true);
      const 空 = v == null || v === "" || v === false || (Array.isArray(v) && !v.length);
      const 候補 = (x) => {
        if (x == null) return [];
        if (Array.isArray(x)) return x.flatMap(候補);
        if (typeof x === "object") return [x.foreignRowId, x.foreignRowDisplayName].filter((y) => y != null).map(String);
        return [String(x)];
      };
      switch (f.operator) {
        case "isEmpty": return 空;
        case "isNotEmpty": return !空;
        case "=":
          if (f.value === null) return 空;
          if (f.value === true) return v === true || v === 1 || v === "1";
          if (f.value === false) return v === false || 空;
          return !空 && 候補(v).includes(String(f.value));
        case "!=": return !判定({ ...f, operator: "=" });
        case "isAnyOf": case "|":
          if (f.value == null || (Array.isArray(f.value) && !f.value.length)) return true;
          return !空 && 候補(v).some((x) => (Array.isArray(f.value) ? f.value : [f.value]).map(String).includes(x));
        case "isNoneOf": return !判定({ ...f, operator: "isAnyOf" });
        case ">": return !空 && Number(v) > Number(f.value);
        case ">=": return !空 && Number(v) >= Number(f.value);
        case "<": return !空 && Number(v) < Number(f.value);
        case "<=": return !空 && Number(v) <= Number(f.value);
        case "contains": return f.value == null ? true : !空 && 候補(v).some((x) => x.includes(String(f.value)));
        case "doesNotContain": return f.value == null ? true : 空 || !候補(v).some((x) => x.includes(String(f.value)));
        default: return true;
      }
    };
    const r = filters.filterSet.map(判定);
    return filters.conjunction === "or" ? r.some(Boolean) : r.every(Boolean);
  }

  /** 関連をたどって集める（rollup / count） */
  function 集める(e, 関連ID, 相手の項目, filters) {
    const out = [];
    if (箱 && 関連ID && !要求された(関連ID, e.id) && e.cells[関連ID] === undefined && !e.新しい行) 箱.未取得 = true;
    for (const { dst_row } of 前向き.all(e.id, 関連ID)) {
      const r = 取る(dst_row);
      if (!r || !通る(r, filters)) continue;
      if (相手の項目) {
        if (箱 && !要求された(相手の項目, dst_row) && r.cells[相手の項目] === undefined && r.calc[相手の項目] === undefined && r.snap?.[相手の項目] === undefined && r.implied?.[相手の項目] === undefined) 箱.未取得 = true;
        const v = 値(r, 相手の項目, true); if (Array.isArray(v)) out.push(...v); else if (v != null) out.push(v);
      }
      else out.push(dst_row);
    }
    return out;
  }

  /** 関連をたどって引く（lookup）。**Airtable の形に合わせる** */
  function 引く(e, 関連ID, 相手の項目, filters) {
    const o = {}, 並び = [];
    if (箱 && 関連ID && !要求された(関連ID, e.id) && e.cells[関連ID] === undefined && !e.新しい行) 箱.未取得 = true;
    for (const { dst_row } of 前向き.all(e.id, 関連ID)) {
      const r = 取る(dst_row);
      if (!r || !通る(r, filters)) continue;
      if (箱 && !要求された(相手の項目, dst_row) && r.cells[相手の項目] === undefined && r.calc[相手の項目] === undefined && r.snap?.[相手の項目] === undefined && r.implied?.[相手の項目] === undefined) 箱.未取得 = true;
      let v = 値(r, 相手の項目, true);
      if (v == null || v === "" || (Array.isArray(v) && !v.length)) continue;
      const t = 項目.get(相手の項目)?.type;
      if ((t === "select" || t === "multiSelect") && !Array.isArray(v)) v = [v];
      o[dst_row] = v; 並び.push(dst_row);
    }
    return 並び.length ? { valuesByForeignRowId: o, foreignRowIdOrder: 並び } : null;
  }

  /**
   * 1項目を1行について評価する。
   * @param 記録 渡すと `{未取得:true}` が立つ（未取得の項目を参照した）
   */
  function 一つ計算(e, fid, 記録 = null) {
    const f = 項目.get(fid);
    if (!f) return undefined;
    const 前の箱 = 箱; 箱 = 記録;
    try { return 一つ計算の中身(e, f, fid); } finally { 箱 = 前の箱; }
  }

  function 一つ計算の中身(e, f, fid) {
    const o = f.opts ?? {};
    try {
      if (f.type === "formula" || f.type === "computation") {
        const t = 式の木(fid);
        if (!t) return null;
        return evaluate(t, { 値: (x) => 値(e, x), 行ID: () => e.id, tz: 時間帯(f), 未対応: [], 作成時刻: e.作成時刻 ? () => e.作成時刻 : undefined });
      }
      if (f.type === "rollup") {
        const vals = 集める(e, o.たどる関連, o.集める項目, o.その他?.filters);
        const t = 式の木(fid);
        return t ? evaluate(t, { 名前で引く: (n) => (n === "values" ? vals : undefined), 値: (x) => 値(e, x), tz: 時間帯(f), 未対応: [] }) : vals;
      }
      if (f.type === "count") return 集める(e, o.たどる関連, null, o.その他?.filters).length;
      if (f.type === "lookup") return 引く(e, o.たどる関連, o.引く項目, o.その他?.filters);
    } catch { return null; }
    return undefined;
  }

  /** 1行の計算項目を順序どおりに全部求める */
  /**
   * 1行ぶんの計算項目を計算し直す。
   *
   * **参照先が取得できていない項目は、計算結果で上書きしない。**
   * 理由: 手元の行は「その列を要求した画面」からしか値を持たない。要求していない列を
   * 参照した式の結果は信用できない。それを calc に書くと
   *   ・Airtable が返した正解（snap）を自分の当て推量で潰す
   *   ・その項目を使った画面の絞り込みが狂う
   * 実測: 製造/入庫 の `IF(AND(関連1=BLANK(),関連2=BLANK(),関連3=BLANK()),"エラー")` が
   * 関連3本すべて未取得のため全行「エラー」になり、在庫残高一覧・原料棚卸表・
   * 日毎在庫残高の3画面が 0行になった（正解は217/214/186行）。
   * 未取得を見たときは snap の値を残す。snap にも無ければ計算値を入れる。
   */
  function 一行を計算(e) {
    const 元 = { ...e.calc };
    const 新 = {};
    for (const fid of 表の計算項目.get(e.tbl) ?? []) {
      const 記録 = {};
      const v = 一つ計算({ ...e, calc: { ...元, ...新 } }, fid, 記録);
      if (記録.未取得 && e.snap?.[fid] !== undefined) { 新[fid] = e.snap[fid]; continue; }
      if (v !== undefined) 新[fid] = v;
    }
    /** 計算できない型（autoNumber など）は元の値を残す */
    for (const [k, v] of Object.entries(元)) if (新[k] === undefined && 計算できない.has(項目.get(k)?.type)) 新[k] = v;
    return 新;
  }

  /** その行を集めている行（rollup / lookup / count の親）。関連の逆をたどる */
  function 影響する行(rid) {
    const out = new Set();
    for (const l of 逆向き.all(rid)) out.add(l.src_row);
    return [...out];
  }

  /**
   * 指定した行と、その影響先を計算し直して保存する。
   * 深さは既定2段（行 → 集めている行 → さらに集めている行）。
   * 無限に辿ると176,446行を巻き込むので段数で止める。
   */
  function 再計算(行ID, { 深さ = 2, 触った = null } = {}) {
    const 済 = new Set();
    let いま = Array.isArray(行ID) ? [...行ID] : [行ID];
    let n = 0;
    for (let d = 0; d <= 深さ; d++) {
      const 次 = new Set();
      for (const rid of いま) {
        if (済.has(rid)) continue;
        済.add(rid);
        const e = 取る(rid);
        if (!e) continue;
        書く.run(JSON.stringify(一行を計算(e)), rid);
        n++;
        if (触った) 触った.add(rid);   // 書いた後に断面を差し替える側（serve.mjs）が使う
        if (d < 深さ) for (const p of 影響する行(rid)) 次.add(p);
      }
      いま = [...次];
      if (!いま.length) break;
    }
    return n;
  }

  return { 項目, 選択肢, 値, 一つ計算, 一行を計算, 影響する行, 再計算, 取る, 通る, 集める, 引く, 表の計算項目 };
}
