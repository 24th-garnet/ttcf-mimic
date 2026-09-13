/**
 * Airtable の式を読んで評価する。
 *
 *   import { parse, evaluate, 使う関数 } from "./db/formula.mjs";
 *   const ast = parse("IF({column_value_fldA}, 'あり', 'なし')");
 *   evaluate(ast, ctx);
 *
 * ■ 実装する範囲は測って決めた
 *
 * 76表1,756項目の式・集め方を全走査して、出てくる関数を数えた。**34種しか無い。**
 *
 *   IF 244 / SUM 232 / MAX 59 / CONCATENATE 51 / AND 44 / DATEADD 35 /
 *   DATETIME_FORMAT 32 / BLANK 31 / NOT 25 / IS_BEFORE 23 / RIGHT 19 / ROUND 19 /
 *   CREATED_TIME 14 / OR 13 / ARRAYUNIQUE 12 / LAST_MODIFIED_TIME 10 /
 *   DATETIME_PARSE 10 / SWITCH 8 / IS_AFTER 7 / RECORD_ID 7 / YEAR 6 / MONTH 6 /
 *   ABS 6 / FLOOR 4 / TRUE 3 / ROUNDDOWN 3 / LEFT 2 / INT 2 / DAY 2 / ROUNDUP 2 /
 *   ENCODE_URL_COMPONENT 2 / ISERROR 2 / LEN 2 / ARRAYJOIN 1
 *
 * 演算子は ÷86 ×80 ＝66 比較50 ＋27 －11 ＆10 ≠2。
 *
 * ■ 項目参照は2種だけ
 *
 *   {column_value_fldXXX}          その項目の値（1,124箇所）
 *   {column_modified_time_fldXXX}  その項目が最後に変わった時刻（9箇所）
 *
 * 後者は LAST_MODIFIED_TIME({項目}) の実体。**作成後に一度も触られていなければ空**という
 * 性質があり、これで「旗がいつ立ったか」が読める（解析で決定的に効いた）。
 *
 * ■ 時間帯は既定でUTC。ここは決め事である
 *
 * Airtable の式は SET_TIMEZONE を書かない限りGMTで動く。現行の式に SET_TIMEZONE は無い。
 * 一方、画面に出ている日付はJSTに見える。**日付のみの項目なら差は出ないが、
 * 時刻を持つ項目を DATETIME_FORMAT で日付にすると9時間ぶんずれ得る。**
 * 既定は "UTC" にしておき、突き合わせで合わなければ ctx.tz を変える。
 * 合わせ込みが済むまでは、ここを疑うこと。
 *
 * ■ 空の扱い
 *
 * 空は null で表す。
 *   計算では 0 として扱う（Airtable と同じ）
 *   文字の連結では "" として扱う
 *   {x} = BLANK() は x が空なら真
 * ここは Airtable の挙動に合わせたが、**0 と空の区別が要る場面が残る**可能性がある。
 * 突き合わせで合わない項目が出たら、まずここを見る。
 */

/** ───────────────── 字句 ───────────────── */

const 記号 = ["<=", ">=", "!=", "<", ">", "=", "+", "-", "*", "/", "&", "(", ")", ",", "^"];

