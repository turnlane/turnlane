/**
 * 会議リンクの判定（D-097。m2-api 25章）。予定の URL・場所・メモに会議サービスの URL があるか。
 * カレンダーヘルパ 0.5.0（native/calendar-helper の `meetingHosts`）も同じ一覧で判定し、メモの本文は外に出さず真偽値だけ返す。
 * 一覧を変えたら両方を変える（test/focus.test.ts で照合する）。
 */

/** 会議サービスのホスト。先頭が `.` のものはそのドメインのサブドメインも含む */
export const MEETING_HOSTS: readonly string[] = [
  "meet.google.com",
  "zoom.us",
  ".zoom.us",
  "zoomgov.com",
  ".zoomgov.com",
  "teams.microsoft.com",
  "teams.live.com",
  ".webex.com",
  "whereby.com",
  "meet.jit.si",
  "chime.aws",
  "bluejeans.com",
  ".bluejeans.com",
  "gotomeeting.com",
  ".gotomeeting.com",
  "meet.goto.com",
  "around.co",
  "facetime.apple.com",
];

const URL_RE = /https?:\/\/([a-z0-9.-]+)/gi;

/** ホストが会議サービスか */
export function isMeetingHost(host: string): boolean {
  const h = host.toLowerCase().replace(/\.$/, "");
  return MEETING_HOSTS.some((m) => (m.startsWith(".") ? h.endsWith(m) : h === m));
}

/** 文字列のどれかに会議サービスの URL があるか（null・空は飛ばす） */
export function hasMeetingLink(texts: readonly (string | null | undefined)[]): boolean {
  for (const t of texts) {
    if (!t) continue;
    for (const m of t.matchAll(URL_RE)) {
      if (m[1] && isMeetingHost(m[1])) return true;
    }
  }
  return false;
}
