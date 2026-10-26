/**
 * 自分の番の件名と「なぜ待っているか」（D-207、spec-glance §2〜§5）。行（帯・自分の番の画面・メニューバー・デイビューの右）、
 * ホバー、詳細パネルの「待っている理由」が同じ部品を使う。
 *
 * 中身（コマンド・AI の問い・直近の指示）は表示の瞬間にデーモンから読んだもの（glance）。core の reasonParts が伏せ字を
 * もう一度通してから渡す。ここで保存・ログに出さない。設定「行に中身を出す」がオフなら読まない（件名は自動の題名）。
 */
import {
  type GlanceResponse,
  type QueueItem,
  type ReasonParts,
  reasonParts,
  turnSubject,
  withSubject,
} from "@turnlane/core/web";
import { useI18n } from "../i18n/index.tsx";

export interface TurnView {
  subject: string;
  /** 件名と違う自動の題名（ai-title など） */
  session: string | null;
  /** 件名が PR の題名（理由の行は番号と量だけ。fix-subject-pr） */
  fromPr: boolean;
  parts: ReasonParts;
  /** 中身を読んだ（読まない設定・読み込み中は false） */
  glanced: boolean;
}

export function turnView(
  item: QueueItem,
  glance: GlanceResponse | undefined,
  locale: "en" | "ja",
): TurnView {
  const s = turnSubject(item, glance, locale);
  return {
    subject: s.subject,
    session: s.session,
    fromPr: s.fromPr === true,
    parts: withSubject(reasonParts(item, glance), s),
    glanced: glance !== undefined && glance.unavailable !== "off",
  };
}

/** Edit / Write などのパスの真ん中を切ってファイル名を残す（spec-glance §5.1） */
export function middlePath(p: string, max = 48): string {
  if (p.length <= max) return p;
  const i = p.lastIndexOf("/");
  const file = i >= 0 ? p.slice(i + 1) : p;
  if (file.length + 4 >= max) return `…/${file.slice(-(max - 2))}`;
  const head = p.slice(0, Math.max(0, max - file.length - 2));
  return `${head}…/${file}`;
}

const fileName = (p: string) => p.slice(p.lastIndexOf("/") + 1);

/**
 * 理由の中身（待ちの種類の言葉を除く）の部品。mode: full = 行・メニューバー、narrow = 300px 未満の帯（ツール名を省く。
 * Edit / Write はツール名とファイル名、MCP はツール名だけ）
 */
export function WhyContent({
  parts,
  mode = "full",
}: {
  parts: ReasonParts;
  mode?: "full" | "narrow";
}) {
  const { t, locale } = useI18n();
  const q = (s: string) => (locale === "ja" ? `「${s}」` : `“${s}”`);
  const sep = <span className="text-fg3"> · </span>;
  if (parts.tool !== undefined) {
    const isPath = parts.detailKind === "path";
    if (mode === "narrow") {
      if (parts.sub !== undefined) return <span>{parts.sub}</span>;
      if (isPath && parts.detail)
        return (
          <span>
            {parts.tool} <span className="font-mono">{fileName(parts.detail)}</span>
          </span>
        );
      if (parts.detail)
        return (
          <span className={parts.detailKind === "query" ? "" : "font-mono"}>{parts.detail}</span>
        );
      return <span>{parts.label ?? parts.tool}</span>;
    }
    return (
      <>
        <span className="font-medium">{parts.tool}</span>
        {parts.sub !== undefined ? <span className="ml-1.5">{parts.sub}</span> : null}
        {parts.label ? <span className="ml-1.5">{parts.label}</span> : null}
        {parts.detail ? (
          <>
            {parts.label ? sep : <span className="ml-1.5" />}
            {parts.detailKind === "query" ? (
              <span>{q(parts.detail)}</span>
            ) : (
              <span className="font-mono" data-kind="turn-detail">
                {isPath ? middlePath(parts.detail) : parts.detail}
              </span>
            )}
          </>
        ) : null}
        {parts.moreLines ? (
          <span className="text-fg3"> {t("turn.why.moreLines", { count: parts.moreLines })}</span>
        ) : null}
        {parts.isNew ? <span className="text-fg3"> {t("turn.why.new")}</span> : null}
      </>
    );
  }
  if (parts.quote) {
    const opts = parts.options ?? [];
    return (
      <>
        <span data-kind="turn-quote">{q(parts.quote)}</span>
        {mode === "full" && opts.length > 0 ? (
          <span>
            {" "}
            {opts.map((o, i) => (
              // biome-ignore lint/suspicious/noArrayIndexKey: 選択肢の順は変わらない
              <span key={i}>
                {i > 0 ? <span className="text-fg3"> / </span> : null}
                {o}
              </span>
            ))}
            {parts.moreOptions ? (
              <span className="text-fg3"> {t("turn.why.more", { count: parts.moreOptions })}</span>
            ) : null}
          </span>
        ) : null}
        {mode === "full" && parts.moreQuestions ? (
          <span className="text-fg3">
            {" "}
            {t("turn.why.moreQuestions", { count: parts.moreQuestions })}
          </span>
        ) : null}
      </>
    );
  }
  if (parts.pr !== undefined && parts.pr !== null)
    return (
      <>
        <span className="font-mono">PR #{parts.pr}</span>
        {parts.prTitle ? <span className="ml-1.5">{parts.prTitle}</span> : null}
      </>
    );
  if (parts.error) return <span>{t(`ai.err.${parts.error}`)}</span>;
  if (parts.limitBack) return <span>{t("turn.why.limitBack")}</span>;
  return null;
}

