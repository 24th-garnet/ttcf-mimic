# PATCHES-detail — 工程「レコード詳細と入口の構造」から serve.mjs への提案と、生レイアウトから読んだ鍵

この工程は `app/ext/30-detail.mjs` だけで完結させた（serve.mjs は触っていない）。
差し込み口「画面」で type='row'（recordContainer 53）と type='entry'（queryContainer / rowSelector / inbox / filter / section を持つ画面）を
引き受け、null を返した画面は今までどおり描かれる。dashboard 型は引き受けない（40-dash の担当）。
ここには **serve.mjs を直すならこう** という提案（差分と理由）と、**DB の spec に無くて生レイアウトから読んだ鍵** を残す。

## 1. serve.mjs への提案（差分と理由）

### 1-1. `ボタンを描く(要素, pid)` に URL を渡す　— **適用済み（2026-09-12 時点の serve.mjs は第 3 引数 u を受け、拡張.ボタン に `{ 門, 条件, 色, u }` を渡す）**

30-detail はこれに合わせ、`ボタン群を描く` で ?row= を補った URL（rowSelector で選んだ行・row 画面の根の行）を渡す。

```diff
-function ボタンを描く(要素, pid) {
+function ボタンを描く(要素, pid, u = new URL("http://x/")) {
   ...
-    if (!d && 拡張.ボタン.has(sp.動作)) { const h = 拡張.ボタン.get(sp.動作)(e, sp, pid, { 門, 条件, 色: [bg, fg] }, 文脈); ... }
+    if (!d && 拡張.ボタン.has(sp.動作)) { const h = 拡張.ボタン.get(sp.動作)(e, sp, pid, { 門, 条件, 色: [bg, fg], u }, 文脈); ... }
```

理由: 行の文脈（?row= / ?sel_<peo>=）はボタンの描き手に要る。10-buttons は 拡張.画面 の先頭で URL を控える回避策
（`今のURL`）を取っているが、`/detail-stats` や `/csv` のように 画面を描く を通らない経路では URL が古いまま。
30-detail は `文脈.ボタンを描く(要素, pid)` を呼ぶしかないので、この差分があれば回避策が要らなくなる。

### 1-2. `一覧を描く` / `一覧の行` に「行集合」と「追加の絞り込み」の入口を作る

```diff
-function 一覧の行(e, spec, pid, 操作) {
+function 一覧の行(e, spec, pid, 操作, { 行集合 = null, 追加 = [] } = {}) {
   ...
-  const r = 実行({ source: { type: "table", tableId: 表ID }, sorts: 並び, filters: 利用者の絞り込み(操作, 元の絞り込み) });
+  const r = 実行({ source: { type: "table", tableId: 表ID }, sorts: 並び, filters: 利用者の絞り込み(操作, 束ねる(元の絞り込み, ...追加)) });
+  const 行 = 行集合 ? r.行.filter((x) => 行集合.has(x)) : r.行;
```

理由: row 画面の子の一覧（器の source が foreignKey。45 器）と rowSelector 配下の一覧（26 本）は「親の行の関連先だけ」を出す。
今の 一覧を描く には行集合を絞る入口が無いので、30-detail は同じ表示形（操作の棒・見出し・頁送り）を約 60 行ぶん自前で持っている。
入口があれば二重の実装が消える。

### 1-3. `器を探す(pid, 表ID)` は出力IDで結ぶ

```diff
-  const 合う = 器.find((x) => (x.sp.元?.tableId ?? x.sp.元?.表ID) === 表ID);
+  const 出力 = spec.段のクエリ?.["1"]?.source?.query?.outputId;
+  const 合う = 器.find((x) => (x.sp.出力 ?? []).some((o) => String(o).replace(/^[A-Za-z]+=/, "") === 出力))
+    ?? 器.find((x) => (x.sp.元?.tableId ?? x.sp.元?.表ID) === 表ID);
```