export function tokenize(src) {
  const out = [];
  let i = 0;
  const s = String(src);
  while (i < s.length) {
    const c = s[i];
    if (/\s/.test(c)) { i++; continue; }
    /** 項目参照 {…} */
    if (c === "{") {
      const j = s.indexOf("}", i);
      if (j < 0) throw new Error(`閉じていない { が ${i} にあります`);
      const 中 = s.slice(i + 1, j);
      let m;
      if ((m = 中.match(/^column_value_(fld[A-Za-z0-9]+)$/))) out.push({ t: "値", fld: m[1] });
      else if ((m = 中.match(/^column_modified_time_(fld[A-Za-z0-9]+)$/))) out.push({ t: "更新時刻", fld: m[1] });
      else if ((m = 中.match(/^(fld[A-Za-z0-9]+)$/))) out.push({ t: "値", fld: m[1] });
      else out.push({ t: "名前", name: 中 });   // 名前での参照。解けなければ評価時に報告する
      i = j + 1; continue;
    }
    /** 文字列。単引用と二重引用の両方が使われている */
    if (c === "'" || c === '"') {
      let j = i + 1, v = "";
      while (j < s.length) {
        if (s[j] === "\\") { v += s[j + 1] ?? ""; j += 2; continue; }
        if (s[j] === c) break;
        v += s[j]; j++;
      }
      if (j >= s.length) throw new Error(`閉じていない引用符が ${i} にあります`);
      out.push({ t: "文字", v }); i = j + 1; continue;
    }
    /** 数 */
    if (/[0-9]/.test(c) || (c === "." && /[0-9]/.test(s[i + 1] ?? ""))) {
      let j = i;
      while (j < s.length && /[0-9.]/.test(s[j])) j++;
      out.push({ t: "数", v: Number(s.slice(i, j)) }); i = j; continue;
    }
    /** 名前（関数名）。ただし… */
    if (/[A-Za-z_]/.test(c)) {
      let j = i;
      while (j < s.length && /[A-Za-z0-9_]/.test(s[j])) j++;
      const w = s.slice(i, j);
      /**
       * **波括弧の無い項目参照がある。**
       * Airtable の formulaTextParsed は autoNumber などを裸で書くことがある:
       *   RIGHT('00000'& column_value_fldqPFLwhrlIR4RKi ,6)
       *   CONCATENATE(DATETIME_FORMAT({column_value_fldX},'YYMMDD'),'-',RIGHT('000'& column_value_fldY ,4))
       * 関数名として扱うと「裸の語」として空になり、
       * 売上伝票ID・発注No などの採番系が全部外れる（実測 19,557件）。
       */
      let m;
      if ((m = w.match(/^column_value_(fld[A-Za-z0-9]+)$/))) { out.push({ t: "値", fld: m[1] }); i = j; continue; }
      if ((m = w.match(/^column_modified_time_(fld[A-Za-z0-9]+)$/))) { out.push({ t: "更新時刻", fld: m[1] }); i = j; continue; }
      out.push({ t: "語", v: w }); i = j; continue;
    }
    /** 記号 */
    const 見つけた = 記号.find((k) => s.startsWith(k, i));
    if (!見つけた) throw new Error(`読めない文字 ${JSON.stringify(c)} が ${i} にあります`);
    out.push({ t: "記号", v: 見つけた }); i += 見つけた.length;
  }
  return out;
}

/** ───────────────── 構文 ───────────────── */

/** 低いほど後で結合する。比較 < 連結 < 加減 < 乗除 */
const 優先 = { "=": 1, "!=": 1, "<": 1, "<=": 1, ">": 1, ">=": 1, "&": 2, "+": 3, "-": 3, "*": 4, "/": 4, "^": 5 };

export function parse(src) {
  const ts = tokenize(src);
  let p = 0;
  const 見る = () => ts[p];
  const 取る = () => ts[p++];
  const 記号か = (v) => 見る()?.t === "記号" && 見る().v === v;
  const 食べる = (v) => { if (!記号か(v)) throw new Error(`${v} を期待したが ${JSON.stringify(見る())} が来ました`); p++; };

  function 一次() {
    const tk = 取る();
    if (!tk) throw new Error("式が途中で終わっています");
    if (tk.t === "数") return { k: "数", v: tk.v };
    if (tk.t === "文字") return { k: "文字", v: tk.v };
    if (tk.t === "値") return { k: "値", fld: tk.fld };
    if (tk.t === "更新時刻") return { k: "更新時刻", fld: tk.fld };
    if (tk.t === "名前") return { k: "名前", name: tk.name };
    if (tk.t === "記号" && tk.v === "(") { const e = 式(0); 食べる(")"); return e; }
    if (tk.t === "記号" && tk.v === "-") return { k: "単項", op: "-", a: 一次() };
    if (tk.t === "記号" && tk.v === "+") return 一次();
    if (tk.t === "語") {
      const 名 = tk.v.toUpperCase();
      if (記号か("(")) {
        食べる("(");
        const 引数 = [];
        if (!記号か(")")) {
          for (;;) { 引数.push(式(0)); if (記号か(",")) { p++; continue; } break; }
        }
        食べる(")");
        return { k: "呼", 名, 引数 };
      }
      /** 括弧なしの語。TRUE / FALSE / BLANK を許す（現行に TRUE() の形で出るが保険） */
      if (名 === "TRUE") return { k: "真偽", v: true };
      if (名 === "FALSE") return { k: "真偽", v: false };
      return { k: "語", v: tk.v };
    }
    throw new Error(`予期しない字句 ${JSON.stringify(tk)}`);
  }

  function 式(最小) {
    let 左 = 一次();
    for (;;) {
      const tk = 見る();
      if (tk?.t !== "記号") break;
      const pr = 優先[tk.v];
      if (pr == null || pr < 最小) break;
      p++;
      const 右 = 式(pr + 1);
      左 = { k: "二項", op: tk.v, a: 左, b: 右 };
    }
    return 左;
  }

  const e = 式(0);
  if (p !== ts.length) throw new Error(`式を読み終えたのに字句が残っています（${p}/${ts.length}）`);
  return e;
}

