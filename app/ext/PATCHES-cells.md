# serve.mjs への提案（工程「その場で書ける欄」から）

工程の成果は `app/ext/20-cells.mjs` に閉じている（差し込み口「欄」と経路 3 本）。
serve.mjs 本体は触っていない。以下は差し込み口では届かない、または本体に置くべき点。

## 1. `値を整える` が関連項目・選択項目・日付を素の文字列のまま通す（純正フォームの POST）

### 現状

```js
function 値を整える(生, 欄) {
  ...
    if (f?.type === "number") v = Number(v);
    if (f?.type === "checkbox") v = v === "on" || v === "true" || v === "1";
    out[x.fld] = v;          // foreignKey / select / date はここに素の文字列で落ちる
```

純正フォーム 11 件の入力欄 34 個のうち foreignKey 4・select 2（種類番号・区分）・multiSelect 1（出力帳票）・date 6 がこの道を通る。

- **foreignKey**: 20-cells が GET を先取りして欄を検索ピッカーに替え、値を**行ID**で送るようにした。
  `関連を張る` は文字列の行IDを辺にするので link 表は正しくなるが、`row.cells` には `"recXXXX"` の文字列が残る。
  計算器の `式から見た形` は `{foreignRowDisplayName}` を持つ物しか表示名に直さないので、
  この関連を参照する式（例: 売上の 伝票区分 を CONCATENATE する式）が `recXXXX` を見る。
- **select / multiSelect**: 名前（"4" / "出荷明細書"）がそのまま入り、選択肢ID（`selw7n9gzdM1WqYox`）にならない。
  `書く` は `m[x] ?? x` で名前ならそのまま出すので画面では気づけないが、`名前に直す` を経た比較や `選択肢の順` の並びが合わない。
- **date**: `"2026-09-12"` の裸の文字列で入る。`外フォームの値` は `T00:00:00.000Z` を付けている。同じDBに 2 つの形が混ざる。

### 差分（`外フォームの値` と同じ規則に揃える）

```diff
 function 値を整える(生, 欄) {
   const out = {};
   for (const x of 欄) {
     const f = 項目.get(x.fld);
     let v = 生[x.fld];
     if (v === undefined || v === "") continue;
     if (f?.type === "number") v = Number(v);
     if (f?.type === "checkbox") v = v === "on" || v === "true" || v === "1";
+    /** 関連は行IDで来る（app/ext/20-cells.mjs のピッカー）。外フォームの値 と同じ形にする */
+    if (f?.type === "foreignKey") {
+      const ids = (Array.isArray(v) ? v : [v]).filter((s) => /^rec[A-Za-z0-9]{14}$/.test(String(s)));
+      v = ids.map((rid) => {
+        const r = db.prepare("SELECT tbl,cells,calc FROM row WHERE id=?").get(rid);
+        const 主 = r && db.prepare("SELECT primary_fld FROM tbl WHERE id=?").get(r.tbl)?.primary_fld;
+        const cv = r ? { ...JSON.parse(r.calc), ...JSON.parse(r.cells) } : {};
+        return { foreignRowId: rid, foreignRowDisplayName: 主 ? String(書く(cv[主], 項目.get(主)) ?? "") : rid };
+      });
+      if (!v.length) continue;
+    }
+    /** 選択肢は名前で来る。選択肢IDに直す（外フォームの値 と同じ） */
+    if (f?.type === "select" || f?.type === "multiSelect") {
+      const 表2 = f.opts?.選択肢ID ?? {};
+      const 直す = (s) => (表2[s] !== undefined ? s : (Object.entries(表2).find(([, n]) => n === s)?.[0] ?? s));
+      v = f.type === "multiSelect" ? (Array.isArray(v) ? v : [v]).map(直す) : 直す(v);
+    }
+    if (f?.type === "date" && /^\d{4}-\d{2}-\d{2}$/.test(String(v))) v = `${v}T00:00:00.000Z`;
     out[x.fld] = v;
   }
   return out;
 }
```

あわせて POST 側で `Object.fromEntries(new URLSearchParams(体))` を使っているため、
multiSelect（出力帳票）と多重の関連（在庫）の複数値が最後の 1 つに潰れる。
`const q = new URLSearchParams(体); 生[k] = q.getAll(k).length > 1 ? q.getAll(k) : q.get(k)` にすると複数値が届く。

## 2. `本文を読む` が同じ鍵の複数値を落とす

```js
const 本文を読む = (req) => new Promise((ok) => { ... ok(Object.fromEntries(new URLSearchParams(体))) });
```

`<select multiple>` の値は同じ鍵で複数回来る。20-cells は自前の `体を読む`（URLSearchParams のまま返す）を使った。
本体で `URLSearchParams` を返すか、複数値を配列にする版を 文脈 に足すと、他の拡張も同じ道を通れる。

## 3. クエリエンジンが起動時の断面しか見ない

`const 実行 = 作る(db)` は起動時に全行を読み込む（db/query.mjs）。ミミックで作った・書き換えた行は
`実行` の結果に映らない。20-cells の行選び（rowSelector の母集団）では、`write_log` で起動後に触った行を拾い、
その行だけ計算器の `通る` で今の値に当て直して補った（`母集団()`）。

本体では、`書き込み` の後に `実行` を作り直す（数百 ms）か、query.mjs に「行を差し替える」入口を足すのが筋。
一覧（levels / grid）も同じ問題を持つ——欄で値を書いても一覧の絞り込み結果は起動時のまま。
db/query.mjs は触らない指示なので、ここに記すだけにする。

## 4. `欄を描く` の既定の描き手

差し込み口があるので変更は不要。ただし既定の描き手にある

```js
const 行ID = 画面.画面の行 ? null : null;   // 行は渡されていない。定義だけ出す
```

は `?row=` を見ていない。20-cells が `u.searchParams.get("row")` を行の文脈として使っているので、
別工程「詳細画面」も同じ鍵で呼べば揃う（既に契約どおり）。

## 反映の記録（2026-09-13）

§1（値を整える の関連・選択肢・日付の形）と §2（本文を読む の複数値）は serve.mjs に**反映済み**。純正フォームの関連ピッカーは多重度 many で multiple にした。
§3（クエリエンジンの断面）は write.mjs の 書いた後 → query.mjs の 読み直す で解決済み。
検証（2026-09-13）の指摘で直したもの: 戻り先の細工（\\ と /./ で外へ飛ぶ）、選択肢に無い値・負の数・小数の拒否、選べる行の制約の列が手元に無い行を候補から外す、formContainer 由来の欄への POST を断る、multiSelect の空は鍵を消す。
