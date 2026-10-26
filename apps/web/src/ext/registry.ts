/**
 * 組み込んだ拡張の一覧（Web 側。ADR 0015）。画面の各所（設定・サイドバー・メニューバーのポップオーバー・今日の列の知らせ・
 * メニュー・パネル・パレット・辞書・経路・AI に頼むの入力）はここから拡張の分を読む。公開のビルドでは全部が空で、画面は拡張なしのときと同じ
 */
import { EXT_API_VERSION } from "@turnlane/core/web";
import { extensions as built } from "@turnlane/ext-web";
import { setExtKeys } from "../keys/keymap.ts";
import type {
  ExtDict,
  ExtLaunchField,
  ExtPaletteCommand,
  ExtPanelSection,
  ExtRoute,
  ExtSettingsSection,
  ExtSidebarItem,
  ExtTaskMenuItem,
  ExtTaskOrigin,
  ExtTodayNotice,
  ExtTrayItem,
  TimelineMark,
  TimelineRange,
  WebExtension,
} from "./types.ts";

const ID_RE = /^[a-z][a-z0-9]{1,23}$/;
const PART_RE = /^[a-z][a-z0-9-]{0,39}$/;

/** 形の検査。合わなければ理由 */
export function checkWebExtension(e: WebExtension): string | null {
  if (!ID_RE.test(e.id)) return `invalid extension id: ${e.id}`;
  if (e.apiVersion !== EXT_API_VERSION)
    return `extension ${e.id} targets api ${e.apiVersion}, this build provides ${EXT_API_VERSION}`;
  const prefix = `ext.${e.id}.`;
  for (const d of [e.i18n?.en ?? {}, e.i18n?.ja ?? {}])
    for (const k of Object.keys(d)) if (!k.startsWith(prefix)) return `message key ${k}`;
  for (const r of e.routes ?? [])
    if (r.path !== `/ext/${e.id}` && !r.path.startsWith(`/ext/${e.id}/`)) return `route ${r.path}`;
  const parts = [
    ...(e.settingsSections ?? []),
    ...(e.sidebarItems ?? []),
    ...(e.trayItems ?? []),
    ...(e.todayNotices ?? []),
    ...(e.taskMenuItems ?? []),
    ...(e.panelSections ?? []),
    ...(e.paletteCommands ?? []),
    ...(e.launchFields ?? []),
  ];
  for (const p of parts) if (!PART_RE.test(p.id)) return `part id ${p.id}`;
  for (const o of e.taskOrigins ?? []) {
    const rest = o.source.startsWith(`ext.${e.id}.`) ? o.source.slice(e.id.length + 5) : null;
    if (o.source !== `ext.${e.id}` && !(rest !== null && PART_RE.test(rest)))
      return `task origin ${o.source}`;
    if (!o.label.startsWith(prefix)) return `task origin label ${o.label}`;
    if (o.primary && !o.primary.startsWith(prefix)) return `task origin primary ${o.primary}`;
  }
  return null;
}

/** 検査を通った拡張だけ（通らないものはコンソールに出して読み飛ばす） */
export function acceptExtensions(list: readonly WebExtension[]): WebExtension[] {
  const out: WebExtension[] = [];
  for (const e of list) {
    const why = checkWebExtension(e) ?? (out.some((x) => x.id === e.id) ? "duplicate id" : null);
    if (why) {
      console.error(`[ext] rejected: ${why}`);
      continue;
    }
    out.push(e);
  }
  return out;
}

export interface ExtRegistry {
  ids: string[];
  messages: { en: ExtDict; ja: ExtDict };
  routes: (ExtRoute & { ext: string })[];
  settingsSections: (ExtSettingsSection & { ext: string; key: `ext-${string}` })[];
  sidebarItems: (ExtSidebarItem & { ext: string; key: string })[];
  trayItems: (ExtTrayItem & { ext: string; key: string })[];
  /** 今日の列の先頭行の知らせ（D-192） */
  todayNotices: (ExtTodayNotice & { ext: string; key: string })[];
  taskMenuItems: (ExtTaskMenuItem & { ext: string; key: string })[];
  panelSections: (ExtPanelSection & { ext: string; key: string })[];
  paletteCommands: (ExtPaletteCommand & { ext: string; key: string })[];
  launchFields: (ExtLaunchField & { ext: string; key: string })[];
  /** 拡張が作ったタスクの出どころ（external.source → 言葉と移る先） */
  taskOrigins: Map<string, ExtTaskOrigin & { ext: string }>;
  /** 時間軸の印のフック（拡張ごと。印の id は `<拡張>:<id>` にする） */
  timelineMarks: { ext: string; use: (range: TimelineRange) => TimelineMark[] }[];
}

export function buildRegistry(list: readonly WebExtension[]): ExtRegistry {
  const xs = acceptExtensions(list);
  const all = <T extends { id: string }>(pick: (e: WebExtension) => T[] | undefined) =>
    xs.flatMap((e) => (pick(e) ?? []).map((p) => ({ ...p, ext: e.id, key: `${e.id}:${p.id}` })));
  return {
    ids: xs.map((e) => e.id),
    messages: {
      en: Object.assign({}, ...xs.map((e) => e.i18n?.en ?? {})),
      ja: Object.assign({}, ...xs.map((e) => e.i18n?.ja ?? {})),
    },
    routes: xs.flatMap((e) => (e.routes ?? []).map((r) => ({ ...r, ext: e.id }))),
    settingsSections: xs.flatMap((e) =>
      (e.settingsSections ?? []).map((s) => ({
        ...s,
        ext: e.id,
        key: `ext-${e.id}-${s.id}` as const,
      })),
    ),
    sidebarItems: all((e) => e.sidebarItems),
    trayItems: all((e) => e.trayItems),
    todayNotices: all((e) => e.todayNotices),
    taskMenuItems: all((e) => e.taskMenuItems),
    panelSections: all((e) => e.panelSections),
    paletteCommands: all((e) => e.paletteCommands),
    launchFields: all((e) => e.launchFields),
    taskOrigins: new Map(
      xs.flatMap((e) => (e.taskOrigins ?? []).map((o) => [o.source, { ...o, ext: e.id }] as const)),
    ),
    timelineMarks: xs.flatMap((e) =>
      e.timelineMarks ? [{ ext: e.id, use: e.timelineMarks }] : [],
    ),
  };
}

/** このビルドに組み込んだ拡張 */
export const ext: ExtRegistry = buildRegistry(built);
// 拡張の画面だけが使うキー（⌘↑↓・⌫）を一覧・設定に出す。拡張が無ければ本体のキーマップのまま
setExtKeys(ext.ids.length > 0);