/** 待ちの種類の言葉 */
export function useWhyWord(parts: ReasonParts): string {
  const { t } = useI18n();
  return parts.why ? t(`turn.why.${parts.why}`) : "";
}

/** 中身を言葉にした 1 行（ホバー・読み上げ用） */
export function whyText(
  parts: ReasonParts,
  t: ReturnType<typeof useI18n>["t"],
  locale: "en" | "ja",
): string {
  const q = (s: string) => (locale === "ja" ? `「${s}」` : `“${s}”`);
  if (parts.tool !== undefined) {
    return [parts.sub ? `${parts.tool}  ${parts.sub}` : parts.tool, parts.label, parts.detail]
      .filter(Boolean)
      .join("  ");
  }
  if (parts.quote) {
    const opts = (parts.options ?? []).join(" / ");
    return [q(parts.quoteDetail || parts.quote), opts].filter(Boolean).join(" ");
  }
  if (parts.pr !== undefined && parts.pr !== null)
    return [`PR #${parts.pr}`, parts.prTitle].filter(Boolean).join(" ");
  if (parts.error) return t(`ai.err.${parts.error}`);
  if (parts.limitBack) return t("turn.why.limitBack");
  return "";
}

/**
 * ホバーの文（spec-glance §3.6。最大 5 行）: 件名 / 待ちの種類 · ツール / 中身（3 行・300 文字まで） / どこで · 待ち /
 * セッション（件名と違うときだけ）。読めなかった理由はホバーにだけ出す（§5.3）
 */
export function turnHover(
  v: TurnView,
  where: string,
  wait: string,
  t: ReturnType<typeof useI18n>["t"],
  locale: "en" | "ja",
): string {
  const p = v.parts;
  const head = [
    p.why ? t(`turn.why.${p.why}`) : "",
    p.tool ? (p.sub ? `${p.tool} ${p.sub}` : p.tool) : "",
  ]
    .filter(Boolean)
    .join(" · ");
  const body =
    p.tool !== undefined
      ? [p.label, (p.full ?? p.detail ?? "").split("\n").slice(0, 3).join("\n")]
          .filter(Boolean)
          .join("\n")
      : whyText(p, t, locale);
  const unread =
    !p.hasContent && p.unavailable && p.unavailable !== "off"
      ? t(`turn.why.unreadable.${p.unavailable}`)
      : "";
  return [
    v.subject.slice(0, 120),
    head,
    body.slice(0, 300),
    [where, wait].filter(Boolean).join(" · "),
    v.session ? t("turn.session", { title: v.session }) : "",
    unread,
  ]
    .filter(Boolean)
    .join("\n");
}

