/**
 * Reusing a finished release set (dist/release/v<version>/) instead of rebuilding, and choosing the commit to tag.
 * `bun run release --publish` verifies an existing set and publishes it as it is (a rebuild notarizes again and the new
 * staple can wait half an hour); plain `bun run release` refuses to overwrite a finished set without --rebuild.
 * Pure functions: file contents, hashes and command results are passed in (tests give synthetic inputs).
 */
import type { ReleaseArgs } from "./from-app.ts";
import { releaseFiles, sha256Line } from "./plan.ts";

export type ReleaseMode =
  | { kind: "reuse" }
  | { kind: "build" }
  | { kind: "from-app" }
  | { kind: "refuse"; reason: string };

/**
 * What to do: an existing set is reused by --publish (unless --rebuild), and protected from plain runs (refuse unless
 * --rebuild). --dry-run previews the reuse (it verifies the set and prints what --publish would do). Without a set (or
 * with --rebuild) the app is built, or taken from --from-app
 */
export function releaseMode(
  a: Pick<ReleaseArgs, "publish" | "rebuild" | "fromApp" | "dryRun">,
  dist: { exists: boolean; dir: string },
): ReleaseMode {
  const make: ReleaseMode = a.fromApp ? { kind: "from-app" } : { kind: "build" };
  if (!dist.exists || a.rebuild) return make;
  if (a.publish || a.dryRun) return { kind: "reuse" };
  return {
    kind: "refuse",
    reason: `${dist.dir} already exists. Publish it with --publish (it is verified, not rebuilt), or pass --rebuild to build a new set (the zip's sha256 changes).`,
  };
}

/** The files of a set that are missing */
export function missingFiles(version: string, exists: (name: string) => boolean): string[] {
  return Object.values(releaseFiles(version)).filter((n) => !exists(n));
}

export interface DistContents {
  version: string;
  downloadUrl: string;
  /** sha256 of Turnlane-<version>.zip and of Turnlane.zip */
  zipSha: string;
  latestZipSha: string;
  latestJson: string;
  sha256File: string;
  cask: string;
  /** the cask this version and zip should have (renderCaskFile) */
  expectedCask: string;
  notes: string;
  /** the current CHANGELOG section for the version (null if missing) */
  changelogSection: string | null;
}

function parseJson(text: string): Record<string, unknown> | null {
  try {
    const v = JSON.parse(text) as unknown;
    return v && typeof v === "object" ? (v as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

/** Check the files of a set against each other and the CHANGELOG (the app inside is checked by checkFromApp) */
export function checkDistFiles(d: DistContents): string[] {
  const f = releaseFiles(d.version);
  const errors: string[] = [];
  if (d.zipSha !== d.latestZipSha)
    errors.push(`${f.zip} and ${f.latestZip} differ (${d.zipSha} vs ${d.latestZipSha})`);
  const latest = parseJson(d.latestJson);
  if (!latest) errors.push(`${f.latest} is not JSON`);
  if (latest) {
    if (latest.version !== d.version)
      errors.push(`${f.latest} version ${String(latest.version)} != ${d.version}`);
    if (latest.url !== d.downloadUrl)
      errors.push(`${f.latest} url ${String(latest.url)} != ${d.downloadUrl}`);
    if (latest.sha256 !== d.zipSha)
      errors.push(`${f.latest} sha256 ${String(latest.sha256)} != the zip's ${d.zipSha}`);
  }
  if (d.sha256File !== sha256Line(d.zipSha, f.zip, f.latestZip))
    errors.push(`${f.sha256} does not list ${d.zipSha} for ${f.zip} and ${f.latestZip}`);
  if (d.cask !== d.expectedCask)
    errors.push(`${f.cask} is not the cask for ${d.version} with sha256 ${d.zipSha}`);
  if (d.changelogSection === null) errors.push(`CHANGELOG has no section for ${d.version}`);
  else if (d.notes !== `${d.changelogSection}\n`)
    errors.push(`${f.notes} differs from the current CHANGELOG section for ${d.version}`);
  return errors;
}

/** `<version>+<sha>` (Info.plist TurnlaneBuild) → the sha, or why it cannot be used */
export function buildCommitOf(
  turnlaneBuild: string | null,
  version: string,
): { sha: string } | { error: string } {
  if (!turnlaneBuild) return { error: "the app has no TurnlaneBuild in Info.plist" };
  const m = /^(.+)\+([0-9a-f]{7,40})$/.exec(turnlaneBuild.trim());
  if (!m) return { error: `TurnlaneBuild ${turnlaneBuild} does not name a commit` };
  if (m[1] !== version)
    return { error: `TurnlaneBuild ${turnlaneBuild} is not version ${version}` };
  return { sha: m[2] as string };
}

/**
 * The commit to tag: the commit the build came from, if it resolves and is an ancestor of main. Otherwise refuse
 * (the build is not from this history)
 */
export function tagCommit(o: {
  build: { sha: string } | { error: string };
  /** the full sha the build's sha resolves to (null if unknown here) */
  resolved: string | null;
  isAncestorOfMain: boolean;
  head: string;
}): { commit: string; note: string } | { error: string } {
  if ("error" in o.build) return { error: `cannot tag the build commit: ${o.build.error}` };
  if (!o.resolved)
    return {
      error: `the build commit ${o.build.sha} is not in this repository (the build is not from this history)`,
    };
  if (!o.isAncestorOfMain)
    return {
      error: `the build commit ${o.resolved} is not an ancestor of main (the build is not from this history)`,
    };
  return {
    commit: o.resolved,
    note:
      o.resolved === o.head
        ? `tagging ${o.resolved} (HEAD, the build commit)`
        : `tagging the build commit ${o.resolved} (HEAD is ${o.head})`,
  };
}
