/**
 * .env から**必要な変数だけ**を名指しで読む。
 *
 * ファイルを丸ごと環境へ流し込まない。移送の作業中に Airtable の認証情報が
 * 実行環境に載る形を作らないため（「現行に一切影響を与えない」を事故で破らない）。
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

export function 読む(鍵たち) {
  const p = path.join(ROOT, ".env");
  if (!fs.existsSync(p)) { console.error(`× ${p} がありません`); process.exit(2); }
  const 値 = {};
  for (const 行 of fs.readFileSync(p, "utf8").split("\n")) {
    const t = 行.trim();
    if (!t || t.startsWith("#") || !t.includes("=")) continue;
    const i = t.indexOf("=");
    const k = t.slice(0, i).trim();
    if (鍵たち.includes(k)) 値[k] = t.slice(i + 1).trim().replace(/^["']|["']$/g, "");
  }
  for (const k of 鍵たち) if (!値[k]) { console.error(`× .env に ${k} がありません`); process.exit(2); }
  return 値;
}

/** 既存 demo の Supabase。ここへ書くと、クライアントが試験中のデータを壊す。 */
const 使ってはいけない参照 = "zjnajwmnakprklcpmrww";

export function 宛先を確かめる(url) {
  if (url.includes(使ってはいけない参照)) {
    console.error("× 既存 demo の Supabase を指しています。ここはクライアントが試験に使っている本番です。");
    process.exit(2);
  }
  const m = url.match(/@([^:/]+):(\d+)\//);
  return { ホスト: m?.[1] ?? "?", ポート: m?.[2] ?? "?" };
}
