/**
 * デモ動画（M6-30）の台本: 構図・カット・字幕（docs/dev/demo-video.md）。録画（scripts/demo-record.ts）と組み立て
 * （scripts/demo-assemble.ts）が同じ表を読む。秒は 2 言語で同じ。
 *
 * 座標は舞台（1440×900 pt。Playwright の viewport、実機の Turnlane のウインドウの中身）。原本は 2 倍（2880×1800）。
 */

export type Lang = "ja" | "en";

/** 構図（x, y, 幅, 高さ。舞台の pt）。どれも 16:10 */
export const FRAMES = {
  /** ボード全体 */
  F1: [0, 0, 1440, 900],
  /**
   * 自分の番の帯・未定・AI のレーン（13:20〜15:50 あたり）。時間軸は 0:00〜24:00 の 1200px で、いちばん下までスクロール
   * しても上端は 10:20 ごろ（絵コンテの「13:00 が上」にはならない）。帯と 15:20 の今の線が同じ絵に入るよう、絵コンテの
   * (400, 60, 752×470) から下にずらして広げた
   */
  F2: [392, 122, 768, 480],
  /** F2 に右下の Ghostty のウインドウを足したもの */
  F3: [400, 60, 1024, 640],
  /** 画面下の真ん中の知らせ（トースト）と Ghostty の左下。絵コンテの y 560 だと舞台の下端（900）を 20 出るので 540 に */
  F4: [420, 540, 576, 360],
} as const satisfies Record<string, readonly [number, number, number, number]>;
export type FrameName = keyof typeof FRAMES;

/** カット（[始まり, 終わり) 秒、構図、素材）。scene12 = Playwright の録画、scene3 = 実機の録画 */
export interface Cut {
  from: number;
  to: number;
  frame: FrameName;
  source: "scene12" | "scene3";
}

export const CUTS_12: Cut[] = [
  { from: 0, to: 6.5, frame: "F1", source: "scene12" },
  { from: 6.5, to: 17.5, frame: "F2", source: "scene12" },
];
/** 場面 (3)。28.0〜31.0 は 28.0 の絵の止め絵（組み立てで伸ばす） */
export const CUTS_3: Cut[] = [
  { from: 17.5, to: 20.3, frame: "F2", source: "scene3" },
  { from: 20.3, to: 22.8, frame: "F3", source: "scene3" },
  { from: 22.8, to: 25.6, frame: "F4", source: "scene3" },
  { from: 25.6, to: 28.0, frame: "F3", source: "scene3" },
];
export const SCENE12_END = 17.5;
export const FULL_END = 31.0;
/** 止め絵の始まり（場面 (3) の最後の絵を 3 秒伸ばす） */
export const FREEZE_AT = 28.0;
/** 合図（C が止まる）の秒。録画の頭はここから 7.5 秒前 */
export const SIGNAL_AT = 7.5;
/** 通知のバナー（案 A）を重ねる区間 */
export const BANNER = { from: 7.6, to: 12.6 } as const;

export interface Subtitle {
  from: number;
  to: number;
  text: Record<Lang, string>;
}

/** 字幕（絵コンテ §3）。締めの URL は英語版だけ（D-259） */
export const SUBTITLES: Subtitle[] = [
  {
    from: 0,
    to: 3.2,
    text: {
      ja: "AI が自分を待ったら、すぐ分かる",
      en: "Know the moment your AI is waiting on you",
    },
  },
  {
    from: 3.2,
    to: 6.5,
    text: {
      ja: "Claude Code を 3 本、今日の予定と同じボードで",
      en: "Three Claude Code sessions, on the same board as your day",
    },
  },
  {
    from: 6.5,
    to: 10.0,
    text: {
      ja: "1 本が、コマンドの許可を待って止まった",
      en: "One of them stops to ask permission for a command",
    },
  },
  {
    from: 10.0,
    to: 14.0,
    text: {
      ja: "通知と自分の番に、どれが・なぜ止まったかが出る",
      en: "The notification and Your turn say which one, and why",
    },
  },
  {
    from: 14.0,
    to: 17.5,
    text: { ja: "ボードを見張っていなくていい", en: "No need to keep watching the board" },
  },
  {
    from: 17.5,
    to: 22.8,
    text: {
      ja: "「開いて対応」で、そのセッションの Ghostty のタブが前に出る",
      en: "“Open and respond” brings that session's Ghostty tab to the front",
    },
  },
  {
    from: 22.8,
    to: 25.6,
    text: { ja: "どのタブを前に出したかを知らせる", en: "It tells you which tab it brought up" },
  },
  {
    from: 25.6,
    to: 28.0,
    text: {
      ja: "新しく起動せず、動いているセッションに戻る",
      en: "No new session: you're back in the one that's running",
    },
  },
  {
    from: 28.0,
    to: 31.0,
    text: {
      ja: "Turnlane — AI の待ちと自分の一日を、1 つのボードに",
      en: "Turnlane — your AI's waits and your day, on one board\ngithub.com/turnlane/turnlane",
    },
  },
];

/** 区間 [from, to) に入る字幕（区間の端で切る） */
export function subtitlesWithin(end: number): Subtitle[] {
  return SUBTITLES.filter((s) => s.from < end).map((s) => ({ ...s, to: Math.min(s.to, end) }));
}

/** 構図を原本（2 倍）の画素に（ffmpeg の crop=w:h:x:y） */
export function cropOf(frame: FrameName, scale = 2): string {
  const [x, y, w, h] = FRAMES[frame];
  return `${w * scale}:${h * scale}:${x * scale}:${y * scale}`;
}
