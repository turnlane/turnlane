/**
 * 拡張点（Web 側。ADR 0015）。拡張はビルドのときに組み込む（Vite の alias `@turnlane/ext-web` が拡張の一覧を指す。
 * 公開のビルドでは空の一覧 `./none.ts`）。拡張のモジュールは `WebExtension` を default export する。
 *
 * 拡張のモジュールが実行時に import してよいのは、`@turnlane/ext-host`（./host.ts。本体が拡張に公開する部品）と react だけ。
 * 型は `@turnlane/web/ext`（このファイル）と `@turnlane/core/web` から import type する。
 *
 * - 辞書のキーは `ext.<id>.` で始める（本体の辞書と同じく英語が正、日本語は部分集合）
 * - 画面の経路は `/ext/<id>` の下だけ
 * - 本体は「拡張が使えるか」を判定しない。使えないときの表示は拡張が決める
 */
import type { OpenAction, TaskView } from "@turnlane/core/web";
import type { ComponentType } from "react";

/** 拡張の辞書のキー */
export type ExtMessageKey = `ext.${string}`;

export type ExtPluralValue = { one?: string; other: string };
export type ExtDict = Record<string, string | ExtPluralValue>;

/** 設定の節（左の目次に出し、`/settings#ext-<id>-<節の id>` で開く） */
export interface ExtSettingsSection {
  /** 拡張の中で一意（小文字の英数字とハイフン） */
  id: string;
  title: ExtMessageKey;
  /** 設定の検索に出す項目（anchor は画面の data-setting の値） */
  items?: { anchor: string; title: ExtMessageKey; hint?: ExtMessageKey }[];
  component: ComponentType;
  /** 見出しの右に出す小さな部品（状態の印など。無ければ見出しだけ） */
  titleAside?: ComponentType;
}

/**
 * 拡張が `@turnlane/ext-host` の `useKeys` で受けられるキー（本体のキーマップの id。キーは利用者の割り当てに従う）。
 * - next / prev: 次・前の項目（j・↓ / k・↑）
 * - open: 開く（⏎）/ select: 選ぶ（x）
 * - reorderUp / reorderDown: 一覧の中で上へ・下へ（⌘↑ / ⌘↓）
 * - remove: 一覧から外す（⌫）
 * - escape: Esc（拡張の画面のカードを閉じるなど）。部品の処理が先に呼ばれ、false を返すと本体へ回る。枠の中の画面では、
 *   部品が受けなければ本体がパレット・パネルを閉じる。入力欄の中でも届く
 * 1文字のキーと ⌫ は入力欄にフォーカスがあるときは届かない
 */
export type ExtKeyId =
  | "next"
  | "prev"
  | "open"
  | "select"
  | "reorderUp"
  | "reorderDown"
  | "remove"
  | "escape";

/** 拡張が登録するキーの処理。false を返したら処理しなかったことになり、次の処理（本体）へ回る */
export type ExtKeyHandlers = Partial<Record<ExtKeyId, (e: KeyboardEvent) => boolean | undefined>>;

/**
 * サイドバーの下（設定の上、取り込み・カレンダーの知らせの上）に出す1行。部品は `@turnlane/ext-host` の `SidebarNotice`
 * を返すか、出さないときは null。サイドバーを畳んだときも同じ部品が呼ばれ、`SidebarNotice` がアイコンで描く（右上の点は
 * 件数か状態があるときだけ。`SidebarNoticeProps.count`・`mark`）
 */
export interface ExtSidebarItem {
  id: string;
  component: ComponentType;
}

/**
 * メニューバーのポップオーバー（/tray）の下の操作の先頭（集中の行の上）に出す1行。部品は `@turnlane/ext-host` の
 * `TrayRow` を返すか、出さないときは null
 */
export interface ExtTrayItem {
  id: string;
  component: ComponentType;
}

/**
 * 今日の列の上部の先頭（自分の番の帯の上）と、デイビューの右の一覧の先頭に出す1行（D-192）。部品は `@turnlane/ext-host` の
 * `TodayNotice` を返すか、出さないときは null。1行だけ（複数の拡張があれば登録順に並ぶ）
 */
export interface ExtTodayNotice {
  id: string;
  component: ComponentType;
}

/** タスクの右クリックメニューの項目（1件・未完了のタスクだけ）。⌘K で同じタスクを選んでいるときは「選択中」の節にも出す */
export interface ExtTaskMenuItem {
  id: string;
  label: ExtMessageKey;
  when?: (task: TaskView) => boolean;
  run: (task: TaskView, anchor: HTMLElement | null) => void;
}

/** タスクの詳細パネルの節（AI の節の後） */
export interface ExtPanelSection {
  id: string;
  component: ComponentType<{ task: TaskView }>;
}

/**
 * 拡張が作ったタスク（デーモンの `tasks.create` の `external.source`）の出どころ。Inbox の行・タスクのカードの2行目・
 * 詳細パネルの「経由」に、内部の名前ではなく `label` を出す。`to` があれば詳細パネルの「経由」の右に本体の画面への移動を出す
 */
