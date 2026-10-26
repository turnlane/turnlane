import { fileURLToPath } from "node:url";
import tailwindcss from "@tailwindcss/vite";
import react from "@vitejs/plugin-react";
import { defineConfig, type Plugin } from "vite";

/**
 * @fontsource の CSS から woff（woff2 の予備）を外す。対象のブラウザは woff2 を読めるので、
 * デーモンに埋め込むファイル（約 8MB）を減らす
 */
function woff2Only(): Plugin {
  return {
    name: "turnlane-woff2-only",
    enforce: "pre",
    transform(code, id) {
      if (!id.includes("@fontsource") || !id.endsWith(".css")) return null;
      return code.replace(/,\s*url\([^)]*\.woff\)\s*format\(['"]woff['"]\)/g, "");
    },
  };
}

// 開発中は Vite dev server がデーモンへプロキシする（phase0-plan 1.2）。
// ブラウザは http://localhost:5173 を開き、先に `turnlane open` 相当で /auth を通しておく必要は無い
// （プロキシ経由の /auth?t=<token> でクッキーが localhost:5173 に付く）。
const daemon = `http://127.0.0.1:${process.env.TURNLANE_PORT ?? "7317"}`;

/**
 * 拡張（ADR 0015）: `@turnlane/ext-web` は組み込む拡張の一覧。scripts/build.ts --ext が TURNLANE_EXT_WEB に
 * .build/ext-web.gen.ts を渡す。無ければ空の一覧（公開のビルド）。拡張は `@turnlane/ext-host`（本体が公開する部品）と
 * react だけを実行時に import する。拡張のリポジトリはこのリポジトリの外にあるので、react 等は dedupe でこちらの1つに揃える
 */
const extWeb =
  process.env.TURNLANE_EXT_WEB?.trim() ||
  fileURLToPath(new URL("./src/ext/none.ts", import.meta.url));
const extHost = fileURLToPath(new URL("./src/ext/host.ts", import.meta.url));

/**
 * 拡張のソースを Tailwind の走査に足す（拡張はこのリポジトリの外にあり、Tailwind が自動では見ないため）。
 * TURNLANE_EXT_SOURCES は拡張のディレクトリの JSON 配列（scripts/build.ts が渡す）
 */
function extSources(): Plugin {
  let dirs: string[] = [];
  try {
    const v = JSON.parse(process.env.TURNLANE_EXT_SOURCES || "[]") as unknown;
    if (Array.isArray(v)) dirs = v.filter((x): x is string => typeof x === "string");
  } catch {}
  return {
    name: "turnlane-ext-sources",
    enforce: "pre",
    transform(code, id) {
      if (dirs.length === 0 || !id.endsWith("/src/styles.css")) return null;
      const lines = dirs.map((d) => `@source ${JSON.stringify(d)};`).join("\n");
      return code.replace('@import "tailwindcss";', `@import "tailwindcss";\n${lines}`);
    },
  };
}

export default defineConfig({
  plugins: [woff2Only(), extSources(), react(), tailwindcss()],
  resolve: {
    alias: { "@turnlane/ext-web": extWeb, "@turnlane/ext-host": extHost },
    dedupe: [
      "react",
      "react-dom",
      "@tanstack/react-query",
      "@tanstack/react-router",
      "lucide-react",
    ],
  },
  build: {
    outDir: "dist",
    emptyOutDir: true,
    sourcemap: false,
  },
  server: {
    port: 5173,
    proxy: {
      "/api": { target: daemon, changeOrigin: true },
      "/auth": { target: daemon, changeOrigin: true },
    },
  },
});
