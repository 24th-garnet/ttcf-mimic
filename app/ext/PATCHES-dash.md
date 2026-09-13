# PATCHES-dash — 工程「集計要素」（app/ext/40-dash.mjs）から

serve.mjs は触っていない。差し込み口（要素・画面・経路・準備）で足りた。ここには
(1) 生レイアウトから読んだ鍵、(2) serve.mjs に手を入れるならこうする、という提案（差分と理由）、
(3) 手元のデータの欠けで描けなかったものの根拠、(4) 検算の記録 を残す。

## 1. 生レイアウトから読んだ鍵（elem.spec に写っていないもの）

生レイアウトは `crawl/out/raw/pages-20260911/<pag>.msgpack` を `crawl/lib/airmsg.mjs` の `decodeAirFile(path)` で読み、
`.top.data.pages[].publishedLayout` を見る。1 ファイルに複数の画面が入っているので、開いたら全部覚える（40-dash.mjs の 生の配置）。

| 要素の型 | 鍵 | 何か | 実測 |
|---|---|---|---|
| text | `document` | Quill の差分形式 `[{insert, attributes}]`。改行の insert に付く `attributes.header` が見出し（3 = h3）、それ以外の attributes が文字の飾り（bold/italic/underline/strike/link/code） | 24 要素すべて document のみ。見出し h3 が 4 本（在庫一覧・製造予定・出荷予定・要確認）、link は 0。受注管理v1 の 4 本（単位：CS / 在庫一覧 / 製造予定 / 出荷予定）は同じ要素IDで 5 画面に複製 |
| dashboard | `query.source{type:"query", query:{outputId}}` / `outputs.query.id` / `drillDownVisibleColumnIds` / `editability` | 母集団は他要素の出力を指す。自分も出力を持ち、子（bigNumber/chart/pivot/levels）がそれを指す | 5 画面すべて queryContainer → dashboard → 子 の 3 段 |
| queryContainer | `source{type:"table", tableId}` / `staticFilters` / `outputs.query.id` / `presetFilters` / `savedFilterSets` / `activeFilterType` / `viewCanvasAreas[{canvasAreaId}]` / `label.value` / `isPdfExportEnabled` | 鎖の根。`viewCanvasAreas` が「帯が見ている面」＝ dashboard の面 | 運賃・倉庫比較の staticFilters: 種類番号 isAnyOf [sel(4), sel(6)] → 779 行中 538 行 |
| pivotTable | `query`（spec に無い）/ `rowDimensions` / `columnDimensions` / `summaries[{columnId, summaryFunction}]` / `isPdfExportEnabled` / `label.value` | 軸は `{columnId, sort{order,type:"group"}, shouldShowLabel, shouldShowTotalValues}` | 3 本とも 1 段 × 1 段・sum・合計行列あり |
| bigNumber | `columnId` / `summary{type:"columnSummary", summaryFunctionKey}` / `descriptionText` / `descriptionSubText` / `colorTheme` / `isBackgroundColorEnabled` / `isDrillDownEnabled` / `drillDownVisibleColumnIds` | 14 本すべて sum。colorTheme は solidRed / solidYellow / solidCyan / solidPink の 4 種 | ネット粗利益 だけ descriptionSubText あり |
| chart | `definition{type, xAxisColumnId, yAxis, yAxisSeriesPrimary[], yAxisSecondary{type:"line", aggregation, color, shouldNotStartAtZero}, sliceColumnId, sliceArcLength, colorScheme{primaryColorIndex}, labelAppearance.shouldShowPercentageOnChart, yAxisLabel}` / `title` / `shouldAlwaysPlotDotsOnLines` / `query.filters` | bar 5（うち 1 本は右軸の折れ線つき）・pie 6。集計は全部 sum | 運賃 chart の `query.filters` は `Field contains null`（値なし＝効かない）。エンジンに渡すと「判定できない」で 0 行になるので 未設定を落とす で外す |
| attachmentCarousel | `source.row{type:"row", tableId, outputId}` / `source.columnId` / `isReadOnly` / `numAttachmentsPerCarouselPage` | 行の出どころ（peo…）と添付の列 | 3 本とも 製造/製品生産.製造指示書・1 面 1 枚・読み取り専用 |
| rowActivityFeed | `sourceRow{type:"row", tableId, outputId}` / `areCommentsDisabled` / `label.isEnabled` | 1 本（予実/地域コード Detail）。コメント有効 | |
| horizontalDivider | （鍵なし） | | 2 本 |
| slotElementsById | `{parentId, elementId, index, slotType}` | 親子と並び。`index` は分数索引の文字列（"Zz" < "ZzV" < "a0" < "a1"、文字列比較でよい）。slotType: `numbersSection` / `chartsSection` / `visualizationsSection`（dashboard の子 section）、`sectionGridRows`、`sectionGridRowChildren`、`children`（verticalStack）、`queryContainerCallToAction`（帯に載ったボタン） | 商品別の bigNumber 3 個は Zz(販売金額)・ZzV(原価)・Zzl(粗利益) で左→右と一致 |
| canvasAreaById / fullCanvasElementById / rootCanvasAreaId | 面。`面.canvasId → 全面.elementId → 要素` | dashboard 型は 2 面: 根の面 = verticalStack（帯）、帯の viewCanvasAreas が指す面 = dashboard | 5 画面すべて。区画は numbersSection@a0 → chartsSection@a1 → visualizationsSection@a2（数字が無い画面は a0 が無い） |

