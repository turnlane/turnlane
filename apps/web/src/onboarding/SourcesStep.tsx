/**
 * O2 取り込み元と同意（onboarding.md 4.2、確定デザイン onb-O2-*）。
 * - 主ボタン「Import the last 7 days」で、チェックした元だけで同意する（D-181）。全部外したら押せない（D-184）
 * - 0件（O2-empty）は「Continue」で空の一覧のまま同意する（見つかったときから読む）。「Not now」は同意しない
 * - 戻るは出さない（D-184）
 */
import type { DetectedSourceView, OnboardingView } from "@turnlane/core/web";
import { Check as CheckIcon, TriangleAlert } from "lucide-react";
import { type ReactNode, useEffect, useMemo, useRef, useState } from "react";
import type { MessageKey } from "../i18n/en.ts";
import { useI18n } from "../i18n/index.tsx";
import { ApiError } from "../lib/api.ts";
import { nowMs } from "../lib/clock.ts";
import { addSource, chooseFolderNative, useDetect } from "./data.ts";
import { ButtonPair, OnboardingLayout, PrivacyPanel, Spinner, withEnter } from "./parts.tsx";
import { type Act, daysAgo, type ImportAct, tildePath } from "./steps.ts";

const TOOL_NAME: Record<string, MessageKey> = {
  claude_code: "sources.tool.claude_code",
  codex: "sources.tool.codex",
};

export function SourcesStep({
  view,
  onImport,
  onNotNow,
}: {
  view: OnboardingView;
  /** 同意（チェックした元の id。0件なら空） */
  onImport: ImportAct;
  onNotNow: Act;
}) {
  const { t } = useI18n();
  const det = useDetect();
  const sources = useMemo(
    () => (det.data?.sources ?? []).filter((s) => s.tool === "claude_code" || s.tool === "codex"),
    [det.data],
  );
  const home = det.data?.home ?? "";
  // チェック（読めない元は外す）。検出し直しても、触った行は利用者の選択を保つ
  const [touched, setTouched] = useState<Record<string, boolean>>({});
  const checked = (s: DetectedSourceView) => s.readable && (touched[s.id] ?? s.enabled);
  const selected = sources.filter(checked).map((s) => s.id);
  const loading = det.isPending;
  const empty = !loading && sources.length === 0;
  const nothing = !loading && !empty && selected.length === 0;
  const [busy, setBusy] = useState<"import" | "notNow" | null>(null);

  const doImport = async () => {
    if (busy || loading || nothing) return;
    setBusy("import");
    try {
      await onImport(empty ? [] : selected, empty);
    } finally {
      setBusy(null);
    }
  };
  const doNotNow = async () => {
    if (busy) return;
    setBusy("notNow");
    try {
      await onNotNow();
    } finally {
      setBusy(null);
    }
  };

  const hasClaude = sources.some((s) => s.tool === "claude_code");
  const hasCodex = sources.some((s) => s.tool === "codex");
  const primaryLabel = empty ? t("onb.continue") : t("onb.sources.import");
  const note = empty
    ? t("onb.sources.emptyNote")
    : nothing
      ? t("onb.sources.nothingSelected")
      : t("onb.sources.range");

  return (
    <OnboardingLayout
      view={view}
      note={loading ? t("onb.sources.range") : note}
      back={null}
      foot={[
        { key: "⏎", label: primaryLabel },
        { key: "Esc", label: t("onb.notNow") },
      ]}
      buttons={
        <ButtonPair
          secondary={{
            labels: [t("onb.notNow")],
            onClick: () => void doNotNow(),
            disabled: busy === "import",
            testId: "onb-not-now",
          }}
          primary={{
            labels: [
              withEnter(t("onb.sources.import")),
              withEnter(t("onb.continue")),
              <>
                <Spinner />
                {t("onb.starting")}
              </>,
            ],
            active: busy === "import" ? 2 : empty ? 1 : 0,
            onClick: () => void doImport(),
            disabled: loading || nothing || busy !== null,
            testId: "onb-import",
          }}
        />
      }
      keys={{ enter: () => void doImport(), escape: () => void doNotNow() }}
    >
      <h1 className="font-semibold text-fg text-title">
        {empty ? t("onb.sources.emptyTitle") : t("onb.sources.title")}
      </h1>
      <p className="mt-1.5 text-body text-fg2">
        {empty ? t("onb.sources.emptyLine") : t("onb.sources.subtitle")}
      </p>

      <div className="mt-6 flex flex-col" data-part="sources">
        {loading
          ? [0, 1, 2].map((i) => <SkeletonRow key={i} />)
          : sources.map((s) => (
              <SourceRow
                key={s.id}
                s={s}
                home={home}
                now={det.data?.now ?? nowMs()}
                checked={checked(s)}
                onToggle={() => setTouched((x) => ({ ...x, [s.id]: !checked(s) }))}
              />
            ))}
      </div>
      {!loading && !empty ? (
        <div className="mt-2 flex flex-col gap-2 pl-4 text-body text-fg3">
          {hasClaude && det.data?.claudeDesktop.present ? <p>{t("onb.sources.desktop")}</p> : null}
          {hasClaude && !hasCodex ? <p>{t("onb.sources.noCodex")}</p> : null}
          {hasCodex && !hasClaude ? <p>{t("onb.sources.noClaude")}</p> : null}
        </div>
      ) : null}
      {!loading ? (
        <div className={empty ? "mt-1" : "mt-2 pl-4"}>
          <ChooseFolder empty={empty} />
        </div>
      ) : null}

      <div className="mt-8">
        <PrivacyPanel />
      </div>
    </OnboardingLayout>
  );
}

