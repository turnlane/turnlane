/**
 * リリースの一本道（phase0-plan M6-10、docs/release.md）。オーナーの Mac で動かす（署名の鍵を CI に置かない）。
 *
 *   bun run release [--dry-run] [--skip-check] [--tap-dir <path>] [--allow-adhoc] [--skip-notarize]
 *                   [--publish [--yes]]
 *
 * 1. 前提の検査（scripts/release/plan.ts の releaseCheck）: main・作業ツリーがきれい・package.json の版と CHANGELOG の
 *    最上段の見出しが一致・タグ v<版> が無い・TURNLANE_CODESIGN_IDENTITY が Developer ID Application・
 *    TURNLANE_NOTARY_PROFILE がある。--allow-adhoc は開発の確かめ用に署名・公証・ブランチを緩める（公開はできない）
 * 2. bun run check（--skip-check で省く）
 * 3. build:app --zip --download-url <Releases の zip>（拡張なし。--ext を渡さない）。出力は out/release/
 * 4. dist/release/v<版>/ に zip・その複製の Turnlane.zip・latest.json・<zip>.sha256・cask・notes.md（CHANGELOG の節）を置く
 * 5. tap: --tap-dir（既定はリポジトリの隣の <TAP_REPO>）があれば Casks/<token>.rb を描いてその repo でコミットだけ作る
 *    （push しない）。tap に LICENSE・README.md が無ければ同じコミットに足す
 * 6. 公開のコマンド（タグ・push・gh release create・tap の push）を印字する。--publish のときだけ実行し、
 *    外に出す操作の前に --yes か端末での確認を求める
 *
 * --dry-run: 検査と、行うことの印字だけ（ビルド・ファイル・tap・公開に触れない）
 */
import { copyFileSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { createInterface } from "node:readline/promises";
import {
  LATEST_JSON_URL,
  LATEST_ZIP_URL,
  releaseZipUrl,
} from "../packages/core/src/release-config.ts";
import { parseLatest } from "../packages/core/src/update.ts";
import { codesignIdentity } from "./build.ts";
import { buildApp } from "./build-app.ts";
import { renderCaskFile, TAP_CASK_PATH } from "./release/cask.ts";
import {
  afterPublishChecks,
  changelogSection,
  defaultTapDir,
  type PublishStep,
  publishSteps,
  type ReleaseFacts,
  releaseCheck,
  releaseFiles,
  sha256Line,
  shellLine,
  tapScaffold,
} from "./release/plan.ts";
import { notaryProfile } from "./signing.ts";
import { productVersion } from "./version.ts";

const ROOT = resolve(import.meta.dir, "..");

function git(args: string[], cwd = ROOT): { code: number; out: string } {
  const p = Bun.spawnSync(["git", ...args], { cwd, stdout: "pipe", stderr: "pipe" });
  return { code: p.exitCode ?? 1, out: p.stdout.toString().trim() };
}

function mustGit(args: string[], cwd = ROOT): string {
  const p = Bun.spawnSync(["git", ...args], { cwd, stdout: "pipe", stderr: "pipe" });
  if (p.exitCode !== 0)
    throw new Error(`git ${args.join(" ")} failed:\n${p.stderr.toString().trim()}`);
  return p.stdout.toString().trim();
}

/** 手元の状態を集める（読むだけ） */
export function gatherFacts(o: {
  allowAdhoc: boolean;
  skipNotarize: boolean;
  env?: Record<string, string | undefined>;
}): ReleaseFacts {
  const env = o.env ?? process.env;
  const version = productVersion(ROOT);
  const branch = git(["symbolic-ref", "--short", "-q", "HEAD"]);
  const status = git(["status", "--porcelain"]);
  const changelogPath = join(ROOT, "CHANGELOG.md");
  return {
    branch: branch.code === 0 && branch.out ? branch.out : null,
    clean: status.code === 0 && status.out === "",
    version,
    changelog: existsSync(changelogPath) ? readFileSync(changelogPath, "utf8") : null,
    tagExists: git(["rev-parse", "-q", "--verify", `refs/tags/v${version}`]).code === 0,
    identity: codesignIdentity(env),
    notaryProfile: notaryProfile(env),
    allowAdhoc: o.allowAdhoc,
    skipNotarize: o.skipNotarize,
  };
}

/**
 * tap の repo に cask を書いてコミットする（push しない）。tap に LICENSE・README.md が無ければ同じコミットに足す
 * （tapScaffold）。変わらなければコミットしない
 */
export function commitTap(
  tapDir: string,
  cask: string,
  version: string,
): "committed" | "unchanged" {
  if (git(["rev-parse", "--is-inside-work-tree"], tapDir).out !== "true")
    throw new Error(`--tap-dir ${tapDir} is not a git repository`);
  const licensePath = join(ROOT, "LICENSE");
  const extra = tapScaffold({
    hasLicense: existsSync(join(tapDir, "LICENSE")),
    hasReadme: existsSync(join(tapDir, "README.md")),
    license: existsSync(licensePath) ? readFileSync(licensePath, "utf8") : null,
  });
  const writes = [{ path: TAP_CASK_PATH, content: cask }, ...extra];
  for (const w of writes) {
    const file = join(tapDir, w.path);
    mkdirSync(join(file, ".."), { recursive: true });
    writeFileSync(file, w.content);
  }
  const paths = writes.map((w) => w.path);
  mustGit(["add", "--", ...paths], tapDir);
  if (git(["diff", "--cached", "--quiet", "--", ...paths], tapDir).code === 0) return "unchanged";
  mustGit(["commit", "-q", "-m", `turnlane ${version}`, "--", ...paths], tapDir);
  return "committed";
}

async function confirm(step: PublishStep, yes: boolean): Promise<boolean> {
  if (!step.remote || yes) return true;
  if (!process.stdin.isTTY) {
    console.error(`refusing to run without --yes (not a terminal): ${shellLine(step.cmd)}`);
    return false;
  }
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  try {
    const a = await rl.question(`Run \`${shellLine(step.cmd)}\`? Type yes to continue: `);
    return a.trim() === "yes";
  } finally {
    rl.close();
  }
}

function printPublish(steps: PublishStep[], version: string): void {
  console.log("\nTo publish, run (in this order):");
  for (const s of steps)
    console.log(`  ${s.cwd ? `(cd ${s.cwd}) ` : ""}${shellLine(s.cmd)}   # ${s.title}`);
  console.log("Then check:");
  for (const u of afterPublishChecks(version)) console.log(`  ${u}`);
  console.log("Or rerun with --publish (asks before each push unless --yes).");
}

async function main(args: string[]): Promise<number> {
  const has = (k: string) => args.includes(k);
  const val = (k: string) => {
    const i = args.indexOf(k);
    return i >= 0 ? args[i + 1] : undefined;
  };
  const dryRun = has("--dry-run");
  const allowAdhoc = has("--allow-adhoc");
  const skipNotarize = has("--skip-notarize");
  const publish = has("--publish");
  if (publish && (dryRun || allowAdhoc)) {
    console.error("error: --publish cannot be combined with --dry-run or --allow-adhoc");
    return 2;
  }
  const tapArg = val("--tap-dir");
  if (has("--tap-dir") && !tapArg) {
    console.error("error: --tap-dir needs a path");
    return 2;
  }
  const tapDir = tapArg ? resolve(tapArg) : defaultTapDir(ROOT);
  const useTap = existsSync(tapDir);

  // 1. 前提
  const facts = gatherFacts({ allowAdhoc, skipNotarize });
  const v = facts.version;
  const check = releaseCheck(facts);
  console.log(
    `Turnlane ${v}${allowAdhoc ? " (--allow-adhoc: development check, not publishable)" : ""}`,
  );
  for (const w of check.warnings) console.log(`warning: ${w}`);
  for (const e of check.errors) console.error(`error: ${e}`);
  if (check.errors.length > 0) return 1;

  const dir = join(ROOT, "dist", "release", `v${v}`);
  const files = releaseFiles(v);
  const downloadUrl = releaseZipUrl(v);
  const buildOut = join(ROOT, "out", "release");
  const steps = publishSteps({
    version: v,
    dir,
    tapDir: useTap ? tapDir : null,
    tapCommitted: useTap,
  });

  if (dryRun) {
    console.log("\nWould run:");
    if (!has("--skip-check")) console.log("  bun run check");
    console.log(
      `  bun run build:app --zip --download-url ${downloadUrl} --out ${buildOut}${skipNotarize ? " --skip-notarize" : ""}   # no extensions`,
    );
    console.log(`  write ${dir}/{${Object.values(files).join(",")}}`);
    console.log(
      useTap
        ? `  write ${join(tapDir, TAP_CASK_PATH)} and commit it in ${tapDir} (no push)`
        : `  no tap at ${tapDir}: the cask is only written to ${dir}/${files.cask}`,
    );
    console.log(`  latest.json url: ${downloadUrl}  (update feed: ${LATEST_JSON_URL})`);
    console.log(`  ${files.latestZip}: a copy of ${files.zip} (site download: ${LATEST_ZIP_URL})`);
    printPublish(steps, v);
    return 0;
  }

  // 2. check
  if (!has("--skip-check")) {
    console.log("\n# bun run check");
    const p = Bun.spawnSync(["bun", "run", "check"], {
      cwd: ROOT,
      stdout: "inherit",
      stderr: "inherit",
    });
    if (p.exitCode !== 0) {
      console.error("error: bun run check failed");
      return 1;
    }
  }

  // 3. build（拡張なし）
  console.log("\n# build:app --zip (no extensions)");
  const r = await buildApp({
    outDir: buildOut,
    zip: { downloadUrl },
    skipNotarize,
  });
  if (r.extensions.length > 0) {
    console.error(
      `error: the release build must not include extensions (${r.extensions.join(", ")})`,
    );
    return 1;
  }
  if (!allowAdhoc && !r.notarized) {
    console.error("error: the build was not notarized");
    return 1;
  }
  for (const l of r.verify) console.log(l);
  if (!r.zip) throw new Error("build:app did not produce a zip");

  // 4. dist/release/v<版>/
  rmSync(dir, { recursive: true, force: true });
  mkdirSync(dir, { recursive: true });
  copyFileSync(r.zip, join(dir, files.zip));
  copyFileSync(r.zip, join(dir, files.latestZip));
  copyFileSync(join(buildOut, "latest.json"), join(dir, files.latest));
  const sha = new Bun.CryptoHasher("sha256")
    .update(readFileSync(join(dir, files.zip)))
    .digest("hex");
  const latest = parseLatest(
    JSON.parse(readFileSync(join(dir, files.latest), "utf8")),
    LATEST_JSON_URL,
  );
  if (!latest || latest.version !== v || latest.sha256 !== sha || latest.url !== downloadUrl)
    throw new Error(`latest.json does not match the zip: ${JSON.stringify(latest)}`);
  writeFileSync(join(dir, files.sha256), sha256Line(sha, files.zip, files.latestZip));
  const cask = renderCaskFile({ version: v, sha256: sha });
  writeFileSync(join(dir, files.cask), cask);
  writeFileSync(join(dir, files.notes), `${changelogSection(facts.changelog ?? "", v) ?? ""}\n`);
  console.log(`\n${dir}`);
  for (const n of Object.values(files)) console.log(`  ${n}`);
  console.log(`sha256: ${sha}`);

  // 5. tap
  let tapCommitted = false;
  if (useTap) {
    const t = commitTap(tapDir, cask, v);
    tapCommitted = t === "committed";
    console.log(
      `tap: ${t === "committed" ? "committed" : "cask unchanged"} in ${tapDir} (not pushed)`,
    );
  } else console.log(`tap: none at ${tapDir}; copy ${files.cask} to ${TAP_CASK_PATH} in the tap`);

  // 6. 公開
  const finalSteps = publishSteps({
    version: v,
    dir,
    tapDir: useTap ? tapDir : null,
    tapCommitted,
  });
  if (!publish) {
    printPublish(finalSteps, v);
    return 0;
  }
  for (const s of finalSteps) {
    if (!(await confirm(s, has("--yes")))) {
      console.error(`stopped before: ${s.title}. See docs/release.md (recovery).`);
      return 1;
    }
    console.log(`# ${s.title}`);
    const p = Bun.spawnSync(s.cmd, { cwd: s.cwd ?? ROOT, stdout: "inherit", stderr: "inherit" });
    if (p.exitCode !== 0) {
      console.error(`error: ${shellLine(s.cmd)} failed. See docs/release.md (recovery).`);
      return 1;
    }
  }
  console.log("Published. Check:");
  for (const u of afterPublishChecks(v)) console.log(`  ${u}`);
  return 0;
}

if (import.meta.main) {
  process.exit(await main(process.argv.slice(2)));
}
