import {
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  readlinkSync,
  writeFileSync,
} from "node:fs";
import { basename, dirname, join, resolve } from "node:path";
import { DESKTOP_APP } from "./paths.ts";
import { CASK_TOKEN, HOMEBREW_UPGRADE_COMMAND } from "./release-config.ts";

/**
 * 配置の方式（ADR 0011 の決定 4・7、onboarding.md 2.2・2.4）。
 * - `app`: 配布版。`Turnlane.app` の中の `Contents/Helpers/turnlaned` として動いている。常駐の登録はアプリが SMAppService で行い、
 *   hooks と MCP には固定の場所 `<データディレクトリ>/bin/turnlane`（アプリの中の turnlane へのリンク）を書く
 * - `dev`: 開発時。`~/.local/bin` のバイナリと `turnlane self-install` が書く LaunchAgent
 * デーモンは起動時に `install.json`（データディレクトリ、600）へ書く。CLI はこれを見て、`app` のときは開発用のコマンド
 * （self-install・calendar install・desktop install）を止める（方式が混ざると同じラベルのエージェントが2つになる）
 */
export type InstallMode = "app" | "dev";

export interface InstallInfo {
  mode: InstallMode;
  /** `Turnlane.app` の絶対パス（dev なら null） */
  appPath: string | null;
  /** 書いたデーモンの版（`turnlaned --version` と同じ） */
  version: string;
  writtenAt: number;
}

/** バンドルの中の場所（onboarding.md 2.1） */
export const BUNDLE_HELPERS = "Contents/Helpers";
export const BUNDLE_LOGIN_ITEMS = "Contents/Library/LoginItems";
export const BUNDLE_LAUNCH_AGENTS = "Contents/Library/LaunchAgents";
export const BUNDLE_INFO_PLIST = "Contents/Info.plist";
/** Info.plist に書く、ビルドの識別（`<版>+<git の短い sha>`。`turnlaned --version` と同じ文字列） */
export const BUNDLE_BUILD_KEY = "TurnlaneBuild";

export function installJsonPath(dataDir: string): string {
  return join(dataDir, "install.json");
}

/** hooks と MCP に書く turnlane の固定の場所（ADR 0011 決定 4、ADR 0016 の対応表） */
export function bundledCliLinkPath(dataDir: string): string {
  return join(dataDir, "bin", "turnlane");
}

/** アプリの中の turnlane / turnlaned */
export function bundledBinary(appPath: string, name: "turnlane" | "turnlaned"): string {
  return join(appPath, BUNDLE_HELPERS, name);
}

/**
 * 実行ファイルの場所から配置の方式を決める。`…/Turnlane.app/Contents/Helpers/<名前>` なら app。
 * シンボリックリンク（`bin/turnlane`）経由で起動したときも `process.execPath` は実体を指す
 */
export function detectInstall(execPath: string | null | undefined): {
  mode: InstallMode;
  appPath: string | null;
} {
  if (!execPath) return { mode: "dev", appPath: null };
  const p = resolve(execPath);
  const helpers = dirname(p);
  if (basename(helpers) !== "Helpers") return { mode: "dev", appPath: null };
  const contents = dirname(helpers);
  if (basename(contents) !== "Contents") return { mode: "dev", appPath: null };
  const app = dirname(contents);
  if (!app.endsWith(".app")) return { mode: "dev", appPath: null };
  return { mode: "app", appPath: app };
}

export function readInstallInfo(dataDir: string): InstallInfo | null {
  const p = installJsonPath(dataDir);
  if (!existsSync(p)) return null;
  try {
    const raw = JSON.parse(readFileSync(p, "utf8")) as Record<string, unknown>;
    if (raw.mode !== "app" && raw.mode !== "dev") return null;
    return {
      mode: raw.mode,
      appPath: typeof raw.appPath === "string" ? raw.appPath : null,
      version: typeof raw.version === "string" ? raw.version : "",
      writtenAt: typeof raw.writtenAt === "number" ? raw.writtenAt : 0,
    };
  } catch {
    return null;
  }
}

