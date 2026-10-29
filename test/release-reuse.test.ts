/**
 * Reusing a finished set (dist/release/v<version>/) for --publish instead of rebuilding, refusing to overwrite it
 * without --rebuild, and tagging the build commit. Synthetic inputs only
 */
import { describe, expect, test } from "bun:test";
import { releaseZipUrl } from "../packages/core/src/release-config.ts";
import { renderCaskFile } from "../scripts/release/cask.ts";
import { parseReleaseArgs } from "../scripts/release/from-app.ts";
import { publishSteps, releaseFiles, sha256Line } from "../scripts/release/plan.ts";
import {
  buildCommitOf,
  checkDistFiles,
  type DistContents,
  missingFiles,
  releaseMode,
  tagCommit,
} from "../scripts/release/reuse.ts";

const V = "0.7.3";
const DIR = "/r/dist/release/v0.7.3";
const SHA = "a".repeat(64);

describe("releaseMode and --rebuild", () => {
  const mode = (args: string[], exists: boolean) =>
    releaseMode(parseReleaseArgs(args), { exists, dir: DIR });

  test("--publish with a finished set reuses it; without one it builds", () => {
    expect(mode(["--publish"], true)).toEqual({ kind: "reuse" });
    expect(mode(["--publish"], false)).toEqual({ kind: "build" });
  });

  test("plain release refuses to overwrite a finished set unless --rebuild", () => {
    const r = mode([], true);
    expect(r.kind).toBe("refuse");
    if (r.kind === "refuse") {
      expect(r.reason).toContain(`${DIR} already exists`);
      expect(r.reason).toContain("--publish");
      expect(r.reason).toContain("--rebuild");
    }
    expect(mode([], false)).toEqual({ kind: "build" });
    expect(mode(["--rebuild"], true)).toEqual({ kind: "build" });
    // --dry-run previews the reuse (verifies the set; writes nothing)
    expect(mode(["--dry-run"], true)).toEqual({ kind: "reuse" });
  });

  test("--rebuild forces a new build for --publish too; --from-app is the source when building", () => {
    expect(mode(["--publish", "--rebuild"], true)).toEqual({ kind: "build" });
    expect(mode(["--from-app", "/a/Turnlane.app"], false)).toEqual({ kind: "from-app" });
    expect(mode(["--from-app", "/a/Turnlane.app", "--rebuild"], true)).toEqual({
      kind: "from-app",
    });
    expect(parseReleaseArgs(["--rebuild"]).rebuild).toBe(true);
    expect(parseReleaseArgs([]).rebuild).toBe(false);
  });
});

/** A consistent set for 0.7.3 */
function contents(over: Partial<DistContents> = {}): DistContents {
  const f = releaseFiles(V);
  const url = releaseZipUrl(V);
  return {
    version: V,
    downloadUrl: url,
    zipSha: SHA,
    latestZipSha: SHA,
    latestJson: JSON.stringify({ version: V, url, sha256: SHA }),
    sha256File: sha256Line(SHA, f.zip, f.latestZip),
    cask: renderCaskFile({ version: V, sha256: SHA }),
    expectedCask: renderCaskFile({ version: V, sha256: SHA }),
    notes: "### Fixed\n\n- something\n",
    changelogSection: "### Fixed\n\n- something",
    ...over,
  };
}

