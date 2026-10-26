/**
 * 配布物 Turnlane.app を組み立てる（phase0-plan M6-13、ADR 0011 決定 1、onboarding.md 2.1）。
 *
 *   bun run build:app [--out <dir>] [--ext <dir>]... [--skip-web] [--zip --download-url <url>] [--debug-webview]
 *                     [--skip-notarize] [--dry-run]
 *
 *   Turnlane.app/Contents/
 *     MacOS/turnlane                                   Tauri のシェル（dev.turnlane.desktop）
 *     Helpers/turnlaned, Helpers/turnlane              scripts/build.ts の単一バイナリ（--ext の拡張を組み込む）
 *     Library/LoginItems/TurnlaneCalendarHelper.app    native/calendar-helper（dev.turnlane.calendar-helper）
 *     Library/LaunchAgents/dev.turnlane.daemon.plist           SMAppService.agent で登録（BundleProgram は相対）
 *     Library/LaunchAgents/dev.turnlane.calendar-helper.plist
 *     Info.plist                                       用途の説明・LSMinimumSystemVersion 14.0・TurnlaneBuild
 *
 * - --ext は scripts/build.ts と同じ（ADR 0015。汎用の口。指定が無ければ公開のビルド）
 * - 版はルートの package.json（scripts/version.ts）。アプリ・ヘルパ・turnlaned・turnlane・latest.json が同じ値になる
 * - 署名は内側から: Helpers の 2 つ（build.ts。hardened runtime・allow-jit）→ ヘルパの .app（build-app.sh）→
 *   Turnlane.app（ここ）。証明書は TURNLANE_CODESIGN_IDENTITY（無ければ ad-hoc の -）
 * - Developer ID（配布用。判定は scripts/signing.ts）なら全部の署名に --timestamp を付け、TURNLANE_NOTARY_PROFILE
 *   （notarytool のキーチェーンのプロファイル名）があれば公証して staple する（M6-8、docs/dev/codesign.md 5 章）。
 *   プロファイルが無ければ警告を 1 行（--skip-notarize なら黙る）。Apple Development・ad-hoc は公証しない。
 *   最後に配布用なら spctl と stapler validate の結果を出す
 * - --dry-run: 組み立てずに、署名・公証・確認のコマンド列を出すだけ（codesign / notarytool / stapler を実行しない）
 * - --zip: Turnlane-<版>.zip（ditto -c -k --keepParent。公証したときは staple 後の .app から）と latest.json（M6-12 の更新確認の形。url は --download-url）
 * - --debug-webview: お試し版だけ。Safari の開発メニューから Turnlane のウインドウ（起動ページ・SPA）の Web Inspector を
 *   開けるようにする（シェルの cargo feature `inspector` = tauri/devtools）。既定のビルドには入らない
 * 最後に checkBundle（形・版・署名）で確かめ、失敗したら out には置かない
 */
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { basename, join, resolve } from "node:path";
import { bundleAgentPlist } from "../apps/daemon/src/launchd/plist.ts";
import { parseLatest } from "../packages/core/src/update.ts";
import { build, codesignIdentity, signCommand } from "./build.ts";
import { extArgs } from "./ext-manifest.ts";
import {
  codesignFailureHint,
  describeSpctl,
  type Exec,
  isDistribution,
  notarize,
  notarizeCommands,
  notarizeDecision,
  notaryProfile,
  StapleError,
  signatureProblems,
  signKind,
  spawnExec,
  timestampArgs,
  verifyCommands,
} from "./signing.ts";
import { buildVersion, productVersion } from "./version.ts";

const ROOT = resolve(import.meta.dir, "..");

export const APP_NAME = "Turnlane.app";
export const APP_BUNDLE_ID = "dev.turnlane.desktop";
export const HELPER_APP = "TurnlaneCalendarHelper.app";
export const AGENTS = [
  {
    label: "dev.turnlane.daemon",
    bundleProgram: "Contents/Helpers/turnlaned",
    keepAlive: true,
  },
  {
    label: "dev.turnlane.calendar-helper",
    bundleProgram: `Contents/Library/LoginItems/${HELPER_APP}/Contents/MacOS/TurnlaneCalendarHelper`,
    keepAlive: true,
    processType: "Interactive" as const,
  },
] as const;

