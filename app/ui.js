/**
 * **一覧の操作感。** demo リポジトリ（main ＝ mimic）の一覧に寄せる。
 *
 * 画面ごとの作り込みはしない。`.el` の中の `table` に**後から**取り付くので、
 * serve.mjs が描く一覧にも app/ext/*.mjs（詳細画面・集計要素）が描く一覧にも同じように効く。
 *
 * サーバ側（絞り込み・並べ替え・検索・頁送り・CSV）は触らない。**JS を切っても今までどおり URL で動く。**
 * ここでやるのは「ブラウザの中だけで完結すること」だけ:
 *
 *   列幅ドラッグ   demo の components/useColumnResize.ts。掴む帯は th の内側に置く
 *                  （外へはみ出すと隣の th の下に潜って掴めない。demo の globals.css の注意書き）
 *   先頭列の固定   demo の components/useStickyOffsets.ts
 *   行の高さ       demo の components/RowHeightMenu.tsx。短い/中/高い の 3 段
 *
 * 覚えるのは localStorage。鍵は「画面ID|表の位置|列名」なので、別の画面には持ち越さない。
 */
(() => {
  "use strict";
  const 画面 = location.pathname;
  const 蔵 = {
    読む(k, 既定) { try { const v = localStorage.getItem(k); return v == null ? 既定 : JSON.parse(v); } catch { return 既定; } },
    書く(k, v) { try { localStorage.setItem(k, JSON.stringify(v)); } catch { /* 使えない設定でも画面は動く */ } },
  };
  const 最小幅 = 56;

  /** この表の覚え鍵。同じ画面に表が複数あるので、何番目かを混ぜる */
  const 鍵 = (t, i) => `ttcf:col:${画面}:${i}`;

  /** 見出しの文字（掴む帯や並べ替えの印を除いた、列の名前） */
  const 列名 = (th) => (th.querySelector("a") || th).textContent.replace(/[▲▼]/g, "").trim();

  function 列幅をつける(t, i) {
    const ths = [...t.tHead?.rows?.[0]?.cells ?? []];
    if (ths.length < 2) return;
    const 覚え = 蔵.読む(鍵(t, i), {});
    /** 保存済みの幅が無い列は、いまの自動レイアウトの幅を初期値にする（導入前後で見た目が変わらない） */
    const 幅 = ths.map((th) => 覚え[列名(th)] ?? Math.max(最小幅, Math.round(th.getBoundingClientRect().width)));
    const 当てる = () => { t.style.tableLayout = "fixed"; ths.forEach((th, n) => { th.style.width = `${幅[n]}px`; }); };
    当てる();
    ths.forEach((th, n) => {
      if (n === ths.length - 1) return;   // 最後の列は残りを埋める
      const 帯 = document.createElement("span");
      帯.className = "col-resizer";
      帯.title = "ドラッグで列幅を変える。二度押しで自動に戻す";
      th.style.position = "relative";
      th.appendChild(帯);
      let 起点 = 0, 元 = 0;
      const 動く = (ev) => {
        const x = (ev.touches ? ev.touches[0].clientX : ev.clientX) - 起点;
        幅[n] = Math.max(最小幅, Math.round(元 + x));
        th.style.width = `${幅[n]}px`;
      };
      const 終わり = () => {
        document.removeEventListener("mousemove", 動く); document.removeEventListener("mouseup", 終わり);
        document.removeEventListener("touchmove", 動く); document.removeEventListener("touchend", 終わり);
        document.body.style.cursor = "";
        const o = {}; ths.forEach((x, m) => { o[列名(x)] = 幅[m]; });
        蔵.書く(鍵(t, i), o);
      };
      帯.addEventListener("mousedown", (ev) => {
        ev.preventDefault(); ev.stopPropagation();
        起点 = ev.clientX; 元 = 幅[n]; document.body.style.cursor = "col-resize";
        document.addEventListener("mousemove", 動く); document.addEventListener("mouseup", 終わり);
      });
      帯.addEventListener("touchstart", (ev) => {
        起点 = ev.touches[0].clientX; 元 = 幅[n];
        document.addEventListener("touchmove", 動く, { passive: true }); document.addEventListener("touchend", 終わり);
      }, { passive: true });
      /** 二度押しで自動に戻す */
      帯.addEventListener("dblclick", (ev) => {
        ev.preventDefault(); ev.stopPropagation();
        const o = 蔵.読む(鍵(t, i), {}); delete o[列名(th)]; 蔵.書く(鍵(t, i), o);
        t.style.tableLayout = ""; ths.forEach((x) => { x.style.width = ""; });
        requestAnimationFrame(() => { ths.forEach((x, m) => { 幅[m] = Math.max(最小幅, Math.round(x.getBoundingClientRect().width)); }); 当てる(); });
      });
    });
  }

  /** 先頭列を左に貼り付ける。横に長い一覧で行の見出しが残る */
  function 先頭列を固定(t) {
    const 行たち = [...(t.tHead?.rows ?? []), ...(t.tBodies?.[0]?.rows ?? [])];
    if (!行たち.length) return;
    if ([...(t.tBodies?.[0]?.rows ?? [])].some((r) => r.cells.length < 2)) return;   // 群の見出し行などがある表は触らない
    for (const r of 行たち) { const c = r.cells[0]; if (c) c.classList.add("stick1"); }
  }

  /**
   * 行の高さ。demo の RowHeightMenu と同じ 3 段。
   * **既定は画面の設定**（表の data-rowheight。Airtable の small/medium/xlarge を写したもの）で、
   * 利用者が選んだらそれが勝つ（localStorage）。
   */
  const 高さの鍵 = "ttcf:rowheight";
  function 行の高さを当てる(v) {
    if (v) { document.documentElement.dataset.rowheight = v; document.querySelectorAll("table[data-rowheight]").forEach((t) => { t.dataset.rowheight = v; }); }
    else { delete document.documentElement.dataset.rowheight; }   // 画面の既定（表が持っている値）に戻す
  }
  function 行の高さの箱() {
    const 今 = 蔵.読む(高さの鍵, null);
    行の高さを当てる(今);
    const 場 = document.querySelector(".crumb");
    if (!場 || 場.querySelector(".rowheight")) return;
    const d = document.createElement("div");
    d.className = "rowheight";
    d.innerHTML = `<span class=lab>行の高さ</span>` + [["", "画面の既定"], ["短い", "短い"], ["中", "中"], ["高い", "高い"]]
      .map(([v, t]) => `<button type=button data-v="${v}"${(今 ?? "") === v ? " class=on" : ""}>${t}</button>`).join("");
    d.addEventListener("click", (ev) => {
      const b = ev.target.closest("button[data-v]"); if (!b) return;
      const v = b.dataset.v || null;
      蔵.書く(高さの鍵, v); 行の高さを当てる(v);
      d.querySelectorAll("button").forEach((x) => x.classList.toggle("on", x === b));
    });
    場.appendChild(d);
  }

  function 取り付ける() {
    行の高さの箱();
    document.querySelectorAll(".el .scroll > table, .el > table").forEach((t, i) => {
      if (t.dataset.ui) return;
      t.dataset.ui = "1";
      try { 列幅をつける(t, i); 先頭列を固定(t); } catch { /* 表の形が違っても画面は出す */ }
    });
  }
  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", 取り付ける);
  else 取り付ける();
})();
