/**
 * 生レイアウト（Airtable の publishedLayout）を引く。
 *
 *   import { レイアウト } from "../../db/layouts.mjs";
 *   const L = レイアウト(ROOT, pid);      // publishedLayout か null
 *
 * ■ なぜこれを挟むか
 *
 * もとは `crawl/out/raw/pages-20260911/<pid>.msgpack` を実行時に読んでいた（812MB）。
 * Vercel のバンドルは 250MB 上限なので載らない。**読まないと静かに壊れる**：
 * `生の要素()` が null を返して既定の描き方に落ち、応答は 200 のまま中身だけが違う。
 * 実際 Vercel の第1回では売上一覧が 27 バイト違い、
 * `表の全行` が `（元は生レイアウトに無い）` になっていた。
 *
 * だが**実行時に読むのは publishedLayout だけ**で、335 画面ぶん全部で 2.2MB しかない
 * （元の 0.28%）。`tools/extract-layouts.mjs` が 1 つの JSON にまとめる。
 *
 * ■ 先着勝ちの順序依存について
 *
 * 1 つの msgpack に最大 36 画面ぶんが入っており、もとは「先に開いたファイルが勝つ」作りだった。
 * つまり見る順でレイアウトが変わりうる。抽出で固定したが、
 * **同じ画面 ID で中身が食い違う組は 0 件**であることを確かめてある（335/335 取得・衝突 0）。
 * だから固定しても常駐版と一致する。
 *
 * ■ 読めなかったとき
 *
 * 黙って null を返すのは以前と同じだが、**一度だけ警告を出す**。
 * 静かに違う画面を出すより、気づける方がよい。
 */
import fs from "node:fs";
import path from "node:path";

let 頁 = null;
let 警告した = false;

function 読む(ROOT) {
  if (頁) return 頁;
  const p = path.join(ROOT, "spec", "published-layout.json");
  try {
    頁 = JSON.parse(fs.readFileSync(p, "utf8"));
  } catch (e) {
    頁 = {};
    if (!警告した) {
      警告した = true;
      console.error(`× 生レイアウトを読めません（${p}）: ${e.message}`);
      console.error("  詳細画面・集計・その場編集の一部が、元と違う描き方に落ちます。");
      console.error("  tools/extract-layouts.mjs で作ってください。");
    }
  }
  return 頁;
}

/** 画面の publishedLayout。無ければ null（以前と同じ振る舞い）。 */
export function レイアウト(ROOT, pid) {
  return 読む(ROOT)[pid] ?? null;
}

/** 何画面ぶん持っているか（診断用）。 */
export function 画面数(ROOT) {
  return Object.keys(読む(ROOT)).length;
}
