/**
 * 値を画面に出す形に直す。
 *
 * ■ 書式は項目の定義に入っている
 *
 * 生の typeOptions から回収した（07-schema が拾っていなかった分を含む）。
 *
 *   小数桁  計算項目431件・number 188件      precision
 *   記号    計算項目254件                   symbol（全件 '¥'）
 *   書式    currency 350 / decimal 148 /     format
 *           percentV2 34 / integer 67
 *   時間帯  62件（formula:client 30 / rollup:client 24 / Asia/Tokyo 4 …）
 *
 * `client` は「閲覧者の時間帯」。TTCF は日本で使うので Asia/Tokyo と読む。
 *
 * ■ 値の形は素直でない
 *
 *   チェックボックス  true は 1 で来る。未チェックは**値そのものが来ない**
 *   選択項目         選択肢ID（"selXXXX"）。名前に直す
 *   関連項目         [{foreignRowId, foreignRowDisplayName}]
 *   lookup          {valuesByForeignRowId, foreignRowIdOrder}
 *
 * ここを直さないと画面に "selOzZBASTfO6nXaB" が出る。
 */

const 桁区切り = (s) => String(s).replace(/\B(?=(\d{3})+(?!\d))/g, ",");

/** 数を書式に当てる */
function 数を書く(v, f) {
  const n = Number(v);
  if (!Number.isFinite(n)) return "";
  const 桁 = f.小数桁 ?? (f.書式 === "integer" ? 0 : null);
  const 符号 = n < 0 ? "-" : "";
  /**
   * percentV2 は**比率のまま**入っている（利益率の生の値は 0.0727）。
   * Airtable は表示のときに 100 倍して % を付けるので、こちらでも同じにする。
   * これを忘れると 月間原価計算の生産比率が 58.79% ではなく 0.59% になる
   * （クライアントの書き出した CSV は 100 倍後の値なので、そちらと食い違う）。
   */
  const a = Math.abs(f.書式 === "percentV2" ? n * 100 : n);
  let s = 桁 == null ? String(a) : a.toFixed(桁);
  const [整, 小] = s.split(".");
  s = 桁区切り(整) + (小 ? "." + 小 : "");
  if (f.書式 === "percentV2") return `${符号}${s}%`;
  if (f.記号) return `${符号}${f.記号}${s}`;
  return 符号 + s;
}

/** 日時を書式に当てる。時間帯は項目の設定に従う */
function 日時を書く(v, f, 既定の時間帯 = "Asia/Tokyo") {
  const d = v instanceof Date ? v : new Date(String(v));
  if (Number.isNaN(d.getTime())) return String(v);
  const tz = f.時間帯 === "client" || !f.時間帯 ? 既定の時間帯 : f.時間帯;
  /**
   * 時刻を出すかは **項目の設定（isDateTime）が優先**。
   * 値の形で判定すると、日付のみの項目も ISO 文字列で来るので必ず時刻が付く
   * （実測: 日付だけの項目に "00:00" が付いた）。
   * 設定が無いときだけ値の形を見る。
   */
  const 時刻あり = f.時刻あり !== undefined && f.時刻あり !== null
    ? !!f.時刻あり
    : /[T ]\d{2}:\d{2}/.test(String(v)) && !/T00:00:00(\.000)?Z?$/.test(String(v));
  const o = {};
  for (const p of new Intl.DateTimeFormat("en-CA", {
    timeZone: tz, year: "numeric", month: "2-digit", day: "2-digit",
    ...(時刻あり ? { hour: "2-digit", minute: "2-digit", hour12: false } : {}),
  }).formatToParts(d)) o[p.type] = p.value;
  const 日 = `${o.year}-${o.month}-${o.day}`;
  return 時刻あり ? `${日} ${o.hour === "24" ? "00" : o.hour}:${o.minute}` : 日;
}

/**
 * 1つの値を文字にする。
 * @param v     生の値
 * @param f     項目の定義（type / opts を持つ）
 */
