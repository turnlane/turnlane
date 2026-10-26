/**
 * Vite の dist/ をデーモンのバイナリに埋め込むためのモジュールを生成する（M0-9、ADR 0007）。
 * dist/ のファイル一覧から `with { type: "file" }` の import と、URL パス → { file, MIME } の表を作る。
 *
 *   bun scripts/gen-web-assets.ts <distDir> <outFile>
 *
 * 生成物は .build/ に置き、コミットしない。
 */
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, relative, resolve } from "node:path";
import { mimeFor } from "../apps/daemon/src/http/static.ts";

const STATIC_TS = resolve(import.meta.dir, "../apps/daemon/src/http/static.ts");

function specifier(fromDir: string, target: string): string {
  const spec = relative(fromDir, target).split("\\").join("/");
  return spec.startsWith(".") ? spec : `./${spec}`;
}

export async function generateWebAssetsModule(distDir: string, outFile: string): Promise<number> {
  const dist = resolve(distDir);
  const files: string[] = [];
  for await (const rel of new Bun.Glob("**/*").scan({ cwd: dist, onlyFiles: true })) {
    files.push(rel);
  }
  files.sort();
  if (!files.includes("index.html")) throw new Error(`index.html not found in ${dist}`);

  const outDir = dirname(resolve(outFile));
  const lines = [
    "// 自動生成（scripts/gen-web-assets.ts）。編集しない",
    `import type { StaticAssets } from ${JSON.stringify(specifier(outDir, STATIC_TS))};`,
  ];
  files.forEach((rel, i) => {
    lines.push(
      `import f${i} from ${JSON.stringify(specifier(outDir, resolve(dist, rel)))} with { type: "file" };`,
    );
  });
  lines.push("", "export const webAssets: StaticAssets = {");
  files.forEach((rel, i) => {
    lines.push(
      `  ${JSON.stringify(`/${rel}`)}: { file: f${i}, type: ${JSON.stringify(mimeFor(rel))} },`,
    );
  });
  lines.push("};", "");
  mkdirSync(outDir, { recursive: true });
  writeFileSync(outFile, lines.join("\n"));
  return files.length;
}

if (import.meta.main) {
  const [distDir, outFile] = process.argv.slice(2);
  if (!distDir || !outFile) {
    console.error("usage: bun scripts/gen-web-assets.ts <distDir> <outFile>");
    process.exit(2);
  }
  const n = await generateWebAssetsModule(distDir, outFile);
  console.log(`web assets: ${n} files -> ${outFile}`);
}