理由: 一覧の `段のクエリ.1.source.query.outputId` と器の `出力 "query=peo…"` が対応している（177 本のうち 156 が DB だけで結べる。
残りは生の `outputs.query.id` で結べる）。表の一致で結ぶと、同じ表の器が複数ある 13 画面で取り違える。

### 1-4. 固定の絞り込み（staticFilters）は一覧に掛かっている

`一覧の行` は `leafLevel.filters` しか見ないが、現行では器の `staticFilters` が一覧に掛かっている
（売掛一覧 pagCuLzzkAl9xnIQx: 売上登録 = ✓ かつ 請求締日 が空）。1-2 の「追加」に器の `固定の絞り込み` と帯（presetFilters）の値を入れるのがよい。

### 1-5. 含意（row.implied）だけの列を絞り込みに使うとき

`db/query.mjs` の 値() は cells → calc しか読まないので、**要求されていない列の節は「判定できない」で行を落とす**。
固定の絞り込み 465 節を数えると、

| 種 | 節 | 例 |
|---|---:|---|
| エンジンで引ける（cells / calc に値がある） | 178 | 入庫.倉庫 isNotEmpty、売掛台帳.当月売掛金額 > 0 |
| 含意でしか分からない（値は無いが row.implied にある） | 147 | 売上登録 = ✓（31 器）、入庫登録 = 空/✓（39 器）、振替登録 = ✓（15 器） |
| 手元に値も含意も無い | 140 | 無名の lookup / formula（入庫 Field lookup = 空 16 器 …） |

30-detail は節を 3 つに分け、含意の節は `計算器.通る`（cells → calc → snap → implied を読む）で当て直し、無い節は外して画面に書く。
serve.mjs 側で直すなら、`db/query.mjs` の 値() に 4 層目として implied を読ませるのが筋だが、query.mjs は 339/344 の検証を通した
エンジンなのでこの工程では触らず、拡張の側で分けた。**query.mjs を直すときは 05-query-test を回し直すこと。**

### 1-6. `欄を描く(要素, 画面, pid, u)` に見出しを渡せるように

```diff
-function 欄を描く(要素, 画面, pid = 画面.id, u = new URL("http://x/")) {
+function 欄を描く(要素, 画面, pid = 画面.id, u = new URL("http://x/"), { 見出し = null } = {}) {
```

理由: row 画面では節（section）ごとに 1 回 欄を描く を呼ぶ。箱の見出しを「入力欄」ではなく節の名（受注情報 …）にできると、現行と同じ見え方になる。
今は節の見出しを 30-detail 側で出し、その下に「入力欄 N個」の箱が来る。

## 2. 生レイアウト（crawl/out/raw/pages-20260911/<pag>.msgpack → publishedLayout）から読んだ鍵

DB の `elem.spec` に写っていないか、写り方が不十分で、この拡張が生から補った鍵。全部ネットワーク不要。

### 2-1. 置き場（並びと面の連鎖）

| 節 | 鍵 | 使い方 |
|---|---|---|
| `rootCanvasAreaId` | | entry 画面の根の面 |
| `rootRowContainer` | `tableId` / `output.id` | row 画面の「この行」の出力（peo…）。cellEditor の `行の出どころ` と一致 |
| `canvasAreaById[pla]` | `canvasId` | 面 → その面が持つ 1 つの canvas（横棒 plh / 行の面 plo / 全面要素 plf） |
| `horizontalBarById[plh]` | `canvasAreaId` / `position` | 横棒 → 下の面。position は top |
| `horizontalBarRowById[pli]` | `parentId` / `index` / `alignment` | 横棒の行（left / right） |
| `horizontalBarElementById[plj]` | `parentId` / `index` / `elementId` | 横棒の中の要素 |
| `rowCanvasById[plo]` | | 行の面 |
| `columnsRowById[plr]` | `parentId` / `index` / `alignment` / `fillWidth` / `style` | 行（lightGrayBackground など） |
| `columnById[plc]` | `parentId` / `index` | 列 |
| `elementRowById[ple]` | `parentId` / `index` / `elementId` / `widthUnits` / `fillWidth` / `alignment` / `height` | 段。widthUnits は列の幅（4 が多い） |
| `fullCanvasElementById[plf]` | `elementId` | 面いっぱいの要素（inbox・器） |
| `slotElementsById[pls]` | `parentId` / `elementId` / `index` / `slotType` | recordContainer / section / sectionGridRow の受け口。slotType は `title` / `section` / `callToAction` / `sectionGridRows` / `sectionGridRowChildren` |

