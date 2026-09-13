/**
 * 帳票を組む。**現行が出したPDFから逆算した組みを、DBの値で埋める。**
 *
 *   import { 帳票の種類, 帳票を組む } from "./app/doc.mjs";
 *
 * ■ どう逆算したか
 *
 * 現行が出した実物1,057件を確保してある。`crawl/lib/pdftext.mjs` で
 * 文字を座標つきに戻し、どこに何が印字されるかを読んだ。
 *
 *   発注書   668件  Skia/PDF m120・m144・m149（ヘッドレスChromiumの印刷）
 *                  **紙は 612×792 点＝USレター。A4ではない**
 *                  フォント IPAGothic（日本語）＋ArialMT＋TimesNewRomanPSMT
 *   請求書   334件  Skia/PDF m120・m129・m139
 *   製造表    44件  **JPEG。PDFではない**
 *   原料棚卸表  9件  Skia/PDF m149
 *   仕掛品棚卸表 2件  **PrinceXML 16.1。他と別系統**
 *
 * ■ 値の出どころ
 *
 * 発注書の実物（rec02oQK5VqQ3QTq8）を読んで突き合わせた結果:
 *
 *   発注No・発注日・仕入先名・希望納品日・納品場所  行の値から
 *   明細（品名・単価・入数・数量・金額）        発注明細から
 *   会社名・住所・TEL・FAX・注意書き            **固定文。納品場所で変わる**
 *   担当者                                **DBに見当たらない。要確認**
 *
 * 関連の辺が未取得のため、明細は **発注明細.発注番号 = 発注書.発注No** で結ぶ。
 * クライアント提供CSVがどちらの値も持っている。
 *
 * ■ 出すのはHTML
 *
 * 現行もHTMLをChromiumで印刷している（Producerが Skia/PDF）。
 * だから同じ作りにする。PDFにするのは最後の機械的な一手で、
 * **機能として要るのは「正しい値が正しい場所に出ること」**である。
 */
import { 書く } from "./format.mjs";

const E = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));

/** 和暦でなく「2024 年 03 月 21 日」の形。実物がこの形 */
function 年月日(v) {
  if (!v) return "";
  const d = new Date(String(v));
  if (Number.isNaN(d.getTime())) return String(v);
  const p = new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Tokyo", year: "numeric", month: "2-digit", day: "2-digit" })
    .formatToParts(d).reduce((a, x) => (a[x.type] = x.value, a), {});
  return `${p.year} 年 ${p.month} 月 ${p.day} 日`;
}
const 円 = (v) => {
  const n = Number(String(v ?? "").replace(/[^0-9.\-]/g, ""));
  return Number.isFinite(n) ? "¥" + n.toLocaleString("ja-JP") : String(v ?? "");
};

/**
 * 発注書の組み。**x座標で左右に分かれている。**
 *
 * 実物（rec02oQK5VqQ3QTq8）を座標つきで読んだ結果:
 *
 *   左 x≈10          右 x≈436〜704
 *   ─────────────    ──────────────────────────────
 *   仕入先名＋御中      発注日 / 発注書No.
 *   **仕入先の** TEL    TTCフーズ株式会社 九州支店 田川工場
 *   **仕入先の** FAX    福岡県田川市大字伊加利 1805-22
 *   下記の通り発注します  **自社の** TEL 0947-50-8210
 *   合計金額           **自社の** FAX 0947-50-8211
 *   希望納品日/納品場所   担当者：矢野　智章
 *   明細表
 *   【備考欄】
 *   注意書き①②
 *
 * **左の TEL/FAX は仕入先の番号である。**
 * 最初は両方を自社の番号として置いていたが誤り。
 * 092-717-7310 / 7317 は得意先マスタで「株式会社丸菱 福岡支店」の番号、
 * 0947-50-8210 は「ＴＴＣフーズ株式会社九州支店」の番号だった
 * （自社も得意先マスタに登録されている）。
 * 行にまとめて読むと同じ y に並ぶので混ざる。**座標で分けること。**
 *
 * ■ 手元に無いもの
 *
 *   仕入先の TEL / FAX / 住所   仕入先マスタ（製造/Table tblyGTkbWStT7fXmS）は**行が0件**
 *   担当者（矢野　智章）         DBのどこにも無い（「智章」で0件）
 *
 * 納品場所は選択項目で、選択肢は
 *   TTCフーズ株式会社　田川工場 / 博多運輸株式会社 / 芳雄製氷冷蔵株式会社 / 三菱倉庫
 */
const 自社 = {
  名: "TTCフーズ株式会社　九州支店　田川工場",
  住所: "福岡県田川市大字伊加利 1805-22",
  TEL: "0947-50-8210", FAX: "0947-50-8211",
};

const 注意書き = [
  "⓵上記希望納期を記載しておりますが、無理な場合は再ＦＡＸを返信される際に記載する様に御願い申し上げます。",
  "② 上記内容ご確認後、問題無ければ、書名押印のＦＡＸご返信の御願い申し上げます。",
];

