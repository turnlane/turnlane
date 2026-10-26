/**
 * turnlaned / turnlane の単一バイナリを out/ に作る（M0-10、ADR 0007）。
 *
 *   bun scripts/build.ts [--skip-web] [--out <dir>] [--ext <dir>]...
 *
 * --ext は組み込む拡張（ADR 0015。dir に extension.json）。繰り返せる。指定が無ければ拡張の一覧は空（公開のビルド）。
 * 拡張の一覧は .build/extensions.gen.ts（デーモン）と .build/ext-web.gen.ts（Web。Vite の alias `@turnlane/ext-web`）に作る
 *
 * 1. apps/web を Vite でビルド（--skip-web なら既存の dist/ を使う）
 * 2. dist/ の一覧から埋め込み用モジュールを .build/ に生成（M0-9）
 * 3. `bun build --compile --minify --bytecode --format=esm --target=bun-darwin-arm64` で
 *    turnlaned と turnlane を作る。--format=esm は必須（--bytecode の既定は CJS でトップレベル await が通らない）
 * 4. TURNLANE_CODESIGN_IDENTITY があれば、その証明書で turnlaned と turnlane を署名し直す（D-060）。
 *    hardened runtime、JIT 用の entitlements（scripts/bun-binary.entitlements）、識別子は dev.turnlane.<名前>。
 *    署名後に `codesign --verify --strict` と `--version` での起動を確かめる。
 *    Developer ID（配布用）なら --timestamp を付ける（scripts/signing.ts。M6-8）。
 *    無ければ今までどおり（bun が付けるリンカの ad-hoc 署名のまま。識別子は a.out）。
 *    `-` を入れると ad-hoc で同じ手順を通す（テストと確認用。cdhash がビルドごとに変わるので常用には向かない）
 */
