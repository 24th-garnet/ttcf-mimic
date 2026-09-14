/**
 * 生産指示編集 Form の控え（`crawl/out/raw/bom`）の**読み口**。
 *
 *   import { 一覧, 本文 } from "../db/bom.mjs";
 *   for (const f of 一覧()) { const s = 本文(f); … }
 *
 * ■ なぜこれを挟むか
 *
 * `app/doc-mfg.mjs:273` と `db/actions.mjs:1163` が実行時に 12MB・41 ファイルを読んでいる。
 * これは**生産指示の実データ**（原材料名・ロット・数量）なので、
 * `spec/published-layout.json` と違って**私有リポジトリであっても GitHub には置けない**。
 * 置き先は他の業務データと同じ Supabase にする。
 *
 * ■ 何を移すか
 *
 * **jsonl の本文をそのまま**移す。読み取った後の解釈（`fetchInitialTableIdsToLinkedTableStates`
 * の掘り出し・出庫検索キーの分解）は 1 文字も触らない。
 * 抽出して構造を変えると、そこが移植による漏れの出どころになる。
 *
 * ■ 静かに壊れる形
 *
 * 控えが無いと `控えを読む()` は**空の Map を返して 200 のまま**進み、製造表から
 * 原料名の表が丸ごと消える。2026-09-14 の 2,822 経路の突き合わせで、
 * 実際に `/doc/製造表/…` 300 本中 245 本がこれで不一致になった。
 * だから**読めなかったときは一度だけ警告を出す**。
 */
import fs from "node:fs";
import path from "node:path";

let 預かり = null;      // 名前 → 本文。Supabase から渡されたもの
let 警告した = false;

/** Supabase から読んだ控えを預ける。`db/hydrate.mjs` が起動時に一度だけ呼ぶ。 */
export function 預ける(m) { 預かり = m; }

/** 置き場（常駐版はここを読む） */
const 置き場 = (ROOT) => path.join(ROOT, "crawl", "out", "raw", "bom");

/** 控えのファイル名。並びは常駐版（readdirSync）と揃える。 */
export function 一覧(ROOT) {
  if (預かり) return [...預かり.keys()];
  try { return fs.readdirSync(置き場(ROOT)); } catch { 言う(ROOT); return []; }
}

/** 1 ファイルの本文。無ければ null（常駐版で存在しないときと同じ）。 */
export function 本文(ROOT, 名) {
  if (預かり) return 預かり.get(名) ?? null;
  try { return fs.readFileSync(path.join(置き場(ROOT), 名), "utf8"); } catch { return null; }
}

function 言う(ROOT) {
  if (警告した) return;
  警告した = true;
  console.error(`× 使用原材料の控えを読めません（${置き場(ROOT)} も Supabase も空）`);
  console.error("  製造表の原料名の表が丸ごと落ちます（応答は 200 のままです）。");
}

/** 何ファイル持っているか（診断用）。 */
export const 控えの数 = (ROOT) => 一覧(ROOT).length;