const USAGE: Record<string, string> = {
  NSCalendarsFullAccessUsageDescription:
    "Turnlane shows your calendar events next to your tasks and AI work, and does not count AI waits during your meetings as idle time. Events stay on this Mac.",
  NSAppleEventsUsageDescription:
    "Turnlane opens a new tab in your terminal or editor when you ask an AI to work on a task or reopen a session.",
};

function run(
  cmd: string[],
  o: { cwd?: string; env?: Record<string, string>; unset?: readonly string[] } = {},
): string {
  const env: Record<string, string | undefined> = { ...process.env, ...o.env };
  for (const k of o.unset ?? []) delete env[k];
  const p = Bun.spawnSync(cmd, {
    cwd: o.cwd ?? ROOT,
    stdout: "pipe",
    stderr: "pipe",
    env,
  });
  if (p.exitCode !== 0)
    throw new Error(`${cmd.join(" ")} failed:\n${p.stdout.toString()}${p.stderr.toString()}`);
  return p.stdout.toString();
}

function plistSet(file: string, key: string, value: string): void {
  run(["/usr/bin/plutil", "-replace", key, "-string", value, file]);
}

function plistGet(file: string, key: string): string | null {
  const p = Bun.spawnSync(["/usr/bin/plutil", "-extract", key, "raw", "-o", "-", file], {
    stdout: "pipe",
    stderr: "pipe",
  });
  return p.exitCode === 0 ? p.stdout.toString().trim() : null;
}

/**
 * 外側の Turnlane.app の entitlements。hardened runtime のアプリは、カレンダーの許可を求めるのに
 * `com.apple.security.personal-information.calendars` が要る（無いと TCC はダイアログを出さずに断り、システム設定にも行が出ない）。
 * 同梱のヘルパ（SMAppService の LoginItems。open で起動しても同じ）のカレンダーの要求は、責任のあるアプリとして
 * Turnlane.app に帰属する（2026-10-21 の Neo: ad-hoc + runtime・entitlements 無しで「未決定」のまま。onboarding.md 2.3）
 */
export const APP_ENTITLEMENTS = join(ROOT, "scripts/app.entitlements");
/**
 * turnlaned の osascript（「開く」「答える」でターミナルを操作する。open.md）のオートメーションの許可も Turnlane.app に
 * 帰属するので、同じ理由で `com.apple.security.automation.apple-events` が要る（docs/dev/codesign.md 3 章）
 */
export const APP_REQUIRED_ENTITLEMENTS = [
  "com.apple.security.personal-information.calendars",
  "com.apple.security.automation.apple-events",
];

/**
 * 同梱のカレンダーヘルパの entitlements（hardened runtime。M6-8、codesign.md 3 章）。署名は
 * native/calendar-helper/scripts/build-app.sh が行い、引数は helperSignCommand と同じ（テストで突き合わせる）
 */
export const HELPER_ENTITLEMENTS = join(
  ROOT,
  "native/calendar-helper/Resources/CalendarHelper.entitlements",
);
export const HELPER_REQUIRED_ENTITLEMENTS = ["com.apple.security.personal-information.calendars"];
export const HELPER_BUNDLE_ID = "dev.turnlane.calendar-helper";

/** ヘルパの .app の署名のコマンド（build-app.sh と同じ形。乾式の表示とテスト用） */
export function helperSignCommand(app: string, identity: string): string[] {
  return [
    "codesign",
    "--force",
    "--options",
    "runtime",
    ...timestampArgs(identity),
    "--entitlements",
    HELPER_ENTITLEMENTS,
    "--identifier",
    HELPER_BUNDLE_ID,
    "--sign",
    identity,
    app,
  ];
}

/** 署名のコマンド（外側の Turnlane.app。中身は先に署名済み。--deep は使わない） */
export function appSignCommand(app: string, identity: string): string[] {
  return [
    "codesign",
    "--force",
    "--options",
    "runtime",
    ...timestampArgs(identity),
    "--entitlements",
    APP_ENTITLEMENTS,
    "--identifier",
    APP_BUNDLE_ID,
    "-s",
    identity,
    app,
  ];
}

/** Tauri が自分で公証を始める環境変数（公証は build-app.ts が外側の .app で 1 回だけ行うので、シェルのビルドには渡さない） */
export const TAURI_NOTARIZE_ENV = [
  "APPLE_ID",
  "APPLE_PASSWORD",
  "APPLE_TEAM_ID",
  "APPLE_API_KEY",
  "APPLE_API_ISSUER",
  "APPLE_API_KEY_PATH",
];