function SkeletonRow() {
  return (
    <div className="flex h-11 items-center gap-3 px-4" data-skeleton="">
      <span className="size-4 rounded-chip bg-sunken" />
      <span className="h-3 w-40 rounded-full bg-sunken" />
      <span className="ml-auto h-3 w-56 rounded-full bg-sunken" />
    </div>
  );
}

/** 四角いチェックボックス（インクの塗り） */
function Box({
  checked,
  disabled,
  onToggle,
  label,
}: {
  checked: boolean;
  disabled: boolean;
  onToggle: () => void;
  label: string;
}) {
  return (
    // biome-ignore lint/a11y/useSemanticElements: 見た目を部品シートに合わせるため button に role を付ける
    <button
      type="button"
      role="checkbox"
      aria-checked={checked}
      aria-label={label}
      disabled={disabled}
      onClick={onToggle}
      className={`inline-flex size-4 shrink-0 items-center justify-center rounded-chip border-[1.5px] outline-none focus-visible:outline focus-visible:outline-[1.5px] focus-visible:outline-accent focus-visible:outline-offset-2 ${
        checked ? "border-accent bg-accent text-onaccent" : "border-fg3 bg-raised"
      } disabled:opacity-40`}
    >
      {checked ? <CheckIcon size={11} strokeWidth={2.5} aria-hidden="true" /> : null}
    </button>
  );
}

function lastUsed(at: number | null, now: number, t: ReturnType<typeof useI18n>["t"]): string {
  if (at === null) return t("onb.sources.lastNever");
  const d = daysAgo(at, now);
  if (d === 0) return t("onb.sources.lastToday");
  if (d === 1) return t("onb.sources.lastYesterday");
  return t("onb.sources.lastDays", { count: d });
}

function unreadableText(reason: string | null, t: ReturnType<typeof useI18n>["t"]): string {
  const k = `onb.sources.unreadable.${reason ?? ""}` as MessageKey;
  const v = t(k);
  return v === k ? t("onb.sources.unreadable", { reason: reason ?? "unreadable" }) : v;
}

/**
 * 取り込み元の行（O2 の小さな部品。設定の SourceItem とは別。review §5 の 1）。
 * 件数と「last used …」は切らない。入らなければパスの途中を省き、それでも入らなければ「Added by you」を外す（§5 の 16）
 */
export function SourceRow({
  s,
  home,
  now,
  checked,
  onToggle,
}: {
  s: DetectedSourceView;
  home: string;
  now: number;
  checked: boolean;
  onToggle: () => void;
}) {
  const { t } = useI18n();
  const name = t(TOOL_NAME[s.tool] ?? "sources.tool.claude_code");
  const label =
    s.label === "default" ? (s.tool === "claude_code" ? t("onb.sources.default") : null) : s.label;
  const path = tildePath(s.rootPath, home);
  const off = !checked;
  const right: ReactNode = !s.readable ? (
    <span className="flex items-center gap-1 text-error">
      <TriangleAlert size={12} strokeWidth={1.5} aria-hidden="true" />
      {unreadableText(s.reason, t)}
    </span>
  ) : off ? (
    t("onb.sources.wontRead")
  ) : (
    `${t("onb.sources.count", { count: s.sessions7d })} · ${lastUsed(s.lastActivityAt, now, t)}`
  );
  return (
    <div
      className="group flex h-11 min-w-0 items-center gap-3 rounded-card px-4 hover:bg-sunken/50"
      data-source={s.id}
      data-checked={checked ? "1" : "0"}
    >
      <Box checked={checked} disabled={!s.readable} onToggle={onToggle} label={name} />
      <span className={`shrink-0 font-medium text-body ${off ? "text-fg3" : "text-fg"}`}>
        {name}
      </span>
      {label ? (
        <span
          className={`shrink-0 rounded-chip border border-line px-1.5 text-meta ${off ? "text-fg3" : "text-fg2"}`}
        >
          {label}
        </span>
      ) : null}
      {s.manual ? (
        <span className="min-w-0 shrink truncate rounded-chip border border-line px-1.5 text-fg3 text-meta">
          {t("onb.sources.addedByYou")}
        </span>
      ) : null}
      <MiddlePath text={path} className={off ? "text-fg3" : "text-fg2"} />
      <span
        className={`ml-auto shrink-0 whitespace-nowrap pl-3 text-meta ${off ? "text-fg3" : "text-fg2"}`}
      >
        {right}
      </span>
    </div>
  );
}

