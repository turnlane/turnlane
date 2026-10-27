/**
 * 更新の知らせ（M6-17。onboarding.md 2.5）: 画面上部の 1 行。Homebrew 版はコマンドのコピー、zip の版はリリースのページ、
 * dev・閉じた版・新しい版が無いときは出さない。SSE update で取り直す（確認の直後に出る）
 */
import { describe, expect, test } from "bun:test";
import type { UpdateStatus } from "@turnlane/core/web";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { UpdateBarView, updateNotice } from "../src/components/UpdateBar.tsx";
import { shouldInvalidate } from "../src/data/invalidate.ts";
import { I18nProvider, type Locale } from "../src/i18n/index.tsx";

const status = (o: Partial<UpdateStatus> = {}): UpdateStatus => ({
  enabled: true,
  configured: true,
  current: "0.7.0",
  latest: { version: "0.7.1", url: "https://github.com/o/r", sha256: null },
  available: true,
  checkedAt: 1,
  error: null,
  channel: "homebrew",
  upgradeCommand: "brew upgrade --cask turnlane",
  releasesUrl: null,
  dismissed: null,
  off: null,
  ...o,
});

const RELEASES = "https://github.com/turnlane/turnlane/releases/latest";

function render(s: UpdateStatus | null, locale: Locale = "en"): string {
  return renderToStaticMarkup(
    createElement(I18nProvider, {
      locale,
      // biome-ignore lint/correctness/noChildrenProp: I18nProvider の型は children を props で要る
      children: createElement(UpdateBarView, {
        notice: updateNotice(s),
        onCopy: () => {},
        onDismiss: () => {},
      }),
    }),
  );
}

describe("更新の知らせの 1 行", () => {
  test("Homebrew 版: 版とコマンドのコピーと閉じる", () => {
    const h = render(status());
    expect(h).toContain('data-testid="update-bar"');
    expect(h).toContain('data-action="copy"');
    expect(h).toContain("Turnlane 0.7.1 is available");
    expect(h).toContain("Copy brew upgrade --cask turnlane");
    expect(h).toContain('data-testid="update-dismiss"');
    expect(h).not.toContain('data-testid="update-open"');
  });

  test("zip の版: 最新リリースのページを開くリンク", () => {
    const h = render(status({ channel: "download", upgradeCommand: null, releasesUrl: RELEASES }));
    expect(h).toContain('data-action="open"');
    expect(h).toContain(`href="${RELEASES}"`);
    expect(h).toContain("Open Releases");
    expect(h).not.toContain('data-testid="update-copy"');
  });

  test("日本語", () => {
    const h = render(status(), "ja");
    expect(h).toContain("Turnlane 0.7.1 に更新できます");
    expect(h).toContain("brew upgrade --cask turnlane をコピー");
    expect(
      render(status({ channel: "download", upgradeCommand: null, releasesUrl: RELEASES }), "ja"),
    ).toContain("リリースのページを開く");
  });

  test("dev・新しい版が無い・閉じた版・状態が無いときは出さない。新しい版が出ればまた出す", () => {
    expect(render(status({ channel: "dev", upgradeCommand: null }))).toBe("");
    expect(render(status({ available: false }))).toBe("");
    expect(render(status({ dismissed: "0.7.1" }))).toBe("");
    expect(render(null)).toBe("");
    // 0.7.1 を閉じた後に 0.7.2 が出た
    expect(
      updateNotice(
        status({
          dismissed: "0.7.1",
          latest: { version: "0.7.2", url: "https://github.com/o/r", sha256: null },
        }),
      ),
    ).toEqual({ version: "0.7.2", action: "copy", command: "brew upgrade --cask turnlane" });
    // 開く先の無い zip の版は出さない
    expect(
      updateNotice(status({ channel: "download", upgradeCommand: null, releasesUrl: null })),
    ).toBeNull();
  });
});

describe("SSE update", () => {
  test("update は GET /api/update（キー update）だけを取り直す", () => {
    const today = "2026-10-27";
    expect(shouldInvalidate(["update"], "update", {}, today)).toBe(true);
    expect(shouldInvalidate(["queue"], "update", {}, today)).toBe(false);
    expect(shouldInvalidate(["board", today, today], "update", {}, today)).toBe(false);
    // ほかのイベントでは取り直さない（日の境目は全部）
    expect(shouldInvalidate(["update"], "settings", {}, today)).toBe(false);
    expect(shouldInvalidate(["update"], "day_boundary", {}, today)).toBe(true);
  });

  test("available が false → true に変わると知らせが出て、true → false で消える", () => {
    expect(updateNotice(status({ available: false }))).toBeNull();
    expect(updateNotice(status({ available: true }))?.version).toBe("0.7.1");
    expect(render(status({ available: false }))).toBe("");
  });
});