export function writeInstallInfo(dataDir: string, info: InstallInfo): void {
  mkdirSync(dataDir, { recursive: true, mode: 0o700 });
  writeFileSync(installJsonPath(dataDir), `${JSON.stringify(info, null, 2)}\n`, { mode: 0o600 });
}

/** シンボリックリンクの先（リンクでなければ・無ければ null） */
export function linkTarget(path: string): string | null {
  try {
    if (!lstatSync(path).isSymbolicLink()) return null;
    return readlinkSync(path);
  } catch {
    return null;
  }
}

/** `GET /api/install`（onboarding.md 2.4・4.8 の Install ▸） */
export interface InstallStatus {
  mode: InstallMode;
  appPath: string | null;
  version: string;
  cli: {
    /** アプリの中の turnlane（dev なら null） */
    bundled: string | null;
    /** hooks・MCP に書く固定の場所（`<データ>/bin/turnlane`）が、今のアプリの turnlane を指しているか */
    fixedLink: { path: string; ok: boolean };
    /** シェル用の `~/.local/bin/turnlane` が、今のアプリの turnlane を指しているか */
    localBin: { path: string; linked: boolean; inPath: boolean };
    /** Homebrew の `binary`（`$(brew --prefix)/bin/turnlane`）があるか（あれば Install ▸ は出さない） */
    homebrew: boolean;
  };
}

/** Homebrew の cask の `binary` が置く場所の候補（Apple Silicon・Intel） */
export const HOMEBREW_BIN_CANDIDATES = ["/opt/homebrew/bin/turnlane", "/usr/local/bin/turnlane"];

export function installStatus(x: {
  mode: InstallMode;
  appPath: string | null;
  version: string;
  dataDir: string;
  home: string;
  pathVar: string | undefined;
  exists?: (p: string) => boolean;
  homebrewCandidates?: readonly string[];
}): InstallStatus {
  const exists = x.exists ?? existsSync;
  const bundled = x.appPath ? bundledBinary(x.appPath, "turnlane") : null;
  const fixed = bundledCliLinkPath(x.dataDir);
  const local = join(x.home, ".local", "bin", "turnlane");
  const pointsToBundled = (p: string) => {
    if (!bundled) return false;
    const t = linkTarget(p);
    return t !== null && resolve(dirname(p), t) === bundled;
  };
  const localDir = join(x.home, ".local", "bin");
  return {
    mode: x.mode,
    appPath: x.appPath,
    version: x.version,
    cli: {
      bundled,
      fixedLink: { path: fixed, ok: pointsToBundled(fixed) },
      localBin: {
        path: local,
        linked: pointsToBundled(local),
        inPath: (x.pathVar ?? "").split(":").includes(localDir),
      },
      homebrew: (x.homebrewCandidates ?? HOMEBREW_BIN_CANDIDATES).some((p) => exists(p)),
    },
  };
}

/** `Turnlane.app` の名前かを確かめる（パスの末尾） */
export function isDesktopAppPath(p: string): boolean {
  return basename(p) === DESKTOP_APP;
}

/** Homebrew の cask の置き場（あれば cask で入れた） */
export const HOMEBREW_CASKROOM_CANDIDATES = [
  `/opt/homebrew/Caskroom/${CASK_TOKEN}`,
  `/usr/local/Caskroom/${CASK_TOKEN}`,
];

/** 更新の案内の分け方（M6-17。onboarding.md 2.5） */
export function updateChannel(
  mode: InstallMode,
  exists: (p: string) => boolean = existsSync,
  caskrooms: readonly string[] = HOMEBREW_CASKROOM_CANDIDATES,
): "homebrew" | "download" | "dev" {
  if (mode !== "app") return "dev";
  return caskrooms.some((p) => exists(p)) ? "homebrew" : "download";
}

export { HOMEBREW_UPGRADE_COMMAND };