`index` は fractional index（"Zz" < "a0" < "a0V" < "a1"）。文字列比較で並ぶ。DB の elem には順序の列が無いので、path 上の節の index を並べた鍵で兄弟を並べる。

**面の連鎖**: 面 → canvas → (横棒なら `canvasAreaId` の面 / 全面要素なら要素の `canvasAreaId`（inbox）や `viewCanvasAreas[].canvasAreaId`（器）の面) → …。
inbox の右側に置かれた要素はこの連鎖の先にある（実測 2 画面とも root 面 → 横棒 → 面 → 全面(inbox) → 面 → 行の面）。
クローラの path は横棒と面の節を繰り返して写している（40 段）だけで、この連鎖は読めない。

### 2-2. 要素（elementById[pel]）

| 型 | 鍵 | DB の spec との関係 |
|---|---|---|
| filter | `tableId`, `filters.filterSet[{columnId, operator, value, type}]`, `outputs.interactiveFilters.id`, `label.isEnabled` | **spec は null（19 本すべて）**。列と比べ方（contains 14 / = 9 / \| 3）はここにしか無い。value は全部 null（利用者が入れる） |
| rowSelector | `query.source.tableId`, `query.filters`, `query.sorts`, `query.interactiveFilters.outputId`, `outputs.selectedRow.id`, `embeddedFormButton{type, layoutType, pageId, isEnabled}`, `upleveledFilterOption` | spec には 母集団（文）・出力・埋め込みフォームのボタン。**母集団の条件そのもの（filters）は生にしか無い** |
| inbox | `query.source.tableId`, `query.interactiveFilters.outputId`, `query.sorts`, `canvasAreaId`, `outputs.selectedRow.id`, `visibleColumnIds`, `label.value` | spec の 見せる列・並び は 1 画面で null。canvasAreaId（右側の面）は生にしか無い |
| queryContainer | `source{type: table \| foreignKey, tableId, foreignColumnId, foreignRow{tableId, outputId}}`, `staticFilters`, `presetFilters`, `viewCanvasAreas[{canvasAreaId}]`, `outputs.query.id`, `endUserControls{isFilterEnabled, isSortEnabled, isSearchEnabled, isGroupLevelsEnabled}`, `isPdfExportEnabled`, `label{isEnabled, value}`, `activeFilterType`, `savedFilterSets`, `allRowsLabel` | spec に 利用者が操れるもの・絞り込み帯の列・固定の絞り込み・CSV/PDF・出力 はある。**source（表の全行か、どの行の関連先か）は無い** |
| levels / grid | `queryByLevel["1"]{source, sorts, interactiveFilters}`, `levelsConfig.leafLevel{allOrderedDisplayColumnIds, filters, sorts, widthsByColumnId}`, `label`, `editability`, `isReadOnly`, `leafTableId` | spec に 段のクエリ・段の設定・見せる列・列幅 はある。帯との結び付き（interactiveFilters.outputId）は生で補う |
| section | `title`, `shouldDisplayTitle`, `shouldDisplayDescription`, `visibilityFilters`, `style.backgroundColor`, `visualVariant` | spec は null。label と visible_when（継承つき）は DB にある。shouldDisplayTitle=false の節は現行では見出しを出さない |
| cellEditor | `source.row.outputId`, `source.columnId`, `isReadOnly`, `visualVariant` | spec に 表ID・項目ID・行の出どころ がある |
| recordContainer | （鍵なし。中身は slotElementsById の parentId で辿る） | |

