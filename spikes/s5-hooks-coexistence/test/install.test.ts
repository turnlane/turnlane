import { describe, expect, test } from "bun:test";
import {
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  realpathSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { install, isDaylineHandler, status, uninstall } from "../src/hooks-config.ts";
import { load, save } from "../src/json-file.ts";
import { claudeHooksDisabled, claudePlan, codexInspect, codexPlan, detectClaudeDirs } from "../src/targets.ts";

const DL = "/Users/someone/.local/bin/dl";
const claude = claudePlan(DL);
const codex = codexPlan(DL);

// 他ツールのエントリを含む設定（他ツールは Stop と PreToolUse に hook を持つ）
const CLAUDE_WITH_OTHERS = {
  permissions: { allow: ["Bash(git status)"] },
  hooks: {
    PreToolUse: [{ matcher: "Bash", hooks: [{ type: "command", command: "other-guard", timeout: 10 }] }],
    Stop: [{ hooks: [{ type: "command", command: "notify-me", timeout: 10 }] }],
  },
  statusLine: { type: "command", command: "my-status" },
};

function tmp(): string {
  return mkdtempSync(join(tmpdir(), "s5-test-"));
}

function roundTrip(original: string, plan = claude): { afterInstall: string; afterTwice: string; afterUninstall: string } {
  const dir = tmp();
  try {
    const p = join(dir, "settings.json");
    writeFileSync(p, original);
    const a = load(p);
    save(a, install(a.value, plan).next, { backupSuffix: ".bak-dayline-1" });
    const afterInstall = readFileSync(p, "utf8");
    const b = load(p);
    const second = save(b, install(b.value, plan).next, { backupSuffix: ".bak-dayline-2" });
    expect(second.changed).toBe(false); // 冪等: 2回目は書かない
    expect(existsSync(`${p}.bak-dayline-2`)).toBe(false);
    const afterTwice = readFileSync(p, "utf8");
    const c = load(p);
    save(c, uninstall(c.value).next, { backupSuffix: ".bak-dayline-3" });
    const afterUninstall = readFileSync(p, "utf8");
    return { afterInstall, afterTwice, afterUninstall };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

describe("install / uninstall の往復", () => {
  test("他ツールのエントリを含む正規形の settings.json はバイト単位で元に戻る", () => {
    const original = `${JSON.stringify(CLAUDE_WITH_OTHERS, null, 2)}\n`;
    const r = roundTrip(original);
    expect(r.afterTwice).toBe(r.afterInstall);
    expect(r.afterUninstall).toBe(original);
  });

  test("他ツールのエントリは位置も内容も変わらない（dayline は各イベントの末尾）", () => {
    const { next } = install(CLAUDE_WITH_OTHERS, claude);
    expect(next.hooks.PreToolUse).toEqual(CLAUDE_WITH_OTHERS.hooks.PreToolUse);
    expect(next.hooks.Stop[0]).toEqual(CLAUDE_WITH_OTHERS.hooks.Stop[0]);
    expect(isDaylineHandler(next.hooks.Stop[1].hooks[0])).toBe(true);
    expect(next.hooks.Stop).toHaveLength(2);
  });

  test("hooks キーが無い settings.json でも元に戻る", () => {
    const original = `${JSON.stringify({ theme: "dark" }, null, 2)}\n`;
    expect(roundTrip(original).afterUninstall).toBe(original);
  });

  test("インデント4・末尾改行なしでも書式を保つ", () => {
    const original = JSON.stringify(CLAUDE_WITH_OTHERS, null, 4);
    expect(roundTrip(original).afterUninstall).toBe(original);
  });

  test("正規形でないファイル（キーの後ろの空白など）は意味が同じで書式が正規化される", () => {
    const original = '{\n  "theme" :  "dark",\n  "hooks": {}\n}\n';
    const r = roundTrip(original);
    expect(JSON.parse(r.afterUninstall)).toEqual({ theme: "dark" }); // 既知の差: 空の hooks も消える
    expect(load(join(tmpdir(), "nonexistent-s5.json")).exists).toBe(false);
  });

  test("Codex の hooks.json（他ツールあり）も元に戻る", () => {
    const original = `${JSON.stringify({ hooks: { Stop: [{ hooks: [{ type: "command", command: "x", timeout: 5 }] }] } }, null, 2)}\n`;
    expect(roundTrip(original, codex).afterUninstall).toBe(original);
  });

  test("ファイルが無ければ作り、uninstall で中身が {} になる（ファイルは消さない）", () => {
    const dir = tmp();
    try {
      const p = join(dir, "hooks.json");
      const a = load(p);
      save(a, install(a.value, codex).next, { backupSuffix: ".bak" });
      expect(existsSync(p)).toBe(true);
      expect(readdirSync(dir)).toEqual(["hooks.json"]); // 新規作成時はバックアップ無し
      const b = load(p);
      save(b, uninstall(b.value).next, { backupSuffix: ".bak2" });
      expect(JSON.parse(readFileSync(p, "utf8"))).toEqual({});
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("更新と壊れた状態からの回復", () => {
  test("dl のパスが変わったら同じ位置で置き換える（Codex の他ツールの承認位置を動かさない）", () => {
    const first = install({ hooks: { Stop: [{ hooks: [{ type: "command", command: "x" }] }] } }, codex).next;
    first.hooks.Stop.push({ hooks: [{ type: "command", command: "third" }] }); // 後から他ツールが追加
    const { next, report } = install(first, codexPlan("/opt/homebrew/bin/dl"));
    expect(report.updated).toContain("Stop");
    expect(next.hooks.Stop.map((g: { hooks: { command: string }[] }) => g.hooks[0]?.command)).toEqual([
      "x",
      "'/opt/homebrew/bin/dl' hook --tool codex --managed-by dayline",
      "third",
    ]);
  });

  test("dayline のグループが重複していたら1つにまとめる", () => {
    const once = install({}, claude).next;
    once.hooks.Stop.push(structuredClone(once.hooks.Stop[0]));
    const { next } = install(once, claude);
    expect(next.hooks.Stop).toHaveLength(1);
  });

  test("他ツールのグループに混ぜ込まれた dayline のハンドラは外し、そのグループは残す", () => {
    const mixed = {
      hooks: {
        Stop: [
          {
            hooks: [
              { type: "command", command: "notify-me" },
              { type: "command", command: `'${DL}' hook --tool claude_code --managed-by dayline` },
            ],
          },
        ],
      },
    };
    const { next } = uninstall(mixed);
    expect(next).toEqual({ hooks: { Stop: [{ hooks: [{ type: "command", command: "notify-me" }] }] } });
  });

  test("対象外になったイベントの dayline エントリは install で外す", () => {
    const old = install({}, claude).next;
    old.hooks.PostToolUse = [{ hooks: [{ type: "command", command: `x hook --managed-by dayline` }] }];
    const { next, report } = install(old, claude);
    expect(next.hooks.PostToolUse).toBeUndefined();
    expect(report.removed).toEqual(["PostToolUse"]);
  });

  test("識別は --managed-by dayline の語に限る（似た文字列は他ツール扱い）", () => {
    expect(isDaylineHandler({ type: "command", command: "dl hook --managed-by daylinex" })).toBe(false);
    expect(isDaylineHandler({ type: "command", command: "echo '--managed-by dayline-other'" })).toBe(false);
    expect(isDaylineHandler({ type: "http", url: "http://x", command: "--managed-by dayline" })).toBe(false);
  });

  test("status: none / partial / installed / outdated", () => {
    expect(status({}, claude).state).toBe("none");
    const full = install({}, claude).next;
    expect(status(full, claude).state).toBe("installed");
    delete full.hooks.Notification;
    expect(status(full, claude).state).toBe("partial");
    expect(status(install({}, claude).next, claudePlan("/other/dl")).state).toBe("outdated");
  });

  test("JSON が壊れていたら読み込みで止まり、ファイルに触れない", () => {
    const dir = tmp();
    try {
      const p = join(dir, "settings.json");
      writeFileSync(p, "{ // comment\n}");
      expect(() => load(p)).toThrow();
      expect(readFileSync(p, "utf8")).toBe("{ // comment\n}");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("読み込み後に他プロセスが書き換えたら保存を中止する", () => {
    const dir = tmp();
    try {
      const p = join(dir, "settings.json");
      writeFileSync(p, "{}\n");
      const a = load(p);
      writeFileSync(p, '{\n  "theme": "light"\n}\n');
      expect(() => save(a, install(a.value, claude).next, { backupSuffix: ".bak" })).toThrow();
      expect(readFileSync(p, "utf8")).toBe('{\n  "theme": "light"\n}\n');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("ファイルシステムの扱い", () => {
  test("シンボリックリンクの settings.json はリンクを保ったまま実体を書き換える。パーミッションも保つ", () => {
    const dir = tmp();
    try {
      const real = join(dir, "dotfiles-settings.json");
      writeFileSync(real, "{}\n", { mode: 0o644 });
      const cfg = join(dir, "cfg");
      mkdirSync(cfg);
      const link = join(cfg, "settings.json");
      symlinkSync(real, link);
      const a = load(link);
      const r = save(a, install(a.value, claude).next, { backupSuffix: ".bak-dayline-1" });
      expect(lstatSync(link).isSymbolicLink()).toBe(true);
      expect(status(JSON.parse(readFileSync(real, "utf8")), claude).state).toBe("installed");
      expect(statSync(real).mode & 0o777).toBe(0o644);
      expect(r.backup).toBe(`${realpathSync(real)}.bak-dayline-1`);
      expect(readFileSync(`${real}.bak-dayline-1`, "utf8")).toBe("{}\n");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("dry-run は書かない", () => {
    const dir = tmp();
    try {
      const p = join(dir, "settings.json");
      writeFileSync(p, "{}\n");
      const a = load(p);
      const r = save(a, install(a.value, claude).next, { backupSuffix: ".bak", dryRun: true });
      expect(r.changed).toBe(true);
      expect(readFileSync(p, "utf8")).toBe("{}\n");
      expect(readdirSync(dir)).toEqual(["settings.json"]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("複数の Claude 設定ディレクトリを検出し、それぞれに入れられる", () => {
    const home = tmp();
    try {
      for (const d of [".claude", ".claude-acme", ".claude-sandbox"]) {
        mkdirSync(join(home, d, "projects"), { recursive: true });
      }
      mkdirSync(join(home, ".claude-empty")); // projects も settings.json も無いものは対象外
      writeFileSync(join(home, ".claude.json"), "{}"); // ファイルは対象外
      const dirs = detectClaudeDirs(home, {});
      expect(dirs.map((d) => d.slice(home.length + 1))).toEqual([".claude", ".claude-acme", ".claude-sandbox"]);
      for (const d of dirs) {
        const f = load(join(d, "settings.json"));
        save(f, install(f.value, claude).next, { backupSuffix: ".bak" });
      }
      for (const d of dirs) {
        expect(status(JSON.parse(readFileSync(join(d, "settings.json"), "utf8")), claude).state).toBe("installed");
      }
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });
});

describe("無効化と信頼承認の検出", () => {
  test("Claude: disableAllHooks と管理設定", () => {
    const dir = tmp();
    try {
      const managed = join(dir, "managed-settings.json");
      expect(claudeHooksDisabled({}, managed).disabled).toBe(false);
      expect(claudeHooksDisabled({ disableAllHooks: true }, managed).reasons).toEqual([
        "settings.json: disableAllHooks",
      ]);
      writeFileSync(managed, JSON.stringify({ allowManagedHooksOnly: true }));
      expect(claudeHooksDisabled({}, managed).reasons).toEqual(["managed-settings: allowManagedHooksOnly"]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("Codex: features.hooks = false と、dayline の位置の承認エントリ", () => {
    const hooksJson = install({ hooks: { Stop: [{ hooks: [{ type: "command", command: "x" }] }] } }, codex).next;
    const toml = [
      "[features]",
      "hooks = false",
      "",
      '[hooks.state."/h/.codex/hooks.json:stop:1:0"]',
      'trusted_hash = "sha256:abc"',
      "",
      '[hooks.state."/h/.codex/hooks.json:stop:0:0"]',
      'trusted_hash = "sha256:def"',
    ].join("\n");
    const r = codexInspect(toml, "/h/.codex/hooks.json", hooksJson);
    expect(r.featureDisabled).toBe(true);
    expect(r.trustEntries.Stop).toBe(true);
    expect(r.trustEntries.SessionStart).toBe(false); // SessionStart は dayline のみで 0:0。承認エントリなし
  });
});
