/**
 * S5 実験 2: Codex の hooks.json と信頼承認（[hooks.state]）の挙動。
 *
 * - 一時 CODEX_HOME だけを使う。実ユーザーの ~/.codex には触れない（auth.json も無い状態で動かす）
 * - `codex app-server`（stdio の JSON-RPC）の `hooks/list` で、各 hook の key / current_hash /
 *   trust_status / 読み込み警告を取る。モデルは呼ばない
 * - 「ユーザーが /hooks で承認した」状態は、hooks/list が返した current_hash を
 *   config.toml の [hooks.state."<key>"].trusted_hash に書いて再現する（一時ディレクトリ内のみ）
 *
 * 実行: bun experiments/codex-trust.ts
 */
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// biome-ignore lint/suspicious/noExplicitAny: 実験用
type Json = any;

const OTHER = { hooks: [{ type: "command", command: "other-tool hook", timeout: 5 }] };
const DAYLINE = {
  hooks: [
    {
      type: "command",
      command: "'/opt/dl' hook --tool codex --managed-by dayline",
      timeout: 2,
    },
  ],
};

async function hooksList(home: string, cwd: string): Promise<Json> {
  const proc = Bun.spawn(["codex", "app-server"], {
    env: { PATH: process.env.PATH ?? "", HOME: process.env.HOME ?? "", CODEX_HOME: home },
    cwd,
    stdin: "pipe",
    stdout: "pipe",
    stderr: "pipe",
  });
  const send = (m: Json) => {
    proc.stdin.write(`${JSON.stringify(m)}\n`);
    proc.stdin.flush();
  };
  const reader = proc.stdout.getReader();
  let buf = "";
  const wait = async (id: number): Promise<Json> => {
    const deadline = Date.now() + 20_000;
    while (Date.now() < deadline) {
      const nl = buf.indexOf("\n");
      if (nl >= 0) {
        const line = buf.slice(0, nl);
        buf = buf.slice(nl + 1);
        if (!line.trim()) continue;
        const msg = JSON.parse(line);
        if (msg.id === id) return msg;
        continue;
      }
      const { value, done } = await reader.read();
      if (done) break;
      buf += new TextDecoder().decode(value);
    }
    throw new Error(`timeout waiting for ${id}`);
  };
  send({
    jsonrpc: "2.0",
    id: 1,
    method: "initialize",
    params: { clientInfo: { name: "s5-spike", version: "0" } },
  });
  await wait(1);
  send({ jsonrpc: "2.0", method: "initialized" });
  send({ jsonrpc: "2.0", id: 2, method: "hooks/list", params: { cwds: [cwd] } });
  const res = await wait(2);
  proc.kill();
  return res;
}

function writeHooks(home: string, obj: Json): void {
  writeFileSync(join(home, "hooks.json"), `${JSON.stringify(obj, null, 2)}\n`);
}

function writeConfig(home: string, states: Record<string, string>, extra = ""): void {
  let toml = `[features]\nhooks = true\n${extra}\n`;
  for (const [k, h] of Object.entries(states)) {
    toml += `\n[hooks.state."${k}"]\ntrusted_hash = "${h}"\n`;
  }
  writeFileSync(join(home, "config.toml"), toml);
}

function summarize(res: Json, home: string): Json {
  if (res.error) return { error: res.error.message };
  const data = res.result?.data ?? [];
  return data.map((d: Json) => ({
    warnings: (d.warnings ?? []).map((w: string) => w.replaceAll(home, "<home>")),
    errors: (d.errors ?? []).map((w: Json) => JSON.stringify(w).replaceAll(home, "<home>")),
    hooks: (d.hooks ?? []).map((h: Json) => ({
      key: String(h.key).replaceAll(home, "<home>"),
      event: h.eventName,
      command: h.handler?.command ?? h.command,
      trust: h.trustStatus,
      enabled: h.enabled,
      hash: h.currentHash,
    })),
  }));
}