/** ───────────────── 値の扱い ───────────────── */

export const 空 = null;
const 空か = (v) => v === null || v === undefined || v === "" ||
  (Array.isArray(v) && v.length === 0);

/** 数として見る。空は0。Airtable と同じ */
function 数に(v) {
  if (空か(v)) return 0;
  if (typeof v === "number") return v;
  if (typeof v === "boolean") return v ? 1 : 0;
  if (v instanceof Date) return v.getTime();
  if (Array.isArray(v)) return 数に(v[0]);
  const n = Number(String(v).replace(/,/g, ""));
  return Number.isFinite(n) ? n : 0;
}

/** 文字として見る。空は空文字 */
function 文字に(v) {
  if (空か(v)) return "";
  if (v instanceof Date) return v.toISOString();
  if (Array.isArray(v)) return v.map(文字に).join(", ");
  if (typeof v === "object") return v.foreignRowDisplayName ?? v.name ?? JSON.stringify(v);
  if (typeof v === "boolean") return v ? "1" : "";
  return String(v);
}

/** 真偽として見る。空・0・空文字は偽 */
function 真偽に(v) {
  if (空か(v)) return false;
  if (typeof v === "number") return v !== 0;
  if (typeof v === "boolean") return v;
  if (Array.isArray(v)) return v.length > 0;
  return true;
}

/**
 * 日時として見る。読めなければ null。
 *
 * **時間帯の付いていない文字列は UTC として読む。**
 * `new Date("2024/06")` は実行環境の地方時で読まれる（JSTなら2024-05-31T15:00Z）。
 * Airtable は 2024-06-01T00:00Z として扱うので、そのままだとずれる
 * （実測: 仕掛入庫.入庫月 が 07:00:00Z になり37件すべて外れた）。
 */
function 日時に(v) {
  if (空か(v)) return null;
  if (v instanceof Date) return Number.isNaN(v.getTime()) ? null : v;
  if (typeof v === "number") return new Date(v);
  const s = String(v).trim();
  /** 時間帯が書かれていない日付・日時。区切りは - と / の両方ある */
  let m = s.match(/^(\d{4})[-/](\d{1,2})(?:[-/](\d{1,2}))?(?:[T ](\d{1,2}):(\d{2})(?::(\d{2}))?)?$/);
  if (m) return new Date(Date.UTC(+m[1], +m[2] - 1, +(m[3] ?? 1), +(m[4] ?? 0), +(m[5] ?? 0), +(m[6] ?? 0)));
  const d = new Date(s);
  return Number.isNaN(d.getTime()) ? null : d;
}

/** 比較。日時どうしなら時刻で、数どうしなら数で、それ以外は文字で */
function 比べる(a, b) {
  const da = 日時に(a), dbb = 日時に(b);
  const 日付らしい = (x) => typeof x === "string" && /^\d{4}-\d{2}-\d{2}/.test(x);
  if (da && dbb && (日付らしい(a) || a instanceof Date) && (日付らしい(b) || b instanceof Date))
    return da.getTime() - dbb.getTime();
  const na = typeof a === "number" || (typeof a === "string" && a !== "" && Number.isFinite(Number(a)));
  const nb = typeof b === "number" || (typeof b === "string" && b !== "" && Number.isFinite(Number(b)));
  if (na && nb) return 数に(a) - 数に(b);
  return 文字に(a) < 文字に(b) ? -1 : 文字に(a) > 文字に(b) ? 1 : 0;
}

