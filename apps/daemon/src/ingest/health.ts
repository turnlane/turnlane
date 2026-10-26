/**
 * 縮退レベルの判定（ai-session-ingestion 3.4、phase0-plan 3.2・M1-12）。
 * - L0 フル
 * - L1: 必須キーの欠落率が 20% を超えたストリームが3本以上（ファイル形式が変わった疑い）。
 *       hooks を受信していれば hooks spool で状態とセッションを把握する
 * - L2: L1 で、hooks も受信していない（ファイルの mtime だけで活動を把握する）
 * - L3（非表示）はユーザーがソースを無効にした場合で、ここでは判定しない
 * testedVersions の範囲外は縮退させず、理由に注意を書くだけ。
 */
export interface StreamHealth {
  records: number;
  missingRequired: number;
  unknownTypes: number;
}

export interface HealthInput {
  streams: StreamHealth[];
  hooksReceiving: boolean;
  versionOk: boolean;
  detectedVersion: string | null;
  testedVersions: string;
}

export interface HealthResult {
  level: "L0" | "L1" | "L2";
  reason: string | null;
}

export const MISSING_RATIO = 0.2;
export const BROKEN_STREAMS = 3;

export function assessHealth(h: HealthInput): HealthResult {
  const broken = h.streams.filter(
    (s) => s.records > 0 && s.missingRequired / s.records > MISSING_RATIO,
  ).length;
  const reasons: string[] = [];
  let level: HealthResult["level"] = "L0";
  if (broken >= BROKEN_STREAMS) {
    level = h.hooksReceiving ? "L1" : "L2";
    reasons.push(`format_changed:${broken}_streams`);
  }
  if (!h.versionOk)
    reasons.push(`untested_version:${h.detectedVersion}(tested ${h.testedVersions})`);
  return { level, reason: reasons.length > 0 ? reasons.join(" ") : null };
}
