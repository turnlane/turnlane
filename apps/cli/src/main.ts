// turnlane のエントリ（phase0-plan 3.6、ADR 0007）。
// 引数を見てからサブコマンドのモジュールを動的 import する。`turnlane hook` の起動時間を保つため、
// ここで静的に import してよいのは小さな version モジュールと言語のモジュールだけ。
import { VERSION } from "@turnlane/core/version";
import { langFromVars, setLang } from "./lang.ts";

const [cmd, ...rest] = process.argv.slice(2);

/** 使い方を出す前に言語を決める（設定 ui.language を DB から読む。hook の速い経路では呼ばない） */
async function helpLang(): Promise<void> {
  const [{ resolveLang }, { resolvePaths }] = await Promise.all([
    import("./lang.ts"),
    import("@turnlane/core"),
  ]);
  setLang(resolveLang(process.env, resolvePaths().dbPath));
}

switch (cmd) {
  case "hook":
    if (rest.includes("--help") || rest.includes("-h")) {
      await helpLang();
      console.log((await import("./run.ts")).helpFor("hook"));
    } else {
      // 速い経路: 言語は環境変数だけで決める（DB を開かない）
      setLang(langFromVars(process.env));
      await (await import("./hook/run.ts")).runHook(rest);
    }
    break;
  case "statusline":
    // 速い経路: Turnlane が起動した Claude Code の statusLine の受け口（使い方には出さない）
    await (await import("./statusline/run.ts")).statusLineMain();
    break;
  case "--version":
  case "-v":
  case "version":
    console.log(`turnlane ${VERSION}`);
    break;
  case undefined:
  case "--help":
  case "-h":
    await helpLang();
    console.log((await import("./run.ts")).usage());
    break;
  default: {
    const { runCommand } = await import("./run.ts");
    try {
      process.exitCode = await runCommand(cmd, rest);
    } catch (e) {
      console.error(`turnlane ${cmd}: ${(e as Error).message}`);
      process.exitCode = 1;
    }
  }
}