export interface ExtTaskOrigin {
  /** `external.source` の値。`ext.<id>` か `ext.<id>.<名前>`（小文字の英数字・ハイフン） */
  source: string;
  label: ExtMessageKey;
  /** 押したときに移る画面（`/ext/<id>/…` など。`navigate` と同じ） */
  to?: string;
  /**
   * 詳細パネルの主ボタンの文言。あれば、このタスク（未完了）の主ボタンはこれになり、押すと `to` へ移る（⏎ も同じ）。
   * 「AI に頼む」は従来の位置（主ボタンでないときの2つ目）に下がる
   */
  primary?: ExtMessageKey;
}

/** コマンドパレットのコマンド */
export interface ExtPaletteCommand {
  id: string;
  label: ExtMessageKey;
  run: () => void;
}

/** 画面の経路（`/ext/<id>` の下） */
export interface ExtRoute {
  /** `/ext/<id>` か `/ext/<id>/...` */
  path: string;
  component: ComponentType;
  /** shell: サイドバーのある枠の中（既定）/ bare: 枠なし（オンボーディングと同じ） */
  chrome?: "shell" | "bare";
  /** 上部バーの左の題名（枠の中の画面だけ。Inbox・自分の番の画面と同じ字。無ければ出さない） */
  title?: ExtMessageKey;
  /** 題名の右に出す小さな部品（件数・札など。title があるときだけ） */
  titleAside?: ComponentType;
}

/** 拡張が本体の開き方で AI を開く種類（`openAi`。m2-api 13章の OpenAction） */
export type ExtOpenAction = OpenAction;

export interface LaunchFieldProps {
  /** 既存のタスクから頼むときのタスク（作成のポップオーバーでは null） */
  taskId: string | null;
  value: unknown;
  onChange: (v: unknown) => void;
}

/** AI に頼むの入力の行（作成のポップオーバーと既存のタスクのポップオーバー）。行のラベルの右に部品を出す */
export interface ExtLaunchField {
  id: string;
  label: ExtMessageKey;
  component: ComponentType<LaunchFieldProps>;
  /**
   * rows: 本体はラベルの行を作らず、部品が自分で行を並べる（`@turnlane/ext-host` の LaunchRow で、本体の行と同じラベルの幅に
   * そろえる）。選んだ値で行が増える・減る欄、出さないとき（null を返す）に使う。既定は row（label の1行）
   */
  layout?: "row" | "rows";
  /**
   * 依頼の直前に呼ぶ。true を返したら本体は今すぐの起動をしない（拡張が引き受けた）。値は行の部品が onChange で渡したもの
   */
  intercept?: (o: {
    taskId: string;
    value: unknown;
    input: {
      repo: string;
      tool: "claude_code" | "codex";
      templateId: string;
      worktree: boolean;
      instruction?: string;
      claudeAccount?: string;
    };
  }) => boolean | Promise<boolean>;
}

/** 時間軸の印の範囲（その列の時間軸。epoch ms） */
export interface TimelineRange {
  from: number;
  to: number;
}

/**
 * 時間軸の AI レーンに描く予定の印（3日ボードとデイビュー）。本体が本体の部品で描く: 6px の中を塗らない実線の枠と
 * 時計のアイコン、右に題名と時刻（mono）、2行目に detail。押すと taskId のタスクの詳細パネルを開く
 */
export interface TimelineMark {
  /** 拡張の中で一意 */
  id: string;
  /** 始まり（epoch ms） */
  at: number;
  /** 終わり（無ければ線の最小の長さ） */
  end?: number;
  /** 1行目（表示する文。辞書は拡張の中で引く） */
  title: string;
  /** 2行目（任意） */
  detail?: string;
  /** 押したときに開くタスク */
  taskId?: string;
}

export interface WebExtension {
  /** デーモンの拡張と同じ id */
  id: string;
  apiVersion: number;
  i18n?: { en: ExtDict; ja?: ExtDict };
  routes?: ExtRoute[];
  settingsSections?: ExtSettingsSection[];
  sidebarItems?: ExtSidebarItem[];
  trayItems?: ExtTrayItem[];
  todayNotices?: ExtTodayNotice[];
  taskMenuItems?: ExtTaskMenuItem[];
  panelSections?: ExtPanelSection[];
  paletteCommands?: ExtPaletteCommand[];
  launchFields?: ExtLaunchField[];
  taskOrigins?: ExtTaskOrigin[];
  /**
   * 時間軸の印（React のフック。描く列ごとに、その列の範囲で呼ぶ）。拡張のデータは useExtQuery などで読む。
   * 呼ぶ順と回数は列ごとに一定（拡張の一覧はビルドのときに決まる）
   */
  timelineMarks?: (range: TimelineRange) => TimelineMark[];
}