/** 等しいか。**空との比較は「両方空」で真**（BLANK() との比較がこれ） */
function 等しい(a, b) {
  if (空か(a) && 空か(b)) return true;
  if (空か(a) || 空か(b)) return false;
  return 比べる(a, b) === 0;
}

/** ───────────────── 日時の書式 ───────────────── */

/** 時間帯を当てた「見かけの」年月日時分秒を出す。tz は "UTC" か "Asia/Tokyo" など */
function 部品(d, tz) {
  if (tz === "UTC") {
    return { y: d.getUTCFullYear(), M: d.getUTCMonth() + 1, D: d.getUTCDate(),
      h: d.getUTCHours(), m: d.getUTCMinutes(), s: d.getUTCSeconds(), dow: d.getUTCDay() };
  }
  /** Intl で当てる。実装差を避けるため en-CA（YYYY-MM-DD）で取る */
  const f = new Intl.DateTimeFormat("en-CA", { timeZone: tz, year: "numeric", month: "2-digit",
    day: "2-digit", hour: "2-digit", minute: "2-digit", second: "2-digit", hour12: false, weekday: "short" });
  const o = {};
  for (const p of f.formatToParts(d)) o[p.type] = p.value;
  const 曜 = { Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 }[o.weekday] ?? 0;
  return { y: +o.year, M: +o.month, D: +o.day, h: +(o.hour === "24" ? "0" : o.hour), m: +o.minute, s: +o.second, dow: 曜 };
}

const 詰め = (n, w) => String(n).padStart(w, "0");

/** Airtable の書式指定子（現行で使われているものを実装） */
function 書式(d, fmt, tz) {
  if (!d) return "";
  const p = 部品(d, tz);
  return String(fmt).replace(/YYYY|YY|MMMM|MMM|MM|M|DDDD|DDD|DD|D|HH|H|mm|m|ss|s|ddd|dd/g, (t) => {
    switch (t) {
      case "YYYY": return String(p.y);
      case "YY": return 詰め(p.y % 100, 2);
      case "MM": return 詰め(p.M, 2);
      case "M": return String(p.M);
      case "DD": return 詰め(p.D, 2);
      case "D": return String(p.D);
      case "HH": return 詰め(p.h, 2);
      case "H": return String(p.h);
      case "mm": return 詰め(p.m, 2);
      case "m": return String(p.m);
      case "ss": return 詰め(p.s, 2);
      case "s": return String(p.s);
      default: return t;
    }
  });
}

/** ───────────────── 評価 ───────────────── */

/**
 * ctx が用意するもの
 *   値(fldId)        その行のその項目の値
 *   更新時刻(fldId)  その項目が最後に変わった時刻（無ければ null）
 *   作成時刻()       行の作成時刻
 *   行ID()           recXXXX
 *   いま()           現在時刻（試験では固定できるように差し替え可能）
 *   tz               時間帯。既定 "UTC"
 *   名前で引く(name) 名前での参照を解く（無ければ未対応として報告）
 */
