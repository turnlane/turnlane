/**
 * リリースの一本道（phase0-plan M6-10、docs/release.md）。オーナーの Mac で動かす（署名の鍵を CI に置かない）。
 *
 *   bun run release [--dry-run] [--skip-check] [--tap-dir <path>] [--allow-adhoc] [--skip-notarize]
 *                   [--publish [--yes]] [--from-app <Turnlane.app>] [--rebuild]
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
 * --from-app <Turnlane.app>: 2・3 を省き、ビルド・公証・staple 済みのアプリから続ける（staple が Error 73 で止まり、
 *   残した作業フォルダのアプリに手で staple した後など）。1 の検査はそのまま。アプリは使う前に確かめる
 *   （scripts/release/from-app.ts の checkFromApp: 名前・codesign・署名の証明書と Team・版・拡張なし・stapler・spctl）。
 *   out/release/Turnlane.app に写し、zip と latest.json は build:app と同じ packageApp で作る。--skip-notarize・
 *   --allow-adhoc とは組み合わせない
 * dist/release/v<版>/ がもうあるとき（scripts/release/reuse.ts の releaseMode）: --publish はビルドし直さずにその一式を
 *   確かめて（ファイル同士の sha256・latest.json・cask・notes と CHANGELOG・zip を展開したアプリの確かめ）そのまま公開する。
 *   確かめに落ちたら理由を出してからビルドする。--publish の無い実行は上書きを断る。--rebuild でどちらも新しくビルドする
 * タグはビルドしたコミット（アプリの TurnlaneBuild の sha）に付ける。main の祖先でなければ断る
 */
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { createInterface } from "node:readline/promises";
import {
  LATEST_JSON_URL,
  LATEST_ZIP_URL,
  releaseZipUrl,
} from "../packages/core/src/release-config.ts";
import { parseLatest } from "../packages/core/src/update.ts";
import { codesignIdentity } from "./build.ts";
import { APP_NAME, buildApp, packageApp, verifyDistribution } from "./build-app.ts";
import { renderCaskFile, TAP_CASK_PATH } from "./release/cask.ts";
import {
  checkFromApp,
  type FromAppResults,
  fromAppCommands,
  fromAppPlan,
  parseReleaseArgs,
} from "./release/from-app.ts";
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
import {
  buildCommitOf,
  checkDistFiles,
  missingFiles,
  releaseMode,
  tagCommit,
} from "./release/reuse.ts";
import { notaryProfile, spawnExec } from "./signing.ts";
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