## 2. serve.mjs への提案（差分と理由）— いまは不要。記録として

### 2.1 dashboard 型の画面の要素の順

`画面を描く` は 一覧 → 入力欄 → フォーム → ボタン → 拡張の要素（`ORDER BY depth, type`）の順で描く。dashboard 型では現行の並び
（帯 → 数字 → 図 → 一覧）と逆になり、一覧が集計の上に来る。**この工程では `拡張.画面` で dashboard 型 5 画面を面の順に描いて回避した**
（30-detail は `layout_kind === "dashboard"` を引き受けないので競合しない）。serve.mjs を直すなら:

```diff
-  for (const e of [...種("levels"), ...種("grid")]) 中 += 一覧を描く(e, e.spec ? JSON.parse(e.spec) : {}, pid, u);
+  /** dashboard 型は拡張（40-dash）が面の順に描く。ここで一覧を先に出すと集計の上に来て現行と逆になる */
+  if (p.layout_kind !== "dashboard") for (const e of [...種("levels"), ...種("grid")]) 中 += 一覧を描く(e, e.spec ? JSON.parse(e.spec) : {}, pid, u);
```

### 2.2 `一覧の行` に「追加の絞り込み」の口

`一覧の行` は `spec.段の設定.leafLevel.filters` しか見ない。dashboard の鎖（queryContainer.staticFilters）は、実測 5 画面では
levels 自身の filters と同じ節（運賃・倉庫比較: 種類番号 isAnyOf 4・6 が両方にある）なので結果は一致するが、一般には器の固定の絞り込みを
and で足す口が要る（30-detail も同じ理由で関連先の一覧を自前に描いている）。

```diff
-function 一覧の行(e, spec, pid, 操作) {
+function 一覧の行(e, spec, pid, 操作, 追加の絞り込み = null) {
   ...
-  const r = 実行({ source: { type: "table", tableId: 表ID }, sorts: 並び, filters: 利用者の絞り込み(操作, 元の絞り込み) });
+  const 固定 = 追加の絞り込み?.filterSet?.length ? (元の絞り込み ? { conjunction: "and", filterSet: [元の絞り込み, 追加の絞り込み] } : 追加の絞り込み) : 元の絞り込み;
+  const r = 実行({ source: { type: "table", tableId: 表ID }, sorts: 並び, filters: 利用者の絞り込み(操作, 固定) });
-function 一覧を描く(e, spec, pid, u) {
+function 一覧を描く(e, spec, pid, u, 追加の絞り込み = null) {
   const 操作 = 操作を読む(u, e.id);
-  const { ... } = 一覧の行(e, spec, pid, 操作);
+  const { ... } = 一覧の行(e, spec, pid, 操作, 追加の絞り込み);
```
`一覧のCSV` も同じ口を通す（描画と CSV は同じ道、という約束を守るため）。