/** 署名した部品（内側から）。checkBundle が 1 つずつ確かめる */
const SIGNED_PARTS = [
  { rel: "Contents/Helpers/turnlaned", required: [] as readonly string[] },
  { rel: "Contents/Helpers/turnlane", required: [] as readonly string[] },
  { rel: `Contents/Library/LoginItems/${HELPER_APP}`, required: HELPER_REQUIRED_ENTITLEMENTS },
  { rel: "", required: APP_REQUIRED_ENTITLEMENTS },
] as const;

/** 署名の情報（codesign -d --verbose=2 の stderr）と entitlements の XML（stdout）。読めなければ空 */
function signatureInfo(path: string): { info: string; xml: string } {
  const p = Bun.spawnSync(["codesign", "-d", "--verbose=2", "--entitlements", "-", "--xml", path], {
    stdout: "pipe",
    stderr: "pipe",
  });
  return p.exitCode === 0
    ? { info: p.stderr.toString(), xml: p.stdout.toString() }
    : { info: "", xml: "" };
}

/**
 * 組み立てたバンドルを確かめる（形・plist・版）。問題の一覧を返す（空なら合格）。
 * signature: true なら codesign --verify --strict --deep と、部品ごとの hardened runtime・entitlements（公証で拒まれる
 * get-task-allow などが無いこと）も見る。distribution: true なら Developer ID の証明書とセキュアタイムスタンプも見る
 */
export function checkBundle(
  app: string,
  o: {
    version?: string;
    build?: string;
    signature?: boolean;
    runVersion?: boolean;
    distribution?: boolean;
  } = {},
): string[] {
  const problems: string[] = [];
  const must = (rel: string) => {
    if (!existsSync(join(app, rel))) problems.push(`missing: ${rel}`);
  };
  for (const rel of [
    "Contents/Info.plist",
    "Contents/MacOS/turnlane",
    "Contents/Helpers/turnlaned",
    "Contents/Helpers/turnlane",
    `Contents/Library/LoginItems/${HELPER_APP}/Contents/Info.plist`,
  ])
    must(rel);
  for (const a of AGENTS) {
    const rel = `Contents/Library/LaunchAgents/${a.label}.plist`;
    const file = join(app, rel);
    if (!existsSync(file)) {
      problems.push(`missing: ${rel}`);
      continue;
    }
    if (Bun.spawnSync(["/usr/bin/plutil", "-lint", "-s", file]).exitCode !== 0)
      problems.push(`invalid plist: ${rel}`);
    if (plistGet(file, "Label") !== a.label) problems.push(`${rel}: Label`);
    const prog = plistGet(file, "BundleProgram");
    if (prog !== a.bundleProgram || !existsSync(join(app, a.bundleProgram)))
      problems.push(`${rel}: BundleProgram ${prog ?? "(none)"}`);
  }
  const info = join(app, "Contents/Info.plist");
  if (existsSync(info)) {
    if (plistGet(info, "CFBundleIdentifier") !== APP_BUNDLE_ID)
      problems.push("Info.plist: bundle ID");
    if (plistGet(info, "LSMinimumSystemVersion") !== "14.0")
      problems.push("Info.plist: LSMinimumSystemVersion");
    for (const k of Object.keys(USAGE)) if (!plistGet(info, k)) problems.push(`Info.plist: ${k}`);
    const v = plistGet(info, "CFBundleShortVersionString");
    const helperV = plistGet(
      join(app, `Contents/Library/LoginItems/${HELPER_APP}/Contents/Info.plist`),
      "CFBundleShortVersionString",
    );
    const b = plistGet(info, "TurnlaneBuild");
    if (o.version && v !== o.version) problems.push(`app version ${v} != ${o.version}`);
    if (o.version && helperV !== o.version)
      problems.push(`helper version ${helperV} != ${o.version}`);
    if (o.build && b !== o.build) problems.push(`TurnlaneBuild ${b} != ${o.build}`);
    if (o.runVersion && b) {
      for (const name of ["turnlaned", "turnlane"]) {
        const p = Bun.spawnSync([join(app, "Contents/Helpers", name), "--version"], {
          stdout: "pipe",
          stderr: "pipe",
          env: { PATH: "/usr/bin:/bin" },
        });
        const out = p.stdout.toString().trim();
        if (out !== `${name} ${b}`) problems.push(`${name} --version: ${out || p.exitCode}`);
      }
    }
  }
  if (o.signature) {
    const p = Bun.spawnSync(["codesign", "--verify", "--strict", "--deep", app], {
      stdout: "pipe",
      stderr: "pipe",
    });
    if (p.exitCode !== 0) problems.push(`codesign: ${p.stderr.toString().trim()}`);
    for (const part of SIGNED_PARTS) {
      const path = part.rel ? join(app, part.rel) : app;
      const s = signatureInfo(path);
      problems.push(
        ...signatureProblems(part.rel || APP_NAME, s.info, s.xml, {
          distribution: !!o.distribution,
          requiredEntitlements: part.required,
        }),
      );
    }
  }
  return problems;
}

