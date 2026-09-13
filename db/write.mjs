/**
 * ローカルDBに書き込む。**現行のAirtableには一切触れない。**
 *
 *   import { 書き込み器を作る } from "./db/write.mjs";
 *   const w = 書き込み器を作る(db);
 *   w.検証(表ID, 値);                 → [文言…]
 *   w.作る(表ID, 値, {出どころ});      → {行ID, 文言, 再計算した行数}
 *   w.更新(行ID, 値, {出どころ});
 *   w.消す(行ID, {出どころ});
 *
 * ■ 検証は2層ある
 *
 *  1. **フォームの制約**（miniExtensions / 純正フォームの定義から）
 *     必須・読み取り専用・一意にする・項目ごとの検証条件と文言
 *     実測: 必須54項目、一意2件（製造/Table.仕入先名・製造/商品.製品ID）、
 *     検証条件1件（原材料名にカンマを許さない。文言「カンマ","は入力できません。」）
 *
 *     **必須はフォームごとの性質である。表の性質ではない。**
 *     表の全フォームの必須を合算すると、そのフォームで入力しない項目まで必須になる
 *     （実測: 製品IDだけを出したのに 商品名1・入数・消費税率・ロットあたりkg・KG/袋 が
 *       必須だと言われた。それらは別のフォームの必須である）。
 *     だから制約は **(フォーム, 項目)** で持ち、検証はフォームを指定して行う。
 *     フォームを指定しないときは、フォームに依らない制約だけを見る
 *     （一意にする＝データの整合、項目ごとの検証条件＝値の形）。
 *
 *  2. **式による門**（Airtable の formula）
 *     「登録エラー」「売上登録エラー」などの式が、空文字なら通る形で書かれている。
 *     文言は式の中の日本語リテラルそのもの（70式・176文言）。
 *     **これは行を保存した後に計算される。** 保存を拒む門ではなく、
 *     「登録ボタンを押せるか」の門である。だから保存時には評価せず、
 *     保存後の計算結果として持つ。
 *
 * ■ 採番
 *
 * autoNumber は `counter` 表で持つ。現行の `maxUsedAutoNumber` が種。
 * **売上のカウンタは1本**で、海外（種類番号4）と国内（6）が分け合っている。
 * 欠番は詰めない。
 *
 * ■ 保存したら計算し直す
 *
 * `db/calc.mjs` を使う。照合側（04-recalc）と同じコードで、
 * 30項目・275,572値で Airtable の計算値と100%一致することを確かめてある（07-calc-parity）。
 * 書いた行と、その行を集めている行（rollup/lookup の親）を2段まで辿って計算し直す。
 */
import { 計算器を作る } from "./calc.mjs";

/**
 * ─── 書いた後に知らせる ───
 *
 * **器ごとではなく module 全体で持つ。** 動作器（db/actions.mjs）は自分の書き込み器を作るので、
 * 器ごとの購読だと動作からの書き込みが漏れる。
 * serve.mjs はここで受けて、起動時に全行を読み込んだクエリエンジンの断面（db/query.mjs）を、
 * 触った行だけ差し替える。知らせる中身は { 動作, 表ID, 行ID, 行たち }。行たち は計算し直した行も含む。
 */
const 購読 = new Set();
export function 書いた後(fn) { 購読.add(fn); return () => 購読.delete(fn); }
const 知らせる = (x) => { for (const fn of 購読) { try { fn(x); } catch (e) { console.error("書いた後の購読で落ちました:", e.message); } } };

const 乱英数 = () => {
  const s = "0123456789abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ";
  let r = "";
  for (let i = 0; i < 14; i++) r += s[Math.floor(Math.random() * s.length)];
  return r;
};

