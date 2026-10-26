/**
 * O7 通知（onboarding.md 4.7、M6-25）。画像は無く、O4 と同じ組み立て。
 * - デスクトップアプリがつながっていれば、アプリに許可を求める（POST /api/desktop/notifications。D-080）。結果はアプリが
 *   知らせる状態（desktop_status）で読む。拒否なら System Settings の案内
 * - ブラウザで開いているときはブラウザの許可。通知が無い環境なら案内だけ
 * - 「今はしない」で飛ばせる（メニューバーの件数は出る。設定 › 通知 でオンにできる）
 */

import { useQueryClient } from "@tanstack/react-query";
import type { OnboardingView } from "@turnlane/core/web";
import { useEffect, useState } from "react";
import { useDesktopStatus } from "../data/queries.ts";
import { useI18n } from "../i18n/index.tsx";
import { desktopNotifications } from "./data.ts";
import { ButtonPair, OnboardingLayout, Points, ResultBox, Spinner, withEnter } from "./parts.tsx";
import type { Act } from "./steps.ts";

type Perm = "idle" | "granted" | "denied" | "unsupported";

function browserPerm(): Perm {
  if (typeof Notification === "undefined") return "unsupported";
  const p = Notification.permission;
  return p === "granted" ? "granted" : p === "denied" ? "denied" : "idle";
}

/** アプリに許可を求めた後、状態が返るまで待つ上限 */
const WAIT_MS = 30_000;

export function NotifyStep({
  view,
  onBack,
  onDone,
  onSkip,
}: {
  view: OnboardingView;
  onBack: () => void;
  onDone: Act;
  onSkip: Act;
}) {
  const { t } = useI18n();
  const qc = useQueryClient();
  const desktop = useDesktopStatus();
  const app = desktop.data?.connected ? desktop.data.app : null;
  const [waiting, setWaiting] = useState(false);
  const [bPerm, setBPerm] = useState<Perm>(browserPerm);
  const [busy, setBusy] = useState(false);

  // アプリの許可の状態（unknown は未設定として扱う）
  const perm: Perm = app
    ? app.notifications === "granted"
      ? "granted"
      : app.notifications === "denied"
        ? "denied"
        : app.notifications === "unsupported"
          ? "unsupported"
          : "idle"
    : bPerm;

  // 待っている間はアプリの状態を 1 秒ごとに取り直す（SSE desktop_status でも取り直す）
  useEffect(() => {
    if (!waiting) return;
    const t0 = Date.now();
    const id = setInterval(() => {
      void qc.invalidateQueries({ queryKey: ["desktop"] });
      if (Date.now() - t0 > WAIT_MS) setWaiting(false);
    }, 1000);
    return () => clearInterval(id);
  }, [waiting, qc]);
  useEffect(() => {
    if (perm !== "idle") setWaiting(false);
  }, [perm]);

  const request = async () => {
    if (busy || waiting) return;
    if (app) {
      setWaiting(true);
      if (!(await desktopNotifications("request"))) setWaiting(false);
      return;
    }
    if (typeof Notification === "undefined") return;
    setWaiting(true);
    try {
      const r = await Notification.requestPermission();
      setBPerm(r === "granted" ? "granted" : r === "denied" ? "denied" : "idle");
    } finally {
      setWaiting(false);
    }
  };
  const run = async (f: Act) => {
    if (busy) return;
    setBusy(true);
    try {
      await f();
    } finally {
      setBusy(false);
    }
  };
  const primaryAction = () => {
    if (perm === "idle") void request();
    else if (perm === "granted") void run(onDone);
    else void run(onSkip);
  };
  const secondaryAction = () => {
    if (perm === "denied" && app) void desktopNotifications("open_settings");
    else void run(onSkip);
  };
  const primaryIndex = waiting ? 1 : perm === "idle" ? 0 : 2;
  const primaryLabels = [t("onb.notify.turnOn"), t("onb.waitingMacos"), t("onb.continue")];
  const canNotNow = perm === "idle" && !waiting;

  return (
    <OnboardingLayout
      view={view}
      back={onBack}
      note={perm === "idle" ? t("onb.notify.notNowNote") : null}
      foot={[
        { key: "⏎", label: primaryLabels[primaryIndex] as string },
        ...(canNotNow ? [{ key: "Esc", label: t("onb.notNow") }] : []),
        { key: "⌘[", label: t("onb.back") },
      ]}
      keys={{
        enter: primaryAction,
        escape: () => {
          if (canNotNow) void run(onSkip);
        },
      }}
      buttons={
        <ButtonPair
          secondary={
            perm === "idle" || (perm === "denied" && app)
              ? {
                  labels: [t("onb.notNow"), t("onb.openSystemSettings")],
                  active: perm === "denied" ? 1 : 0,
                  onClick: secondaryAction,
                  disabled: busy || waiting,
                  testId: "onb-not-now",
                }
              : undefined
          }
          primary={{
            labels: [
              withEnter(primaryLabels[0] as string),
              <>
                <Spinner />
                {primaryLabels[1]}
              </>,
              withEnter(primaryLabels[2] as string),
            ],
            active: primaryIndex,
            onClick: primaryAction,
            disabled: busy || waiting,
            testId: "onb-notify-primary",
          }}
        />
      }
    >
      <h1 className="font-semibold text-fg text-title">{t("onb.notify.title")}</h1>
      <Points items={[t("onb.notify.point1"), t("onb.notify.point2"), t("onb.notify.point3")]} />
      {!app && perm !== "unsupported" ? (
        <p className="mt-4 text-body text-fg3" data-part="browser-note">
          {perm === "denied" ? t("onb.notify.browserDenied") : t("onb.notify.browser")}
        </p>
      ) : null}
      {perm === "granted" ? (
        <ResultBox mark="done" title={t("onb.notify.on")} testId="onb-notify-on" />
      ) : null}
      {perm === "denied" && app ? (
        <ResultBox
          mark="problem"
          title={t("onb.notify.denied.title")}
          lines={[t("onb.notify.denied.line")]}
          testId="onb-notify-denied"
        />
      ) : null}
      {perm === "unsupported" ? (
        <ResultBox
          mark="notSet"
          title={t("onb.notify.unsupported")}
          testId="onb-notify-unsupported"
        />
      ) : null}
    </OnboardingLayout>
  );
}