export function evaluate(ast, ctx) {
  const tz = ctx.tz ?? "UTC";
  const 未対応 = ctx.未対応 ?? [];

  const ev = (n) => {
    switch (n.k) {
      case "数": return n.v;
      case "文字": return n.v;
      case "真偽": return n.v;
      case "値": return ctx.値 ? ctx.値(n.fld) : 空;
      case "更新時刻": return ctx.更新時刻 ? ctx.更新時刻(n.fld) : 空;
      case "名前": {
        if (ctx.名前で引く) { const v = ctx.名前で引く(n.name); if (v !== undefined) return v; }
        /** {values} の形も許す */
        未対応.push({ 種類: "名前での参照", 名: n.name });
        return 空;
      }
      case "語": {
        /**
         * 裸の語。rollup の集め方に出る **`values`** がこれ。
         *   例: SUM(values) / MAX(values) / ARRAYUNIQUE(values)
         * `values` は「関連をたどって集めた値の配列」。ctx が束縛する。
         */
        if (ctx.名前で引く) { const v = ctx.名前で引く(n.v); if (v !== undefined) return v; }
        未対応.push({ 種類: "裸の語", 名: n.v });
        return 空;
      }
      case "単項": return n.op === "-" ? -数に(ev(n.a)) : ev(n.a);
      case "二項": {
        const op = n.op;
        if (op === "&") return 文字に(ev(n.a)) + 文字に(ev(n.b));
        const a = ev(n.a), b = ev(n.b);
        switch (op) {
          case "+": return 数に(a) + 数に(b);
          case "-": return 数に(a) - 数に(b);
          case "*": return 数に(a) * 数に(b);
          case "/": { const d = 数に(b); return d === 0 ? { エラー: "ゼロ除算" } : 数に(a) / d; }
          case "^": return Math.pow(数に(a), 数に(b));
          case "=": return 等しい(a, b);
          case "!=": return !等しい(a, b);
          case "<": return !空か(a) && !空か(b) && 比べる(a, b) < 0;
          case "<=": return !空か(a) && !空か(b) && 比べる(a, b) <= 0;
          case ">": return !空か(a) && !空か(b) && 比べる(a, b) > 0;
          case ">=": return !空か(a) && !空か(b) && 比べる(a, b) >= 0;
          default: 未対応.push({ 種類: "演算子", 名: op }); return 空;
        }
      }
      case "呼": return 呼ぶ(n.名, n.引数);
      default: 未対応.push({ 種類: "節", 名: n.k }); return 空;
    }
  };

  /** 集める系。rollup の values を配列で受ける */
  const 並べる = (引数) => {
    const out = [];
    for (const a of 引数) {
      const v = ev(a);
      if (Array.isArray(v)) out.push(...v); else out.push(v);
    }
    return out;
  };

  function 呼ぶ(名, 引数) {
    const A = (i) => (引数[i] === undefined ? 空 : ev(引数[i]));
    switch (名) {
      /** 論理 */
      case "IF": return 真偽に(A(0)) ? A(1) : (引数.length > 2 ? A(2) : 空);
      case "AND": return 引数.every((a) => 真偽に(ev(a)));
      case "OR": return 引数.some((a) => 真偽に(ev(a)));
      case "NOT": return !真偽に(A(0));
      case "XOR": return 引数.filter((a) => 真偽に(ev(a))).length % 2 === 1;
      case "TRUE": return true;
      case "FALSE": return false;
      case "BLANK": return 空;
      case "SWITCH": {
        const 元 = A(0);
        for (let i = 1; i + 1 < 引数.length; i += 2) if (等しい(元, ev(引数[i]))) return ev(引数[i + 1]);
        /** 引数の数が偶数なら最後が既定値 */
        return 引数.length % 2 === 0 ? ev(引数[引数.length - 1]) : 空;
      }
      case "ISERROR": { const v = A(0); return !!(v && typeof v === "object" && v.エラー); }
      case "IS_ERROR": { const v = A(0); return !!(v && typeof v === "object" && v.エラー); }

      /** 集める（rollup の集め方に出る） */
      case "SUM": return 並べる(引数).reduce((s, x) => s + 数に(x), 0);
      case "MAX": { const a = 並べる(引数).filter((x) => !空か(x)); if (!a.length) return 空;
        return a.reduce((b, x) => (比べる(x, b) > 0 ? x : b)); }
      case "MIN": { const a = 並べる(引数).filter((x) => !空か(x)); if (!a.length) return 空;
        return a.reduce((b, x) => (比べる(x, b) < 0 ? x : b)); }
      case "AVERAGE": { const a = 並べる(引数).filter((x) => !空か(x)); return a.length ? a.reduce((s, x) => s + 数に(x), 0) / a.length : 空; }
      case "COUNT": return 並べる(引数).filter((x) => !空か(x) && Number.isFinite(Number(x))).length;
      case "COUNTA": return 並べる(引数).filter((x) => !空か(x)).length;
      case "COUNTALL": return 並べる(引数).length;
      case "ARRAYUNIQUE": { const seen = new Set(), out = [];
        for (const x of 並べる(引数)) { const k = 文字に(x); if (空か(x) || seen.has(k)) continue; seen.add(k); out.push(x); } return out; }
      case "ARRAYJOIN": { const a = 並べる([引数[0]]); const 区切り = 引数.length > 1 ? 文字に(ev(引数[1])) : ", ";
        return a.filter((x) => !空か(x)).map(文字に).join(区切り); }
      case "ARRAYCOMPACT": return 並べる(引数).filter((x) => !空か(x));
      case "ARRAYFLATTEN": return 並べる(引数);

      /** 文字 */
      case "CONCATENATE": return 引数.map((a) => 文字に(ev(a))).join("");
      case "LEFT": return 文字に(A(0)).slice(0, Math.max(0, 数に(A(1))));
      case "RIGHT": { const s = 文字に(A(0)); const n = Math.max(0, 数に(A(1))); return n >= s.length ? s : s.slice(s.length - n); }
      case "MID": return 文字に(A(0)).slice(Math.max(0, 数に(A(1)) - 1), Math.max(0, 数に(A(1)) - 1) + Math.max(0, 数に(A(2))));
      case "LEN": return 文字に(A(0)).length;
      case "TRIM": return 文字に(A(0)).trim();
      case "UPPER": return 文字に(A(0)).toUpperCase();
      case "LOWER": return 文字に(A(0)).toLowerCase();
      case "SUBSTITUTE": { const s = 文字に(A(0)), 旧 = 文字に(A(1)), 新 = 文字に(A(2));
        return 引数.length > 3 ? s.split(旧).map((x, i, arr) => x).join(新) : s.split(旧).join(新); }
      case "FIND": { const i = 文字に(A(1)).indexOf(文字に(A(0)), Math.max(0, 数に(A(2)) - 1 || 0)); return i < 0 ? 0 : i + 1; }
      case "ENCODE_URL_COMPONENT": return encodeURIComponent(文字に(A(0)));
      case "T": { const v = A(0); return typeof v === "string" ? v : ""; }
      case "VALUE": { const n = Number(文字に(A(0)).replace(/[^0-9.\-]/g, "")); return Number.isFinite(n) ? n : 空; }

      /** 数 */
      case "ROUND": { const d = 数に(A(1)); const f = Math.pow(10, d); return Math.round(数に(A(0)) * f) / f; }
      case "ROUNDUP": { const d = 数に(A(1)); const f = Math.pow(10, d); const v = 数に(A(0));
        return (v < 0 ? -Math.ceil(-v * f) : Math.ceil(v * f)) / f; }
      case "ROUNDDOWN": { const d = 数に(A(1)); const f = Math.pow(10, d); const v = 数に(A(0));
        return (v < 0 ? -Math.floor(-v * f) : Math.floor(v * f)) / f; }
      case "FLOOR": { const 単位 = 引数.length > 1 ? 数に(A(1)) : 1; return Math.floor(数に(A(0)) / 単位) * 単位; }
      case "CEILING": { const 単位 = 引数.length > 1 ? 数に(A(1)) : 1; return Math.ceil(数に(A(0)) / 単位) * 単位; }
      case "INT": return Math.floor(数に(A(0)));
      case "ABS": return Math.abs(数に(A(0)));
      case "MOD": { const d = 数に(A(1)); return d === 0 ? { エラー: "ゼロ除算" } : 数に(A(0)) % d; }
      case "POWER": return Math.pow(数に(A(0)), 数に(A(1)));
      case "SQRT": return Math.sqrt(数に(A(0)));

      /** 日時 */
      case "TODAY": { const d = ctx.いま ? ctx.いま() : new Date(); const p = 部品(d, tz);
        return `${p.y}-${詰め(p.M, 2)}-${詰め(p.D, 2)}`; }
      case "NOW": return (ctx.いま ? ctx.いま() : new Date()).toISOString();
      case "CREATED_TIME": return ctx.作成時刻 ? ctx.作成時刻() : 空;
      case "LAST_MODIFIED_TIME": {
        /**
         * 引数に項目を指定した形は、字句の段階で {column_modified_time_fldXXX} に
         * なっている。ここに来るのは引数なしの形（行全体の最終更新）。
         */
        if (引数.length === 0) return ctx.最終更新 ? ctx.最終更新() : 空;
        return A(0);
      }
      case "DATETIME_FORMAT": return 書式(日時に(A(0)), 文字に(A(1)), tz);
      case "DATETIME_PARSE": {
        const s = 文字に(A(0)); if (!s) return 空;
        const fmt = 引数.length > 1 ? 文字に(A(1)) : null;
        const d = 解く(s, fmt);
        /**
         * **読めなければエラーを返す。空ではない。**
         * IF(ISERROR(DATETIME_PARSE(x)),'ERROR',…) という使い方があり、
         * 空を返すと ISERROR が偽になって 'ERROR' が出ない
         * （実測: 賞味期限ロットNO が50件外れた）。
         */
        return d == null ? { エラー: "日時として読めません" } : d;
      }
      case "DATEADD": {
        const d = 日時に(A(0)); if (!d) return 空;
        return 足す(d, 数に(A(1)), 文字に(A(2)) || "days", tz);
      }
      case "DATETIME_DIFF": {
        const a = 日時に(A(0)), b = 日時に(A(1)); if (!a || !b) return 空;
        return 差(a, b, 文字に(A(2)) || "days");
      }
      case "IS_BEFORE": { const a = 日時に(A(0)), b = 日時に(A(1)); return !!(a && b) && a.getTime() < b.getTime(); }
      case "IS_AFTER": { const a = 日時に(A(0)), b = 日時に(A(1)); return !!(a && b) && a.getTime() > b.getTime(); }
      case "IS_SAME": { const a = 日時に(A(0)), b = 日時に(A(1)); if (!a || !b) return false;
        const 単位 = 引数.length > 2 ? 文字に(A(2)) : "ms";
        return 単位 === "ms" ? a.getTime() === b.getTime() : 書式(a, 単位の書式(単位), tz) === 書式(b, 単位の書式(単位), tz); }
      case "YEAR": { const d = 日時に(A(0)); return d ? 部品(d, tz).y : 空; }
      case "MONTH": { const d = 日時に(A(0)); return d ? 部品(d, tz).M : 空; }
      case "DAY": { const d = 日時に(A(0)); return d ? 部品(d, tz).D : 空; }
      case "HOUR": { const d = 日時に(A(0)); return d ? 部品(d, tz).h : 空; }
      case "MINUTE": { const d = 日時に(A(0)); return d ? 部品(d, tz).m : 空; }
      case "SECOND": { const d = 日時に(A(0)); return d ? 部品(d, tz).s : 空; }
      case "WEEKDAY": { const d = 日時に(A(0)); return d ? 部品(d, tz).dow : 空; }
      case "SET_TIMEZONE": return A(0);   // 現行の式に出てこない。素通し
      case "SET_LOCALE": return A(0);

      /** その行のこと */
      case "RECORD_ID": return ctx.行ID ? ctx.行ID() : 空;

      default:
        未対応.push({ 種類: "関数", 名 });
        return 空;
    }
  }

  const 単位の書式 = (u) => ({ year: "YYYY", month: "YYYY-MM", day: "YYYY-MM-DD",
    hour: "YYYY-MM-DD HH", minute: "YYYY-MM-DD HH:mm", second: "YYYY-MM-DD HH:mm:ss" }[u] ?? "YYYY-MM-DD");

  return ev(ast);
}

