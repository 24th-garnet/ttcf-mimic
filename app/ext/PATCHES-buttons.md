# serve.mjs への提案（工程「ボタン」）

`app/ext/10-buttons.mjs` は差し込み口（拡張.ボタン / 拡張.画面 / 拡張.経路）だけで 243 個のボタンを動かした。
serve.mjs は触っていない。差し込み口で足りなかった箇所を、回避した方法と一緒に書く。どれも小さい。

## 1. `ボタンを描く(要素, pid)` に URL を渡す

**何が足りないか** ボタンの描き手は `(要素, spec, pid, {門,条件,色}, 文脈)` を受けるが URL を受けない。
deleteRow / updateRow / navigateToRowUrl / addForeignRow は行の文脈（`?row=rec…`）が要る（rowInput.outputId が
rootRowContainer / rowSelector の 1 行を指す。7+6+18+1＝32 個）。

**いまの回避** `拡張.画面` の差し込み口で URL をモジュール変数に控え（null を返して既定の描き方に任せる）、
ボタンの描き手がそれを読む。`画面を描く` は同期で、拡張.画面 → ボタンを描く の順に呼ぶので取り違えは起きないが、
描き手の引数として渡す方が筋。

**差分**
```diff
-function ボタンを描く(要素, pid) {
+function ボタンを描く(要素, pid, u = new URL("http://x/")) {
 …
-    if (!d && 拡張.ボタン.has(sp.動作)) { const h = 拡張.ボタン.get(sp.動作)(e, sp, pid, { 門, 条件, 色: [bg, fg] }, 文脈); if (h != null) return h; }
+    if (!d && 拡張.ボタン.has(sp.動作)) { const h = 拡張.ボタン.get(sp.動作)(e, sp, pid, { 門, 条件, 色: [bg, fg], u }, 文脈); if (h != null) return h; }
 …
-  if (b.length) 中 += ボタンを描く(b, pid);
+  if (b.length) 中 += ボタンを描く(b, pid, u);
```
拡張側は `{u}` があればそれを、無ければ控えた URL を使う形にしてあるので、この差分を入れても壊れない。

## 2. `フォームを描く` / `POST /form` がクエリの既定値を受ける

**何が足りないか** addForeignRow（入金登録）は「親の行（売掛台帳）の関連項目 fldMgvOGTsgLGc3JT に新しい行を張る」動作だが、
純正フォーム pag8viZ0mEJ9zzMsR の入力欄は 入金日・手数料・今回入金額 の 3 つで、関連項目の欄が無い。
`GET /form/:pid/:eid` は `フォームを描く(pid, eid)` を引数無しで呼び、`POST /form` は cellEditor の欄しか値に取らないので、
親を URL のクエリ（`?fldMgvOGTsgLGc3JT=rec…`）で渡しても届かない。

**いまの回避** 拡張の経路 `/button/:pid/:eid/form?row=<親>` が同じ `フォームを描く` を呼び、POST も拡張側で受けて
`書き込み.作る` → 親の関連項目に `書き込み.更新` で足す（両側が「逆にしない」関連で辺 0 なので、
新しい行側の逆側の項目 fld7ImJlDZ4ZwyrZw にも親を入れる）。親の注はフォームの HTML の `<form method=post class=el>` の直前に
文字列置換で差し込んでいる（差し込み口が無いため）。

**差分（案）**
```diff
-function フォームを描く(pid, eid, { 値 = {}, 文言 = [], 成功 = null } = {}) {
+function フォームを描く(pid, eid, { 値 = {}, 文言 = [], 成功 = null, 注 = "" } = {}) {
 …
+    ${注}
     <form method=post class=el>
 …
-      if (req.method === "GET") { const h = フォームを描く(pid, eid); …
+      if (req.method === "GET") {
+        /** クエリの fld… は既定値。addForeignRow が親の行を渡す */
+        const 値 = {}; for (const [k, v] of u.searchParams) if (/^fld[A-Za-z0-9]+$/.test(k) && 項目.has(k)) 値[k] = v;
+        const h = フォームを描く(pid, eid, { 値 }); …
```
POST 側は、関連項目の既定値を hidden で持ち回り `[{foreignRowId}]` に直す処理が要る。拡張の `子の値を整える` がその形。

## 3. `ボタンの色` に primary / secondary を足す

Airtable の colorTheme の実測（319 個）: gray 139・secondary 63・primary 38・red 36・green 27・blue 16。
`ボタンの色[sp.色] ?? ボタンの色.gray` なので primary（主ボタン）が灰色に落ちる。
```diff
 export const ボタンの色 = {
   blue: ["#2d7ff9", "#fff"], …
+  primary: ["#2d7ff9", "#fff"], secondary: ["#eee", "#1d1f25"],
 };
```
拡張側は `色を引く()` で寄せているので、入れなくても動く。

## 4. `実行`（db/query.mjs の 作る）は起動時の断面を持つ

`作る(db)` は行を起動時に全部読み込み、以後 DB を見ない。ミミックで作った・消した行が一覧（levels/grid）に出ない／消えない。
ボタン層は `書き込み.計算器`（毎回 DB を読む）だけを使っているので影響は無いが、deleteRow で消した行が
同じ画面の一覧に残る。`書き込み.作る/更新/消す` の後に `実行` の行を差し替える口（または 1 行だけ読み直す口）があるとよい。

## 5. deleteRow の確認は isConfirmationModalEnabled を見ない

生レイアウトでは deleteRow 7 個のうち 6 個が confirmationModalTitle/Message/ButtonLabel を持つが、
`isConfirmationModalEnabled` は付いていない（triggerWorkflow/updateRow/navigateToStaticUrl では付く）。
14-layout の既存の `e.確認` は `isConfirmationModalEnabled` を条件にしているので deleteRow の文言が落ちる。
既存の鍵は変えず、`e.動作の詳細.確認 = {題,本文,進むボタン,有効:null}` に文言だけ残した。
serve.mjs の既定の描き手（`sp.確認`）で deleteRow の確認文を出したいなら、`sp.確認 ?? sp.動作の詳細?.確認` にする。
