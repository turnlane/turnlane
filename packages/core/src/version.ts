// ビルド時に `--define __TURNLANE_VERSION__='"x.y.z"'` で埋め込む。開発中は 0.0.0-dev。
declare const __TURNLANE_VERSION__: string | undefined;

export const VERSION: string =
  typeof __TURNLANE_VERSION__ === "string" ? __TURNLANE_VERSION__ : "0.0.0-dev";
