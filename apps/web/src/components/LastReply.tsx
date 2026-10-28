/**
 * 「最後の返答」の節（Issue #8、ADR 0019 の Decision 10）: AI の詳細パネルで、選んだ AI 項目の最後のセッションの、AI の
 * 最後の発言を出す（完了・idle は最後の発言、動作中はその時点の最新の発言、自分の番は問いの文）。パネルを開いた瞬間に
 * 手元の記録から読み（GET /last-reply）、閉じたら捨てる。保存しない。
 *
 * - 文は Markdown として出す（HTML は解釈しない）。長い文は「答える」の問いと同じく枠の中でスクロールする
 * - 2,000 字で切ったときは「続きは端末で」と「開く」（行・パネルの「開く」と同じ経路）
 * - 記録が消えていれば「記録が消えていて読めません」。設定「行に中身を出す」がオフなら節ごと出さない
 * - 「答える」の節が問いの全文を出している間は、同じ文を 2 回出さないよう呼ぶ側が出さない
 * - 下に「次の指示」の入力欄（Issue #9。NextInstruction）
 */
import { useLastReply } from "../data/last-reply.ts";
import { openTask } from "../data/mutations.ts";
import { useI18n } from "../i18n/index.tsx";
import { Markdown } from "./Markdown.tsx";
import { NextInstruction } from "./NextInstruction.tsx";
import { Button } from "./ui.tsx";

/** 文の枠の高さの上限（読むだけの節なので「答える」の問いの枠より少し高い） */
const REPLY_MAX = 240;

export function LastReplySection({ workItemId, version }: { workItemId: string; version: string }) {
  const { t } = useI18n();
  const q = useLastReply(workItemId, version);
  const r = q.data;
  // 設定「行に中身を出す」がオフなら返答は出さない（次の指示の欄は文を読まないので出す）
  const off = r?.state === "off";
  if (off && (!r?.instruct || (!r.instruct.ok && r.instruct.reason === "off"))) return null;
  const note = (key: Parameters<typeof t>[0]) => <p className="text-fg3 text-meta">{t(key)}</p>;
  return (
    <section
      className="flex flex-col gap-2 border-line border-t pt-4"
      data-testid="ai-last-reply"
      aria-label={t(off ? "instruct.title" : "ai.lastReply")}
    >
      {off ? null : <h3 className="font-semibold text-fg2 text-meta">{t("ai.lastReply")}</h3>}
      {off ? null : !r ? (
        note(q.isError ? "ai.lastReply.failed" : "ai.lastReply.loading")
      ) : r.state === "ok" && r.text ? (
        <>
          <div
            style={{ maxHeight: REPLY_MAX }}
            className="overflow-auto break-words rounded-[8px] bg-sunken px-3 py-2"
            data-testid="ai-last-reply-text"
            // biome-ignore lint/a11y/noNoninteractiveTabindex: 長い返答をキーでスクロールする
            tabIndex={0}
          >
            <Markdown text={r.text} />
          </div>
          {r.truncated ? (
            <div className="flex items-center gap-2">
              <span className="min-w-0 flex-1 text-[11px] text-fg3">{t("ai.lastReply.more")}</span>
              <Button
                className="shrink-0 px-2"
                onClick={() => void openTask({ workItemId })}
                data-testid="ai-last-reply-open"
              >
                {t("answer.open")}
              </Button>
            </div>
          ) : null}
          {r.masked ? <span className="text-[11px] text-fg3">{t("turn.why.redacted")}</span> : null}
        </>
      ) : r.state === "gone" ? (
        note("ai.lastReply.gone")
      ) : r.state === "unreadable" ? (
        note("ai.lastReply.unreadable")
      ) : (
        note("ai.lastReply.none")
      )}
      {/* 次の指示（Issue #9）: 送れるかはデーモンの判定（プロセス・ターンの終わり・待ち・端末） */}
      {r?.instruct ? (
        <NextInstruction workItemId={workItemId} version={version} check={r.instruct} />
      ) : null}
    </section>
  );
}