/**
 * DATEADD。月・年は暦のうえで足す（日数ではない）。
 *
 * ■ **暦の計算は UTC で行う。表示の時間帯は使わない**
 *
 * 部品を表示の時間帯で取り出して Date.UTC で組み立てると枠が混ざる。
 * 実測でそれをやったら 製造/仕掛入庫.入庫月 が9時間ずれた:
 *   式 DATEADD(DATEADD(DATETIME_FORMAT({入庫日},'YYYY/MM'),1,'month'),-1,'days')
 *   Asia/Tokyo で部品を取ると 2024-06-30T09:00Z、正解は 2024-06-30T00:00Z
 *
 * Airtable もここは UTC で計算している（37件すべて UTC 計算と一致）。
 * 項目ごとの timeZone 設定は **書式・YEAR/MONTH/DAY の取り出しにだけ**効く。
 */
function 足す(d, n, 単位, _tz) {
  const u = String(単位).toLowerCase().replace(/s$/, "");
  const ms = { millisecond: 1, second: 1000, minute: 60000, hour: 3600000, day: 86400000, week: 604800000 }[u];
  if (ms) return new Date(d.getTime() + n * ms);
  if (u === "month" || u === "quarter" || u === "year") {
    const 足す月 = u === "month" ? n : u === "quarter" ? n * 3 : n * 12;
    const 目標月 = d.getUTCMonth() + 足す月;
    const y = d.getUTCFullYear() + Math.floor(目標月 / 12);
    const m = ((目標月 % 12) + 12) % 12;
    /** 月末の丸め。Airtable も月末を超えたら月末に寄せる */
    const 月末 = new Date(Date.UTC(y, m + 1, 0)).getUTCDate();
    const D = Math.min(d.getUTCDate(), 月末);
    return new Date(Date.UTC(y, m, D, d.getUTCHours(), d.getUTCMinutes(), d.getUTCSeconds()));
  }
  return d;
}

