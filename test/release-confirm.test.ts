/**
 * `bun run release --publish` confirmations and an unpushed local tag: y / yes answers, the local-tag decision
 * (synthetic git results), the order of asking (the tag is made only after the push is confirmed)
 */
import { describe, expect, test } from "bun:test";
import {
  askOrder,
  isYes,
  localTagDecision,
  publishSteps,
  type ReleaseFacts,
  releaseCheck,
} from "../scripts/release/plan.ts";

const BUILD = "2222222222222222222222222222222222222222";
const OTHER = "3333333333333333333333333333333333333333";

describe("isYes", () => {
  test.each(["y", "Y", "yes", "YES", "  yes  ", "Yes\n"])("yes: %j", (a) =>
    expect(isYes(a)).toBe(true),
  );
  test.each(["", "n", "no", "ye", "yess", "ok", "y es"])("not yes: %j", (a) =>
    expect(isYes(a)).toBe(false),
  );
});

const facts = (over: Partial<ReleaseFacts> = {}): ReleaseFacts => ({
  branch: "main",
  clean: true,
  version: "0.7.4",
  changelog: "# Changelog\n\n## [0.7.4] - 2026-10-30\n\n### Changed\n\n- x\n",
  tagExists: false,
  identity: "Developer ID Application: Example (AB12CD34EF)",
  notaryProfile: "turnlane",
  allowAdhoc: false,
  skipNotarize: false,
  ...over,
});

describe("preflight with an existing tag", () => {
  test("only local (not on origin): not refused here; decided against the build commit", () => {
    expect(
      releaseCheck(facts({ tagExists: true, localTag: BUILD, remoteTag: false })).errors,
    ).toEqual([]);
  });

  test("on origin: refused (published or half-published), pointing to the recovery table", () => {
    const e = releaseCheck(facts({ tagExists: true, localTag: BUILD, remoteTag: true })).errors;
    expect(e).toHaveLength(1);
    expect(e[0]).toContain("already exists on origin");
    expect(e[0]).toContain("docs/release.md");
  });

  test("origin could not be checked: refused with the delete command; unknown commit: refused as before", () => {
    expect(
      releaseCheck(facts({ tagExists: true, localTag: BUILD, remoteTag: null })).errors[0],
    ).toContain("git tag -d v0.7.4");
    expect(releaseCheck(facts({ tagExists: true })).errors).toEqual(["tag v0.7.4 already exists"]);
  });
});

describe("localTagDecision", () => {
  test("no local tag: tag as usual", () => {
    expect(localTagDecision({ version: "0.7.4", localTag: null, commit: BUILD })).toEqual({
      skipTag: false,
    });
  });

  test("on the build commit: continue and skip the git tag step", () => {
    expect(localTagDecision({ version: "0.7.4", localTag: BUILD, commit: BUILD })).toEqual({
      skipTag: true,
      note: `tag v0.7.4 already exists locally on ${BUILD} (not pushed), continuing`,
    });
  });

  test("on another commit: refuse, naming it and the delete command", () => {
    const d = localTagDecision({ version: "0.7.4", localTag: OTHER, commit: BUILD });
    expect(d.skipTag).toBe(false);
    expect(d.error).toContain(`exists locally on ${OTHER}`);
    expect(d.error).toContain(`build commit ${BUILD}`);
    expect(d.error).toContain("git tag -d v0.7.4");
  });
});

describe("the order of asking", () => {
  const base = { version: "0.7.4", dir: "/r/dist", tapDir: "/r/tap", tapCommitted: true };

  test("the push is asked before the tag is made; then release and tap as before", () => {
    const steps = publishSteps({ ...base, commit: BUILD });
    expect(steps.map((s) => s.title)).toEqual([
      "tag v0.7.4",
      "push main and v0.7.4",
      "create the GitHub release v0.7.4",
      "push the tap",
    ]);
    // before the tag (index 0) ask the push (1); the push itself is not asked again; then 2 and 3
    expect(askOrder(steps)).toEqual([1, null, 2, 3]);
  });

  test("with an existing local tag the git tag step is left out and the push is asked first", () => {
    const steps = publishSteps({ ...base, commit: BUILD, skipTag: true });
    expect(steps[0]?.title).toBe("push main and v0.7.4");
    expect(askOrder(steps)).toEqual([0, 1, 2]);
  });
});