### 2.3 入れ子の `.el` の余白

40-dash は dashboard の中に `.el`（chart・pivot・一覧）を入れ子にする。30-detail が `様式` で足している
`.el .el{margin-bottom:10px}` を `骨` の CSS に入れると、拡張ごとに足さなくてよい。

```diff
 .el{background:#fff;border:1px solid #e5e5e7;border-radius:6px;margin:0 0 14px;overflow:hidden}
+.el .el{margin-bottom:10px}
```

### 2.4 文脈に `計算器` を直接

`文脈.書き込み.計算器` で届くので動くが、読み取りだけの描き手が「書き込み」を経由するのは筋が違う。`文脈` に `計算器: 書き込み.計算器` を 1 行足す。

## 3. 手元のデータの欠けで描けなかったもの（正直に出している）

クローラは動かしていない。ここに書くのは「読み取りだけの追加取得で埋まる」ものの根拠。

| 何 | 根拠 | 画面での出し方 |
|---|---|---|
| 予実/Table（年間実績）の軸 分類1/2/3・月(計上日) | requested 0・値あり 0 行（19,989 行）。分類1/2/3 は 種類番号（関連、辺 0・逆側も辺 0、相手の表 tblk4nvc6mRJsX25T は 0 行）を辿る lookup。月(計上日) は関連で辺 0。表は同期表（airtableSharedView、同期元は 販売/売上）だが、同期元の項目 fldoST0FM6IzL8hyM は手元の定義に無く、主項目 Field も未要求なので同期元の行と結べない | pie 6・pivot 3 は 1 群「（空）」に畳み、金額の合計だけ出す。注記に上の理由を出す（復元できない訳） |
| 予実/商品別月間・売掛台帳・分類別・地域コード | 0 行（同期表。同期元は 販売 の表） | bigNumber 14 本は「—・0行」、chart 3 本は「集計する行がありません」 |
| 製造/製品生産.製造指示書（attachmentCarousel 3） | requested 0・2,226 行すべて値なし。`attach` 表 0 行。crawl/out/artifacts（1,057 件）に製品生産の実物 0 | 「添付が無いのではなく取っていない」と出す。添付が来れば `/artifact/<名>` で手元の実物を出す（外部 URL は開かない） |
| rowActivityFeed の Airtable 自身の履歴・コメント | 読み取りの経路に無い | write_log（ミミックで書いた分）だけを時系列で出し、注記する。更新は値の変わった項目だけ出す |
| 絞り込み帯（verticalStack › queryContainer）の値 | 取得時すべて filterObj null | 帯は列だけ描き、制約にしない（db/query.mjs の注と同じ） |

## 4. 検算（PORT=8804・scratchpad/check.mjs、SQL と JSON の直読みで別の道）

- 運賃・倉庫比較 chart「運賃金額」「倉庫」: 母集団 538 行（種類番号∈{4,6}、全 779）。**36 群 × 2 系列 × 2 本 = 144 値がすべて一致**。合計 ¥210,980,416 / ¥188,747,805、¥113,138,390 / ¥110,290,396 も一致
- 年間実績 pie 6・pivot 3: 販売金額 合計 ¥17,469,674,149（19,989 行）が pie 3 本 × 3 箇所 ＋ pivot 3 本 × 4 升 = 24 回、ネット粗利益 ¥1,928,825,821 が 12 回、SQL の SUM と一致
- bigNumber 14: 3 表とも 0 行 → 14 個すべて「—」
- 並び: 帯 → 配置（数字 → 図 → 一覧）の順を 3 画面で確認（年間実績は一覧なし）
- rowActivityFeed: write_log 7 件の行で 7 項目、作成 1・更新 6 の順
- 制御文字: 329 行目の NUL の番兵（`"\0空"`）を Map の null 鍵に置き換え、`LC_ALL=C grep -naP '[\x00-\x08\x0B\x0C\x0E-\x1F\x7F]'` が 0 件、file(1) が JavaScript source と判定