/** Commits in the tap that its upstream does not have (null when there is no upstream: pushing is needed) */
export function tapAhead(tapDir: string): number | null {
  const r = git(["rev-list", "--count", "@{u}..HEAD"], tapDir);
  return r.code === 0 ? Number(r.out) : null;
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

/** Validate the --from-app app (runs only reading commands) */
function validateFromApp(app: string, identity: string, version: string) {
  const c = fromAppCommands(app);
  const isDirectory = existsSync(app) && statSync(app).isDirectory();
  const results = Object.fromEntries(
    Object.entries(c).map(([k, cmd]) => [
      k,
      isDirectory ? spawnExec(cmd) : { code: 1, stdout: "", stderr: "" },
    ]),
  ) as FromAppResults;
  return checkFromApp({ app, isDirectory, identity, version, results });
}

const sha256Of = (file: string) =>
  new Bun.CryptoHasher("sha256").update(readFileSync(file)).digest("hex");

/** Info.plist TurnlaneBuild of an app (`<version>+<sha>`), or null */
function turnlaneBuildOf(app: string): string | null {
  const p = Bun.spawnSync(
    [
      "/usr/bin/plutil",
      "-extract",
      "TurnlaneBuild",
      "raw",
      "-o",
      "-",
      join(app, "Contents/Info.plist"),
    ],
    { stdout: "pipe", stderr: "pipe" },
  );
  return p.exitCode === 0 ? p.stdout.toString().trim() : null;
}

/** The commit to tag for an app: its build commit, if it is in this history (an ancestor of main) */
function tagCommitFor(app: string, version: string) {
  const build = buildCommitOf(turnlaneBuildOf(app), version);
  const resolved =
    "sha" in build ? git(["rev-parse", "--verify", "-q", `${build.sha}^{commit}`]) : null;
  const full = resolved && resolved.code === 0 && resolved.out ? resolved.out : null;
  return tagCommit({
    build,
    resolved: full,
    isAncestorOfMain:
      full !== null && git(["merge-base", "--is-ancestor", full, "main"]).code === 0,
    head: git(["rev-parse", "HEAD"]).out,
  });
}

/**
 * Verify an existing dist/release/v<version>/ (files against each other and the CHANGELOG, and the app inside the
 * zip like --from-app). Reads only: the zip is unpacked to a temporary folder. Returns the commit to tag too
 */
function verifyDist(o: {
  dir: string;
  version: string;
  downloadUrl: string;
  identity: string;
  changelog: string;
}): {
  errors: string[];
  warnings: string[];
  builtAt: Date | null;
  tag: ReturnType<typeof tagCommit> | null;
} {
  const files = releaseFiles(o.version);
  const at = (n: string) => join(o.dir, n);
  const missing = missingFiles(o.version, (n) => existsSync(at(n)));
  if (missing.length > 0)
    return { errors: [`missing: ${missing.join(", ")}`], warnings: [], builtAt: null, tag: null };
  const zipSha = sha256Of(at(files.zip));
  const errors = checkDistFiles({
    version: o.version,
    downloadUrl: o.downloadUrl,
    zipSha,
    latestZipSha: sha256Of(at(files.latestZip)),
    latestJson: readFileSync(at(files.latest), "utf8"),
    sha256File: readFileSync(at(files.sha256), "utf8"),
    cask: readFileSync(at(files.cask), "utf8"),
    expectedCask: renderCaskFile({ version: o.version, sha256: zipSha }),
    notes: readFileSync(at(files.notes), "utf8"),
    changelogSection: changelogSection(o.changelog, o.version),
  });
  const tmp = mkdtempSync(join(tmpdir(), "turnlane-dist-"));
  try {
    const x = Bun.spawnSync(["/usr/bin/ditto", "-x", "-k", at(files.zip), tmp], {
      stdout: "pipe",
      stderr: "pipe",
    });
    if (x.exitCode !== 0) {
      errors.push(`cannot unzip ${files.zip}: ${x.stderr.toString().trim()}`);
      return { errors, warnings: [], builtAt: null, tag: null };
    }
    const app = join(tmp, APP_NAME);
    const c = validateFromApp(app, o.identity, o.version);
    return {
      errors: [...errors, ...c.errors.map((e) => `the app in ${files.zip}: ${e}`)],
      warnings: c.warnings,
      builtAt: statSync(at(files.zip)).mtime,
      tag: tagCommitFor(app, o.version),
    };
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
}

/** Print the tag decision; false if it refuses */
function reportTag(t: ReturnType<typeof tagCommit>): t is { commit: string; note: string } {
  if ("error" in t) {
    console.error(`error: ${t.error}`);
    return false;
  }
  console.log(t.note);
  return true;
}

async function main(args: string[]): Promise<number> {
  const a = parseReleaseArgs(args);
  for (const e of a.errors) console.error(`error: ${e}`);
  if (a.errors.length > 0) return 2;
  const { dryRun, allowAdhoc, skipNotarize, publish } = a;
  const fromApp = a.fromApp ? resolve(a.fromApp) : null;
  const tapDir = a.tapDir ? resolve(a.tapDir) : defaultTapDir(ROOT);
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
  // 既にある一式（dist/release/v<版>/）: --publish は確かめて使い、--publish の無い実行は上書きを断る
  let mode = releaseMode(a, { exists: existsSync(dir), dir });
  if (mode.kind === "refuse") {
    console.error(`error: ${mode.reason}`);
    return 1;
  }
  let reused: { commit: string; note: string } | null = null;
  if (mode.kind === "reuse") {
    const d = verifyDist({
      dir,
      version: v,
      downloadUrl,
      identity: facts.identity ?? "",
      changelog: facts.changelog ?? "",
    });
    for (const w of d.warnings) console.log(`warning: ${w}`);
    if (d.errors.length === 0 && d.tag && !("error" in d.tag)) {
      console.log(
        `\nusing ${dir} built at ${d.builtAt?.toISOString() ?? "(unknown)"} (no rebuild)`,
      );
      reused = d.tag;
      console.log(d.tag.note);
    } else {
      if (d.tag && "error" in d.tag) {
        // ビルドのコミットがこの履歴に無い一式は使わない（作り直すのでなく、はっきり断る）
        console.error(`error: ${d.tag.error}`);
        if (d.errors.length === 0) return 1;
      }
      console.error(`${dir} cannot be reused:`);
      for (const e of d.errors) console.error(`  - ${e}`);
      mode = fromApp ? { kind: "from-app" } : { kind: "build" };
      console.error(`building a new set instead${fromApp ? " (from --from-app)" : ""}.`);
    }
  }
  let fromAppTag: { commit: string; note: string } | null = null;
  if (fromApp) {
    const t = tagCommitFor(fromApp, v);
    if (!reportTag(t)) return 1;
    fromAppTag = t;
  }
  const tagged = reused ?? fromAppTag;
  const steps = publishSteps({
    version: v,
    dir,
    tapDir: useTap ? tapDir : null,
    tapCommitted: useTap,
    ...(tagged ? { commit: tagged.commit } : {}),
  });

  if (dryRun) {
    console.log("\nWould run:");
    if (reused) console.log(`  (reuse ${dir}: no check, no build, no new files)`);
    else if (fromApp)
      for (const l of fromAppPlan({ app: fromApp, buildOut, version: v })) console.log(l);
    else {
      if (!a.skipCheck) console.log("  bun run check");
      console.log(
        `  bun run build:app --zip --download-url ${downloadUrl} --out ${buildOut}${skipNotarize ? " --skip-notarize" : ""}   # no extensions`,
      );
    }
    if (!reused) console.log(`  write ${dir}/{${Object.values(files).join(",")}}`);
    console.log(
      useTap
        ? `  write ${join(tapDir, TAP_CASK_PATH)} and commit it in ${tapDir} (no push)`
        : `  no tap at ${tapDir}: the cask is only written to ${dir}/${files.cask}`,
    );
    console.log(`  latest.json url: ${downloadUrl}  (update feed: ${LATEST_JSON_URL})`);
    console.log(`  ${files.latestZip}: a copy of ${files.zip} (site download: ${LATEST_ZIP_URL})`);
    printPublish(steps, v);
    if (fromApp) {
      // 確かめは読むだけなので乾式でも行う（公開の前に、そのアプリで続けられるかが分かる）
      const c = validateFromApp(fromApp, facts.identity ?? "", v);
      console.log(`\n--from-app ${fromApp}: ${c.errors.length === 0 ? "ok" : "not usable"}`);
      for (const w of c.warnings) console.log(`warning: ${w}`);
      for (const e of c.errors) console.error(`error: ${e}`);
      if (c.errors.length > 0) return 1;
    }
    return 0;
  }

  let commit: string | null = reused?.commit ?? null;
  if (!reused) {
    // --from-app: 2・3 の代わりに、確かめたアプリを写して zip と latest.json を作る
    const r =
      mode.kind === "from-app" && fromApp
        ? await fromAppBuild(fromApp, facts.identity ?? "", v, buildOut, downloadUrl)
        : await checkAndBuild(a.skipCheck, skipNotarize, allowAdhoc, buildOut, downloadUrl);
    if (!r) return 1;
    for (const l of r.verify) console.log(l);
    if (fromAppTag) commit = fromAppTag.commit;
    else {
      const t = tagCommitFor(join(buildOut, APP_NAME), v);
      if (!reportTag(t)) return 1;
      commit = t.commit;
    }
    writeDist(dir, v, r.zip, buildOut, downloadUrl, facts.changelog ?? "");
  }
  const cask = readFileSync(join(dir, files.cask), "utf8");

  // 5. tap
  let tapCommitted = false;
  if (useTap) {
    const t = commitTap(tapDir, cask, v);
    // 先の実行で作って push していない tap のコミットも push する（使い直した一式では cask が変わらない）
    const ahead = tapAhead(tapDir);
    tapCommitted = t === "committed" || ahead !== 0;
    console.log(
      `tap: ${t === "committed" ? "committed" : "cask unchanged"} in ${tapDir} (not pushed${ahead && ahead > 0 && t !== "committed" ? `; ${ahead} local commit${ahead > 1 ? "s" : ""} to push` : ""})`,
    );
  } else console.log(`tap: none at ${tapDir}; copy ${files.cask} to ${TAP_CASK_PATH} in the tap`);

  // 6. 公開
  const finalSteps = publishSteps({
    version: v,
    dir,
    tapDir: useTap ? tapDir : null,
    tapCommitted,
    ...(commit ? { commit } : {}),
  });
  if (!publish) {
    printPublish(finalSteps, v);
    return 0;
  }
  for (const s of finalSteps) {
    if (!(await confirm(s, a.yes))) {
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

/** 4. dist/release/v<版>/ を書く（zip とその複製・latest.json・sha256・cask・notes） */
function writeDist(
  dir: string,
  v: string,
  zip: string,
  buildOut: string,
  downloadUrl: string,
  changelog: string,
): void {
  const files = releaseFiles(v);
  rmSync(dir, { recursive: true, force: true });
  mkdirSync(dir, { recursive: true });
  copyFileSync(zip, join(dir, files.zip));
  copyFileSync(zip, join(dir, files.latestZip));
  copyFileSync(join(buildOut, "latest.json"), join(dir, files.latest));
  const sha = sha256Of(join(dir, files.zip));
  const latest = parseLatest(
    JSON.parse(readFileSync(join(dir, files.latest), "utf8")),
    LATEST_JSON_URL,
  );
  if (!latest || latest.version !== v || latest.sha256 !== sha || latest.url !== downloadUrl)
    throw new Error(`latest.json does not match the zip: ${JSON.stringify(latest)}`);
  writeFileSync(join(dir, files.sha256), sha256Line(sha, files.zip, files.latestZip));
  writeFileSync(join(dir, files.cask), renderCaskFile({ version: v, sha256: sha }));
  writeFileSync(join(dir, files.notes), `${changelogSection(changelog, v) ?? ""}\n`);
  console.log(`\n${dir}`);
  for (const n of Object.values(files)) console.log(`  ${n}`);
  console.log(`sha256: ${sha}`);
}

/** 2・3: bun run check と build:app（拡張なし）。失敗したら null */
async function checkAndBuild(
  skipCheck: boolean,
  skipNotarize: boolean,
  allowAdhoc: boolean,
  buildOut: string,
  downloadUrl: string,
): Promise<{ zip: string; verify: string[] } | null> {
  // 2. check
  if (!skipCheck) {
    console.log("\n# bun run check");
    const p = Bun.spawnSync(["bun", "run", "check"], {
      cwd: ROOT,
      stdout: "inherit",
      stderr: "inherit",
    });
    if (p.exitCode !== 0) {
      console.error("error: bun run check failed");
      return null;
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
    return null;
  }
  if (!allowAdhoc && !r.notarized) {
    console.error("error: the build was not notarized");
    return null;
  }
  if (!r.zip) throw new Error("build:app did not produce a zip");
  return { zip: r.zip, verify: r.verify };
}

/** --from-app: アプリを確かめ、out/release/Turnlane.app に写して zip と latest.json を作る。確かめに落ちたら null */
async function fromAppBuild(
  app: string,
  identity: string,
  version: string,
  buildOut: string,
  downloadUrl: string,
): Promise<{ zip: string; verify: string[] } | null> {
  console.log(`\n# --from-app ${app} (no check, no build)`);
  const c = validateFromApp(app, identity, version);
  for (const w of c.warnings) console.log(`warning: ${w}`);
  for (const e of c.errors) console.error(`error: ${e}`);
  if (c.errors.length > 0) return null;
  mkdirSync(buildOut, { recursive: true });
  const dst = join(buildOut, APP_NAME);
  if (resolve(app) !== resolve(dst)) {
    rmSync(dst, { recursive: true, force: true });
    const p = Bun.spawnSync(["/usr/bin/ditto", app, dst], { stdout: "pipe", stderr: "pipe" });
    if (p.exitCode !== 0) throw new Error(`ditto ${app} ${dst} failed:\n${p.stderr.toString()}`);
  }
  const { zip } = packageApp({ app: dst, outDir: buildOut, version, downloadUrl });
  return { zip, verify: verifyDistribution(dst, true) };
}

if (import.meta.main) {
  process.exit(await main(process.argv.slice(2)));
}