/**
 * 詳細パネルの「待っている理由」（spec-glance §3.7）。ここだけは中身を全部見せる（コマンドは 20 行まで）。
 * 押せるものは置かない（答えるのはターミナル）
 */
export function WhyBlock({ view, prompt }: { view: TurnView; prompt?: string | undefined }) {
  const { t, locale } = useI18n();
  const p = view.parts;
  const unread =
    !p.hasContent && p.unavailable && p.unavailable !== "off"
      ? t(`turn.why.unreadable.${p.unavailable}`)
      : null;
  if (!p.hasContent && !unread && !view.session) return null;
  const q = (s: string) => (locale === "ja" ? `「${s}」` : `“${s}”`);
  return (
    <section
      className="flex flex-col gap-2"
      data-testid="turn-why"
      aria-label={t("turn.why.title")}
    >
      {p.tool !== undefined ? (
        <>
          {p.label ? <p className="text-body text-fg">{p.label}</p> : null}
          <div className="relative rounded-[8px] bg-sunken px-3 py-2">
            <div className="mb-1 font-medium text-fg2 text-meta">
              {[p.sub ? `${p.tool} · ${p.sub}` : p.tool, p.detailKind === "path" ? p.detail : null]
                .filter(Boolean)
                .join(" · ")}
              {p.isNew ? ` ${t("turn.why.new")}` : ""}
            </div>
            {p.detailKind !== "path" && (p.full ?? p.detail) ? (
              <pre
                className="max-h-[20lh] overflow-auto whitespace-pre-wrap break-all font-mono text-[12px] text-fg leading-[18px]"
                data-kind="turn-why-full"
              >
                {p.detailKind === "query" ? q(p.detail ?? "") : (p.full ?? p.detail)}
              </pre>
            ) : null}
            {p.masked ? (
              <div className="mt-1 text-right text-[11px] text-fg3">{t("turn.why.redacted")}</div>
            ) : null}
          </div>
        </>
      ) : null}
      {p.questions && p.questions.length > 0 ? (
        <div className="flex flex-col gap-2">
          {p.questions.map((x, i) => (
            // biome-ignore lint/suspicious/noArrayIndexKey: 問いの順は変わらない
            <div key={i} className="flex flex-col gap-1">
              <span className="text-[11px] text-fg3">
                {p.questions && p.questions.length > 1
                  ? t("turn.why.questionN", { i: i + 1, n: p.questions.length })
                  : t("turn.why.question")}
              </span>
              <p className="text-body text-fg">{x.question}</p>
              {x.options.length > 0 ? (
                <ul className="flex flex-col gap-0.5 pl-3 text-fg2 text-meta">
                  {x.options.map((o, j) => (
                    // biome-ignore lint/suspicious/noArrayIndexKey: 選択肢の順は変わらない
                    <li key={j}>· {o}</li>
                  ))}
                </ul>
              ) : null}
            </div>
          ))}
        </div>
      ) : p.quote ? (
        <div className="flex flex-col gap-1">
          <span className="text-[11px] text-fg3">{t("turn.why.question")}</span>
          <p className="text-body text-fg" data-kind="turn-why-question">
            {p.quoteDetail || p.quote}
          </p>
          {p.masked ? <span className="text-[11px] text-fg3">{t("turn.why.redacted")}</span> : null}
        </div>
      ) : null}
      {p.error ? <p className="text-body text-fg">{t(`ai.err.${p.error}`)}</p> : null}
      {p.limitBack ? <p className="text-body text-fg">{t("turn.why.limitBack")}</p> : null}
      {prompt && prompt !== view.subject ? (
        <p className="truncate text-fg3 text-meta">
          {t("turn.lastPrompt")} {prompt}
        </p>
      ) : null}
      {view.session ? (
        <p className="truncate text-fg3 text-meta">{t("turn.session", { title: view.session })}</p>
      ) : null}
      {unread ? <p className="text-fg3 text-meta">{unread}</p> : null}
    </section>
  );
}
