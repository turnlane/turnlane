import { describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

// biome.json のプロジェクト固有ルールが効いていることを確認する（ルールの設定ミスで素通りしないように）。
const ROOT = join(import.meta.dir, "..");
const BIOME = join(ROOT, "node_modules/.bin/biome");

/** 指定したパスに一時ファイルを置いて lint する（biome の stdin モードは診断を出さないため） */
function lint(path: string, source: string): string {
  const file = join(
    ROOT,
    path.replace(/\.tsx?$/, (ext) => `.lint-probe-${process.pid}${ext}`),
  );
  // 作ったディレクトリは後で消す（存在しない最上位の祖先を覚えておく）
  let created: string | null = null;
  for (let d = dirname(file); !existsSync(d); d = dirname(d)) created = d;
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, source);
  try {
    const p = Bun.spawnSync([process.execPath, "--bun", BIOME, "lint", file], {
      cwd: ROOT,
      stdout: "pipe",
      stderr: "pipe",
    });
    return p.stdout.toString() + p.stderr.toString();
  } finally {
    rmSync(file, { force: true });
    if (created) rmSync(created, { recursive: true, force: true });
  }
}

describe("同期対象テーブルへの直接書き込みの禁止（phase0-plan 2.4）", () => {
  test("routes から task へ insert すると plugin の診断が出る", () => {
    const out = lint(
      "apps/daemon/src/http/routes/x.ts",
      'import { schema } from "@turnlane/core";\ndeclare const db: { insert(t: unknown): void };\ndb.insert(schema.task);\n',
    );
    expect(out).toContain("mutate()");
  });
  test("取り込み系（ai_turn）への書き込みと、同期対象の読み取りは許可", () => {
    const out = lint(
      "apps/daemon/src/ingest/sink.ts",
      'import { schema } from "@turnlane/core";\ndeclare const db: { insert(t: unknown): void; select(): { from(t: unknown): void } };\ndb.insert(schema.aiTurn);\ndb.select().from(schema.task);\n',
    );
    expect(out).not.toContain("mutate()");
  });
});

describe("turnlane hook の import 制限（ADR 0007・0009）", () => {
  test("hook/ は node:fs、同じディレクトリのファイル、@turnlane/collectors/hook-allowlist だけを import できる", () => {
    const out = lint(
      "apps/cli/src/hook/x.ts",
      [
        'import { readFileSync } from "node:fs";',
        'import { join } from "node:path";',
        'import { VERSION } from "@turnlane/core/version";',
        'import { HOOK_ALLOWLIST } from "@turnlane/collectors/hook-allowlist";',
        'import { pickAllowed } from "@turnlane/collectors";',
        'import { a } from "./x2.ts";',
        'import x from "../commands/a.ts";',
        "export const z = [readFileSync, join, VERSION, HOOK_ALLOWLIST, pickAllowed, a, x];",
        "",
      ].join("\n"),
    );
    // node:path・@turnlane/core/version・@turnlane/collectors・../commands の4つ
    expect(out.match(/noRestrictedImports/g)?.length).toBe(4);
  });
  test("collectors/src/hook-allowlist.ts は何も import できない", () => {
    const out = lint(
      "packages/collectors/src/hook-allowlist.ts",
      'import { readFileSync } from "node:fs";\nimport { a } from "./define.ts";\nexport const z = [readFileSync, a];\n',
    );
    expect(out.match(/noRestrictedImports/g)?.length).toBe(2);
  });
});

describe("collectors の公開境界（phase0-plan 3.1.1）", () => {
  test("collectors から @turnlane/core と drizzle-orm を import できない", () => {
    const out = lint(
      "packages/collectors/src/x.ts",
      'import { newId } from "@turnlane/core";\nimport { sql } from "drizzle-orm";\nexport const a = [newId, sql];\n',
    );
    expect(out.match(/noRestrictedImports/g)?.length).toBe(2);
  });
});
