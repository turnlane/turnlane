/**
 * LaunchAgent の plist 生成（phase0-plan 1.3 の apps/daemon/src/launchd/）。
 * `turnlane self-install` が ~/Library/LaunchAgents/dev.turnlane.daemon.plist に書く。
 * このモジュールは純粋関数だけにする（CLI からも import するため、Hono や DB に依存しない）。
 */

export interface DaemonPlistOptions {
  label: string;
  /** turnlaned の絶対パス */
  program: string;
  /** ログディレクトリ（stdout / stderr の受け皿。本ログは turnlaned.log に自分で書く） */
  logDir: string;
  /** 既定以外のデータディレクトリ・ポートを使う場合だけ渡す */
  env?: Record<string, string>;
}

/** launchd 配下では PATH が最小なので、git / gh を見つけられるよう補う（M1 以降で使う） */
export const LAUNCHD_PATH = "/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin";

function esc(s: string): string {
  return s
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
}

const str = (s: string) => `<string>${esc(s)}</string>`;

export function daemonPlist(o: DaemonPlistOptions): string {
  const env = { PATH: LAUNCHD_PATH, ...o.env };
  const envXml = Object.entries(env)
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([k, v]) => `      <key>${esc(k)}</key>\n      ${str(v)}`)
    .join("\n");
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
  <dict>
    <key>Label</key>
    ${str(o.label)}
    <key>ProgramArguments</key>
    <array>
      ${str(o.program)}
    </array>
    <key>RunAtLoad</key>
    <true/>
    <key>KeepAlive</key>
    <true/>
    <key>ThrottleInterval</key>
    <integer>10</integer>
    <key>StandardOutPath</key>
    ${str(`${o.logDir}/turnlaned.stdout.log`)}
    <key>StandardErrorPath</key>
    ${str(`${o.logDir}/turnlaned.stderr.log`)}
    <key>EnvironmentVariables</key>
    <dict>
${envXml}
    </dict>
  </dict>
</plist>
`;
}

export interface HelperPlistOptions {
  label: string;
  /** TurnlaneCalendarHelper.app の絶対パス */
  app: string;
  logDir: string;
  env?: Record<string, string>;
}

/**
 * カレンダーヘルパの LaunchAgent（phase0-plan 1.5、M3-1）。`turnlane calendar install` が
 * ~/Library/LaunchAgents/dev.turnlane.calendar-helper.plist に書く。
 * .app の中の実行ファイルを launchd が直接起動する（責任のあるプロセスがヘルパ自身になり、TCC の権限がヘルパに付く。S1）。
 * ログインセッション（Aqua）でだけ動かす。ヘルパは自分で calendar-helper.log に書くので stdout は捨てる
 */
export function helperPlist(o: HelperPlistOptions): string {
  const envXml = Object.entries(o.env ?? {})
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([k, v]) => `      <key>${esc(k)}</key>\n      ${str(v)}`)
    .join("\n");
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
  <dict>
    <key>Label</key>
    ${str(o.label)}
    <key>ProgramArguments</key>
    <array>
      ${str(`${o.app}/Contents/MacOS/TurnlaneCalendarHelper`)}
    </array>
    <key>RunAtLoad</key>
    <true/>
    <key>KeepAlive</key>
    <true/>
    <key>ThrottleInterval</key>
    <integer>10</integer>
    <key>LimitLoadToSessionType</key>
    <string>Aqua</string>
    <key>ProcessType</key>
    <string>Interactive</string>
    <key>StandardOutPath</key>
    <string>/dev/null</string>
    <key>StandardErrorPath</key>
    ${str(`${o.logDir}/calendar-helper.stderr.log`)}
    <key>EnvironmentVariables</key>
    <dict>
${envXml}
    </dict>
  </dict>
</plist>
`;
}

export interface BundleAgentPlistOptions {
  label: string;
  /** バンドルからの相対パス（`Contents/Helpers/turnlaned` など。SMAppService が解決する） */
  bundleProgram: string;
  /** アプリの bundle ID（ログイン項目でアプリの名前に寄せる） */
  associatedBundleId: string;
  /** 落ちたら起こし直す（デーモン・ヘルパは true） */
  keepAlive: boolean;
  /** Interactive（ヘルパ。TCC のダイアログを出す）。省略時は無指定 */
  processType?: "Interactive";
}

/**
 * `Turnlane.app/Contents/Library/LaunchAgents/` に入れる LaunchAgent（ADR 0011 決定 1・2、onboarding.md 2.1）。
 * アプリが `SMAppService.agent(plistName:)` で登録する。`BundleProgram` はバンドルからの相対パスなので、アプリの場所が
 * 変わっても書き直さない。署名されたバンドルの中なので、利用者ごとの値（ログの場所・環境変数）は書かない。
 * デーモンは自分で `~/Library/Logs/turnlane/turnlaned.log` に書き、ヘルパも自分のログに書く
 */
export function bundleAgentPlist(o: BundleAgentPlistOptions): string {
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
  <dict>
    <key>Label</key>
    ${str(o.label)}
    <key>BundleProgram</key>
    ${str(o.bundleProgram)}
    <key>RunAtLoad</key>
    <true/>
    <key>KeepAlive</key>
    ${o.keepAlive ? "<true/>" : "<false/>"}
    <key>ThrottleInterval</key>
    <integer>10</integer>
    <key>LimitLoadToSessionType</key>
    <string>Aqua</string>
${o.processType ? `    <key>ProcessType</key>\n    <string>${o.processType}</string>\n` : ""}    <key>AssociatedBundleIdentifiers</key>
    <array>
      ${str(o.associatedBundleId)}
    </array>
    <key>EnvironmentVariables</key>
    <dict>
      <key>PATH</key>
      ${str(LAUNCHD_PATH)}
    </dict>
  </dict>
</plist>
`;
}

export interface DesktopPlistOptions {
  label: string;
  /** Turnlane.app の絶対パス */
  app: string;
  logDir: string;
  env?: Record<string, string>;
}

/**
 * デスクトップアプリの LaunchAgent（desktop-shell.md 6.1、ADR 0010 の決定 4）。`turnlane self-install` / `turnlane desktop install` が
 * ~/Library/LaunchAgents/dev.turnlane.desktop.plist に書く。ログイン時に1回起動し（RunAtLoad）、⌘Q で終了したら
 * 次のログインまで起こさない（KeepAlive=false）。--background でメニューバーだけで始める
 */
export function desktopPlist(o: DesktopPlistOptions): string {
  const envXml = Object.entries(o.env ?? {})
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([k, v]) => `      <key>${esc(k)}</key>\n      ${str(v)}`)
    .join("\n");
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
  <dict>
    <key>Label</key>
    ${str(o.label)}
    <key>ProgramArguments</key>
    <array>
      ${str(`${o.app}/Contents/MacOS/turnlane`)}
      <string>--background</string>
    </array>
    <key>RunAtLoad</key>
    <true/>
    <key>KeepAlive</key>
    <false/>
    <key>LimitLoadToSessionType</key>
    <string>Aqua</string>
    <key>ProcessType</key>
    <string>Interactive</string>
    <key>StandardOutPath</key>
    <string>/dev/null</string>
    <key>StandardErrorPath</key>
    ${str(`${o.logDir}/desktop.stderr.log`)}
    <key>EnvironmentVariables</key>
    <dict>
${envXml}
    </dict>
  </dict>
</plist>
`;
}