function 差(a, b, 単位) {
  const u = String(単位).toLowerCase().replace(/s$/, "");
  const ms = { millisecond: 1, second: 1000, minute: 60000, hour: 3600000, day: 86400000, week: 604800000 }[u];
  if (ms) return Math.trunc((a.getTime() - b.getTime()) / ms);
  if (u === "month") return (a.getUTCFullYear() - b.getUTCFullYear()) * 12 + (a.getUTCMonth() - b.getUTCMonth());
  if (u === "year") return a.getUTCFullYear() - b.getUTCFullYear();
  return Math.trunc((a.getTime() - b.getTime()) / 86400000);
}

/** DATETIME_PARSE。現行で使われている形だけ確実に通す */
function 解く(s, fmt) {
  if (fmt) {
    /** 書式から正規表現を組む */
    const 順 = [];
    const re = fmt.replace(/YYYY|MM|DD|HH|mm|ss|./g, (t) => {
      if (t === "YYYY") { 順.push("y"); return "(\\d{4})"; }
      if (t === "MM") { 順.push("M"); return "(\\d{1,2})"; }
      if (t === "DD") { 順.push("D"); return "(\\d{1,2})"; }
      if (t === "HH") { 順.push("h"); return "(\\d{1,2})"; }
      if (t === "mm") { 順.push("m"); return "(\\d{1,2})"; }
      if (t === "ss") { 順.push("s"); return "(\\d{1,2})"; }
      return t.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    });
    const m = String(s).match(new RegExp("^" + re));
    if (m) {
      const o = { y: 1970, M: 1, D: 1, h: 0, m: 0, s: 0 };
      順.forEach((k, i) => { o[k] = Number(m[i + 1]); });
      return new Date(Date.UTC(o.y, o.M - 1, o.D, o.h, o.m, o.s));
    }
  }
  const d = 日時に(s);
  return d;
}