export const 帳票の種類 = [
  { 鍵: "発注書", 名: "発注書", 実物: 668, 生成元: "ヘッドレスChromium（Skia/PDF）", 紙: "レター 612×792" },
  { 鍵: "請求書", 名: "請求書", 実物: 334, 生成元: "Documint（帯「made with documint」。Producer は Skia/PDF）", 紙: "A4 縦" },
  { 鍵: "原料棚卸表", 名: "原料棚卸表", 実物: 9, 生成元: "ヘッドレスChromium（Skia/PDF）", 紙: "A4横" },
  { 鍵: "仕掛品棚卸表", 名: "仕掛品棚卸表", 実物: 2, 生成元: "PrinceXML 16.1", 紙: "A4" },
  { 鍵: "製造表", 名: "製造表", 実物: 44, 生成元: "画像（JPEG）", 紙: "—" },
];

/** 共通の枠。レターに合わせる */
function 紙に載せる(題, 中, { 幅 = "612pt", 高さ = "792pt" } = {}) {
  return `<!doctype html><html lang=ja><head><meta charset=utf-8><title>${E(題)}</title><style>
@page{size:${幅} ${高さ};margin:0}
*{box-sizing:border-box}
body{margin:0;font-family:"IPAGothic","IPAPGothic","Hiragino Kaku Gothic ProN","Yu Gothic",Meiryo,sans-serif;
  color:#000;background:#888}
.紙{width:${幅};height:${高さ};background:#fff;margin:10px auto;padding:28pt 34pt;position:relative}
@media print{body{background:#fff}.紙{margin:0;box-shadow:none}}
.題{text-align:center;font-size:19pt;letter-spacing:.3em;margin:0 0 6pt}
.上{display:flex;justify-content:space-between;align-items:flex-start;font-size:9pt}
.宛{font-size:12pt;margin:14pt 0 2pt;border-bottom:1px solid #000;display:inline-block;padding-bottom:2pt}
.差{text-align:right;line-height:1.5}
table{border-collapse:collapse;width:100%;font-size:9.5pt;margin-top:10pt}
th,td{border:1px solid #000;padding:3pt 5pt}
th{background:#eee;text-align:center;font-weight:600}
td.r{text-align:right}
td.c{text-align:center}
.合計{margin-top:8pt;text-align:right;font-size:11pt}
.欄{margin-top:10pt;border:1px solid #000;min-height:54pt;padding:4pt 6pt;font-size:9pt}
.注{margin-top:8pt;font-size:8pt;line-height:1.6}
.不明{background:#fff2f2;outline:1px dashed #c00;padding:0 2px}
</style></head><body><div class=紙>${中}</div></body></html>`;
}

/**
 * 発注書。
 * @param 親   発注書の行の値（項目名で引ける形）
 * @param 明細 発注明細の行の配列
 */
export function 発注書を組む(親, 明細) {
  const 合計 = 明細.reduce((s, x) => s + (Number(String(x.金額 ?? "").replace(/[^0-9.\-]/g, "")) || 0), 0);
  const 行 = 明細.length
    ? 明細.map((x) => `<tr>
        <td>${E(x.原材料名 ?? "")}</td>
        <td class=r>${E(x.単価 ? 円(x.単価) : "")}${x.単価単位 ? ` / 1${E(x.単価単位)}` : ""}</td>
        <td class=c>${E(x.入数 ?? "")}</td>
        <td class=r>${E(x.発注数量 ?? "")}${x.数量単位 ? ` ${E(x.数量単位)}` : ""}</td>
        <td class=r>${E(円(x.金額))}</td></tr>`).join("")
    : `<tr><td colspan=5 style="text-align:center;color:#c00">明細の紐付けが手元にありません</td></tr>`;
  const 不明 = (v, 何) => v ? E(v) : `<span class=不明>${E(何)}</span>`;
  const 中 = `<div class=題>発注書</div>
    <div class=上>
      <div style="min-width:300px">
        <div class=宛>${E(親.仕入先 ?? 親.仕入先名 ?? "")}　御中</div>
        <div style="margin-top:6pt">TEL ： ${不明(親.仕入先TEL, "仕入先マスタが手元にありません")}</div>
        <div>F AX ： ${不明(親.仕入先FAX, "同上")}</div>
      </div>
      <div class=差>
        <div>発注日 ${E(年月日(親.発注日))}</div>
        <div style="margin-top:6pt">発注書 No. <b>${E(親.発注No ?? "")}</b></div>
        <div style="margin-top:10pt">${E(自社.名)}</div>
        <div>${E(自社.住所)}</div>
        <div>TEL ${E(自社.TEL)}</div>
        <div>F AX ${E(自社.FAX)}</div>
        <div>担当者：${不明(親.担当者, "DBに無い値")}</div>
      </div>
    </div>
    <div style="font-size:9.5pt;margin-top:8pt">下記の通り発注します。</div>
    <table><thead><tr><th style="width:44%">品名</th><th>単価</th><th>入数</th><th>数量</th><th>金額</th></tr></thead>
      <tbody>${行}</tbody></table>
    <div class=合計>合計金額　<b>${E(円(合計))}</b></div>
    <div style="margin-top:10pt;font-size:9.5pt">希望納品日 ${E(年月日(親.希望納品日))}　　納品場所 ${E(親.納品場所 ?? "")}</div>
    <div class=欄><b>【備考欄】</b><br>${E(親.備考 ?? "")}</div>
    <div class=注>${注意書き.map((x) => `<div>${E(x)}</div>`).join("")}</div>`;
  return 紙に載せる(`発注書 ${親.発注No ?? ""}`, 中);
}