/** パスの途中を「…」で省く（先頭と最後のフォルダ名は残す） */
function MiddlePath({ text, className }: { text: string; className: string }) {
  const ref = useRef<HTMLSpanElement>(null);
  const [shown, setShown] = useState(text);
  useEffect(() => {
    const el = ref.current;
    if (!el || typeof ResizeObserver === "undefined") return;
    const fit = () => {
      el.textContent = text;
      if (el.scrollWidth <= el.clientWidth) return setShown(text);
      const parts = text.split("/");
      const last = parts.pop() ?? "";
      for (let keep = parts.length - 1; keep >= 1; keep--) {
        const s = `${parts.slice(0, keep).join("/")}/…/${last}`;
        el.textContent = s;
        if (el.scrollWidth <= el.clientWidth) return setShown(s);
      }
      setShown(`…/${last}`);
    };
    fit();
    const ro = new ResizeObserver(fit);
    ro.observe(el);
    return () => ro.disconnect();
  }, [text]);
  return (
    <span
      ref={ref}
      title={text}
      className={`min-w-0 flex-1 overflow-hidden text-ellipsis whitespace-nowrap text-meta ${className}`}
    >
      {shown}
    </span>
  );
}

/**
 * Choose a folder…（Claude Code の設定フォルダを手で足す。仕様 5.6）。アプリの中ならネイティブのフォルダの選択
 * （IPC desktop_setup の chooseFolder。隠しフォルダも出す）、アプリの外（ブラウザ）・古いアプリならパスを入れる欄
 * （~/ で始めてよい）
 */
function ChooseFolder({ empty }: { empty: boolean }) {
  const { t } = useI18n();
  const [open, setOpen] = useState(false);
  const [path, setPath] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const submit = async (value = path) => {
    if (!value.trim() || busy) return;
    setBusy(true);
    try {
      await addSource(value.trim());
      setOpen(false);
      setPath("");
      setError(null);
    } catch (e) {
      setError(
        e instanceof ApiError && e.code === "not_a_claude_config_dir"
          ? t("onb.sources.badFolder")
          : t("onb.sources.addFailed"),
      );
    } finally {
      setBusy(false);
    }
  };
  const choose = async () => {
    if (busy) return;
    const picked = await chooseFolderNative(t("onb.sources.choosePrompt"));
    if (picked === undefined) setOpen(true);
    else if (picked !== null) await submit(picked);
  };
  return (
    <div className="flex flex-col gap-1.5 text-body">
      <p>
        {empty ? null : <span className="text-fg3">{t("onb.sources.missing")} </span>}
        <button
          type="button"
          onClick={() => void choose()}
          data-testid="onb-choose-folder"
          className={
            empty
              ? "mt-2 inline-flex h-8 items-center rounded-card border border-line bg-raised px-4 font-medium text-fg hover:border-fg3"
              : "font-medium text-fg2 hover:text-fg hover:underline"
          }
        >
          {error ? t("onb.sources.chooseAnother") : t("onb.sources.choose")}
        </button>
      </p>
      {open ? (
        <form
          className="flex max-w-[520px] items-center gap-2"
          onSubmit={(e) => {
            e.preventDefault();
            void submit();
          }}
        >
          <input
            // biome-ignore lint/a11y/noAutofocus: 開いた欄にすぐ入れられるように
            autoFocus
            value={path}
            onChange={(e) => setPath(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Escape") {
                e.stopPropagation();
                e.preventDefault();
                setOpen(false);
              }
            }}
            placeholder={t("onb.sources.pathPlaceholder")}
            className="h-8 min-w-0 flex-1 rounded-control border border-line bg-raised px-2 text-body text-fg outline-none focus:border-fg3"
          />
          <button
            type="submit"
            className="h-8 rounded-card border border-line bg-raised px-3 font-medium text-body text-fg hover:border-fg3"
          >
            {t("onb.sources.add")}
          </button>
        </form>
      ) : null}
      {error ? <p className="text-error text-meta">{error}</p> : null}
    </div>
  );
}