import { existsSync, mkdirSync, statSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { extArgs, readExtManifests, writeExtLists } from "./ext-manifest.ts";
import { generateWebAssetsModule } from "./gen-web-assets.ts";
import { codesignFailureHint, timestampArgs } from "./signing.ts";
import { buildVersion } from "./version.ts";

const ROOT = resolve(import.meta.dir, "..");
/**
 * hardened runtime で署名するときの entitlements（D-060。AMFI はコメント入りの plist を読めないので説明はここに書く）。
 * JavaScriptCore の JIT は MAP_JIT を使うので allow-jit が要る。無いと JIT が切られ、計算の重い処理が数倍遅くなる
 * （実測: 同じループで 1.0s → 7.8s）。在席の記録（D-105、ADR 0013）は bun:ffi で CoreGraphics（システムのフレームワーク）を
 * 呼ぶ。bun:ffi も JIT を要し、allow-jit だけで動く（S-A1: ad-hoc・hardened runtime・allow-jit のコンパイル済みバイナリで
 * 確認。allow-jit が無いと "bun:ffi requires the JIT" で失敗し、デーモンは ioreg に切り替える）。Bun のドキュメントが挙げる
 * 他の項目（allow-unsigned-executable-memory、disable-library-validation など）は、サードパーティの dylib を使わないので付けない。
 */
export const ENTITLEMENTS = join(ROOT, "scripts", "bun-binary.entitlements");
export const COMPILE_FLAGS = [
  "--compile",
  "--minify",
  "--bytecode",
  "--format=esm",
  "--target=bun-darwin-arm64",
] as const;

function run(cmd: string[], cwd = ROOT): string {
  const p = Bun.spawnSync(cmd, { cwd, stdout: "pipe", stderr: "pipe" });
  if (p.exitCode !== 0) {
    throw new Error(`${cmd.join(" ")} failed:\n${p.stdout.toString()}${p.stderr.toString()}`);
  }
  return p.stdout.toString();
}

/** 署名に使う証明書（名前か SHA-1）。未設定・空なら null（署名し直さない） */
export function codesignIdentity(env: Record<string, string | undefined> = process.env) {
  const v = env.TURNLANE_CODESIGN_IDENTITY?.trim();
  return v ? v : null;
}

/** バイナリのコード署名の識別子。TCC は許可をこの識別子と証明書（指定要件）で覚える */
export function codesignIdentifier(name: string): string {
  return `dev.turnlane.${name}`;
}

/**
 * 署名のコマンド。Developer ID（配布用）ならセキュアタイムスタンプ（--timestamp）を付け、それ以外は --timestamp=none
 * （判定は signing.ts。M6-8）
 */
export function signCommand(file: string, name: string, identity: string): string[] {
  return [
    "codesign",
    "--force",
    "--options",
    "runtime",
    ...timestampArgs(identity),
    "--entitlements",
    ENTITLEMENTS,
    "--identifier",
    codesignIdentifier(name),
    "-s",
    identity,
    file,
  ];
}

/** 署名し、検証と起動（`<file> --version` が `<name> ` で始まる）を確かめる。失敗したら例外 */
export function signBinary(file: string, name: string, identity: string): void {
  try {
    run(signCommand(file, name, identity));
  } catch (e) {
    const hint = codesignFailureHint(identity, (e as Error).message);
    throw hint ? new Error(`${hint}\n${(e as Error).message}`) : e;
  }
  run(["codesign", "--verify", "--strict", file]);
  const p = Bun.spawnSync(["codesign", "-d", "--verbose=2", file], {
    stdout: "pipe",
    stderr: "pipe",
  });
  const info = `${p.stdout.toString()}${p.stderr.toString()}`;
  if (
    !info.includes(`Identifier=${codesignIdentifier(name)}`) ||
    !/flags=0x[0-9a-f]+\([^)]*runtime/.test(info)
  ) {
    throw new Error(`${file}: unexpected signature\n${info}`);
  }
  const out = run([file, "--version"]).trim();
  if (!out.startsWith(`${name} `)) {
    throw new Error(`${file} --version: unexpected output: ${out}`);
  }
}

export async function build(
  opts: {
    skipWeb?: boolean;
    outDir?: string;
    identity?: string | null;
    /** 組み込む拡張のディレクトリ（ADR 0015） */
    ext?: readonly string[];
  } = {},
) {
  const identity = opts.identity === undefined ? codesignIdentity() : opts.identity;
  const outDir = resolve(opts.outDir ?? join(ROOT, "out"));
  const buildDir = join(ROOT, ".build");
  mkdirSync(outDir, { recursive: true });
  mkdirSync(buildDir, { recursive: true });

  const manifests = readExtManifests(opts.ext ?? []);
  const lists = writeExtLists(buildDir, manifests);
  if (!opts.skipWeb)
    runWebBuild(
      lists.web,
      undefined,
      // Tailwind の走査に足すのは Web の入口のディレクトリだけ（拡張のリポジトリの他の場所は見ない）
      manifests.flatMap((m) => (m.web ? [dirname(m.web)] : [])),
    );
  const assets = await generateWebAssetsModule(
    join(ROOT, "apps/web/dist"),
    join(buildDir, "web-assets.gen.ts"),
  );
  writeFileSync(
    join(buildDir, "turnlaned.ts"),
    [
      "// 自動生成（scripts/build.ts）。turnlaned の単一バイナリ用エントリ",
      'import { runDaemon } from "../apps/daemon/src/bin.ts";',
      'import { extensions } from "./extensions.gen.ts";',
      'import { webAssets } from "./web-assets.gen.ts";',
      "await runDaemon(process.argv.slice(2), webAssets, extensions);",
      "",
    ].join("\n"),
  );

  const v = buildVersion(ROOT);
  const define = ["--define", `__TURNLANE_VERSION__=${JSON.stringify(v)}`];
  const targets = [
    { name: "turnlaned", entry: join(buildDir, "turnlaned.ts") },
    { name: "turnlane", entry: join(ROOT, "apps/cli/src/main.ts") },
  ];
  const result: Record<string, number> = {};
  for (const t of targets) {
    const out = join(outDir, t.name);
    run([process.execPath, "build", ...COMPILE_FLAGS, ...define, t.entry, "--outfile", out]);
    if (identity) signBinary(out, t.name, identity);
    result[t.name] = statSync(out).size;
  }
  return {
    version: v,
    outDir,
    webAssets: assets,
    sizes: result,
    identity,
    extensions: manifests.map((m) => m.id),
  };
}

/**
 * out/Turnlane.app が apps/desktop の最後のコミットより古いか（`bun run build` はアプリを作らない。古いアプリのまま
 * self-install すると Rust 側の直しが入らない。集中モードの問いのボタンの調査で、10/8 のアプリが動き続けていた）
 */
export function desktopAppStale(
  appBuiltAtMs: number | null,
  lastDesktopCommitMs: number | null,
): boolean {
  return (
    appBuiltAtMs !== null && lastDesktopCommitMs !== null && appBuiltAtMs < lastDesktopCommitMs
  );
}

/** out の Turnlane.app の実行ファイルの時刻と apps/desktop の最後のコミットの時刻（どちらか無ければ null） */
export function desktopAppTimes(
  outDir: string,
  root = ROOT,
): { app: number | null; commit: number | null } {
  const exe = join(outDir, "Turnlane.app", "Contents", "MacOS", "turnlane");
  const app = existsSync(exe) ? statSync(exe).mtimeMs : null;
  const p = Bun.spawnSync(["git", "log", "-1", "--format=%ct", "--", "apps/desktop"], {
    cwd: root,
    stdout: "pipe",
    stderr: "pipe",
  });
  const sec = p.exitCode === 0 ? Number.parseInt(p.stdout.toString().trim(), 10) : Number.NaN;
  return { app, commit: Number.isFinite(sec) ? sec * 1000 : null };
}

/**
 * Web のビルド。拡張があれば TURNLANE_EXT_WEB に一覧のモジュールを渡す（vite.config.ts の alias）。
 * outDir を渡すとそこに出す（E2E の拡張つきのビルド。既定は apps/web/dist）
 */
export function runWebBuild(
  extWeb: string | null,
  outDir?: string,
  extSources: readonly string[] = [],
): void {
  const extra = outDir ? ["--outDir", outDir, "--emptyOutDir"] : [];
  const p = Bun.spawnSync([process.execPath, "run", "--cwd", "apps/web", "build", ...extra], {
    cwd: ROOT,
    stdout: "pipe",
    stderr: "pipe",
    env: {
      ...process.env,
      TURNLANE_EXT_WEB: extWeb ?? "",
      TURNLANE_EXT_SOURCES: JSON.stringify(extSources),
    },
  });
  if (p.exitCode !== 0)
    throw new Error(`web build failed:\n${p.stdout.toString()}${p.stderr.toString()}`);
}

if (import.meta.main) {
  const args = process.argv.slice(2);
  const outIdx = args.indexOf("--out");
  const r = await build({
    skipWeb: args.includes("--skip-web"),
    ...(outIdx >= 0 && args[outIdx + 1] ? { outDir: args[outIdx + 1] } : {}),
    ext: extArgs(args),
  });
  console.log(`turnlane ${r.version}`);
  if (r.identity) {
    console.log(
      `signed: ${r.identity === "-" ? "ad-hoc (-)" : r.identity} (hardened runtime, verified)`,
    );
  } else {
    console.error(
      "warning: TURNLANE_CODESIGN_IDENTITY is not set; turnlaned and turnlane keep the linker ad-hoc signature. macOS may ask for Automation permission again after every self-install.",
    );
  }
  console.log(`web assets: ${r.webAssets} files`);
  console.log(`extensions: ${r.extensions.length > 0 ? r.extensions.join(", ") : "(none)"}`);
  for (const [name, size] of Object.entries(r.sizes)) {
    console.log(`${join(r.outDir, name)}  ${(size / 1024 / 1024).toFixed(1)} MB`);
  }
  const t = desktopAppTimes(r.outDir);
  if (desktopAppStale(t.app, t.commit)) {
    console.error(
      `warning: ${join(r.outDir, "Turnlane.app")} was built before the last change to apps/desktop. turnlane self-install copies it as is; run bun run build:desktop first to update the desktop app.`,
    );
  }
}
