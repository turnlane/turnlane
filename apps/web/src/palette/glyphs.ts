/**
 * ⌘K の行の絵柄（model.ts の GlyphName → lucide のアイコン）。Record なので名前の足し忘れは型で落ちる。
 * 知らない名前（古い版がブラウザに保存した行など）は既定の絵柄にして、undefined を要素として描かない
 */
import {
  Bot,
  Calendar,
  CalendarCheck2,
  CalendarClock,
  CalendarDays,
  CalendarRange,
  ChevronLeft,
  ChevronRight,
  CircleArrowRight,
  Clock,
  CornerDownLeft,
  Inbox,
  Keyboard,
  Languages,
  type LucideIcon,
  Moon,
  NotebookPen,
  PanelLeft,
  Plus,
  RefreshCw,
  Settings,
  SunMoon,
  Undo2,
  Webhook,
} from "lucide-react";
import type { GlyphName } from "./model.ts";

export const GLYPH: Record<GlyphName, LucideIcon> = {
  today: CalendarCheck2,
  week: CalendarRange,
  day: CalendarDays,
  turn: CircleArrowRight,
  inbox: Inbox,
  ai: Bot,
  note: NotebookPen,
  settings: Settings,
  date: Calendar,
  event: CalendarClock,
  plus: Plus,
  theme: SunMoon,
  lang: Languages,
  hooks: Webhook,
  calendar: Calendar,
  rescan: RefreshCw,
  keys: Keyboard,
  sidebar: PanelLeft,
  undo: Undo2,
  prev: ChevronLeft,
  next: ChevronRight,
  action: CornerDownLeft,
  clock: Clock,
  focus: Moon,
};

export function glyphOf(name: string): LucideIcon {
  return Object.hasOwn(GLYPH, name) ? GLYPH[name as GlyphName] : CornerDownLeft;
}