/** latest.json（M6-12 の更新確認が読む形。core の parseLatest で検証できること） */
export function latestJson(x: { version: string; url: string; sha256: string }): string {
  const body = { version: x.version, url: x.url, sha256: x.sha256 };
  if (!parseLatest(body, x.url))
    throw new Error(`latest.json would not parse: ${JSON.stringify(body)}`);
  return `${JSON.stringify(body, null, 2)}\n`;
}

const AD_HOC_WARNING =
  "warning: signing Turnlane.app ad-hoc. Do not hand this build to anyone: ad-hoc builds have no Team ID, so after a reinstall or a move launchd kills the registered background items (Launch Constraint Violation). Set TURNLANE_CODESIGN_IDENTITY to an Apple Development (or Developer ID) certificate. See docs/dev/codesign.md 4.";

const KIND_LABEL = {
  "developer-id": "Developer ID (distribution: secure timestamp, notarization)",
  "apple-development": "Apple Development (no notarization)",
  "ad-hoc": "ad-hoc (-)",
  other: "certificate given by hash or another name (treated as non-distribution: no notarization)",
} as const;

const q = (a: string) => (/^[\w@%+=:,./-]+$/.test(a) ? a : `'${a.replaceAll("'", "'\\''")}'`);
const shell = (cmd: readonly string[]) => cmd.map(q).join(" ");

/**
 * 乾式（--dry-run）: 署名・公証・確認のコマンド列を、実行せずに行の配列で返す。実際のビルドと同じ組み立ての関数を使う。
 * 場所は <stage>（一時の組み立て場所）と outDir で示す
 */
export function buildPlan(o: {
  identity: string;
  profile: string | null;
  skipNotarize?: boolean;
  zip?: boolean;
  outDir: string;
  version: string;
}): string[] {
  const stage = "<stage>";
  const app = join(stage, APP_NAME);
  const lines = [`identity: ${KIND_LABEL[signKind(o.identity)]}`];
  if (o.identity === "-") lines.push(AD_HOC_WARNING);
  lines.push("# 1. turnlaned / turnlane (scripts/build.ts)");
  for (const name of ["turnlaned", "turnlane"])
    lines.push(shell(signCommand(join(stage, "bin", name), name, o.identity)));
  lines.push("# 2. calendar helper (native/calendar-helper/scripts/build-app.sh)");
  lines.push(shell(helperSignCommand(join(stage, "helper", HELPER_APP), o.identity)));
  lines.push(
    "# 3. Turnlane.app (Tauri builds the shell with APPLE_SIGNING_IDENTITY; this outer signature replaces it after the parts are copied in)",
  );
  lines.push(shell(appSignCommand(app, o.identity)));
  lines.push(shell(["codesign", "--verify", "--strict", "--deep", app]));
  const d = notarizeDecision({
    identity: o.identity,
    profile: o.profile,
    skip: !!o.skipNotarize,
  });
  if (d.action === "notarize") {
    lines.push("# 4. notarize and staple");
    const c = notarizeCommands(app, join(stage, "notarize.zip"), d.profile);
    lines.push(shell(c.zip), shell(c.submit));
    lines.push("#    Accepted → staple; anything else → print the log and fail:");
    lines.push(`#    ${shell(c.log("<submission id>"))}`);
    lines.push(shell(c.staple), shell(c.validate));
  } else {
    lines.push(
      `# 4. notarize: skipped${o.skipNotarize ? " (--skip-notarize)" : isDistribution(o.identity) ? "" : " (not a Developer ID certificate)"}`,
    );
    if (d.warning) lines.push(d.warning);
  }
  const dst = join(o.outDir, APP_NAME);
  if (o.zip) {
    lines.push(`# 5. zip${d.action === "notarize" ? " (the stapled app)" : ""}`);
    lines.push(
      shell([
        "/usr/bin/ditto",
        "-c",
        "-k",
        "--keepParent",
        dst,
        join(o.outDir, `Turnlane-${o.version}.zip`),
      ]),
    );
  }
  if (isDistribution(o.identity)) {
    lines.push("# 6. check");
    const v = verifyCommands(dst);
    lines.push(shell(v.spctl), shell(v.stapler));
  }
  return lines;
}