describe("checkDistFiles", () => {
  test("a consistent set passes", () => {
    expect(checkDistFiles(contents())).toEqual([]);
  });

  test("missing files are listed", () => {
    const f = releaseFiles(V);
    expect(missingFiles(V, (n) => n !== f.notes && n !== f.latestZip)).toEqual([
      f.latestZip,
      f.notes,
    ]);
    expect(missingFiles(V, () => true)).toEqual([]);
  });

  test("the two zips differ", () => {
    expect(checkDistFiles(contents({ latestZipSha: "b".repeat(64) }))[0]).toContain("differ");
  });

  test("latest.json: wrong version, url, sha256, or not JSON", () => {
    const url = releaseZipUrl(V);
    expect(
      checkDistFiles(
        contents({
          latestJson: JSON.stringify({ version: "0.7.2", url: "https://x/y.zip", sha256: "c" }),
        }),
      ),
    ).toEqual([
      "latest.json version 0.7.2 != 0.7.3",
      `latest.json url https://x/y.zip != ${url}`,
      `latest.json sha256 c != the zip's ${SHA}`,
    ]);
    expect(checkDistFiles(contents({ latestJson: "{" }))).toEqual(["latest.json is not JSON"]);
  });

  test("the .sha256 file and the cask must carry the zip's hash", () => {
    const f = releaseFiles(V);
    expect(
      checkDistFiles(contents({ sha256File: sha256Line("d".repeat(64), f.zip, f.latestZip) })),
    ).toEqual([`${f.sha256} does not list ${SHA} for ${f.zip} and ${f.latestZip}`]);
    expect(
      checkDistFiles(contents({ cask: renderCaskFile({ version: V, sha256: "e".repeat(64) }) })),
    ).toEqual([`${f.cask} is not the cask for ${V} with sha256 ${SHA}`]);
  });

  test("notes.md must equal the current CHANGELOG section", () => {
    expect(checkDistFiles(contents({ notes: "old notes\n" }))).toEqual([
      `notes.md differs from the current CHANGELOG section for ${V}`,
    ]);
    expect(checkDistFiles(contents({ changelogSection: null }))).toEqual([
      `CHANGELOG has no section for ${V}`,
    ]);
  });
});

describe("the commit to tag", () => {
  const HEAD = "1111111111111111111111111111111111111111";
  const BUILD = "2222222222222222222222222222222222222222";

  test("TurnlaneBuild <version>+<sha> names the build commit", () => {
    expect(buildCommitOf("0.7.3+2222222", V)).toEqual({ sha: "2222222" });
    expect(buildCommitOf(null, V)).toEqual({ error: "the app has no TurnlaneBuild in Info.plist" });
    expect(buildCommitOf("0.7.3+nogit", V)).toEqual({
      error: "TurnlaneBuild 0.7.3+nogit does not name a commit",
    });
    expect(buildCommitOf("0.7.2+2222222", V)).toEqual({
      error: "TurnlaneBuild 0.7.2+2222222 is not version 0.7.3",
    });
  });

  test("tag the build commit when it is an ancestor of main; say when it is not HEAD", () => {
    expect(
      tagCommit({ build: { sha: "2222222" }, resolved: BUILD, isAncestorOfMain: true, head: HEAD }),
    ).toEqual({ commit: BUILD, note: `tagging the build commit ${BUILD} (HEAD is ${HEAD})` });
    expect(
      tagCommit({ build: { sha: "1111111" }, resolved: HEAD, isAncestorOfMain: true, head: HEAD }),
    ).toEqual({ commit: HEAD, note: `tagging ${HEAD} (HEAD, the build commit)` });
  });

  test("refuse a build from another history", () => {
    const notHere = tagCommit({
      build: { sha: "3333333" },
      resolved: null,
      isAncestorOfMain: false,
      head: HEAD,
    });
    expect("error" in notHere && notHere.error).toContain("is not in this repository");
    const branch = tagCommit({
      build: { sha: "2222222" },
      resolved: BUILD,
      isAncestorOfMain: false,
      head: HEAD,
    });
    expect("error" in branch && branch.error).toContain("is not an ancestor of main");
    const none = tagCommit({
      build: { error: "x" },
      resolved: null,
      isAncestorOfMain: false,
      head: HEAD,
    });
    expect("error" in none && none.error).toBe("cannot tag the build commit: x");
  });

  test("publishSteps tags the given commit (HEAD when omitted)", () => {
    const base = { version: V, dir: DIR, tapDir: null, tapCommitted: false };
    expect(publishSteps({ ...base, commit: BUILD })[0]?.cmd).toEqual([
      "git",
      "tag",
      "-a",
      "v0.7.3",
      "-m",
      "Turnlane 0.7.3",
      BUILD,
    ]);
    expect(publishSteps(base)[0]?.cmd).toEqual([
      "git",
      "tag",
      "-a",
      "v0.7.3",
      "-m",
      "Turnlane 0.7.3",
    ]);
  });
});
