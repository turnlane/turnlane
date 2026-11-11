/**
 * Google のカレンダーか（「Google カレンダーで招待」。0.8.2）。ヘルパが返す EKSource の種類が calDAV で、
 * アカウント名が「Google」か、そのカレンダーの予定の外部 ID（iCalendar の UID）が `@google.com` で終わるもの。
 * Exchange（外部 ID が `040000008200…` の長い形）・iCloud・ローカル・購読は Google にしない
 */
export interface GoogleProbe {
  /** EKSource の種類（calDAV・exchange・local・subscribed・birthdays など。分からなければ null） */
  sourceType: string | null;
  /** EKSource の名前（calendar.account_name） */
  accountName: string | null;
  /** そのカレンダーの予定に、外部 ID が `@google.com` で終わるものがある */
  hasGoogleIds: boolean;
}

export function isGoogleCalendar(p: GoogleProbe): boolean {
  if ((p.sourceType ?? "").toLowerCase() !== "caldav") return false;
  if ((p.accountName ?? "").trim().toLowerCase() === "google") return true;
  return p.hasGoogleIds;
}
