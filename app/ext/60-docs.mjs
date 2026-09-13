/**
 * **帳票の読み込み口。** `app/doc-*.mjs` が export する `帳票` を集めて、/docs と /doc/:種/:鍵 を出す。
 * serve.mjs の /docs（発注書だけ）より先に当たる。発注書は今までどおり 文脈.帳票を出す に回す。
 *
 * 各 doc-*.mjs の契約:
 *   export const 帳票 = [{
 *     鍵, 名, 紙, 実物(件数), 生成元(現行の作り方),
 *     一覧(db, 文脈) => [{ 鍵の値, 表示, 補足 }]     出せる対象（多いときは新しい順に 300 まで）
 *     組む(db, 鍵の値, 文脈) => html | null            紙1枚ぶんのHTML。印刷 → PDF
 *   }]
 *
 * 注意: 文脈.計算器.値(行, fid) の既定は「式から見た形」（関連は表示名の配列・選択肢は名前）。
 * 帳票のように関連先の行IDが要るときは第3引数 true（生の形）で読む。
 */
import fs from "node:fs";
import path from "node:path";

const 種類 = new Map();   // 鍵 → 定義
export async function 準備(文脈) {
  const dir = path.join(文脈.ROOT, "app");
  for (const f of fs.readdirSync(dir).filter((x) => /^doc-.*\.mjs$/.test(x)).sort()) {
    try { const m = await import(path.join(dir, f)); for (const d of m.帳票 ?? []) 種類.set(d.鍵, { ...d, 元: f }); }
    catch (e) { console.error(`帳票 ${f} を読めません: ${e.message}`); }
  }
  if (種類.size) console.log(`帳票の組み: ${[...種類.keys()].join("・")}`);
}

const 一覧を描く = (文脈) => {
  const { E, 骨, db } = 文脈;
  let 中 = `<h1>帳票</h1><div class=sub>現行で出している紙。ローカルの行から同じ形に組む。ブラウザの印刷で PDF にする</div>`;
  for (const k of 文脈.帳票の種類) {
    const d = 種類.get(k.鍵);
    /** doc-*.mjs は実物を読んだ上で 実物・紙・生成元 を書いているので、あればそちらを優先する */
    const m = { ...k, ...(d ? Object.fromEntries(Object.entries(d).filter(([kk, v]) => ["名", "実物", "紙", "生成元"].includes(kk) && v != null)) : {}) };
    中 += `<div class=el><div class=elh>${E(m.名)} <span class=tag>現行の実物 ${m.実物}件</span> <span class=tag>${E(m.紙)}</span> <span class=tag>${E(m.生成元)}</span>${d ? "" : k.鍵 === "発注書" ? ` <a href="/docs/native">発注書へ</a>` : ` <span class=tag style="background:#fde8e8;color:#a00">未着手</span>`}</div>`;
    if (d) { let 行 = []; try { 行 = d.一覧(db, 文脈) ?? []; } catch (e) { 中 += `<div class=warn>${E(e.message)}</div>`; }
      中 += `<div style="padding:6px 12px">` + 行.slice(0, 300).map((r) => `<div><a href="/doc/${encodeURIComponent(k.鍵)}/${encodeURIComponent(r.鍵の値)}">${E(r.表示)}</a>${r.補足 ? ` <span class=tag>${E(r.補足)}</span>` : ""}</div>`).join("") + (行.length > 300 ? `<div class=note>…ほか ${行.length - 300} 件</div>` : "") + `</div>`; }
    中 += `</div>`;
  }
  for (const [k, d] of 種類) if (!文脈.帳票の種類.some((x) => x.鍵 === k)) {
    let 行 = []; try { 行 = d.一覧(db, 文脈) ?? []; } catch {}
    中 += `<div class=el><div class=elh>${E(d.名)} <span class=tag>${E(d.紙 ?? "")}</span></div><div style="padding:6px 12px">` + 行.slice(0, 300).map((r) => `<div><a href="/doc/${encodeURIComponent(k)}/${encodeURIComponent(r.鍵の値)}">${E(r.表示)}</a></div>`).join("") + `</div></div>`;
  }
  return 骨("帳票", 中, null);
};

export const 経路 = [
  { method: "GET", pattern: /^\/docs$/, handler: (req, res, u, m, 文脈) => 文脈.出す(res, 一覧を描く(文脈)) },
  { method: "GET", pattern: /^\/docs\/native$/, handler: (req, res, u, m, 文脈) => 文脈.出す(res, 文脈.索引を描く()) },
  { method: "GET", pattern: /^\/doc\/([^/]+)\/(.+)$/, handler: (req, res, u, m, 文脈) => {
      const 種 = decodeURIComponent(m[1]), 鍵 = decodeURIComponent(m[2]);
      const d = 種類.get(種);
      /** 帳票は 1 件ずつ見るものなので、落ちたらどの帳票のどの鍵かを本文に出す */
      let h;
      try { h = d ? d.組む(文脈.db, 鍵, 文脈) : 文脈.帳票を出す(種, 鍵); }
      catch (e) { return 文脈.出す(res, 文脈.骨("帳票エラー", `<h1>${文脈.E(種)} ${文脈.E(鍵)} を組めません</h1><pre>${文脈.E(e.stack ?? e.message)}</pre>`, null), 500); }
      return 文脈.出す(res, h ?? 文脈.骨("404", "<h1>その帳票はありません</h1>", null), h ? 200 : 404);
    } },
];
