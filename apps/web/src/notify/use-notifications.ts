/**
 * ブラウザ通知とタブタイトルの件数（M2-8）。キュー（["queue"]）の変化から判定する（判定と文言は core の notify/plan.ts。
 * デーモンの NotifyRunner と同じ関数）。題名は件名、本文は待ちの種類 · リポジトリとブランチ（ブラウザ通知に副題は無い）。
 * コマンド・AI の問い・表示の瞬間に読む中身は入れない（D-207 (4)）。
 * デスクトップアプリがつながっている間（desktopNotifier）とアプリの中では出さない（二重通知の防止。desktop-shell.md 3.4）。
 * 集中モード中（QueueResponse.focus。D-097）は出さず（設定で needs_input だけ許せる）、終わったときのまとめはデーモンの
 * SSE notify（focus-summary）を受けて出す。
 */

import { useQuery } from "@tanstack/react-query";
import {
  filterFocus,
  initialNotifyState,
  type NoticeMessage,
  noticeMessage,
  planNotifications,
  type QueueResponse,
  visibleQueue,
} from "@turnlane/core/web";
import { useEffect, useRef } from "react";
import { openTask } from "../data/mutations.ts";
import { onSse } from "../data/sse.ts";
import { useI18n } from "../i18n/index.tsx";
import { api, unwrap } from "../lib/api.ts";
import { inDesktop } from "../lib/desktop.ts";

export function useNotifications(queue: QueueResponse | undefined): void {
  const { locale } = useI18n();
  const state = useRef(initialNotifyState());
  // 通知に出す中身（notify.content。D-207 (4)）
  const config = useQuery({
    queryKey: ["settings", "config"],
    queryFn: () =>
      unwrap<{ values: Record<string, unknown> }>(api.api.config.$get()).then((r) => r.values),
    staleTime: 60_000,
  });
  const content = config.data?.["notify.content"] === "minimal" ? "minimal" : "subject";
  const items = visibleQueue(queue?.items);
  const n = items.length;
  useEffect(() => {
    document.title = n > 0 ? `(${n}) Turnlane` : "Turnlane";
  }, [n]);
  useEffect(() => {
    let recheck: ReturnType<typeof setTimeout> | null = null;
    const run = () => {
      const now = Date.now();
      const r = planNotifications(state.current, visibleQueue(queue?.items), now);
      state.current = r.state;
      // 許可待ちの猶予（10 秒）の後にもう一度判定する
      if (r.recheckAt !== undefined && recheck === null)
        recheck = setTimeout(
          () => {
            recheck = null;
            run();
          },
          Math.max(0, r.recheckAt - now) + 50,
        );
      if (inDesktop() || queue?.desktopNotifier) return;
      if (typeof Notification === "undefined" || Notification.permission !== "granted") return;
      // 集中中は止める（止めた分のまとめはデーモンが数えて notify で送る。D-097）
      const focus = queue?.focus;
      const notices = filterFocus(r.notices, {
        active: focus != null && now < focus.until,
        allowNeedsInput: focus?.allowNeedsInput ?? false,
      }).pass;
      for (const x of notices) {
        const m = noticeMessage(x, locale, content);
        const body = [m.subtitle, m.body].filter(Boolean).join("\n");
        const n = new Notification(m.title, { body, tag: `turnlane:${m.id}` });
        // クリックでタスクの既定の開き先を開く（D-059。path の open=<followUpId>）。無ければタブを前面に出す
        const fid = new URL(m.path, location.origin).searchParams.get("open");
        n.onclick = () => {
          if (fid) void openTask({ followUpId: fid });
          else window.focus();
          n.close();
        };
      }
    };
    run();
    // まとめ通知のため、キューが変わらなくても1分ごとに判定する
    const i = setInterval(run, 60_000);
    return () => {
      clearInterval(i);
      if (recheck !== null) clearTimeout(recheck);
    };
  }, [queue, locale, content]);
  // 集中の終わりのまとめ（デーモンが数えた focus-summary）。アプリがつながっている間とアプリの中では出さない
  const desktop = queue?.desktopNotifier === true;
  useEffect(
    () =>
      onSse((type, data) => {
        if (type !== "notify" || inDesktop() || desktop) return;
        if (typeof Notification === "undefined" || Notification.permission !== "granted") return;
        const ns = ((data as { notices?: NoticeMessage[] }).notices ?? []).filter(
          (n) => n.kind === "focus_summary",
        );
        for (const m of ns) {
          const n = new Notification(m.title, { body: m.body, tag: `turnlane:${m.id}` });
          n.onclick = () => {
            window.focus();
            n.close();
          };
        }
      }),
    [desktop],
  );
}
