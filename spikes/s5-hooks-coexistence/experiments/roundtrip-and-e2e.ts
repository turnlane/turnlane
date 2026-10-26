/**
 * S5 実験 3:
 *  (a) 実際の設定ファイルの「コピー」で install → install → uninstall の往復がバイト一致するか
 *      （実ファイルは読み取りのみ。コピーは一時ディレクトリに置き、終わったら消す。出力は真偽値と件数だけ）
 *  (b) 一時 CLAUDE_CONFIG_DIR に、他ツールの hook と dayline の hook（偽の dl）を並べて入れ、
 *      Claude Code が両方を実行するか
 *  (c) 一時 CODEX_HOME で、承認前は dayline の hook が実行されず、承認後に実行されるか
 *
 * 実行: bun experiments/roundtrip-and-e2e.ts
 */
import {
  chmodSync,
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { install, status, uninstall } from "../src/hooks-config.ts";
import { load, save } from "../src/json-file.ts";
import { claudeHooksDisabled, claudePlan, codexInspect, codexPlan, detectClaudeDirs } from "../src/targets.ts";

// biome-ignore lint/suspicious/noExplicitAny: 実験用
type Json = any;
const out: Json = {};
const root = realpathSync(mkdtempSync(join(tmpdir(), "s5-e2e-")));

try {
  // ---------- (a) 実ファイルのコピーで往復 ----------
  const home = homedir();
  const claudeDirs = detectClaudeDirs(home, {});
  const targets: { label: string; src: string; plan: Json }[] = claudeDirs.map((d, i) => ({
    label: `claude_dir_${i}`,
    src: join(d, "settings.json"),
    plan: claudePlan("/fake/dl"),
  }));
  targets.push({ label: "codex_hooks_json", src: join(home, ".codex", "hooks.json"), plan: codexPlan("/fake/dl") });
  out.roundTrip = [];
  for (const t of targets) {
    if (!existsSync(t.src)) {
      out.roundTrip.push({ label: t.label, exists: false });
      continue;
    }
    const copy = join(root, `${t.label}.json`);
    copyFileSync(t.src, copy);
    const original = readFileSync(copy, "utf8");
    const a = load(copy);
    const otherGroupsBefore = countGroups(a.value);
    save(a, install(a.value, t.plan).next, { backupSuffix: ".bak1" });
    const b = load(copy);
    const st = status(b.value, t.plan).state;
    const second = save(b, install(b.value, t.plan).next, { backupSuffix: ".bak2" });
    const c = load(copy);
    save(c, uninstall(c.value).next, { backupSuffix: ".bak3" });
    out.roundTrip.push({
      label: t.label,
      exists: true,
      canonical: a.canonical,
      otherGroupsBefore,
      groupsAfterInstall: countGroups(b.value),
      stateAfterInstall: st,
      secondInstallChanged: second.changed,
      byteEqualAfterUninstall: readFileSync(copy, "utf8") === original,
      disableAllHooks: t.label.startsWith("claude") ? claudeHooksDisabled(a.value).disabled : undefined,
    });
  }
  const realToml = join(home, ".codex", "config.toml");
  if (existsSync(realToml)) {
    out.codexFeatureDisabled = codexInspect(readFileSync(realToml, "utf8"), "/n/a", {}).featureDisabled;
  }

  // ---------- (b) Claude: 他ツール + dayline（偽の dl）の並存 ----------
  const fakeDl = join(root, "fake-dl");
  const log = join(root, "fake-dl.log");
  // 偽の dl: 引数と hook_event_name だけを記録（本文は記録しない）
  writeFileSync(
    fakeDl,
    `#!/bin/sh\nev=$(jq -r .hook_event_name)\necho "$ev $*" >> '${log}'\nexit 0\n`,
  );
  chmodSync(fakeDl, 0o755);
  const otherLog = join(root, "other.log");
  const cfg = join(root, "claude-cfg");
  mkdirSync(cfg);
  const cwd = join(root, "cwd");
  mkdirSync(cwd);
  const base = {
    hooks: {
      SessionStart: [{ hooks: [{ type: "command", command: `echo other-start >> '${otherLog}'`, timeout: 5 }] }],
      UserPromptSubmit: [{ hooks: [{ type: "command", command: `echo other-prompt >> '${otherLog}'`, timeout: 5 }] }],
    },
  };
  writeFileSync(join(cfg, "settings.json"), `${JSON.stringify(base, null, 2)}\n`);
  const s = load(join(cfg, "settings.json"));
  save(s, install(s.value, claudePlan(fakeDl)).next, { backupSuffix: ".bak-dayline-test" });
  const p = Bun.spawnSync(["claude", "-p", "say ok", "--max-turns", "1"], {
    cwd,
    env: {
      PATH: process.env.PATH ?? "",
      HOME: process.env.HOME ?? "",
      CLAUDE_CONFIG_DIR: cfg,
      ANTHROPIC_API_KEY: "sk-ant-dummy-s5-spike",
    },
    timeout: 30_000,
  });
  out.claudeE2E = {
    exitCode: p.exitCode,
    daylineFired: readLines(log).map((l) => l.replace(fakeDl, "<dl>")),
    otherFired: readLines(otherLog),
  };

  // ---------- (c) Codex: 承認前後 ----------
  const chome = join(root, "codex-home");
  mkdirSync(chome);
  writeFileSync(join(chome, "config.toml"), "");
  const clog = join(root, "fake-dl-codex.log");
  const fakeDlCodex = join(root, "fake-dl-codex");
  writeFileSync(fakeDlCodex, `#!/bin/sh\nev=$(jq -r .hook_event_name)\necho "$ev" >> '${clog}'\nexit 0\n`);
  chmodSync(fakeDlCodex, 0o755);
  const hj = load(join(chome, "hooks.json"));
  save(hj, install(hj.value, codexPlan(fakeDlCodex)).next, { backupSuffix: ".bak" });
  const runCodex = () =>
    Bun.spawnSync(["codex", "exec", "--skip-git-repo-check", "say ok"], {
      cwd,
      env: { PATH: process.env.PATH ?? "", HOME: process.env.HOME ?? "", CODEX_HOME: chome, OPENAI_API_KEY: "sk-dummy-s5" },
      timeout: 30_000,
    });
  const r1 = runCodex();
  const before = readLines(clog);
  const r1out = `${r1.stdout}${r1.stderr}`;
  out.codexBeforeTrust = {
    exitCode: r1.exitCode,
    daylineFired: before,
    mentionsHooksReview: /\/hooks|untrusted|review/i.test(r1out),
    hookWarningLines: r1out
      .split("\n")
      .filter((l) => /hook/i.test(l))
      .map((l) => l.replaceAll(root, "<tmp>").slice(0, 200))
      .slice(0, 5),
  };
  out.codexNote = "承認後の実行は experiments/codex-trust.ts の hooks/list で trust=trusted を確認済み。ここでは exec で実行されるかを見る";
} finally {
  rmSync(root, { recursive: true, force: true });
}

function readLines(p: string): string[] {
  return existsSync(p) ? readFileSync(p, "utf8").trim().split("\n").filter(Boolean) : [];
}

function countGroups(v: Json): number {
  let n = 0;
  for (const arr of Object.values(v?.hooks ?? {})) if (Array.isArray(arr)) n += arr.length;
  return n;
}

writeFileSync(join(import.meta.dir, "..", "results", "roundtrip-and-e2e.json"), `${JSON.stringify(out, null, 2)}\n`);
console.log(JSON.stringify(out, null, 2));
