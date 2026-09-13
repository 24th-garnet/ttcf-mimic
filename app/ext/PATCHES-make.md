# 工程「Make と項目型ボタンの置き換え」からの提案（中核は触っていない）

差し込み口で足りたので serve.mjs への差分は無い。中核（db/calc.mjs）に 1 件だけ提案を残す。

## db/calc.mjs — 式の評価に 作成時刻 を渡す

**何が起きるか** `CREATED_TIME()` を使う式（14 本。入庫.在庫明細ID・製品生産.生産ID の一部・締処理履歴.締処理日時・製造 7 表の 登録エラー…）が、
ミミックで作った行では空になる。`一つ計算の中身` が evaluate に渡す ctx は `{ 値, 行ID, tz, 未対応 }` だけで、formula.mjs の
`case "CREATED_TIME": return ctx.作成時刻 ? ctx.作成時刻() : 空;` が常に 空 を返すため。

**どう回避したか** db/actions.mjs の システム登録／製品在庫登録 は 在庫明細ID（`yymmdd-6桁連番`）を、締める は 締処理日時 を、**値として cells に入れている**
（計算器の 値 は cells→calc→snap の順に見るので画面には正しく出る）。式の結果を入力側に置くのは本来の形ではない。

**提案（差分）**

```diff
   function 一つ計算の中身(e, f, fid) {
     const o = f.opts ?? {};
     try {
       if (f.type === "formula" || f.type === "computation") {
         const t = 式の木(fid);
         if (!t) return null;
-        return evaluate(t, { 値: (x) => 値(e, x), 行ID: () => e.id, tz: 時間帯(f), 未対応: [] });
+        /** ミミックで作った行（src='ミミックの入力'）は row.loaded が作成時刻。Airtable の行は createdTime が偽値なので渡さない */
+        return evaluate(t, { 値: (x) => 値(e, x), 行ID: () => e.id, tz: 時間帯(f), 未対応: [],
+          作成時刻: e.作成時刻 ? () => e.作成時刻 : undefined });
```

`取る` で `SELECT …,src,loaded` を読み、`src === "ミミックの入力"` のときだけ `作成時刻 = loaded` を行に持たせる。
Airtable 由来の行には渡さない（メモ「行データの時刻には罠が3つ」: createdTime は偽値）。
これが入れば actions.mjs 側の「値として入れる」3 箇所（在庫明細IDを作る・履歴の 日時）は外せる。

## 30-detail / 20-cells の差し込み口について（serve.mjs ではなく拡張どうしの話）

`拡張.画面` は最初に html を返した拡張で止まり、`拡張.欄` も同じなので、後ろの拡張は先の拡張の出力に何も足せない。
50-fieldbuttons は 準備 で `文脈.拡張.画面` / `文脈.拡張.欄` の中の 30-detail / 20-cells の関数を包んだものに**入れ替えて**いる。
serve.mjs 側で「後ろの拡張に html を渡して加工させる口」（例: `拡張.仕上げ: [(html, p, u) => html]`）があれば入れ替えは要らない。
