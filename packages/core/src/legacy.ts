/**
 * 名前を変える前（旧名 dayline）の版がカレンダーに残した予定の目印（ADR 0016）。旧名で作った予定を
 * 編集できるように、読み取りと時間ブロックの予定の判定・削除にだけ使う。新しく書く目印には使わない。
 *
 * 旧名の文字列はこのファイルに集める（scripts/check-names.ts が他の場所の旧名を検出する）。
 */

/** 旧名の版が作った予定の目印（カレンダーに残るので読み続ける） */
export const LEGACY_EVENT_URL_PREFIX = "dayline://event/";
/** M3-3 の旧名の版が書いた時間ブロックの予定の目印（D-093 で書くのをやめた。削除の対象の判定と読み取りでの除外） */
export const LEGACY_TIMEBLOCK_URL_PREFIX = "dayline://timeblock/";
