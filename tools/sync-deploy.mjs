#!/usr/bin/env node
/**
 * 作業ツリー（crawler）から **deploy ブランチへ機械的に写す**。
 *
 *   node tools/sync-deploy.mjs            写して commit（push はしない）
 *   node tools/sync-deploy.mjs --見るだけ   何が変わるかだけ出す
 *
 * ■ なぜ道具にするか
 *
 * 常駐版と Vercel は**同じ app/serve.mjs を実行する**という原則がある。
 * deploy を手で直すと 2 つのコードが静かに分かれ、比較の意味が消える。
 * だから写すのは機械にやらせ、**写したあと sha を突き合わせて、ずれたら止める**。
 *
 * ■ 入れてはいけないもの
 *
 * リポジトリは 240MB・1,621 ファイルを追跡しており、その中に請求書・発注書・棚卸表の
 * 実物 1,057 件が入っている。**私有リポジトリであっても、push すればクライアントの
 * 業務文書が GitHub に載る。** 名簿（下の `写すもの`）に挙げたものだけを写し、
 * それ以外は 1 件も持ち出さない。業務データの置き場は Supabase である。
 */
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const 見るだけ = process.argv.includes("--見るだけ");
const 作業 = "/tmp/ttcf-deploy-wt";
const git = (...a) => execFileSync("git", a, { cwd: ROOT, encoding: "utf8" }).trim();
const gitW = (...a) => execFileSync("git", a, { cwd: 作業, encoding: "utf8" }).trim();

/** 実行に要るものだけ。**ここに無いものは写らない。** */
const 写すもの = [
  "server.mjs", "vercel.json",
  "app/serve.mjs", "app/format.mjs", "app/ui.js", "app/doc.mjs", "app/doc-sales.mjs", "app/doc-mfg.mjs",
  ...fs.readdirSync(path.join(ROOT, "app", "ext")).filter((f) => /\.(mjs|md)$/.test(f)).map((f) => `app/ext/${f}`),
  "db/schema.sql", "db/open.mjs", "db/query.mjs", "db/calc.mjs", "db/formula.mjs", "db/write.mjs",
  "db/actions.mjs", "db/hydrate.mjs", "db/layouts.mjs", "db/bom.mjs", "db/artifacts.mjs",
  "db/replicate.mjs",
  "db/pg/001_schema.sql", "db/pg/002_files.sql", "db/pg/003_effect.sql", "db/pg/mapping.mjs",
  "spec/gates.json", "spec/published-layout.json",
  ...["apply-schema", "check-columns", "check-env", "compare", "export-to-pg", "extract-layouts",
      "harvest", "load-to-pg", "load-files-to-pg", "measure-csv", "pgenv", "sync-deploy",
      "test-replicate", "try-hydrate", "verify-pg", "write-compare"]
     .map((f) => `tools/${f}.mjs`),
];

/**
 * **枝ごとに違ってよいもの。** deploy 側は実行に要るものだけの枝なので、
 * 依存も説明も網も別物になる（package.json は playwright を外し engines を 22 に固定、
 * .gitignore は業務データを弾く網、README は置いてあるものの説明）。
 * ここに挙げたものは**写さない**。無ければ止める。
 */
const 枝ごとに違ってよい = ["package.json", "package-lock.json", ".gitignore", "README.md"];

/** 名簿に間違って業務データを足してしまったときに止める番人 */
const 通してはいけない = [/^crawl\/out\//, /^data\//, /^airtable-csv\//, /^db\/pg\/data\//, /\.env$/, /^spec\/attachments\.json$/];
for (const f of 写すもの) {
  if (通してはいけない.some((r) => r.test(f))) { console.error(`× 名簿に業務データが入っています: ${f}`); process.exit(2); }
}

const 無い = 写すもの.filter((f) => !fs.existsSync(path.join(ROOT, f)));
if (無い.length) { console.error("× 手元にありません:\n  " + 無い.join("\n  ")); process.exit(2); }

/** deploy を別の場所に取り出す（作業ツリーは触らない） */
fs.rmSync(作業, { recursive: true, force: true });
try { git("worktree", "prune"); } catch { /* 無ければよい */ }
git("worktree", "add", "--force", 作業, "deploy");

const 前 = new Set(gitW("ls-files").split("\n").filter(Boolean));
for (const f of 枝ごとに違ってよい) {
  if (!前.has(f)) { console.error(`× deploy に ${f} がありません。枝ごとに違ってよいものは手で置く決まりです`); process.exit(2); }
}
let 変わった = 0, 同じ = 0;
const 足した = [], 直した = [], 消した = [...前].filter((f) => !写すもの.includes(f) && !枝ごとに違ってよい.includes(f));

for (const f of 写すもの) {
  const 元 = fs.readFileSync(path.join(ROOT, f));
  const 先 = path.join(作業, f);
  const 旧 = fs.existsSync(先) ? fs.readFileSync(先) : null;
  if (旧 && 旧.equals(元)) { 同じ++; continue; }
  (旧 ? 直した : 足した).push(f);
  変わった++;
  if (!見るだけ) { fs.mkdirSync(path.dirname(先), { recursive: true }); fs.writeFileSync(先, 元); }
}

console.log(`名簿 ${写すもの.length} ファイル  そのまま ${同じ} ／ 足す ${足した.length} ／ 直す ${直した.length} ／ 名簿から外れた ${消した.length}`);
for (const f of 足した) console.log(`  ＋ ${f}`);
for (const f of 直した) console.log(`  ～ ${f}`);
for (const f of 消した) console.log(`  － ${f}`);

if (見るだけ) { git("worktree", "remove", "--force", 作業); process.exit(0); }
if (!変わった && !消した.length) { console.log("変わりありません"); git("worktree", "remove", "--force", 作業); process.exit(0); }

for (const f of 消した) { fs.rmSync(path.join(作業, f), { force: true }); }
gitW("add", "-A");

/** **写したあと突き合わせる。** ずれていたら commit しない */
const 出 = gitW("ls-files").split("\n").filter(Boolean).sort();
const 余分 = 出.filter((f) => !写すもの.includes(f) && !枝ごとに違ってよい.includes(f));
if (余分.length) { console.error("× 名簿に無いものが入っています:\n  " + 余分.join("\n  ")); process.exit(2); }
let 違い = 0;
for (const f of 出.filter((x) => !枝ごとに違ってよい.includes(x))) {
  const a = crypto.createHash("sha256").update(fs.readFileSync(path.join(ROOT, f))).digest("hex");
  const b = crypto.createHash("sha256").update(fs.readFileSync(path.join(作業, f))).digest("hex");
  if (a !== b) { console.error(`× 写せていません: ${f}`); 違い++; }
}
if (違い) process.exit(2);
console.log(`\n写し終えて sha を突き合わせました: ${出.length - 枝ごとに違ってよい.length} ファイル 全部一致（枝ごとに違ってよいもの ${枝ごとに違ってよい.length} 件は除く）`);

const 文 = process.env.SYNC_MSG || `作業ツリーから写す（${new Date().toISOString().slice(0, 10)}）`;
gitW("commit", "-m", 文);
console.log(gitW("log", "--oneline", "-1"));
console.log(`\n作業ツリー: ${作業}`);
console.log(`push するには: git -C ${作業} push origin deploy`);
