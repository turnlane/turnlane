/**
 * 署名の種別と公証（phase0-plan M6-8、onboarding.md 2.1、docs/dev/codesign.md 5 章）。
 *
 * 証明書の種別の判定はここ 1 か所に置く。scripts/build.ts（turnlaned・turnlane）、scripts/build-app.ts（Turnlane.app と公証）、
 * native/calendar-helper/scripts/build-app.sh（`bun scripts/signing.ts timestamp-flag` で同じ判定を読む）が使う。
 *
 * - 配布用（Developer ID）: `TURNLANE_CODESIGN_IDENTITY` が `Developer ID Application:` で始まるとき。全部の署名に
 *   セキュアタイムスタンプ（`--timestamp`、Apple のタイムスタンプサーバーへの接続が要る）を付け、
 *   `TURNLANE_NOTARY_PROFILE`（`xcrun notarytool store-credentials` で作ったキーチェーンのプロファイル名）があれば公証して staple する
 * - それ以外（`Apple Development:`、`-`、未設定、SHA-1 での指定）: `--timestamp=none`。公証しない
 *
 *   bun scripts/signing.ts timestamp-flag   # 今の環境変数での codesign のタイムスタンプの引数を 1 行で出す（シェル用）
 */

export type SignKind = "developer-id" | "apple-development" | "ad-hoc" | "other";

export const DEVELOPER_ID_PREFIX = "Developer ID Application:";
const APPLE_DEVELOPMENT_PREFIX = "Apple Development:";

/** 証明書の名前から署名の種別を決める。SHA-1 などの名前でない指定は other（配布用とはみなさない） */
export function signKind(identity: string | null | undefined): SignKind {
  const v = identity?.trim();
  if (!v || v === "-") return "ad-hoc";
  if (v.startsWith(DEVELOPER_ID_PREFIX)) return "developer-id";
  if (v.startsWith(APPLE_DEVELOPMENT_PREFIX)) return "apple-development";
  return "other";
}

/** 配布用（Developer ID）の署名か */
export function isDistribution(identity: string | null | undefined): boolean {
  return signKind(identity) === "developer-id";
}

/** codesign のタイムスタンプの引数。配布用だけセキュアタイムスタンプを付ける（公証に要る） */
export function timestampArgs(identity: string | null | undefined): string[] {
  return isDistribution(identity) ? ["--timestamp"] : ["--timestamp=none"];
}

/** 公証の資格情報のプロファイル名（TURNLANE_NOTARY_PROFILE）。未設定・空なら null */
export function notaryProfile(
  env: Record<string, string | undefined> = process.env,
): string | null {
  const v = env.TURNLANE_NOTARY_PROFILE?.trim();
  return v ? v : null;
}

/**
 * 公証で拒まれる・配布物に入れない entitlements。get-task-allow はデバッガの接続を許す（公証が拒む）。
 * 残りは hardened runtime の保護を外すもので、Turnlane は使わない（Bun の単一バイナリは allow-jit だけ。build.ts）
 */
export const FORBIDDEN_ENTITLEMENTS = [
  "com.apple.security.get-task-allow",
  "com.apple.security.cs.disable-library-validation",
  "com.apple.security.cs.allow-unsigned-executable-memory",
  "com.apple.security.cs.allow-dyld-environment-variables",
  "com.apple.security.cs.disable-executable-page-protection",
];

/**
 * `codesign -d --verbose=2 --entitlements - --xml` の出力（info は stderr、xml は stdout）から、公証に通らない・
 * 想定と違う点を挙げる。label は問題の行の頭に付ける名前
 */
export function signatureProblems(
  label: string,
  info: string,
  entitlementsXml: string,
  o: { distribution: boolean; requiredEntitlements?: readonly string[] },
): string[] {
  const problems: string[] = [];
  if (!/flags=0x[0-9a-f]+\([^)]*runtime/.test(info))
    problems.push(`${label}: hardened runtime is off`);
  for (const k of FORBIDDEN_ENTITLEMENTS)
    if (entitlementsXml.includes(`<key>${k}</key>`))
      problems.push(`${label}: entitlement not allowed: ${k}`);
  for (const k of o.requiredEntitlements ?? [])
    if (!entitlementsXml.includes(`<key>${k}</key>`))
      problems.push(`${label}: entitlement missing: ${k}`);
  if (o.distribution) {
    if (!/^Authority=Developer ID Application:/m.test(info))
      problems.push(`${label}: not signed with a Developer ID Application certificate`);
    if (!/^Timestamp=/m.test(info)) problems.push(`${label}: no secure timestamp`);
  }
  return problems;
}

/**
 * codesign が失敗したときの補足。配布用でタイムスタンプが取れなかった（ネットが無い・Apple のサーバーが答えない）ときに
 * 原因を 1 行で示す。当てはまらなければ null
 */
export function codesignFailureHint(
  identity: string | null | undefined,
  output: string,
): string | null {
  if (!isDistribution(identity)) return null;
  if (!/timestamp/i.test(output)) return null;
  return "codesign could not get a secure timestamp from Apple (Developer ID signing needs a network connection to timestamp.apple.com). Check the network and run the build again.";
}

/** 公証をするか。しないときは出す警告（null なら黙って省く） */
export type NotarizeDecision =
  | { action: "notarize"; profile: string }
  | { action: "skip"; warning: string | null };

