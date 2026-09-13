/**
 * 画面のクエリをローカルDBに対して実行する。
 *
 *   import { 作る } from "./db/query.mjs";
 *   const 実行 = 作る(db);
 *   const r = 実行(spec);   // { 行: [rowId…], 怪しい: [rowId…] }
 *   実行.読み直す([rowId…]);  // 書いた後に、その行だけ断面を差し替える（全部読み直すと 10 秒・900MB かかる）
 *
 * ■ ミミックが作った行は「全列が分かっている」
 *
 * 手元の行は「その列を要求した画面」からしか値を持たないので、要求されていない列は
 * 判定できない（怪しい）扱いにする。だがこのミミックで作った行（src が「ミミックの入力」）は
 * 入力した値がすべてで、無い列は本当に空である。怪しい扱いにすると、作ったばかりの行が
 * 一覧から漏れる。だからその行は全列を要求済みとみなす。
 *
 * ■ 絞り込みの節は3種類ある
 *
 *   columnComparison  {columnId, operator, value}         項目の比較
 *   nested            {conjunction, filterSet}            and / or の入れ子
 *   foreignKey        {sourceColumnId, foreignTableId,    **関連をたどった副問い合わせ**
 *                      foreignTableFilter}
 *
 * 3つ目が要点。「リンク先の行がこの条件を満たすか」を問う。**入れ子は4段以上ある。**
 * 受注一覧 pag4w8Q3nU1a4kB4p は 出庫 → 売上 → 月 と辿っている。
 * リンクが無い行では偽になる（だから現行の式は
 * `or(foreignKey副問い合わせ, {リンク項目} isEmpty)` の形で「リンク無し」を拾っている）。
 *
 * ■ 演算子（実測 307節の内訳）
 *
 *   = 113 / isNotEmpty 68 / > 26 / != 22 / contains 20 / isEmpty 13 /
 *   （型が foreignKey で演算子なし）12 / doesNotContain 9 / isWithin 7 /
 *   >= 6 / | 5 / isAnyOf 4 / isNoneOf 2
 *
 * ■ 利用者が操る絞り込みは制約にならない
 *
 * 節には `source` が付く。`permissionsFilters` は画面に焼かれた固定の絞り込み、
 * `arbitraryColumnFilters` は絞り込み帯で利用者が動かすもの。
 * 取得時点では後者はすべて値が null（未設定）だったので、**制約として扱わない。**
 * 扱うと全画面で行が0になる。
 *
 * **`source` は入れ子の親側に付いていて、葉の節には付いていない。**
 * 葉だけを見て判定すると、未設定の帯が制約として効いてしまう
 * （実測: 3クエリが 1,109行・110行・193行の正解に対して0行を返した。
 *   絞り込みは `and（arbitraryColumnFilters） → 月 = null / 製品名 contains null`
 *   という形で、source は親の and に付いていた）。
 * だから **親から子へ受け継ぐ。**
 *
 * ■ 未取得の列に注意
 *
 * 手元の行は「その列を要求した画面」からしか値を持たない。
 * 要求されていない列を isEmpty で判定すると、**本当は値があるのに通ってしまう。**
 * だからその行は「怪しい」に入れて、合否の判定から外す。
 */