export function 書き込み器を作る(db) {
  const c = 計算器を作る(db);

  /** ─── 定義 ─── */
  const 項目 = c.項目;
  const 表の項目 = new Map();
  for (const f of 項目.values()) (表の項目.get(f.tbl) ?? 表の項目.set(f.tbl, []).get(f.tbl)).push(f);

  /**
   * フォームごとの制約。**鍵は (フォームの名, 項目ID)。**
   * あわせて「フォームに依らない制約」（一意にする・項目ごとの検証条件）を別に持つ。
   */
  const フォームの制約 = new Map();   // フォームの名 → Map(項目ID → {…})
  const 固有の制約 = new Map();       // 項目ID → {一意, 検証, 文言}
  const 足す = (名, fid, x) => {
    const m = フォームの制約.get(名) ?? フォームの制約.set(名, new Map()).get(名);
    m.set(fid, { ...(m.get(fid) ?? {}), ...x });
  };
  for (const r of db.prepare("SELECT share,tbl,button,spec FROM form").all()) {
    const sp = r.spec ? JSON.parse(r.spec) : {};
    const 出す = new Set(sp.出す項目 ?? []);
    const 名 = `mx:${r.share}|${r.tbl}|${r.button}`;
    for (const x of sp.項目 ?? []) {
      if (!出す.has(x.id)) continue;
      足す(名, x.id, {
        必須: !!x.必須, 読み取り専用: !!x.読み取り専用,
        検証: x.検証の生 ?? null, 検証の文: x.検証 ?? null, 文言: x.エラーの文言 ?? null,
        一意: !!x.一意にする,
      });
      /** 一意と値の形はフォームに依らない。どのフォームから入れても守るべき */
      if (x.一意にする || x.検証の生) {
        const e = 固有の制約.get(x.id) ?? {};
        if (x.一意にする) e.一意 = true;
        if (x.検証の生) { e.検証 = x.検証の生; e.検証の文 = x.検証; e.文言 = x.エラーの文言 ?? null; }
        固有の制約.set(x.id, e);
      }
    }
  }
  /** 純正フォーム（formContainer）の必須 */
  for (const r of db.prepare("SELECT page,id,spec FROM elem WHERE type=?").all("formContainer")) {
    const sp = JSON.parse(r.spec ?? "{}");
    const 名 = `native:${r.page}|${r.id}`;
    if (!フォームの制約.has(名)) フォームの制約.set(名, new Map());   // 必須が無いフォームも「定義あり」。無いと保存が「定義がありません」で止まった（11 のうち 6）
    for (const x of sp.必須 ?? []) 足す(名, x.id, { 必須: true });
  }

  /** ─── 採番 ─── */
  {
    const 有 = new Set(db.prepare("SELECT fld FROM counter").all().map((r) => r.fld));
    const ins = db.prepare("INSERT INTO counter(fld,next) VALUES(?,?)");
    for (const f of 項目.values()) {
      if (f.type !== "autoNumber" || 有.has(f.id)) continue;
      ins.run(f.id, f.opts?.次の値 ?? 1);
    }
  }
  const 採る = (fid) => {
    const r = db.prepare("SELECT next FROM counter WHERE fld=?").get(fid);
    if (!r) return null;
    db.prepare("UPDATE counter SET next=next+1 WHERE fld=?").run(fid);
    return r.next;
  };

  const 空か = (v) => v === null || v === undefined || v === "" ||
    (Array.isArray(v) && v.length === 0);

  /**
   * miniExtensions の条件を Airtable の形に直す。
   *
   * **2つは別の形をしている。** 取り違えると条件が黙って無視される
   * （実測: カンマを許さない検証が一度も発火しなかった）。
   *
   *   miniExtensions  {logicalOperator:"and", conditions:[{setting:{idOrName:{id}, type, value}, type:"singleCondition"}]}
   *   Airtable        {conjunction:"and",     filterSet:[{columnId, operator, value}]}
   *
   * 入れ子（type:"nestedCondition"）も同じ形で来るので再帰する。
   */
  function 条件を直す(c) {
    if (!c) return null;
    if (c.filterSet) return c;                       // もう Airtable の形
    const 節 = (c.conditions ?? []).map((x) => {
      if (x.conditions || x.type === "nestedCondition") return 条件を直す(x);
      const st = x.setting ?? {};
      return {
        columnId: st.idOrName?.id ?? st.idOrName?.name ?? null,
        operator: st.type ?? "=",
        value: st.value === undefined ? null : st.value,
      };
    }).filter(Boolean);
    return { conjunction: c.logicalOperator === "or" ? "or" : "and", filterSet: 節 };
  }

  /**
   * ─── 検証 ───
   * @param フォーム 指定するとそのフォームの必須・読み取り専用も見る。
   *                 指定しないときは、フォームに依らない制約だけ（一意・値の形）。
   */
  function 検証(表ID, 値, { 行ID = null, フォーム = null } = {}) {
    const 文言 = [];
    const 帳 = フォーム ? フォームの制約.get(フォーム) : null;
    if (フォーム && !帳) 文言.push(`フォーム ${フォーム} の定義がありません`);
    for (const f of 表の項目.get(表ID) ?? []) {
      const k = { ...(固有の制約.get(f.id) ?? {}), ...(帳?.get(f.id) ?? {}) };
      if (!Object.keys(k).length) continue;
      const v = 値[f.id];
      /** 必須。**フォームを指定したときだけ見る** */
      if (k.必須 && 空か(v)) 文言.push(`${f.name || f.id} は必須です`);
      /** 一意にする */
      if (k.一意 && !空か(v)) {
        const 他 = db.prepare(`SELECT id FROM row WHERE tbl=? AND json_extract(cells,?)=? ${行ID ? "AND id<>?" : ""} LIMIT 1`)
          .get(...[表ID, "$." + f.id, typeof v === "object" ? JSON.stringify(v) : v, ...(行ID ? [行ID] : [])]);
        if (他) 文言.push(`${f.name || f.id} は既に使われています（${他.id}）`);
      }
      /** 項目ごとの検証条件。外れたら定義の文言を出す */
      if (k.検証 && !空か(v)) {
        const 仮 = { id: 行ID ?? "新規", tbl: 表ID, cells: 値, calc: {}, 新しい行: !行ID };
        const 条 = 条件を直す(k.検証);
        if (!c.通る(仮, 条)) 文言.push(k.文言 || `${f.name || f.id} の値が条件に合いません`);
      }
    }
    return 文言;
  }

  /** 既定値を当てる。dynamicCurrentDateValue は今日 */
  function 既定値を当てる(既定, 値) {
    const out = { ...値 };
    for (const [fid, v] of Object.entries(既定 ?? {})) {
      if (!空か(out[fid])) continue;
      if (v && typeof v === "object" && v.specialValue === "dynamicCurrentDateValue") {
        const d = new Date();
        const p = new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Tokyo", year: "numeric", month: "2-digit", day: "2-digit" })
          .formatToParts(d).reduce((a, x) => (a[x.type] = x.value, a), {});
        out[fid] = `${p.year}-${p.month}-${p.day}`;
      } else out[fid] = v;
    }
    return out;
  }

  /**
   * 締処理表（販売/締処理・製造/締処理。各 1 行）への関連は、**作成時から全行に張られている**
   * （製造/入庫.在庫残高設定日＝この関連経由の rollup が 2020 年の行にも最新締日より後の行にも入っている。検証 2026-09-13）。
   * 各表の 登録エラー は 締日・締処理日時 の rollup をこの関連で辿るので、無いとミミックで作った行が締めの門を通り抜ける。
   * 値が渡されていなければ、その表の 1 行に張る。
   */
  const 締処理表 = new Set(db.prepare("SELECT id FROM tbl WHERE name='締処理'").all().map((r) => r.id));
  function 締処理表への関連を既定にする(表ID, 値) {
    const out = { ...値 };
    for (const f of 表の項目.get(表ID) ?? []) {
      if (f.type !== "foreignKey" || !締処理表.has(f.opts?.関連先) || !空か(out[f.id])) continue;
      const r = db.prepare("SELECT id FROM row WHERE tbl=? LIMIT 1").get(f.opts.関連先);
      if (r) out[f.id] = [{ foreignRowId: r.id, foreignRowDisplayName: "1" }];
    }
    return out;
  }

  /** 関連を link 表に反映する */
  function 関連を張る(行ID, 値) {
    const del = db.prepare("DELETE FROM link WHERE src_row=? AND fld=?");
    const ins = db.prepare("INSERT OR REPLACE INTO link(src_row,fld,dst_row,ord) VALUES(?,?,?,?)");
    for (const [fid, v] of Object.entries(値)) {
      if (項目.get(fid)?.type !== "foreignKey") continue;
      del.run(行ID, fid);
      const a = Array.isArray(v) ? v : v == null ? [] : [v];
      a.forEach((x, i) => {
        const dst = x?.foreignRowId ?? (typeof x === "string" ? x : null);
        if (dst) ins.run(行ID, fid, dst, i);
      });
    }
  }

  const 記録 = db.prepare("INSERT INTO write_log(at,action,tbl,row,origin,before,after,note) VALUES(?,?,?,?,?,?,?,?)");

  /** ─── 行を作る ─── */
  function 作る(表ID, 値, { 出どころ = null, 既定 = null, 検証する = true, フォーム = null } = {}) {
    const v = 締処理表への関連を既定にする(表ID, 既定値を当てる(既定, 値));
    const 文言 = 検証する ? 検証(表ID, v, { フォーム }) : [];
    if (文言.length) return { 行ID: null, 文言, 再計算した行数: 0 };

    /** 採番。autoNumber は計算結果側に置く（入力ではない） */
    const calc = {};
    for (const f of 表の項目.get(表ID) ?? []) {
      if (f.type !== "autoNumber") continue;
      const n = 採る(f.id);
      if (n != null) calc[f.id] = n;
    }
    const 行ID = "rec" + 乱英数();
    const いま = new Date().toISOString();
    db.exec("BEGIN");
    try {
      db.prepare("INSERT INTO row(id,tbl,cells,calc,src,loaded) VALUES(?,?,?,?,?,?)")
        .run(行ID, 表ID, JSON.stringify(v), JSON.stringify(calc), "ミミックの入力", いま);
      関連を張る(行ID, v);
      記録.run(いま, "createRow", 表ID, 行ID, 出どころ, null, JSON.stringify(v), null);
      db.exec("COMMIT");
    } catch (e) { db.exec("ROLLBACK"); throw e; }
    const 触った = new Set();
    const n = c.再計算([行ID, ...c.影響する行(行ID)], { 触った });
    知らせる({ 動作: "createRow", 表ID, 行ID, 行たち: [行ID, ...触った] });
    return { 行ID, 文言: [], 再計算した行数: n };
  }

  /** ─── 行を更新する ─── */
  function 更新(行ID, 値, { 出どころ = null, 検証する = true, フォーム = null } = {}) {
    const 前 = c.取る(行ID);
    if (!前) return { 行ID: null, 文言: ["その行はありません"], 再計算した行数: 0 };
    const 新 = { ...前.cells, ...値 };
    /** null は「値を消す」。Airtable はチェックを外す・欄を空にすると鍵ごと消える（false や "" を書かない）。差分の併合ではそれができなかった */
    for (const [k, v] of Object.entries(値)) if (v === null) delete 新[k];
    const 文言 = 検証する ? 検証(前.tbl, 新, { 行ID, フォーム }) : [];
    if (文言.length) return { 行ID, 文言, 再計算した行数: 0 };
    const いま = new Date().toISOString();
    db.exec("BEGIN");
    try {
      db.prepare("UPDATE row SET cells=?,loaded=? WHERE id=?").run(JSON.stringify(新), いま, 行ID);
      関連を張る(行ID, 値);
      記録.run(いま, "updateRow", 前.tbl, 行ID, 出どころ, JSON.stringify(前.cells), JSON.stringify(新), null);
      db.exec("COMMIT");
    } catch (e) { db.exec("ROLLBACK"); throw e; }
    const 触った = new Set();
    const n = c.再計算([行ID, ...c.影響する行(行ID)], { 触った });
    知らせる({ 動作: "updateRow", 表ID: 前.tbl, 行ID, 行たち: [行ID, ...触った] });
    return { 行ID, 文言: [], 再計算した行数: n };
  }

  /** ─── 行を消す ─── */
  function 消す(行ID, { 出どころ = null } = {}) {
    const 前 = c.取る(行ID);
    if (!前) return { 文言: ["その行はありません"], 再計算した行数: 0 };
    /** 消す前に、この行を集めている行を覚えておく */
    const 親 = c.影響する行(行ID);
    /**
     * before には**行全体**（cells / calc / snap / implied / src / loaded と、両向きの辺）を残す。
     * cells だけだと、Airtable から写した行（snap＝正解）を消したときに snap と辺が復元できない（監査 2026-09-12）。
     */
    const 辺 = db.prepare("SELECT src_row,fld,dst_row,ord FROM link WHERE src_row=? OR dst_row=?").all(行ID, 行ID);
    const 写し = db.prepare("SELECT src,loaded FROM row WHERE id=?").get(行ID);
    const いま = new Date().toISOString();
    db.exec("BEGIN");
    try {
      db.prepare("DELETE FROM link WHERE src_row=? OR dst_row=?").run(行ID, 行ID);
      db.prepare("DELETE FROM row WHERE id=?").run(行ID);
      記録.run(いま, "deleteRow", 前.tbl, 行ID, 出どころ,
        JSON.stringify({ cells: 前.cells, calc: 前.calc, snap: 前.snap, implied: 前.implied, src: 写し?.src ?? null, loaded: 写し?.loaded ?? null, link: 辺 }), null, null);
      db.exec("COMMIT");
    } catch (e) { db.exec("ROLLBACK"); throw e; }
    const 触った = new Set();
    const n = c.再計算(親, { 触った });
    知らせる({ 動作: "deleteRow", 表ID: 前.tbl, 行ID, 行たち: [行ID, ...触った] });
    return { 文言: [], 再計算した行数: n };
  }

  return { 検証, 作る, 更新, 消す, フォームの制約, 固有の制約, 採る, 条件を直す, 計算器: c };
}
