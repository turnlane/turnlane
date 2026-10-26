/**
 * デモ動画（M6-30）の撮影キットを作る（docs/dev/demo-video.md の 4 章）。オーナーがテスト用の macOS ユーザーで
 * 場面 (3) と通知のバナーを撮るためのもの。そのユーザーはリポジトリを読めない前提なので、要るものを写す。
 *
 *   bun run build:web && bun run build:app && bun scripts/demo-kit.ts [--dest /Users/Shared/turnlane-demo] [--app out/app/Turnlane.app]
 *
 * 中身: dev-board を 1 ファイルにまとめた dev-board.js（bun build。依存の node_modules は要らない）、web/（apps/web/dist）、
 * Turnlane.app（開発ビルド）、scripts/demo/tab.sh、scripts/demo/kit/ の手順書と台本。run/ と captures/{ja,en}/ は
 * ほかのユーザーも書けるようにする（1777）。既存の captures/ は残す。
 */
import { chmodSync, cpSync, existsSync, mkdirSync, readdirSync, rmSync } from "node:fs";
import { join, resolve } from "node:path";

const ROOT = resolve(import.meta.dir, "..");
const args = process.argv.slice(2);
const opt = (k: string) => {
  const i = args.indexOf(k);
  return i >= 0 ? args[i + 1] : undefined;
};
const dest = resolve(opt("--dest") ?? "/Users/Shared/turnlane-demo");
const app = resolve(opt("--app") ?? join(ROOT, "out/app/Turnlane.app"));
const web = join(ROOT, "apps/web/dist");
if (!existsSync(join(web, "index.html")))
  throw new Error("apps/web/dist is missing: bun run build:web");
if (!existsSync(join(app, "Contents/MacOS/turnlane")))
  throw new Error(`${app} is missing: bun run build:app`);

mkdirSync(dest, { recursive: true });
// 作り直すもの（captures/ と run/ は残す）
for (const name of readdirSync(dest))
  if (name !== "captures" && name !== "run")
    rmSync(join(dest, name), { recursive: true, force: true });

const built = await Bun.build({
  entrypoints: [join(ROOT, "scripts/dev-board.ts")],
  target: "bun",
  outdir: dest,
  naming: "dev-board.js",
});
if (!built.success) throw new Error(built.logs.map(String).join("\n"));

cpSync(web, join(dest, "web"), { recursive: true });
// .app は ditto で写す（拡張属性・署名を保つ）
const ditto = Bun.spawnSync(["/usr/bin/ditto", app, join(dest, "Turnlane.app")]);
if (ditto.exitCode !== 0) throw new Error("ditto failed");
const kit = join(ROOT, "scripts/demo/kit");
for (const f of readdirSync(kit)) cpSync(join(kit, f), join(dest, f));
cpSync(join(ROOT, "scripts/demo/tab.sh"), join(dest, "tab.sh"));
for (const f of readdirSync(dest)) if (f.endsWith(".sh")) chmodSync(join(dest, f), 0o755);
for (const d of ["run", "captures", "captures/ja", "captures/en"]) {
  mkdirSync(join(dest, d), { recursive: true });
  chmodSync(join(dest, d), 0o1777);
}
console.log(`wrote ${dest}`);