export function notarizeDecision(o: {
  identity: string | null | undefined;
  profile: string | null;
  skip?: boolean;
}): NotarizeDecision {
  const dist = isDistribution(o.identity);
  if (o.skip) return { action: "skip", warning: null };
  if (dist && o.profile) return { action: "notarize", profile: o.profile };
  if (dist)
    return {
      action: "skip",
      warning:
        "warning: signed with Developer ID but not notarized (TURNLANE_NOTARY_PROFILE is not set). Gatekeeper blocks this build on other Macs. Pass --skip-notarize to build without notarizing on purpose.",
    };
  if (o.profile)
    return {
      action: "skip",
      warning:
        "note: TURNLANE_NOTARY_PROFILE is ignored: notarization needs a Developer ID Application certificate in TURNLANE_CODESIGN_IDENTITY.",
    };
  return { action: "skip", warning: null };
}

/** 公証の一連のコマンド（zip を送る。staple は .app に） */
export function notarizeCommands(app: string, zip: string, profile: string) {
  return {
    zip: ["/usr/bin/ditto", "-c", "-k", "--keepParent", app, zip],
    submit: [
      "xcrun",
      "notarytool",
      "submit",
      zip,
      "--keychain-profile",
      profile,
      "--wait",
      "--output-format",
      "json",
    ],
    log: (id: string) => ["xcrun", "notarytool", "log", id, "--keychain-profile", profile],
    staple: ["xcrun", "stapler", "staple", app],
    validate: ["xcrun", "stapler", "validate", app],
  };
}

/** 確認のコマンド（Gatekeeper の評価と staple の確認） */
export function verifyCommands(app: string) {
  return {
    spctl: ["/usr/sbin/spctl", "-a", "-vv", "-t", "exec", app],
    stapler: ["xcrun", "stapler", "validate", app],
  };
}

export interface ExecResult {
  code: number;
  stdout: string;
  stderr: string;
}
export type Exec = (cmd: string[]) => ExecResult;

export const spawnExec: Exec = (cmd) => {
  const p = Bun.spawnSync(cmd, { stdout: "pipe", stderr: "pipe" });
  return { code: p.exitCode ?? 1, stdout: p.stdout.toString(), stderr: p.stderr.toString() };
};

/** `notarytool submit --output-format json` の出力から id と status を読む。読めなければ null */
export function parseSubmit(
  stdout: string,
): { id: string; status: string; message: string } | null {
  try {
    const j = JSON.parse(stdout.trim()) as Record<string, unknown>;
    if (typeof j.id !== "string" || typeof j.status !== "string") return null;
    return { id: j.id, status: j.status, message: typeof j.message === "string" ? j.message : "" };
  } catch {
    return null;
  }
}

/**
 * 公証して staple する: app を zip にして送り（--wait）、Accepted なら staple → validate。
 * Accepted 以外なら notarytool log を取って例外にする（メッセージに log を含める）。exec はテストで差し替える
 */
export function notarize(
  app: string,
  zip: string,
  profile: string,
  exec: Exec = spawnExec,
  log: (s: string) => void = (s) => console.error(s),
): { id: string } {
  const c = notarizeCommands(app, zip, profile);
  const must = (cmd: string[], what: string) => {
    const r = exec(cmd);
    if (r.code !== 0) throw new Error(`${what} failed (${cmd.join(" ")}):\n${r.stdout}${r.stderr}`);
    return r;
  };
  must(c.zip, "zip for notarization");
  log(
    `notarizing: submitting to Apple with keychain profile "${profile}" (this waits for the result)`,
  );
  const r = exec(c.submit);
  const s = parseSubmit(r.stdout);
  if (!s)
    throw new Error(
      `notarytool submit failed (${c.submit.join(" ")}):\n${r.stdout}${r.stderr}\nCheck the keychain profile: xcrun notarytool history --keychain-profile "${profile}"`,
    );
  if (s.status !== "Accepted") {
    const l = exec(c.log(s.id));
    throw new Error(
      `notarization ${s.status} (submission ${s.id})${s.message ? `: ${s.message}` : ""}\n--- xcrun notarytool log ${s.id} ---\n${l.stdout}${l.stderr}`,
    );
  }
  log(`notarized: submission ${s.id} Accepted`);
  must(c.staple, "stapler staple");
  must(c.validate, "stapler validate");
  return { id: s.id };
}

/** spctl の出力（stderr）を 1 行に。notarized は公証して staple したか */
export function describeSpctl(r: ExecResult, notarized: boolean): string {
  const out = `${r.stdout}${r.stderr}`;
  const source = /^source=(.*)$/m.exec(out)?.[1]?.trim();
  const verdict = r.code === 0 ? "accepted" : "rejected";
  const tag = notarized ? "" : " (not notarized)";
  return `spctl: ${verdict}${source ? ` · source=${source}` : ""}${tag}`;
}

if (import.meta.main) {
  const cmd = process.argv[2];
  if (cmd === "timestamp-flag") {
    console.log(timestampArgs(process.env.TURNLANE_CODESIGN_IDENTITY).join(" "));
  } else {
    console.error("usage: bun scripts/signing.ts timestamp-flag");
    process.exit(2);
  }
}