### 2-3. 結び付き

- 一覧 ↔ 器: 一覧の `queryByLevel.1.source.query.outputId` ＝ 器の `outputs.query.id`（177 本すべて結べた。DB だけでは 156）
- 帯 ↔ 一覧 / inbox / rowSelector: 帯の `outputs.interactiveFilters.id` ＝ 相手の `query.interactiveFilters.outputId`（19 本すべて結べた）
- 器（foreignKey）↔ 行: 器の `source.foreignRow.outputId` ＝ rootRowContainer の出力（row 画面）か rowSelector の `outputs.selectedRow.id`（entry 画面）
- 欄 ↔ 行: cellEditor の `source.row.outputId` ＝ 同上、または inbox の `outputs.selectedRow.id`、formContainer の出力

## 3. 実測（この工程で確かめた数）

- 引き受ける画面 319（row 53 のうち recordContainer を持つ 53、entry 266）。`/detail-stats?rows=1` で全部描いて落ちた 0・その他 0（2026-09-12 再計測、冷えた状態で 55 秒）
  - 描いた要素: cellEditor 1,088・sectionGridRow 609・button 332・queryContainer 259・levels 241・section 135・grid 130・recordContainer 44・rowSelector 30・text 23・filter 19・formContainer 5・attachmentCarousel 3・inbox 2・horizontalDivider 1
  - recordContainer が 44 で止まるのは、row 画面 9 つ（Record Detail × 7・出荷依頼 Detail・地域コード Detail）の表に手元の行が 0 件で、行選びの画面になるため
  - text / attachmentCarousel / horizontalDivider は 40-dash の描き手（文脈.拡張.要素）を呼んだ数。二重には描いていない（40-dash の 画面 は dashboard 型だけを引き受け、30-detail は dashboard 型を引き受けない）
- rowSelector の母集団（生の query.filters）: 売上 15 画面（売上登録 = 空 ∧ 種類番号 = 4/6 ∧ 返品旗 = 空 [∧ 受注登録 = 空]）、商品 5 画面（無名 foreignKey isNotEmpty → 手元に無く外す）、振替伝票 10 画面（振替登録 = 空 ∧ 区分 isAnyOf → 区分は手元に無く外す）
- 売上登録・返品旗・振替登録・入庫登録 は**どの画面も要求していない**（requested 0〜6 行）が、含意は 19,586 / 19,591 / 1,128 / 8,385 行にある
- 海外売上入力 pagsprVmSpVDwlE4o の母集団は 3 行（4-020601・4-020605・4-020620。いずれも src にこの画面がある＝クロール時にこの画面に出ていた行）
- 売掛一覧は 19,584 行（クロール時 18,981）。差の 603 行は 請求締日 が手元に無い行（含意は画面に出ていた行にしか無い）。**現行より多く出る側に振れる**
- 在庫登録済 2,192 行（製品生産.在庫登録 = true の含意 2,192 行と一致）
- 計算器で 19,611 行を当て直すと約 1.1 秒（取る が 0.8 秒）。行集合は (表, 絞り込み, 並び, write_log 件数) で覚える。`/detail-stats` は冷えた状態で 35 秒、温まると 8 秒

## 4. 直したこと（前回の実装者の残り）

- 文脈を組む の出力登録で `for (...) if (o) …; else if (inbox)` の else if が for の中の if に結び付いており、inbox / formContainer / queryContainer の出力が登録されていなかった（受信箱で行を選んでも右が出ない）
- inbox の右側の要素を「消費」にしていたため 面を描く が飛ばしていた → 「予約」に変え、inbox が描く
- 節（section）の欄を sectionGridRow ごとに描いていた → 節の cellEditor たちを 1 回の 文脈.欄を描く に渡す
- callToAction のボタンが末尾にも二重に出ていた → 詳細を描く で消費に入れる
- horizontalDivider は 40-dash の描き手を先に見る

## 5. 今回（再開後）に直したこと