export function 書く(v, f) {
  if (v === null || v === undefined || v === "") return "";
  const o = f?.opts ?? {};
  const t = f?.type;

  /** チェックボックス。1 / true が入っていれば付く */
  if (t === "checkbox") return (v === true || v === 1 || v === "1") ? "✓" : "";

  /** 選択項目。値はIDなので名前に直す */
  if (t === "select" || t === "multiSelect") {
    const m = o.選択肢ID ?? {};
    const 直す = (x) => m[x] ?? x;
    return Array.isArray(v) ? v.map(直す).join(", ") : 直す(v);
  }

  /** 関連項目 */
  if (t === "foreignKey") {
    const a = Array.isArray(v) ? v : [v];
    return a.map((x) => x?.foreignRowDisplayName ?? x?.foreignRowId ?? x).join(", ");
  }

  /** lookup。相手の行で束ねた形 */
  if (v && typeof v === "object" && v.valuesByForeignRowId) {
    const 順 = v.foreignRowIdOrder ?? Object.keys(v.valuesByForeignRowId);
    const 中 = { type: o.引く項目の型 ?? "text", opts: o };
    return 順.map((k) => {
      const x = v.valuesByForeignRowId[k];
      return Array.isArray(x) ? x.map((y) => 書く(y, 中)).join(", ") : 書く(x, 中);
    }).filter(Boolean).join(", ");
  }

  /** エラーを表す物（式のゼロ除算など） */
  if (v && typeof v === "object" && v.エラー) return "#ERROR";

  /** 添付 */
  if (t === "multipleAttachment") {
    const a = Array.isArray(v) ? v : [v];
    return a.map((x) => x?.filename ?? x?.name ?? "添付").join(", ");
  }

  /** 日付 */
  if (t === "date" || (t === "formula" && o.結果の型 === "date") ||
      (typeof v === "string" && /^\d{4}-\d{2}-\d{2}T/.test(v)) || v instanceof Date) {
    return 日時を書く(v, { ...o, 時刻あり: o.時刻あり });
  }

  /** 数 */
  if (typeof v === "number" || o.書式 === "currency" || o.書式 === "decimal" ||
      o.書式 === "percentV2" || o.書式 === "integer" || o.記号 || o.小数桁 != null) {
    if (typeof v === "number" || (typeof v === "string" && v !== "" && Number.isFinite(Number(v))))
      return 数を書く(v, o);
  }

  if (Array.isArray(v)) return v.map((x) => 書く(x, f)).join(", ");
  if (typeof v === "object") return JSON.stringify(v);
  return String(v);
}

/** 右に寄せるか（数と日付は右） */
export function 右寄せか(f) {
  const o = f?.opts ?? {};
  if (["number", "autoNumber", "count"].includes(f?.type)) return true;
  if (o.記号 || o.小数桁 != null) return true;
  if (["currency", "decimal", "percentV2", "integer"].includes(o.書式)) return true;
  if (f?.type === "rollup" && (o.書式 || o.小数桁 != null)) return true;
  return false;
}

/** 選択項目の色。Airtable の色名を CSS に写す */
export const 色 = {
  blue: "#cfdfff", cyan: "#d0f0fd", teal: "#c2f5e9", green: "#d1f7c4", yellow: "#ffeab6",
  orange: "#fee2d5", red: "#ffdce5", pink: "#ffdaf6", purple: "#ede2fe", gray: "#eee",
  blueLight2: "#cfdfff", cyanLight2: "#d0f0fd", tealLight2: "#c2f5e9", greenLight2: "#d1f7c4",
  yellowLight2: "#ffeab6", orangeLight2: "#fee2d5", redLight2: "#ffdce5", pinkLight2: "#ffdaf6",
  purpleLight2: "#ede2fe", grayLight2: "#eee",
  blueBright: "#2d7ff9", greenBright: "#20c933", redBright: "#f82b60", yellowBright: "#fcb400",
};

/**
 * ボタンの色。Airtable の colorTheme を写す。
 * 実測（319 個）: gray 139・secondary 63・primary 38・red 36・green 27・blue 16。
 * primary（主ボタン）は青、secondary は灰。無いと primary が gray に落ちて主ボタンが目立たない。
 */
export const ボタンの色 = {
  primary: ["#2d7ff9", "#fff"], secondary: ["#eee", "#1d1f25"],
  blue: ["#2d7ff9", "#fff"], green: ["#20c933", "#fff"], red: ["#f82b60", "#fff"],
  yellow: ["#fcb400", "#1d1f25"], orange: ["#ff6f2c", "#fff"], purple: ["#8b46ff", "#fff"],
  pink: ["#ff08c2", "#fff"], teal: ["#20d9d2", "#1d1f25"], cyan: ["#18bfff", "#fff"],
  gray: ["#eee", "#1d1f25"], white: ["#fff", "#1d1f25"],
};
