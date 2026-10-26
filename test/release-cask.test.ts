/** Homebrew cask の描画（M6-9、ADR 0011 決定 6）。固定の版・sha256 で出力を比べる */
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { releaseZipUrl } from "../packages/core/src/release-config.ts";
import {
  CASK_TEMPLATE,
  renderCask,
  renderCaskFile,
  TAP_CASK_PATH,
} from "../scripts/release/cask.ts";

const SHA = "0123456789abcdef".repeat(4);

const EXPECTED = `cask "turnlane" do
  version "0.7.0"
  sha256 "${SHA}"

  url "https://github.com/turnlane/turnlane/releases/download/v#{version}/Turnlane-#{version}.zip"
  name "Turnlane"
  desc "Daily planner for your calendar, tasks, and AI coding agents"
  homepage "https://github.com/turnlane/turnlane"

  livecheck do
    url :url
    strategy :github_latest
  end

  depends_on arch: :arm64
  depends_on macos: :sonoma

  app "Turnlane.app"
  binary "#{appdir}/Turnlane.app/Contents/Helpers/turnlane"

  uninstall quit: "dev.turnlane.desktop"

  zap launchctl: [
        "dev.turnlane.calendar-helper",
        "dev.turnlane.daemon",
      ],
      trash:     [
        "~/Library/Application Support/turnlane",
        "~/Library/Caches/dev.turnlane.desktop",
        "~/Library/Logs/turnlane",
        "~/Library/Preferences/dev.turnlane.desktop.plist",
        "~/Library/Saved Application State/dev.turnlane.desktop.savedState",
        "~/Library/WebKit/dev.turnlane.desktop",
      ]

  caveats <<~EOS
    Turnlane's hooks and MCP entries in Claude Code and Codex are not removed by
    \`brew uninstall\`. Before uninstalling, run:
      turnlane uninstall --all
    Your data in ~/Library/Application Support/turnlane stays unless you use
    \`brew uninstall --zap --cask turnlane\`.
  EOS
end
`;

describe("cask の描画", () => {
  test("雛形に版と sha256 と名前を差し込む（固定の出力）", () => {
    expect(renderCaskFile({ version: "0.7.0", sha256: SHA })).toBe(EXPECTED);
    expect(TAP_CASK_PATH).toBe("Casks/turnlane.rb");
  });

  test("url の #{version} を展開すると core の releaseZipUrl と同じ", () => {
    const cask = renderCaskFile({ version: "1.2.3", sha256: SHA });
    const url = /^\s*url "([^"]+)"/m.exec(cask)?.[1] ?? "";
    expect(url.replaceAll("#{version}", "1.2.3")).toBe(releaseZipUrl("1.2.3"));
  });

  test("uninstall に launchctl を書かず、postflight を持たない（uninstall は brew upgrade のたびに走る）", () => {
    const cask = renderCaskFile({ version: "0.7.0", sha256: SHA });
    const uninstall = cask.split("\n").filter((l) => /^\s*uninstall\b/.test(l));
    expect(uninstall).toEqual(['  uninstall quit: "dev.turnlane.desktop"']);
    expect(cask).not.toContain("postflight");
    expect(cask).not.toContain("turnlane.dev");
  });

  test("名前を差し替えると雛形のどこにも元の名前が残らない（雛形は持ち主の名前を持たない）", () => {
    expect(readFileSync(CASK_TEMPLATE, "utf8")).not.toContain("github.com");
    const out = renderCask(
      'cask "{{CASK_TOKEN}}" do\n  url "{{RELEASES_DOWNLOAD_URL}}/v#{version}/x.zip"\n  homepage "{{HOMEPAGE}}"\nend\n',
      { version: "0.7.0", sha256: SHA },
      {
        CASK_TOKEN: "turnlane",
        HOMEPAGE: "https://github.com/example-org/turnlane",
        RELEASES_DOWNLOAD_URL: "https://github.com/example-org/turnlane/releases/download",
      },
    );
    expect(out).toContain('homepage "https://github.com/example-org/turnlane"');
    expect(out).not.toContain("github.com/turnlane/");
  });

  test.each([
    { version: "0.7", sha256: SHA, err: "invalid version" },
    { version: "v0.7.0", sha256: SHA, err: "invalid version" },
    { version: "0.7.0", sha256: "abc", err: "sha256" },
    { version: "0.7.0", sha256: SHA.toUpperCase(), err: "sha256" },
  ])("不正な値は例外: $version / $err", (c) => {
    expect(() => renderCaskFile(c)).toThrow(c.err);
  });

  test("差し込み漏れは例外", () => {
    expect(() => renderCask('cask "{{OTHER}}"', { version: "0.7.0", sha256: SHA })).toThrow(
      "unfilled placeholder {{OTHER}}",
    );
  });
});