- **受信箱の右側の欄を 1 枚に束ねた。** 原価計算 pagxncMVIH0jmZAfp の右側は 5 行 × 3 列に 1 欄ずつ置かれていて（生の columnsRowById 5・columnById 13・elementRowById 13）、列ごとに描くと「入力欄 1 個」の箱が 14 個並んだ。
  `面を描く` で **欄（cellEditor）だけで出来た行が続くときは列に分けず 1 つの欄の箱へ束ねる**（欄以外を含む行はそのまま列に並べる）。今は横棒の 製品ID 1 個＋面の 13 個の 2 箱
- ボタンに URL を渡す（1-1 が適用済みになったため）。`/detail-stats` や `/sel` からの描画でも行の文脈が古くならない
- 行を選ぶ画面の「この画面へ来る道」に束（bundle）の名を添えた。運用-編集 pagZG8nDi84WGdQyC へ来る道は 海外売上入力 × 5 束・国内売上入力 × 5 束・受注管理有り × 5 束の 15 画面で、名前だけでは見分けられなかった
- 前回の実装者が port 8803 に残したサーバ（5 時間半前の起動）が EADDRINUSE を起こしていた。PID を確かめて止め、起こし直した

## 6. 確かめた操作（PORT=8803、node の fetch。全部 200）

| 画面 | 何を確かめたか |
|---|---|
| 運用-受注登録 pagKmkHTOKIYeFwZZ?row=recJxuYJOlvRqYXdp | recordContainer → callToAction ボタン（売上伝票変換）→ section 3 の順。節「受注情報」の欄 8 個が 1 箱。子の器（出庫）は行 6-020470 の関連先 6 件だけ |
| 運用-編集 pagZG8nDi84WGdQyC?row=… | section 4、書ける欄 6（20-cells の入力欄が差し込まれた）。見せる条件に合わない欄は畳む |
| 在庫登録時詳細 pagiYml9Lv6T99xPY / Record Detail paguY5K9UfJuTEWbF / pagr6d3X1ggFIZBFg | 同上。pagr6d3X… は器（入庫。固定の絞り込み 入庫登録 ＝ 空）が関連先 4 件を出す |
| 運用-編集 pagZG8nDi84WGdQyC（?row= 無し） | 行選びの画面。この画面で実際に開けた行 25 を先頭に、来る道 15 画面を束の名つきで |
| 海外売上入力 pagsprVmSpVDwlE4o | rowSelector の母集団 3 行（含意で判定）。/sel → 303 → ?sel_peo…=rec…&row=rec… に写り、欄 13 個に値・書ける 3、出荷一覧は関連先 1 件、CSV も同じ 1 件 |
| 売掛一覧 pagCuLzzkAl9xnIQx / 在庫登録済 pagvlNwZWxorNjmJw | queryContainer の中に levels（/ grid）。固定の絞り込みが掛かる |
| 原価計算 pagxncMVIH0jmZAfp（inbox） | 左 110 行、行を選ぶと右に欄 14 個の値 |
| 月間原価計算 review pagdfj2xPbEG3JRFZ（inbox + filter 2 列） | 帯「月 ＝」を選択肢で当てると inbox の行が絞られる |
| 在庫登録済 pagfTLZlaXjBh7OxY（filter） | 帯「製品名 を含む」に 白粒 を入れると 2,192 → 98 行 |

## 反映の記録（2026-09-13）

1-1（ボタンに URL）・1-2/1-4（一覧の行 に 行集合・追加、器の固定の絞り込み）・1-5（query.mjs の 値() に含意の層と、関連項目を link 表の辺から起こす層）・1-6（欄を描く の 見出し）は **serve.mjs / query.mjs に反映済み**。
検証（2026-09-13）で直したもの: 行を開くと の鍵なしの形（78 本）、関連項目の節をエンジンに任せる（辺があれば引ける）、rowSelector で節を外したときはクロール時にその画面に出ていた行を優先、帯の日付「=」を日付部分の一致に、checkbox は常に計算器で判定。
