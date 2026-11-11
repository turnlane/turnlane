/**
 * Google カレンダーの Web の画面を開く URL（「Google カレンダーで招待」。0.8.2。ux-mvp 4.12・4.20 の後）。
 * Turnlane は Google の API に触らない（OAuth なし）。予定の作成の画面に題名・時刻・招待する人を入れて開き、招待と相手の
 * 空きの確認（Google の「時間を探す」）は Google の画面で行う。既存の予定はその編集画面（分からなければその日の表示）を開く
 */

const BASE = "https://calendar.google.com/calendar/u/0/r";
/** 新しい予定の作成の画面（テンプレートの形） */
const RENDER = "https://calendar.google.com/calendar/render";

/** メールの形か（招待する人の欄・アカウントの判定） */
export function looksLikeEmail(s: string | null | undefined): boolean {
  return !!s && /^[^\s@,;<>]+@[^\s@,;<>]+\.[^\s@,;<>]+$/.test(s.trim());
}

/** 招待する人の欄（カンマ・セミコロン・空白区切り）→ メールの形のものだけ（重複は除く。入力の順） */
export function parseGuests(text: string): string[] {
  const out: string[] = [];
  for (const x of text.split(/[\s,;]+/)) {
    const v = x.trim();
    if (looksLikeEmail(v) && !out.includes(v)) out.push(v);
  }
  return out;
}

/** その時間帯の壁時計の `YYYYMMDDTHHmmss` */
export function googleDateTime(ms: number, tz: string): string {
  const parts = Object.fromEntries(
    new Intl.DateTimeFormat("en-US", {
      timeZone: tz,
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
      hourCycle: "h23",
    })
      .formatToParts(new Date(ms))
      .map((p) => [p.type, p.value]),
  );
  return `${parts.year}${parts.month}${parts.day}T${parts.hour}${parts.minute}${parts.second}`;
}

const compactDate = (d: string) => d.replaceAll("-", "");

/** Google のアカウントのメール（アカウントの選択に渡す）: カレンダーの名前、無ければアカウントの名前がメールの形ならそれ */
export function googleAccountOf(
  calendarName: string | null,
  accountName: string | null,
): string | null {
  if (looksLikeEmail(calendarName)) return (calendarName as string).trim();
  if (looksLikeEmail(accountName)) return (accountName as string).trim();
  return null;
}

export interface NewGoogleEvent {
  title: string;
  /** 時刻のある予定（allDay でなければ必須） */
  start?: number;
  end?: number;
  /** 終日の予定: 開始日と終わりの日（終わりは含まない翌日。YYYY-MM-DD） */
  allDay?: { startDate: string; endDate: string };
  tz: string;
  guests: readonly string[];
  location?: string | null;
  /** Google のアカウントのメール（分かればアカウントの選択を通して開く。分からなければ null） */
  account?: string | null;
}

/** 新しい予定の作成の画面（題名・日時・時間帯・招待する人・場所） */
export function googleNewEventUrl(e: NewGoogleEvent): string {
  const dates = e.allDay
    ? `${compactDate(e.allDay.startDate)}/${compactDate(e.allDay.endDate)}`
    : `${googleDateTime(e.start ?? 0, e.tz)}/${googleDateTime(e.end ?? 0, e.tz)}`;
  const q: [string, string][] = [
    ["action", "TEMPLATE"],
    ["text", e.title],
    ["dates", dates],
    ["ctz", e.tz],
  ];
  if (e.guests.length > 0) q.push(["add", e.guests.join(",")]);
  if (e.location?.trim()) q.push(["location", e.location.trim()]);
  // 新規は render?action=TEMPLATE（Google の案内の形。Google が作成の画面へ移し、項目を入れて開く）。
  // `/u/0/r/eventedit?text=…` は実機のアカウントで題名が入らなかった
  return withAccount(
    `${RENDER}?${q.map(([k, v]) => `${k}=${encodeURIComponent(v)}`).join("&")}`,
    e.account ?? null,
  );
}

/**
 * アカウントのメールが分かれば、Google のアカウントの選択（AccountChooser）を通して開く: そのアカウントでログインして
 * いれば選び、いなければそのメールでのログインを求めてから continue へ進む。`authuser=` はそのブラウザでログイン済みの
 * ときしか効かず、違えば黙って既定のアカウント（u/0）で開いてしまう（実機で別のアカウントの画面になった）
 */
export function withAccount(url: string, email: string | null | undefined): string {
  if (!looksLikeEmail(email)) return url;
  return `https://accounts.google.com/AccountChooser?Email=${encodeURIComponent(
    (email as string).trim(),
  )}&continue=${encodeURIComponent(url)}`;
}

/** base64url（パディングなし）。UTF-8 */
function base64url(s: string): string {
  const bytes = new TextEncoder().encode(s);
  let bin = "";
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin).replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/, "");
}

/**
 * Google の予定の ID（EventKit の外部 ID `<id>@google.com` の `@` より前。繰り返しの回の `_YYYYMMDDTHHmmssZ` は残す）。
 * Google の予定でなければ null
 */
export function googleEventIdOf(externalId: string | null | undefined): string | null {
  const m = /^(.+)@google\.com$/i.exec((externalId ?? "").trim());
  return m?.[1] ? m[1] : null;
}

/**
 * 既存の予定の編集画面（eid = base64url(`<イベント ID> <カレンダーのメール>`)）。カレンダーのメール（名前がメールの形）か
 * イベント ID が分からなければ、その日（date。YYYY-MM-DD）の表示
 */
export function googleEventEditUrl(p: {
  externalId: string | null | undefined;
  calendarName: string | null;
  date: string;
  /** Google のアカウントのメール（分かればアカウントの選択を通して開く） */
  account?: string | null;
}): string {
  const id = googleEventIdOf(p.externalId);
  if (id && looksLikeEmail(p.calendarName))
    return withAccount(
      `${BASE}/eventedit/${base64url(`${id} ${(p.calendarName as string).trim()}`)}`,
      p.account,
    );
  const [y, m, d] = p.date.split("-");
  return withAccount(`${BASE}/day/${y}/${m}/${d}`, p.account);
}

/** 外の URL を開く（デスクトップアプリは新しいウインドウの要求を既定のブラウザに渡す。ブラウザは新しいタブ） */
export function openExternalUrl(url: string): void {
  window.open(url, "_blank", "noopener,noreferrer");
}