### 4.2 再開後の再計測（09-12・PORT=8804・PID 255779、scratchpad/dash-fetch.mjs → check2b.mjs、scratchpad/dash-unit.mjs）

サーバ経由（13 画面＋行つき 7 画面、全部 200・エラー 0）:

- 運賃・倉庫比較 chart 2 本: 母集団 538 行（種類番号∈{4,6}、全 779）。36 群 × 2 系列 × 2 本 = 144 値と合計 4 値が SQL と一致。SVG の棒の title も同じ値（2024年02月 運賃金額 実績 ¥4,563,827、2026年02月 倉庫代金 予算 ¥4,303,196）
- 年間実績 pie 6・pivot 3: 販売金額 ¥17,469,674,149（19,989 行）が 24 回、ネット粗利益 ¥1,928,825,821 が 12 回。軸 4 列（分類1/2/3・月(計上日)）は requested 0・値あり 0 → 注記 12 箇所
- bigNumber 14: 商品別 3・担当者/顧客別 8・海外営業 分類別 3、3 表とも 0 行 → 14 個すべて「—」
- 並び 帯 → 配置 → 一覧 を 3 画面で確認。text 4（受注管理v1）・text 1＋hr 1（Untitled）・hr 1（原価計算v2）・text 1 × 3（詳細 3 画面、行つき）・attachmentCarousel 3（行つき、「取っていない」の注記）
- /artifact/<名>: 実物 200 application/pdf・無い名 404・`../serve.mjs` 404（basename に潰す）

描き手を直接呼ぶ検算（serve.mjs と同じ部品で最小の文脈を組む。合成の要素は DB に書かない）:

- bigNumber sum / average / count（運賃 表 779 行・鎖なし）: ¥210,980,416 / ¥270,835（SQL 270,834.94）/ 779 が一致
- pivot 月TEXT(36) × 種類番号(11) sum 運賃金額 実績: **396 升すべて一致**、総合計 ¥210,980,416。行と列が交わらない升は空白
- pie（種類番号・sum 運賃金額 実績・鎖の 538 行）: 4 = ¥159,695,840（75.7%）・6 = ¥51,284,576（24.3%）
- rowActivityFeed: 消した行 rec8ODsrpBO9aYQBc の write_log 7 件が 作成・更新×5・削除 の順で出る。行なしは案内
- text 24 本すべて生レイアウトの document から本文が出る（h3 見出し 16 本）

**注意（open issue）**: rowActivityFeed の唯一の画面 予実/地域コード Detail は表が 0 行（同期表）なので、サーバ経由では 30-detail が
「行 … は手元にありません」で止まり、描き手まで届かない。描き手は上の直接呼び出しで確認した。行が来れば（読み取りだけの追加取得）そのまま出る。

## 反映の記録（2026-09-13）

§2.1（dashboard 型で一覧を先に描かない）・§2.3（.el .el の余白）・§2.4（文脈.計算器）は **serve.mjs に反映済み**。§2.2 は 一覧の行 の `{ 追加 }` の入口で解決。
§3 の「3 表は 0 行」は失効: 09-12 に csv/sync で 商品別月間 2,552・売掛台帳 4,704・分類別 68 行が入った。売掛台帳の集計 8 列は要求 0 で値が無い（「取っていない」）。
検証（2026-09-13）で直したもの: 取っていない列の合計を ¥0 と描かない（—＋注記）、群名「（未取得）」と「（空）」の区別、全部 0 の目盛り、既定の経路でも一覧・ボタンをその場に描く、/artifact の不正な符号は 404。
図の色の並び（categorical "airtable"）と primaryColorIndex の解釈は**未確認・推定**（生レイアウトに配色表が無い）。
