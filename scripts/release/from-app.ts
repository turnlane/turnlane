/**
 * `bun run release --from-app <Turnlane.app>`: continue a release from an app that is already built, notarized and
 * stapled (for example the work folder kept after `stapler staple` kept failing with Error 73, stapled by hand).
 * The check and the build are skipped; the preflight (releaseCheck) is not. The app is validated here before it is
 * used. Pure functions: the command results are passed in (tests give synthetic results).
 */
import { basename } from "node:path";
import type { ExecResult } from "../signing.ts";

export interface ReleaseArgs {
  dryRun: boolean;
  allowAdhoc: boolean;
  skipNotarize: boolean;
  skipCheck: boolean;
  publish: boolean;
  yes: boolean;
  /** build a new set even when dist/release/v<version>/ exists */
  rebuild: boolean;
  tapDir: string | null;
  fromApp: string | null;
  errors: string[];
}

/** Parse the `bun run release` arguments (flags and their combinations) */
export function parseReleaseArgs(args: readonly string[]): ReleaseArgs {
  const has = (k: string) => args.includes(k);
  const val = (k: string) => {
    const i = args.indexOf(k);
    const v = i >= 0 ? args[i + 1] : undefined;
    return v && !v.startsWith("--") ? v : undefined;
  };
  const errors: string[] = [];
  const r: ReleaseArgs = {
    dryRun: has("--dry-run"),
    allowAdhoc: has("--allow-adhoc"),
    skipNotarize: has("--skip-notarize"),
    skipCheck: has("--skip-check"),
    publish: has("--publish"),
    yes: has("--yes"),
    rebuild: has("--rebuild"),
    tapDir: val("--tap-dir") ?? null,
    fromApp: val("--from-app") ?? null,
    errors,
  };
  if (r.publish && (r.dryRun || r.allowAdhoc))
    errors.push("--publish cannot be combined with --dry-run or --allow-adhoc");
  if (has("--tap-dir") && !r.tapDir) errors.push("--tap-dir needs a path");
  if (has("--from-app") && !r.fromApp) errors.push("--from-app needs the path to Turnlane.app");
  if (has("--from-app") && (r.skipNotarize || r.allowAdhoc))
    errors.push(
      "--from-app cannot be combined with --skip-notarize or --allow-adhoc (the app must be notarized and stapled)",
    );
  return r;
}

/** The commands that read the given app (nothing is changed) */
export function fromAppCommands(app: string) {
  return {
    verify: ["codesign", "--verify", "--deep", "--strict", app],
    display: ["codesign", "-dv", "--verbose=2", app],
    version: [
      "/usr/bin/plutil",
      "-extract",
      "CFBundleShortVersionString",
      "raw",
      "-o",
      "-",
      `${app}/Contents/Info.plist`,
    ],
    extensions: [
      "/usr/bin/plutil",
      "-extract",
      "TurnlaneExtensions",
      "raw",
      "-o",
      "-",
      `${app}/Contents/Info.plist`,
    ],
    stapler: ["xcrun", "stapler", "validate", app],
    spctl: ["/usr/sbin/spctl", "--assess", "--type", "execute", "-vv", app],
  };
}

export type FromAppResults = Record<keyof ReturnType<typeof fromAppCommands>, ExecResult>;

const out = (r: ExecResult) => `${r.stdout}${r.stderr}`.trim();

/** `Developer ID Application: Name (TEAMID)` → TEAMID */
export function teamOf(identity: string): string | null {
  return /\(([A-Z0-9]{10})\)\s*$/.exec(identity)?.[1] ?? null;
}

/**
 * Decide whether the app can be released. errors stop the release; warnings are printed.
 * - a directory named Turnlane.app
 * - `codesign --verify --deep --strict` passes
 * - signed by the configured identity (the first Authority line, and the TeamIdentifier when the identity names one)
 * - CFBundleShortVersionString is the release version
 * - no extensions: Info.plist `TurnlaneExtensions` (written by build:app) is empty. Apps built before that key existed
 *   cannot be checked: a warning (the release build never passes --ext)
 * - `xcrun stapler validate` passes (otherwise print the staple command)
 * - `spctl --assess --type execute` accepts it
 */
export function checkFromApp(o: {
  app: string;
  isDirectory: boolean;
  identity: string;
  version: string;
  results: FromAppResults;
}): { errors: string[]; warnings: string[] } {
  const errors: string[] = [];
  const warnings: string[] = [];
  if (!o.isDirectory) return { errors: [`${o.app} is not a directory`], warnings };
  if (basename(o.app) !== "Turnlane.app")
    return { errors: [`${o.app} is not named Turnlane.app`], warnings };
  const r = o.results;
  if (r.verify.code !== 0)
    errors.push(`codesign --verify --deep --strict failed: ${out(r.verify)}`);
  const info = out(r.display);
  const authority = /^Authority=(.+)$/m.exec(info)?.[1]?.trim() ?? null;
  const team = /^TeamIdentifier=(.+)$/m.exec(info)?.[1]?.trim() ?? null;
  const wantTeam = teamOf(o.identity);
  if (r.display.code !== 0) errors.push(`codesign -dv failed: ${info}`);
  else {
    if (authority !== o.identity)
      errors.push(`signed by ${authority ?? "(no authority)"}, not ${o.identity}`);
    if (wantTeam && team !== wantTeam)
      errors.push(`TeamIdentifier ${team ?? "(none)"} != ${wantTeam}`);
  }
  const v = r.version.code === 0 ? r.version.stdout.trim() : null;
  if (v !== o.version) errors.push(`app version ${v ?? "(unreadable)"} != ${o.version}`);
  if (r.extensions.code === 0) {
    const ext = r.extensions.stdout.trim();
    if (ext) errors.push(`the app includes extensions (${ext}); a release must not`);
  } else
    warnings.push(
      "could not check for extensions: the app has no TurnlaneExtensions key (built before build:app recorded it). The release build never passes --ext; make sure this app came from `bun run release`.",
    );
  if (r.stapler.code !== 0)
    errors.push(
      `the app is not stapled (${out(r.stapler)}). Staple it first:\n  xcrun stapler staple "${o.app}"\n  xcrun stapler validate "${o.app}"`,
    );
  if (r.spctl.code !== 0) errors.push(`spctl rejected the app: ${out(r.spctl)}`);
  return { errors, warnings };
}

/** The lines `--dry-run --from-app` prints instead of the check and the build */
export function fromAppPlan(o: { app: string; buildOut: string; version: string }): string[] {
  const c = fromAppCommands(o.app);
  return [
    "  (--from-app: no bun run check, no build)",
    ...Object.values(c).map((cmd) => `  ${cmd.join(" ")}   # validate`),
    `  copy ${o.app} to ${o.buildOut}/Turnlane.app`,
    `  /usr/bin/ditto -c -k --keepParent ${o.buildOut}/Turnlane.app ${o.buildOut}/Turnlane-${o.version}.zip`,
    `  write ${o.buildOut}/latest.json (sha256 of the zip)`,
  ];
}