const root = realpathSync(mkdtempSync(join(tmpdir(), "s5-codex-")));
const steps: Json[] = [];
try {
  const home = join(root, "home");
  const cwd = join(root, "cwd");
  mkdirSync(home, { recursive: true });
  mkdirSync(cwd, { recursive: true });

  // 1. 他ツールの hook だけ（未承認）
  writeConfig(home, {});
  writeHooks(home, { hooks: { Stop: [OTHER] } });
  let r = summarize(await hooksList(home, cwd), home);
  steps.push({ step: "1_other_only_untrusted", r });
  const otherKey = r[0].hooks[0].key.replace("<home>", home);
  const otherHash = r[0].hooks[0].hash;

  // 2. ユーザーが承認した状態
  writeConfig(home, { [otherKey]: otherHash });
  r = summarize(await hooksList(home, cwd), home);
  steps.push({ step: "2_other_trusted", r });

  // 2b. async: true を付けた場合（Codex 0.147 は async を未対応として読み飛ばす）
  writeHooks(home, { hooks: { Stop: [OTHER, { hooks: [{ ...DAYLINE.hooks[0], async: true }] }] } });
  r = summarize(await hooksList(home, cwd), home);
  steps.push({ step: "2b_dayline_async_true", r });

  // 3. dayline を末尾に追加
  writeHooks(home, { hooks: { Stop: [OTHER, DAYLINE] } });
  r = summarize(await hooksList(home, cwd), home);
  steps.push({ step: "3_dayline_appended", r });
  const dlKey = r[0].hooks[1].key.replace("<home>", home);
  const dlHash = r[0].hooks[1].hash;

  // 4. dayline を先頭に挿入した場合（やってはいけない例）
  writeHooks(home, { hooks: { Stop: [DAYLINE, OTHER] } });
  r = summarize(await hooksList(home, cwd), home);
  steps.push({ step: "4_dayline_prepended", r });

  // 5. dayline を承認し、その後に他ツールがさらに末尾へ追加 → dayline を削除
  writeConfig(home, { [otherKey]: otherHash, [dlKey]: dlHash });
  const THIRD = { hooks: [{ type: "command", command: "third-tool hook", timeout: 5 }] };
  writeHooks(home, { hooks: { Stop: [OTHER, DAYLINE, THIRD] } });
  r = summarize(await hooksList(home, cwd), home);
  steps.push({ step: "5a_third_appended_after_dayline", r });
  const thirdKey = r[0].hooks[2].key.replace("<home>", home);
  const thirdHash = r[0].hooks[2].hash;
  writeConfig(home, { [otherKey]: otherHash, [dlKey]: dlHash, [thirdKey]: thirdHash });
  writeHooks(home, { hooks: { Stop: [OTHER, THIRD] } });
  r = summarize(await hooksList(home, cwd), home);
  steps.push({ step: "5b_dayline_removed_from_middle", r });

  // 6. トップレベルに未知キー
  writeConfig(home, { [otherKey]: otherHash });
  writeHooks(home, { "x-dayline": { managed: true }, hooks: { Stop: [OTHER] } });
  r = summarize(await hooksList(home, cwd), home);
  steps.push({ step: "6_toplevel_unknown_key", r });

  // 7. グループ・ハンドラに未知キー（hash は変わるか）
  writeHooks(home, {
    hooks: {
      Stop: [{ managedBy: "dayline", hooks: [{ ...OTHER.hooks[0], managedBy: "dayline" }] }],
    },
  });
  r = summarize(await hooksList(home, cwd), home);
  steps.push({ step: "7_group_and_handler_unknown_key", r });

  // 8. features.hooks = false
  writeHooks(home, { hooks: { Stop: [OTHER] } });
  writeFileSync(
    join(home, "config.toml"),
    `[features]\nhooks = false\n\n[hooks.state."${otherKey}"]\ntrusted_hash = "${otherHash}"\n`,
  );
  r = summarize(await hooksList(home, cwd), home);
  steps.push({ step: "8_features_hooks_false", r });
  const feat = Bun.spawnSync(["codex", "features", "list"], {
    env: { PATH: process.env.PATH ?? "", HOME: process.env.HOME ?? "", CODEX_HOME: home },
  })
    .stdout.toString()
    .split("\n")
    .filter((l) => /^hooks\b|^codex_hooks\b/.test(l));
  steps.push({ step: "8b_features_list_hooks_line", r: feat });

  // 9. hooks.json の JSON が壊れている
  writeFileSync(join(home, "hooks.json"), "{ not json");
  writeConfig(home, {});
  r = summarize(await hooksList(home, cwd), home);
  steps.push({ step: "9_broken_json", r });
} finally {
  rmSync(root, { recursive: true, force: true });
}
const version = Bun.spawnSync(["codex", "--version"]).stdout.toString().trim();
const outPath = join(import.meta.dir, "..", "results", "codex-trust.json");
writeFileSync(outPath, `${JSON.stringify({ codexVersion: version, steps }, null, 2)}\n`);
console.log(JSON.stringify(steps, null, 1));