/** 配布用のビルドの最後の確認（spctl と stapler validate）。結果の行を返す */
export function verifyDistribution(
  app: string,
  notarized: boolean,
  exec: Exec = spawnExec,
): string[] {
  const v = verifyCommands(app);
  const lines = [describeSpctl(exec(v.spctl), notarized)];
  const st = exec(v.stapler);
  lines.push(
    st.code === 0
      ? "stapler validate: ok (ticket stapled)"
      : `stapler validate: no ticket${notarized ? ` (${`${st.stdout}${st.stderr}`.trim()})` : " (not notarized)"}`,
  );
  return lines;
}

export async function buildApp(o: {
  outDir?: string;
  ext?: readonly string[];
  skipWeb?: boolean;
  zip?: { downloadUrl: string } | null;
  debugWebview?: boolean;
  skipNotarize?: boolean;
}) {
  const outDir = resolve(o.outDir ?? join(ROOT, "out", "app"));
  const identity = codesignIdentity() ?? "-";
  const distribution = isDistribution(identity);
  const decision = notarizeDecision({
    identity,
    profile: notaryProfile(),
    skip: !!o.skipNotarize,
  });
  if (identity === "-") console.error(AD_HOC_WARNING);
  const version = productVersion(ROOT);
  const buildId = buildVersion(ROOT);
  mkdirSync(outDir, { recursive: true });
  const stage = mkdtempSync(join(outDir, ".stage-"));
  let keepStage = false;
  try {
    // 1. turnlaned / turnlane（拡張を組み込み、内側から署名）
    const bin = join(stage, "bin");
    const b = await build({
      outDir: bin,
      identity,
      ...(o.ext ? { ext: o.ext } : {}),
      ...(o.skipWeb ? { skipWeb: true } : {}),
    });
    if (b.version !== buildId) throw new Error(`version mismatch: ${b.version} != ${buildId}`);
    // 2. カレンダーヘルパ（版を書き込んで署名）
    const env = { TURNLANE_CODESIGN_IDENTITY: identity };
    run(["native/calendar-helper/scripts/build-app.sh", join(stage, "helper")], { env });
    // 3. シェル（Tauri。版を書き込む）
    run(["apps/desktop/scripts/build.sh", join(stage, "desktop")], {
      env: o.debugWebview ? { ...env, TURNLANE_DESKTOP_FEATURES: "inspector" } : env,
      unset: TAURI_NOTARIZE_ENV,
    });

    // 4. 組み立て
    const app = join(stage, APP_NAME);
    run(["/usr/bin/ditto", join(stage, "desktop", APP_NAME), app]);
    mkdirSync(join(app, "Contents/Helpers"), { recursive: true });
    for (const name of ["turnlaned", "turnlane"])
      run(["/usr/bin/ditto", join(bin, name), join(app, "Contents/Helpers", name)]);
    mkdirSync(join(app, "Contents/Library/LoginItems"), { recursive: true });
    run([
      "/usr/bin/ditto",
      join(stage, "helper", HELPER_APP),
      join(app, "Contents/Library/LoginItems", HELPER_APP),
    ]);
    mkdirSync(join(app, "Contents/Library/LaunchAgents"), { recursive: true });
    for (const a of AGENTS)
      writeFileSync(
        join(app, "Contents/Library/LaunchAgents", `${a.label}.plist`),
        bundleAgentPlist({ ...a, associatedBundleId: APP_BUNDLE_ID }),
      );
    const info = join(app, "Contents/Info.plist");
    plistSet(info, "TurnlaneBuild", buildId);
    plistSet(info, "LSMinimumSystemVersion", "14.0");
    for (const [k, v] of Object.entries(USAGE)) plistSet(info, k, v);
    // Web Inspector 入りのお試し版の目印（見分けるため）
    if (o.debugWebview) plistSet(info, "TurnlaneDebugWebview", "1");

    // 5. 外側を署名し直す（中身を足したので）
    try {
      run(appSignCommand(app, identity));
    } catch (e) {
      const hint = codesignFailureHint(identity, (e as Error).message);
      throw hint ? new Error(`${hint}\n${(e as Error).message}`) : e;
    }
    const problems = checkBundle(app, {
      version,
      build: buildId,
      signature: true,
      runVersion: true,
      distribution,
    });
    if (problems.length > 0) throw new Error(`bundle check failed:\n- ${problems.join("\n- ")}`);

    // 5b. 公証と staple（Developer ID かつ TURNLANE_NOTARY_PROFILE があるとき。zip を送り、.app に staple）
    let notarized: { id: string } | null = null;
    if (decision.action === "notarize") {
      try {
        notarized = notarize(app, join(stage, "notarize.zip"), decision.profile);
      } catch (e) {
        // 公証は通って staple だけ落ちたときは、手でやり直せるよう作業フォルダを残す
        if (e instanceof StapleError) {
          keepStage = true;
          throw new Error(
            `${e.message}\nThe work folder was kept so you can staple by hand: ${stage}\nDelete it when done (rm -rf "${stage}").`,
          );
        }
        throw e;
      }
    } else if (decision.warning) console.error(decision.warning);

    // 6. 置き換え
    const dst = join(outDir, APP_NAME);
    rmSync(dst, { recursive: true, force: true });
    renameSync(app, dst);
    let zipPath: string | null = null;
    if (o.zip) {
      zipPath = join(outDir, `Turnlane-${version}.zip`);
      rmSync(zipPath, { force: true });
      run(["/usr/bin/ditto", "-c", "-k", "--keepParent", dst, zipPath]);
      const sha = new Bun.CryptoHasher("sha256").update(readFileSync(zipPath)).digest("hex");
      writeFileSync(
        join(outDir, "latest.json"),
        latestJson({ version, url: o.zip.downloadUrl, sha256: sha }),
      );
    }
    // 7. 確認（配布用だけ。公証していなければ spctl は「未公証」として出す）
    const verify = distribution ? verifyDistribution(dst, notarized !== null) : [];
    return {
      app: dst,
      version,
      build: buildId,
      identity,
      extensions: b.extensions,
      zip: zipPath,
      debugWebview: !!o.debugWebview,
      notarized,
      verify,
    };
  } finally {
    if (!keepStage) rmSync(stage, { recursive: true, force: true });
  }
}