/** 実装している関数の一覧（試験と棚卸しに使う） */
export const 実装した関数 = [
  "IF", "AND", "OR", "NOT", "XOR", "TRUE", "FALSE", "BLANK", "SWITCH", "ISERROR", "IS_ERROR",
  "SUM", "MAX", "MIN", "AVERAGE", "COUNT", "COUNTA", "COUNTALL",
  "ARRAYUNIQUE", "ARRAYJOIN", "ARRAYCOMPACT", "ARRAYFLATTEN",
  "CONCATENATE", "LEFT", "RIGHT", "MID", "LEN", "TRIM", "UPPER", "LOWER",
  "SUBSTITUTE", "FIND", "ENCODE_URL_COMPONENT", "T", "VALUE",
  "ROUND", "ROUNDUP", "ROUNDDOWN", "FLOOR", "CEILING", "INT", "ABS", "MOD", "POWER", "SQRT",
  "TODAY", "NOW", "CREATED_TIME", "LAST_MODIFIED_TIME",
  "DATETIME_FORMAT", "DATETIME_PARSE", "DATEADD", "DATETIME_DIFF",
  "IS_BEFORE", "IS_AFTER", "IS_SAME",
  "YEAR", "MONTH", "DAY", "HOUR", "MINUTE", "SECOND", "WEEKDAY",
  "SET_TIMEZONE", "SET_LOCALE", "RECORD_ID",
];
