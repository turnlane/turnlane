/**
 * 版を1か所から（phase0-plan M6-17、onboarding.md 2.1）。正はルートの package.json の `version`。
 * - `turnlaned --version`・`turnlane --version`: `<版>+<git の短い sha>`（scripts/build.ts が埋め込む）
 * - Turnlane.app（Tauri の version、CFBundleShortVersionString）・TurnlaneCalendarHelper.app（CFBundleShortVersionString）:
 *   `<版>`（apps/desktop/scripts/build.sh と native/calendar-helper/scripts/build-app.sh がこれを読んで書き込む）
 * - Turnlane.app の Info.plist の TurnlaneBuild: `<版>+<sha>`（scripts/build-app.ts。デーモンがバンドルの入れ替えに気づくのに使う）
 * - latest.json の version: `<版>`（scripts/build-app.ts --zip）
 *
 *   bun scripts/version.ts           <版>
 *   bun scripts/version.ts --build   <版>+<sha>
 */
import { readFileSync } from "node:fs";
import { join, resolve } from "node:path";

const ROOT = resolve(import.meta.dir, "..");

/** 製品の版（ルートの package.json） */
export function productVersion(root = ROOT): string {
  const pkg = JSON.parse(readFileSync(join(root, "package.json"), "utf8")) as { version?: string };
  const v = pkg.version ?? "0.0.0";
  if (!/^\d+\.\d+\.\d+(-[0-9A-Za-z.-]+)?$/.test(v))
    throw new Error(`package.json: invalid version ${v}`);
  return v;
}

/** ビルドの識別（`<版>+<git の短い sha>`。git が無ければ +nogit） */
export function buildVersion(root = ROOT): string {
  let sha = "nogit";
  const p = Bun.spawnSync(["git", "rev-parse", "--short", "HEAD"], {
    cwd: root,
    stdout: "pipe",
    stderr: "pipe",
  });
  if (p.exitCode === 0) sha = p.stdout.toString().trim() || sha;
  return `${productVersion(root)}+${sha}`;
}

if (import.meta.main) {
  console.log(process.argv.includes("--build") ? buildVersion() : productVersion());
}