if (import.meta.main) {
  const args = process.argv.slice(2);
  const val = (k: string) => {
    const i = args.indexOf(k);
    return i >= 0 ? args[i + 1] : undefined;
  };
  const url = val("--download-url");
  if (args.includes("--zip") && !url) {
    console.error("error: --zip needs --download-url <url> (the asset URL written to latest.json)");
    process.exit(2);
  }
  if (args.includes("--dry-run")) {
    const lines = buildPlan({
      identity: codesignIdentity() ?? "-",
      profile: notaryProfile(),
      skipNotarize: args.includes("--skip-notarize"),
      zip: args.includes("--zip"),
      outDir: resolve(val("--out") ?? join(ROOT, "out", "app")),
      version: productVersion(ROOT),
    });
    for (const l of lines) console.log(l);
    process.exit(0);
  }
  const r = await buildApp({
    ...(val("--out") ? { outDir: val("--out") as string } : {}),
    ext: extArgs(args),
    skipWeb: args.includes("--skip-web"),
    zip: url && args.includes("--zip") ? { downloadUrl: url } : null,
    debugWebview: args.includes("--debug-webview"),
    skipNotarize: args.includes("--skip-notarize"),
  });
  console.log(`${basename(r.app)} ${r.build}`);
  console.log(`signed: ${r.identity === "-" ? "ad-hoc (-)" : r.identity}`);
  if (r.notarized) console.log(`notarized: submission ${r.notarized.id} (stapled)`);
  for (const l of r.verify) console.log(l);
  console.log(`extensions: ${r.extensions.length > 0 ? r.extensions.join(", ") : "(none)"}`);
  if (r.debugWebview) console.log("web inspector: on (Safari › Develop menu; trial builds only)");
  console.log(r.app);
  if (r.zip) console.log(r.zip);
}
