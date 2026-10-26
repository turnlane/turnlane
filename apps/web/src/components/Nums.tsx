/**
 * 等幅は時刻と長さだけ（D-101「mono は時刻・期間・キーだけ」、D-114）。題名・日本語・件数・プロジェクト名は sans のまま、
 * 文の中の時刻（`13:05`、`13:05–15:34`）と長さ（`2h29m`、`45m`）だけを等幅にする。
 */

/** 時刻・時刻の範囲・長さ（`~` 付きの推定も含む） */
const NUM_RE = /(~?\d{1,2}:\d{2}(?:\s?[–-]\s?\d{1,2}:\d{2})?|~?\d+h\d+m|~?\d+[hms](?![a-zA-Z]))/;

/** 文を [sans, mono, sans, mono, ...] に分ける（奇数番目が時刻・長さ） */
export function splitNums(text: string): string[] {
  return text.split(new RegExp(NUM_RE.source, "g"));
}

/** 文の中の時刻と長さだけを等幅にする */
export function Nums({ text, className }: { text: string; className?: string | undefined }) {
  const parts = splitNums(text);
  return (
    <span className={className}>
      {parts.map((p, i) =>
        i % 2 === 1 ? (
          // biome-ignore lint/suspicious/noArrayIndexKey: 文の切れ目の順は変わらない
          <span key={i} className="font-mono">
            {p}
          </span>
        ) : (
          p
        ),
      )}
    </span>
  );
}
