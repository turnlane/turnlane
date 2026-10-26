/** doctor の署名の行（M6-8）: 種別と公証のチケットの有無。staple はファイルを見るだけで判定する */
import { afterAll, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { notarizationStapled } from "../src/commands/desktop.ts";
import { type InstallSummary, signatureLines } from "../src/commands/doctor-redact.ts";

const base: InstallSummary = { mode: "app", cliLinkOk: true, background: null };
const dir = mkdtempSync(join(tmpdir(), "turnlane-doctor-sig-"));
afterAll(() => rmSync(dir, { recursive: true, force: true }));

describe("署名の行", () => {
  test("Developer ID で staple 済みなら公証済み", () => {
    expect(
      signatureLines({ ...base, signature: { kind: "Developer ID Application", stapled: true } }),
    ).toEqual(["signature: Developer ID · notarized (ticket stapled)"]);
  });

  test("Apple Development・ad-hoc は未公証", () => {
    expect(
      signatureLines({ ...base, signature: { kind: "Apple Development", stapled: false } }),
    ).toEqual(["signature: Apple Development · not notarized"]);
    expect(signatureLines({ ...base, signature: { kind: "ad-hoc", stapled: false } })).toEqual([
      "signature: ad-hoc · not notarized",
    ]);
  });

  test("Developer ID でカレンダーの許可が無ければ、再許可の場所を添える", () => {
    const x = { ...base, signature: { kind: "Developer ID Application", stapled: true } };
    const lines = signatureLines(x, { calendarAccess: "notDetermined" });
    expect(lines).toHaveLength(2);
    expect(lines[1]).toContain("Privacy & Security");
    expect(signatureLines(x, { calendarAccess: "fullAccess" })).toHaveLength(1);
    // Apple Development では出さない（証明書の切り替えの話ではない）
    expect(
      signatureLines(
        { ...base, signature: { kind: "Apple Development", stapled: false } },
        { calendarAccess: "denied" },
      ),
    ).toHaveLength(1);
  });

  test(".app が無ければ行を出さない", () => {
    expect(signatureLines(base)).toEqual([]);
    expect(signatureLines({ ...base, signature: null })).toEqual([]);
  });

  test("staple の判定は Contents/CodeResources の有無", () => {
    const app = join(dir, "Turnlane.app");
    mkdirSync(join(app, "Contents"), { recursive: true });
    expect(notarizationStapled(app)).toBe(false);
    writeFileSync(join(app, "Contents", "CodeResources"), "");
    expect(notarizationStapled(app)).toBe(true);
  });
});