export function 作る(db) {
  /** 行 → {tbl, cells, calc} */
  const 行 = new Map();
  const 表の行 = new Map();
  /** 完全: ミミックが作った行（無い列は本当に空） */
  const 行に = (r) => ({ id: r.id, tbl: r.tbl, cells: JSON.parse(r.cells), calc: JSON.parse(r.calc), snap: JSON.parse(r.snap ?? "{}"), implied: r.implied ? JSON.parse(r.implied) : null, 完全: /^ミミックの入力/.test(r.src ?? "") });
  for (const r of db.prepare("SELECT id,tbl,cells,calc,snap,src,implied FROM row").all()) {
    const e = 行に(r);
    行.set(r.id, e);
    (表の行.get(r.tbl) ?? 表の行.set(r.tbl, []).get(r.tbl)).push(e);
  }
  /** 関連。前向き（src|fld → dst…）と、逆にしない関連を相手側から読むための 逆向き（dst|fld → src…） */
  const 前向き = new Map(), 逆向き = new Map(), 辺のある項目 = new Set();
  for (const l of db.prepare("SELECT src_row,fld,dst_row FROM link ORDER BY src_row,fld,ord").all()) {
    const k = `${l.src_row}|${l.fld}`;
    (前向き.get(k) ?? 前向き.set(k, []).get(k)).push(l.dst_row);
    const k2 = `${l.dst_row}|${l.fld}`;
    (逆向き.get(k2) ?? 逆向き.set(k2, []).get(k2)).push(l.src_row);
    辺のある項目.add(l.fld);
  }
  /** 要求の記録 */
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
  const 要求された = (fid, rid) => 全行要求.has(fid) || (一部要求.get(fid)?.has(rid) ?? false) || (行.get(rid)?.完全 ?? false);

  /** 項目の定義 */
  const 項目 = new Map();
  for (const f of db.prepare("SELECT id,tbl,name,type,opts FROM fld").all())
    項目.set(f.id, { ...f, opts: f.opts ? JSON.parse(f.opts) : {} });
  const 選択肢 = new Map();
  const 選択肢の順 = new Map();   // 項目ID → Map(選択肢ID → 並びの位置)
  for (const f of 項目.values()) {
    /**
     * 選択肢の対応表。2箇所に入っている。
     *   select / multiSelect      → opts.選択肢ID（07-schema が作る）
     *   **formula で結果の型が select → opts.その他.choices**
     * 後者を見落としていて、予実/担当者月間(運賃・倉庫).月TEXT の並びが合わなかった。
     * 選択肢に selFORMULADEFAULT（既定）が先頭に入るのも後者の特徴。
     */
    let 表 = f.opts?.選択肢ID;
    if (!表 && f.opts?.その他?.choices) {
      const ch = f.opts.その他.choices;
      const 順 = f.opts.その他.choiceOrder ?? Object.keys(ch);
      表 = Object.fromEntries(順.map((id) => [id, ch[id]?.name]).filter(([, n]) => n != null));
    }
    if (!表) continue;
    選択肢.set(f.id, 表);
    const m = new Map();
    Object.keys(表).forEach((id, i) => m.set(id, i));
    選択肢の順.set(f.id, m);
  }

  /**
   * 値を引く。cells → calc → implied の順。
   * implied は「画面の所属から決まった値」（売上登録・在庫反映フラグ等 131,260 値。メモ「来ていない値は画面の所属で決まる」）。
   * 固定の絞り込み 465 節のうち 147 節はこの層でしか判定できず、無いと「判定できない」で行が落ちていた（30-detail が自前で当て直していた）。
   */
  function 値(e, fid) {
    if (e.cells[fid] !== undefined) return e.cells[fid];
    if (e.calc[fid] !== undefined) return e.calc[fid];
    if (e.implied && e.implied[fid] !== undefined) return e.implied[fid];
    /**
     * 5 層目: 関連項目は link 表から起こす。値が来ていなくても辺は 219,767 本ある（205 本の関連は「逆にしない」で片側だけ）。
     * 自分の辺（前向き）が無ければ、逆側の項目の辺（相手 → 自分）を読む。
     * **辺が無い行を「空」とは読まない。** 辺は「その列を要求した画面」に出た行にしか無いので、無い＝未取得（判定できない）のまま。
     * （一度「辺が 1 本でもある項目は無い行＝空」と読んで、製造/入庫の帯が 0 行になった。2026-09-13）
     * 例: 受注管理v1 の母集団「商品.Field isNotEmpty」は 入庫.商品コード の逆辺 8,385 本で判定できる（検証 2026-09-13）。
     */
    const f = 項目.get(fid);
    if (f?.type === "foreignKey") {
      const a = 前向き.get(`${e.id}|${fid}`);
      if (a?.length) return a.map((rid) => ({ foreignRowId: rid }));
      const 逆 = f.opts?.逆側の項目 ?? null;
      const b = 逆 ? 逆向き.get(`${e.id}|${逆}`) : null;
      if (b?.length) return b.map((rid) => ({ foreignRowId: rid }));
    }
    /** チェックボックスは要求されていて値が無ければ false */
    if (項目.get(fid)?.type === "checkbox" && 要求された(fid, e.id)) return false;
    return undefined;
  }

  const 空か = (v) => v === null || v === undefined || v === "" ||
    (Array.isArray(v) && v.length === 0) || v === false;

  /** 値を比べるための文字列に。関連は行IDと表示名の両方を候補にする */
  const 候補 = (v) => {
    if (v == null) return [];
    if (Array.isArray(v)) return v.flatMap(候補);
    if (typeof v === "object") {
      const o = [];
      if (v.foreignRowId) o.push(v.foreignRowId);
      if (v.foreignRowDisplayName != null) o.push(String(v.foreignRowDisplayName));
      if (v.valuesByForeignRowId) for (const x of Object.values(v.valuesByForeignRowId)) o.push(...候補(x));
      return o;
    }
    return [String(v)];
  };

  /**
   * 1節を1行に当てる。
   * @returns {true|false|null} null は「判定できない（未取得の列を見た）」
   */
  function 節を当てる(e, f, 深 = 0, 親の出どころ = null) {
    if (深 > 12) return null;

    /** 入れ子 */
    if (f.filterSet) return 集合を当てる(e, f, 深 + 1, 親の出どころ);

    /** 関連をたどった副問い合わせ */
    if (f.type === "foreignKey" || (f.operator === undefined && f.sourceColumnId)) {
      const 先 = 前向き.get(`${e.id}|${f.sourceColumnId}`) ?? [];
      if (!先.length) {
        /** リンクが無い。要求されていないなら判定できない */
        if (!要求された(f.sourceColumnId, e.id) && e.cells[f.sourceColumnId] === undefined) return null;
        return false;
      }
      let 判定できない = false;
      for (const rid of 先) {
        const r = 行.get(rid);
        if (!r) { 判定できない = true; continue; }   // 相手の行が手元に無い
        const v = 集合を当てる(r, f.foreignTableFilter ?? { conjunction: "and", filterSet: [] }, 深 + 1, 親の出どころ);
        if (v === true) return true;                 // **どれか1つでも満たせば真**
        if (v === null) 判定できない = true;
      }
      return 判定できない ? null : false;
    }

    /** 項目の比較 */
    const fid = f.columnId;
    if (!fid) return null;
    const 生 = 値(e, fid);
    /** 未取得なら判定できない */
    if (生 === undefined && !要求された(fid, e.id)) return null;
    const v = 生 === undefined ? null : 生;
    const 空 = 空か(v);
    const m = 選択肢.get(fid);
    const 値の候補 = [...候補(v), ...(m && v != null && !Array.isArray(v) && m[v] ? [m[v]] : [])];
    const 期待 = f.value;
    const 期待の候補 = Array.isArray(期待) ? 期待.map(String) : 期待 == null ? [] : [String(期待)];

    switch (f.operator) {
      case "isEmpty": return 空;
      case "isNotEmpty": return !空;
      case "=":
        if (期待 === null) return 空;
        if (期待 === true) return v === true || v === 1 || v === "1";
        if (期待 === false) return v === false || 空;
        if (空) return false;
        return 値の候補.some((x) => 期待の候補.includes(x));
      case "!=": {
        const r = 節を当てる(e, { ...f, operator: "=" }, 深, 親の出どころ);
        return r === null ? null : !r;
      }
      case "isAnyOf":
      case "|":
        /** 値が無い＝利用者が未設定。制約にならない */
        if (期待 == null || (Array.isArray(期待) && !期待.length)) return true;
        if (空) return false;
        return 値の候補.some((x) => 期待の候補.includes(x));
      case "isNoneOf": {
        if (期待 == null || (Array.isArray(期待) && !期待.length)) return true;
        if (空) return true;
        return !値の候補.some((x) => 期待の候補.includes(x));
      }
      case "contains": {
        if (期待 == null) return true;                 // 未設定
        if (空) return false;
        return 値の候補.some((x) => x.includes(String(期待)));
      }
      case "doesNotContain": {
        if (期待 == null) return true;
        if (空) return true;
        return !値の候補.some((x) => x.includes(String(期待)));
      }
      case ">": case ">=": case "<": case "<=": {
        if (期待 == null) return true;
        if (空) return false;
        const a = 数か日時(v), b = 数か日時(期待);
        if (a == null || b == null) return false;
        return f.operator === ">" ? a > b : f.operator === ">=" ? a >= b : f.operator === "<" ? a < b : a <= b;
      }
      case "isWithin":
        /** 日付の範囲。取得時はすべて未設定だった */
        if (期待 == null) return true;
        return null;                                  // 設定つきは未対応。判定できないと報告する
      default:
        return null;
    }
  }

  const 数か日時 = (v) => {
    if (v == null) return null;
    if (typeof v === "number") return v;
    const s = String(Array.isArray(v) ? v[0] : v);
    if (/^\d{4}-\d{2}-\d{2}/.test(s)) { const d = new Date(s); return Number.isNaN(d.getTime()) ? null : d.getTime(); }
    const n = Number(s);
    return Number.isFinite(n) ? n : null;
  };

  /** and / or。null（判定できない）を混ぜて畳む */
  function 集合を当てる(e, f, 深 = 0, 親の出どころ = null) {
    /** source は親に付くことがある。子に受け継ぐ */
    const 出どころ = f.source ?? 親の出どころ;
    const 節 = (f.filterSet ?? []).filter((x) => {
      const s2 = x.source ?? 出どころ;
      /** 利用者が動かす絞り込みは制約にしない。ただし値が入っていれば効かせる */
      if (s2 === "arbitraryColumnFilters" && x.value == null && !x.filterSet && !x.sourceColumnId) return false;
      return true;
    });
    if (!節.length) return true;
    const 結果 = 節.map((x) => 節を当てる(e, x, 深, 出どころ));
    if (f.conjunction === "or") {
      if (結果.some((r) => r === true)) return true;
      return 結果.some((r) => r === null) ? null : false;
    }
    if (結果.some((r) => r === false)) return false;
    return 結果.some((r) => r === null) ? null : true;
  }

  /**
   * 並べ替え。
   *
   * ■ 並び順は機能である
   *
   * 利用者は並んだ一覧を見て仕事をするので、順序が違えば別の画面になる。
   *
   * ■ 型ごとに並べる鍵が違う
   *
   *   lookup   値は {valuesByForeignRowId, foreignRowIdOrder}。**先頭の値で並ぶ。**
   *            全部を連結して比べると順序が合わない（実測: 8本のうち複数がこれ）
   *   rollup   計算結果そのまま
   *   関連項目  表示名で並ぶ（行IDではない）
   *
   * ■ 空は最後
   *
   * 昇順・降順に関わらず空は末尾。Airtable と同じ（降順で先頭に来ない）。
   *
   * ■ **文字は自然順（数字の並びを数として比べる）**
   *
   * 単純な文字比較では合わない。実測（販売/商品マスタ、製品ID で昇順、110行）:
   *   Airtable は O0411009 の次を O0416002 とし、**O04111001 を106番目**に置いた。
   *   単純な文字比較だと O0411009 の直後（52番目）に来る。
   * "O" のあとの数として見ると 4,111,001 > 417,002 なので後ろに来る。
   * つまり Airtable は数字の並びを数として比べている。
   * `Intl.Collator(undefined,{numeric:true})` がこれに当たる。
   */
  const 照合 = new Intl.Collator("ja", { numeric: true, sensitivity: "variant" });
  function 並べる(rows, sorts) {
    if (!sorts?.length) return rows;
    const key = (e, s) => {
      const v = 値(e, s.columnId);
      if (v == null || v === "" || (Array.isArray(v) && !v.length)) return null;
      /** lookup は先頭の値で並ぶ */
      if (v && typeof v === "object" && v.valuesByForeignRowId) {
        const 順 = v.foreignRowIdOrder ?? Object.keys(v.valuesByForeignRowId);
        const 先頭 = v.valuesByForeignRowId[順[0]];
        const 実 = Array.isArray(先頭) ? 先頭[0] : 先頭;
        if (実 == null) return null;
        const n = 数か日時(実);
        return n != null ? n : String(候補(実)[0] ?? "");
      }
      /** 関連項目は表示名で */
      if (Array.isArray(v) && v[0] && typeof v[0] === "object" && v[0].foreignRowDisplayName != null)
        return String(v[0].foreignRowDisplayName);
      /**
       * **選択項目は選択肢の並び順（choiceOrder の位置）で並ぶ。**
       * IDの文字列でも名前でもない。実測（予実/担当者月間(運賃・倉庫)、779行）で
       * 正解の先頭が selbI3sJYAel9prel、自分の先頭が sel0IdiAC0UVbUqOx になった。
       * ID順でも名前順でもなく、選択肢を並べた順である。
       */
      const 順表 = 選択肢の順.get(s.columnId);
      if (順表) {
        const 生 = Array.isArray(v) ? v[0] : v;
        const i = 順表.get(生);
        if (i !== undefined) return i;
      }
      const n = 数か日時(v);
      return n != null ? n : String(候補(v)[0] ?? "");
    };
    return [...rows].sort((a, b) => {
      for (const s of sorts) {
        const x = key(a, s), y = key(b, s);
        if (x === y) continue;
        /** 空は昇順でも降順でも最後 */
        if (x == null) return 1;
        if (y == null) return -1;
        const c = typeof x === "number" && typeof y === "number" ? x - y
          : 照合.compare(String(x), String(y));
        if (c) return s.ascending === false ? -c : c;
      }
      return 0;
    });
  }

  /**
   * 触った行だけ読み直す。無くなった行は外す。新しい行は表の末尾（作られた順＝自然順）に足す。
   * 関連は「この行から出る辺」だけ持ち直す（相手側から入る辺は相手の行の読み直しで持ち直る。
   * write.mjs の 関連を張る は書いた行の辺しか変えないので、それで足りる）。
   */
  const 表の項目 = new Map();
  for (const f of 項目.values()) (表の項目.get(f.tbl) ?? 表の項目.set(f.tbl, []).get(f.tbl)).push(f.id);
  const 一行 = db.prepare("SELECT id,tbl,cells,calc,snap,src,implied FROM row WHERE id=?");
  const 行の関連 = db.prepare("SELECT fld,dst_row FROM link WHERE src_row=? ORDER BY fld,ord");
  function 読み直す(ids) {
    let n = 0;
    for (const id of Array.isArray(ids) ? ids : [ids]) {
      const 旧 = 行.get(id);
      const r = 一行.get(id);
      if (旧) for (const fid of 表の項目.get(旧.tbl) ?? []) 前向き.delete(`${id}|${fid}`);
      for (const k of [...逆向き.keys()]) if (k.startsWith(id + "|")) 逆向き.delete(k);
      if (!r) {
        if (!旧) continue;
        行.delete(id);
        const a = 表の行.get(旧.tbl), i = a ? a.indexOf(旧) : -1;
        if (i >= 0) a.splice(i, 1);
        n++;
        continue;
      }
      const e = 行に(r);
      if (旧) Object.assign(旧, e);   // 表の行 の配列が同じ物を指しているので、その場で書き換える
      else { 行.set(id, e); (表の行.get(r.tbl) ?? 表の行.set(r.tbl, []).get(r.tbl)).push(e); }
      for (const l of 行の関連.all(id)) { const k = `${id}|${l.fld}`; (前向き.get(k) ?? 前向き.set(k, []).get(k)).push(l.dst_row); 辺のある項目.add(l.fld); }
      for (const l of db.prepare("SELECT src_row,fld FROM link WHERE dst_row=?").all(id)) { const k = `${id}|${l.fld}`; (逆向き.get(k) ?? 逆向き.set(k, []).get(k)).push(l.src_row); }
      n++;
    }
    return n;
  }

  /** クエリを実行する */
  function 実行(spec) {
    const tb = spec?.source?.tableId;
    const rows = 表の行.get(tb) ?? [];
    const 通った = [], 怪しい = [];
    for (const e of rows) {
      const r = spec.filters ? 集合を当てる(e, spec.filters) : true;
      if (r === true) 通った.push(e);
      else if (r === null) 怪しい.push(e.id);
    }
    return { 行: 並べる(通った, spec.sorts).map((e) => e.id), 怪しい, 表: tb, 母数: rows.length };
  }
  実行.読み直す = 読み直す;
  return 実行;
}
