/**
 * 拡張の組み込み（ADR 0015）: `--ext <dir>` の dir にある `extension.json` を読み、デーモンと Web の一覧のモジュールを作る。
 *
 *   { "id": "<拡張の id>", "daemon": "<dir からの相対パス>", "web": "<dir からの相対パス>" }
 *
 * daemon / web はどちらか片方でもよい。デーモンのモジュールは DaemonExtensionFactory、Web のモジュールは WebExtension を
 * default export する。生成するファイルは .build/ に置く（リポジトリには入れない）
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { isAbsolute, join, resolve } from "node:path";

export interface ExtManifest {
  id: string;
  dir: string;
  daemon: string | null;
  web: string | null;
}

const ID_RE = /^[a-z][a-z0-9]{1,23}$/;

export function readExtManifest(dir: string): ExtManifest {
  const abs = resolve(dir);
  const file = join(abs, "extension.json");
  if (!existsSync(file)) throw new Error(`--ext ${dir}: extension.json not found`);
  const raw = JSON.parse(readFileSync(file, "utf8")) as Record<string, unknown>;
  const id = raw.id;
  if (typeof id !== "string" || !ID_RE.test(id)) throw new Error(`${file}: invalid id`);
  const entry = (k: "daemon" | "web") => {
    const v = raw[k];
    if (v === undefined || v === null) return null;
    if (typeof v !== "string" || isAbsolute(v)) throw new Error(`${file}: ${k} must be relative`);
    const p = resolve(abs, v);
    if (!existsSync(p)) throw new Error(`${file}: ${k} entry not found: ${v}`);
    return p;
  };
  return { id, dir: abs, daemon: entry("daemon"), web: entry("web") };
}

export function readExtManifests(dirs: readonly string[]): ExtManifest[] {
  const out = dirs.map(readExtManifest);
  const ids = out.map((m) => m.id);
  const dup = ids.find((x, i) => ids.indexOf(x) !== i);
  if (dup) throw new Error(`duplicate extension id: ${dup}`);
  return out;
}

/** `--ext <dir>` を繰り返し読める */
export function extArgs(args: readonly string[]): string[] {
  const out: string[] = [];
  args.forEach((a, i) => {
    const v = args[i + 1];
    if (a === "--ext" && v) out.push(v);
  });
  return out;
}

/** デーモンの一覧（`export const extensions = [...]`）。拡張が無ければ空の一覧 */
export function daemonListSource(ms: readonly ExtManifest[]): string {
  const xs = ms.filter((m) => m.daemon);
  return [
    "// 自動生成（scripts/build.ts）。組み込む拡張（ADR 0015）。公開のビルドでは空",
    'import type { DaemonExtensionFactory } from "../apps/daemon/src/ext/types.ts";',
    ...xs.map((m, i) => `import ext${i} from ${JSON.stringify(m.daemon)};`),
    `export const extensions: DaemonExtensionFactory[] = [${xs.map((_, i) => `ext${i}`).join(", ")}];`,
    "",
  ].join("\n");
}

/** Web の一覧（Vite の alias `@turnlane/ext-web` の先）。拡張が無ければ null（alias は空の実装 apps/web/src/ext/none.ts） */
export function webListSource(ms: readonly ExtManifest[]): string | null {
  const xs = ms.filter((m) => m.web);
  if (xs.length === 0) return null;
  return [
    "// 自動生成（scripts/build.ts）。組み込む拡張（ADR 0015）",
    'import type { WebExtension } from "../apps/web/src/ext/types.ts";',
    ...xs.map((m, i) => `import ext${i} from ${JSON.stringify(m.web)};`),
    `export const extensions: WebExtension[] = [${xs.map((_, i) => `ext${i}`).join(", ")}];`,
    "",
  ].join("\n");
}

/** .build/ に一覧を書き、Web の一覧のパス（無ければ null）を返す */
export function writeExtLists(
  buildDir: string,
  ms: readonly ExtManifest[],
): { daemon: string; web: string | null } {
  mkdirSync(buildDir, { recursive: true });
  const daemon = join(buildDir, "extensions.gen.ts");
  writeFileSync(daemon, daemonListSource(ms));
  const src = webListSource(ms);
  const web = src ? join(buildDir, "ext-web.gen.ts") : null;
  if (web && src) writeFileSync(web, src);
  return { daemon, web };
}
