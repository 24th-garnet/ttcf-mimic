#!/usr/bin/env node
/**
 * .env に置いた接続情報を、**繋がずに**確かめる。
 *
 *   node tools/check-env.mjs
 *
 * 見るのは形と宛先だけで、接続はしない。確かめるのは4つ。
 *
 *   1. 既存 demo の Supabase を指していないか
 *      → プロジェクト参照 zjnajwmnakprklcpmrww は **クライアントが試験中の demo の本番**。
 *        ここへ 345MB を流すと相手の試験データを壊す。名指しで弾く
 *   2. リージョンが東京（ap-northeast-1）か
 *      → Vercel は hnd1（東京）。ずれると毎回のコールドスタートで 345MB を遠くから引く
 *   3. セッション用が 5432、トランザクション用が 6543 か
 *      → 用途が違う。5432 は COPY の長い転送向け、6543 はサーバレスの短命な接続向け
 *   4. Airtable の認証情報が混ざっていないか
 *      → 「現行に一切影響を与えない」を事故で破る形を、最初から作らない
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const 場所 = process.argv[2] ?? path.join(ROOT, ".env");

/** 既存 demo の Supabase。ここへ書くと相手の試験を壊す。 */
const 使ってはいけない参照 = "zjnajwmnakprklcpmrww";

if (!fs.existsSync(場所)) {
  console.error(`× ${場所} がありません。`);
  console.error(`  Supabase の Connect から接続文字列を取って、ここに置いてください。`);
  process.exit(2);
}

const 値 = {};
for (const 行 of fs.readFileSync(場所, "utf8").split("\n")) {
  const t = 行.trim();
  if (!t || t.startsWith("#") || !t.includes("=")) continue;
  const i = t.indexOf("=");
  値[t.slice(0, i).trim()] = t.slice(i + 1).trim().replace(/^["']|["']$/g, "");
}

let 悪い = 0;
const だめ = (s) => { console.log("  × " + s); 悪い++; };
const よし = (s) => console.log("  ○ " + s);

console.log(`■ ${場所}\n`);

// 4. Airtable の認証情報が混ざっていないか
console.log("Airtable の認証情報が混ざっていないか");
const 危険 = Object.keys(値).filter((k) => /^AIRTABLE_/i.test(k));
if (危険.length) {
  だめ(`${危険.join(" / ")} が同じファイルにある`);
  console.log("     このファイルを丸ごと読み込むと、現行 Airtable の認証情報が実行環境に載ります。");
  console.log("     移送用の .env からは外してください。");
} else よし("入っていない");

for (const [鍵, 期待ポート, 用途] of [
  ["SUPABASE_SESSION_URL", "5432", "コールドスタートの一括読み出し（COPY）"],
  ["SUPABASE_TX_URL", "6543", "リクエストごとの書き込み"],
]) {
  console.log(`\n${鍵}  — ${用途}`);
  const u = 値[鍵];
  if (!u) { だめ("未設定"); continue; }

  const m = u.match(/^postgres(?:ql)?:\/\/(?<user>[^:]+):(?<pw>[^@]*)@(?<host>[^:/]+):(?<port>\d+)\/(?<db>\S+)$/);
  if (!m) { だめ("形が違う。postgresql://ユーザ:パスワード@ホスト:ポート/postgres の形にしてください"); continue; }
  const { user, pw, host, port, db } = m.groups;

  const 参照 = (user.match(/^postgres\.([a-z0-9]+)$/) ?? [])[1];
  if (!参照) だめ(`ユーザが postgres.<ref> の形でない（${user}）。プーラー用の文字列か確かめてください`);
  else if (参照 === 使ってはいけない参照) {
    だめ(`**既存 demo の Supabase を指している**（${参照}）`);
    console.log("     ここはクライアントが試験に使っている本番です。345MB を流すと相手の試験データを壊します。");
    console.log("     TTCF 専用のプロジェクトを新しく作ってください。");
  } else よし(`プロジェクト ${参照}（demo とは別）`);

  if (!pw) だめ("パスワードが空");
  if (db !== "postgres") だめ(`データベース名が postgres でない（${db}）`);

  const r = (host.match(/^aws-\d+-([a-z0-9-]+)\.pooler\.supabase\.com$/) ?? [])[1];
  if (!r) {
    if (/^db\..*\.supabase\.co$/.test(host)) {
      だめ(`直結（${host}）。IPv4 アドオンが無いと IPv6 のみなので、プーラーを使ってください`);
    } else だめ(`ホストの形が想定外（${host}）`);
  } else if (r === "ap-northeast-1") よし(`リージョン ${r}（東京。Vercel の hnd1 と同じ）`);
  else だめ(`リージョンが ${r}。Vercel は hnd1（東京）なので、毎回 345MB を遠くから引くことになる`);

  if (port === 期待ポート) よし(`ポート ${port}`);
  else だめ(`ポートが ${port}。${用途}には ${期待ポート} を使ってください`);
}

console.log("\nVERCEL_AUTOMATION_BYPASS_SECRET");
const b = 値.VERCEL_AUTOMATION_BYPASS_SECRET ?? 値.Protection_Bypass_for_Automation;
if (!b) だめ("未設定");
else if (b.length !== 32) だめ(`${b.length} 文字。Vercel が出すのは 32 文字です`);
else よし("32 文字");

console.log(`\n${悪い === 0 ? "── すべて問題ありません。移送に進めます。" : `── ${悪い} 件を直してください。`}`);
process.exit(悪い ? 1 : 0);
