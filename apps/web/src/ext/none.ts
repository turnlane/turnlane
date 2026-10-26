/**
 * 拡張なし（公開のビルド）。Vite の alias `@turnlane/ext-web` の既定の先（ADR 0015）。
 * scripts/build.ts --ext を使ったビルドだけ、alias が .build/ext-web.gen.ts を指す
 */
import type { WebExtension } from "./types.ts";

export const extensions: WebExtension[] = [];
