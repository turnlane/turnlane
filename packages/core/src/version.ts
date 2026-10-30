// ビルド時に `--define __TURNLANE_VERSION__='"x.y.z"'` で埋め込む。開発中は 0.0.0-dev。
declare const __TURNLANE_VERSION__: string | undefined;

export const VERSION: string =
  typeof __TURNLANE_VERSION__ === "string" ? __TURNLANE_VERSION__ : "0.0.0-dev";

// ビルド時に `--define __TURNLANE_COMMIT__='"e820ba7"'` で埋め込む（短いコミット）。開発中・分からなければ null
declare const __TURNLANE_COMMIT__: string | undefined;

export const COMMIT: string | null =
  typeof __TURNLANE_COMMIT__ === "string" && __TURNLANE_COMMIT__ ? __TURNLANE_COMMIT__ : null;

/** 版とビルドの印（`0.8.0+e820ba7`。コミットが分からなければ版だけ） */
export const BUILD: string = COMMIT ? `${VERSION}+${COMMIT}` : VERSION;
