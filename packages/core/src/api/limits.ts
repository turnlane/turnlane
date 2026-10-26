/** Claude の利用枠（statusLine の `rate_limits`）の型。拡張点 `limits.claude(account)` と受け口の API で使う */
import type { EpochMs } from "./common.ts";

/** 1つの枠（5時間・7日）: 使用率（0〜100。超えることもある）とリセットの時刻 */
export interface ClaudeLimitWindow {
  usedPercentage: number;
  resetsAt: EpochMs;
}

/** アカウント（設定ディレクトリ）ごとの最新の値。届いていない枠・リセットの時刻を過ぎた枠は無い */
export interface ClaudeLimits {
  fiveHour?: ClaudeLimitWindow;
  sevenDay?: ClaudeLimitWindow;
  /** 受け取った時刻 */
  at: EpochMs;
}
