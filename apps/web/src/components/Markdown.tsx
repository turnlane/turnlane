/**
 * AI の文（「答える」の問いの全文、「最後の返答」）の小さな Markdown の描画器。依存を足さず、React の要素に直接組む。
 *
 * - AI の文は信用しない: HTML として解釈しない（文字列の HTML を流し込まない。タグは文字のまま出る）。リンクは
 *   http(s) だけ（`javascript:` などほかのスキームは素の文字のまま）。画像は読み込まない（`![alt](url)` は alt のリンク）
 * - 対応: 見出し（#〜###。#### 以下は ### と同じ）、段落（1 つの改行はそのまま改行）、箇条書き（- * +）、番号付き（1. 1)）、
 *   入れ子、太字（** __）、斜体（* _）、インラインコード、フェンスのコードブロック（``` ~~~。言語名は無視）、引用（>）、
 *   区切り線、リンク（`[text](url)` と素の URL）、`\` のエスケープ、表（GFM の pipe table。区切り行のコロンで揃え、`\|` はセルの中の
 *   `|`。見出し行と区切り行の列数が合わなければ段落のまま）
 */
import type { ReactNode } from "react";

export type MdBlock =
  | { k: "para"; text: string }
  | { k: "heading"; level: 1 | 2 | 3; text: string }
  | { k: "code"; text: string }
  | { k: "hr" }
  | { k: "quote"; children: MdBlock[] }
  | { k: "list"; ordered: boolean; start: number; items: MdBlock[][] }
  | { k: "table"; align: MdAlign[]; head: string[]; rows: string[][] };

export type MdAlign = "left" | "center" | "right" | "none";

/** 入れ子の上限（引用・リストの中の引用・リスト）。超えたら段落にする */
const MAX_DEPTH = 4;

const FENCE = /^ {0,3}(`{3,}|~{3,})/;
const HEADING = /^ {0,3}(#{1,6})(?:[ \t]+(.*?))?[ \t]*$/;
const HR = /^ {0,3}([-*_])(?:[ \t]*\1){2,}[ \t]*$/;
const QUOTE = /^ {0,3}> ?(.*)$/;
const ITEM = /^( *)([-*+]|\d{1,9}[.)])(?:[ \t]+(.*))?$/;

const blank = (l: string | undefined) => l === undefined || l.trim() === "";
const indentOf = (l: string) => /^ */.exec(l)?.[0].length ?? 0;
const isOrdered = (marker: string) => /\d/.test(marker);

/** 表の 1 行をセルに分ける（両端のパイプは省略可。`\|` はセルの中の `|`） */
function splitRow(l: string): string[] {
  let t = l.trim();
  if (t.startsWith("|")) t = t.slice(1);
  if (t.endsWith("|") && !t.endsWith("\\|")) t = t.slice(0, -1);
  const cells: string[] = [];
  let cur = "";
  for (let i = 0; i < t.length; i++) {
    const c = t[i] as string;
    if (c === "\\" && t[i + 1] === "|") {
      cur += "|";
      i++;
    } else if (c === "|") {
      cells.push(cur.trim());
      cur = "";
    } else cur += c;
  }
  cells.push(cur.trim());
  return cells;
}

const DELIM_CELL = /^:?-+:?$/;

/** 区切り行なら各列の揃え（区切り行でなければ null）。パイプを 1 つ以上含むものだけ */
function delimiterRow(l: string): MdAlign[] | null {
  if (!l.includes("|")) return null;
  const cells = splitRow(l);
  if (cells.length === 0 || !cells.every((c) => DELIM_CELL.test(c))) return null;
  return cells.map((c) =>
    c.startsWith(":") && c.endsWith(":")
      ? "center"
      : c.endsWith(":")
        ? "right"
        : c.startsWith(":")
          ? "left"
          : "none",
  );
}

/** lines[i] が表の見出し行で、次の行が列数の合う区切り行か（GFM。合わなければ表にしない） */
function tableAt(lines: string[], i: number): MdAlign[] | null {
  const head = lines[i];
  const delim = lines[i + 1];
  if (head === undefined || delim === undefined || !head.includes("|")) return null;
  const align = delimiterRow(delim);
  return align && align.length === splitRow(head).length ? align : null;
}

/** ほかのブロックの始まりか（段落を切る） */
function startsBlock(l: string): boolean {
  return FENCE.test(l) || HEADING.test(l) || HR.test(l) || QUOTE.test(l) || ITEM.test(l);
}

/** 文 → ブロックの並び（純粋な関数。テストする） */
export function parseMarkdown(src: string): MdBlock[] {
  const lines = src.replace(/\r\n?/g, "\n").replace(/\t/g, "    ").split("\n");
  return parseBlocks(lines, 0);
}

function parseBlocks(lines: string[], depth: number): MdBlock[] {
  const out: MdBlock[] = [];
  let i = 0;
  while (i < lines.length) {
    const line = lines[i] as string;
    if (blank(line)) {
      i++;
      continue;
    }
    const fence = FENCE.exec(line);
    if (fence) {
      const mark = fence[1] as string;
      const close = new RegExp(`^ {0,3}${mark[0] === "`" ? "`" : "~"}{${mark.length},}[ \\t]*$`);
      const body: string[] = [];
      i++;
      while (i < lines.length && !close.test(lines[i] as string)) body.push(lines[i++] as string);
      i++;
      out.push({ k: "code", text: body.join("\n") });
      continue;
    }
    const h = HEADING.exec(line);
    if (h) {
      const level = Math.min(3, (h[1] as string).length) as 1 | 2 | 3;
      out.push({ k: "heading", level, text: (h[2] ?? "").replace(/[ \t]+#+$/, "") });
      i++;
      continue;
    }
    if (HR.test(line)) {
      out.push({ k: "hr" });
      i++;
      continue;
    }
    if (QUOTE.test(line)) {
      const inner: string[] = [];
      while (i < lines.length && QUOTE.test(lines[i] as string))
        inner.push(QUOTE.exec(lines[i++] as string)?.[1] ?? "");
      out.push(
        depth < MAX_DEPTH
          ? { k: "quote", children: parseBlocks(inner, depth + 1) }
          : { k: "para", text: inner.join("\n") },
      );
      continue;
    }
    if (ITEM.test(line) && depth < MAX_DEPTH) {
      i = parseList(lines, i, depth, out);
      continue;
    }
    const align = tableAt(lines, i);
    if (align) {
      const n = align.length;
      // セルが足りない行は空で埋め、多い行は切る
      const fit = (cells: string[]) => Array.from({ length: n }, (_, j) => cells[j] ?? "");
      const head = fit(splitRow(line));
      const rows: string[][] = [];
      i += 2;
      while (i < lines.length && !blank(lines[i]) && !startsBlock(lines[i] as string))
        rows.push(fit(splitRow(lines[i++] as string)));
      out.push({ k: "table", align, head, rows });
      continue;
    }
    const para: string[] = [line.trim()];
    i++;
    while (
      i < lines.length &&
      !blank(lines[i]) &&
      !startsBlock(lines[i] as string) &&
      !tableAt(lines, i)
    )
      para.push((lines[i++] as string).trim());
    out.push({ k: "para", text: para.join("\n") });
  }
  return out;
}

/** リスト 1 つを読み、次の行の位置を返す */
function parseList(lines: string[], from: number, depth: number, out: MdBlock[]): number {
  const first = ITEM.exec(lines[from] as string) as RegExpExecArray;
  const base = (first[1] as string).length;
  const ordered = isOrdered(first[2] as string);
  const start = ordered ? Number.parseInt(first[2] as string, 10) : 1;
  const items: string[][] = [];
  /** 今の項目の中身の字下げ（続きの行から外す空白の数） */
  let content = 0;
  let i = from;
  while (i < lines.length) {
    const line = lines[i] as string;
    if (blank(line)) {
      // 空行の次が同じリストの項目か、項目の続き（字下げ）ならリストは続く
      let j = i + 1;
      while (j < lines.length && blank(lines[j])) j++;
      const next = lines[j];
      if (next === undefined) break;
      const m = ITEM.exec(next);
      const same = m && indentOf(next) <= base + 1 && isOrdered(m[2] as string) === ordered;
      if (!same && indentOf(next) < base + 2) break;
      items.at(-1)?.push("");
      i = j;
      continue;
    }
    const m = ITEM.exec(line);
    const ind = indentOf(line);
    if (m && ind <= base + 1) {
      if (isOrdered(m[2] as string) !== ordered) break;
      items.push([m[3] ?? ""]);
      content = ind + (m[2] as string).length + 1;
      i++;
      continue;
    }
    const cur = items.at(-1);
    if (!cur) break;
    if (ind >= base + 2) cur.push(line.slice(Math.min(ind, content)));
    else if (!startsBlock(line)) cur.push(line.trim());
    else break;
    i++;
  }
  out.push({
    k: "list",
    ordered,
    start,
    items: items.map((it) => parseBlocks(it, depth + 1)),
  });
  return i;
}

/** http(s) の URL だけを href にする（ほかは null = 素の文字） */
export function safeHref(u: string): string | null {
  if (!/^https?:\/\//i.test(u)) return null;
  try {
    const x = new URL(u);
    return x.protocol === "http:" || x.protocol === "https:" ? x.href : null;
  } catch {
    return null;
  }
}

const PUNCT = /[!-/:-@[-`{-~]/;
const WORD = /[\p{L}\p{N}]/u;
const URL_AT = /^https?:\/\/[^\s<>"'`]+/i;

/** 素の URL の末尾の句読点（と対になっていない閉じ括弧）を外す */
function trimUrl(u: string): string {
  let s = u.replace(/[.,;:!?'"*_~]+$/, "");
  while (s.endsWith(")") && (s.match(/\(/g)?.length ?? 0) < (s.match(/\)/g)?.length ?? 0))
    s = s.slice(0, -1).replace(/[.,;:!?'"*_~]+$/, "");
  return s;
}

/** 強調の閉じ（open の後、中身が空でなく、空白の直後でない位置） */
function closeOf(s: string, delim: string, from: number): number {
  for (let j = s.indexOf(delim, from); j >= 0; j = s.indexOf(delim, j + 1)) {
    if (j === from || /\s/.test(s[j - 1] as string)) continue;
    if (delim.length === 1 && (s[j + 1] === delim || s[j - 1] === delim)) continue;
    if (delim[0] === "_" && WORD.test(s[j + delim.length] ?? "")) continue;
    return j;
  }
  return -1;
}

/** `[text](url)` の終わり（見つからなければ null） */
function linkAt(s: string, i: number): { text: string; url: string; end: number } | null {
  let depth = 0;
  let j = i;
  for (; j < s.length; j++) {
    const c = s[j];
    if (c === "\\") j++;
    else if (c === "[") depth++;
    else if (c === "]" && --depth === 0) break;
  }
  if (j >= s.length || s[j + 1] !== "(") return null;
  const m = /^\(\s*<?([^\s()<>]*(?:\([^\s()<>]*\)[^\s()<>]*)*)>?(?:\s+"[^"]*")?\s*\)/.exec(
    s.slice(j + 1),
  );
  if (!m) return null;
  return { text: s.slice(i + 1, j), url: m[1] as string, end: j + 1 + m[0].length };
}

const LINK = "text-accent underline-offset-2 hover:underline";

function inline(s: string, inLink = false): ReactNode[] {
  const out: ReactNode[] = [];
  let buf = "";
  const flush = () => {
    if (buf) out.push(buf);
    buf = "";
  };
  const push = (n: ReactNode) => {
    flush();
    out.push(n);
  };
  let i = 0;
  while (i < s.length) {
    const c = s[i] as string;
    if (c === "\\" && PUNCT.test(s[i + 1] ?? "")) {
      buf += s[i + 1];
      i += 2;
      continue;
    }
    if (c === "`") {
      const run = (/^`+/.exec(s.slice(i)) as RegExpExecArray)[0];
      const close = s.indexOf(run, i + run.length);
      if (close > i && s[close + run.length] !== "`") {
        const code = s.slice(i + run.length, close).replace(/^ (.+) $/, "$1");
        push(
          <code key={i} className="rounded-[4px] border border-line px-1 font-mono text-[0.92em]">
            {code}
          </code>,
        );
        i = close + run.length;
        continue;
      }
      buf += run;
      i += run.length;
      continue;
    }
    const img = c === "!" && s[i + 1] === "[";
    if (c === "[" || img) {
      const at = img ? i + 1 : i;
      const l = linkAt(s, at);
      const href = l && !inLink ? safeHref(l.url) : null;
      if (l && href) {
        push(
          <a key={i} href={href} target="_blank" rel="noreferrer noopener" className={LINK}>
            {inline(l.text, true)}
          </a>,
        );
        i = l.end;
        continue;
      }
      if (l) {
        // http(s) でないリンク・リンクの中のリンクは素の文字
        buf += s.slice(i, l.end);
        i = l.end;
        continue;
      }
    }
    if ((c === "*" || c === "_") && s[i + 1] === c) {
      const d = c + c;
      const open = !/\s/.test(s[i + 2] ?? " ") && !(c === "_" && WORD.test(s[i - 1] ?? ""));
      const j = open ? closeOf(s, d, i + 2) : -1;
      if (j > i + 2) {
        push(<strong key={i}>{inline(s.slice(i + 2, j), inLink)}</strong>);
        i = j + 2;
        continue;
      }
      buf += d;
      i += 2;
      continue;
    }
    if (c === "*" || c === "_") {
      const open = !/\s/.test(s[i + 1] ?? " ") && !(c === "_" && WORD.test(s[i - 1] ?? ""));
      const j = open ? closeOf(s, c, i + 1) : -1;
      if (j > i + 1) {
        push(<em key={i}>{inline(s.slice(i + 1, j), inLink)}</em>);
        i = j + 1;
        continue;
      }
    }
    if (!inLink && (c === "h" || c === "H") && !WORD.test(s[i - 1] ?? "")) {
      const m = URL_AT.exec(s.slice(i));
      const u = m ? trimUrl(m[0]) : "";
      const href = u ? safeHref(u) : null;
      if (href) {
        push(
          <a key={i} href={href} target="_blank" rel="noreferrer noopener" className={LINK}>
            {u}
          </a>,
        );
        i += u.length;
        continue;
      }
    }
    buf += c;
    i++;
  }
  flush();
  return out;
}

const HEADING_CLASS: Record<1 | 2 | 3, string> = {
  1: "font-semibold text-fg text-section",
  2: "font-semibold text-body text-fg",
  3: "font-semibold text-body text-fg2",
};

/** 表のセル（罫線はコードブロックと同じ border-line。上揃えで折り返す） */
const CELL = "border border-line px-2 py-1 align-top break-words";
/** 見出しのセル（地の色を変えて太字） */
const HEAD_CELL = `${CELL} bg-bg font-semibold text-fg2`;
const ALIGN: Record<MdAlign, string> = {
  left: "text-left",
  center: "text-center",
  right: "text-right",
  none: "text-left",
};

function Blocks({ blocks }: { blocks: MdBlock[] }) {
  return blocks.map((b, i) => {
    const key = `${b.k}-${i}`;
    switch (b.k) {
      case "para":
        return (
          <p key={key} className="whitespace-pre-wrap break-words">
            {inline(b.text)}
          </p>
        );
      case "heading":
        return (
          <p key={key} className={`break-words ${HEADING_CLASS[b.level]}`}>
            {inline(b.text)}
          </p>
        );
      case "code":
        return (
          <pre
            key={key}
            className="overflow-x-auto whitespace-pre rounded-[6px] border border-line px-2 py-1.5 font-mono text-meta"
          >
            <code>{b.text}</code>
          </pre>
        );
      case "hr":
        return <hr key={key} className="border-line" />;
      case "table":
        return (
          // 狭いパネルでは文字を折り返す。長い URL・コードで溢れるときだけ横にスクロールする
          <div key={key} className="overflow-x-auto">
            <table className="w-full border-collapse text-meta">
              <thead>
                <tr>
                  {b.head.map((c, j) => (
                    // biome-ignore lint/suspicious/noArrayIndexKey: 列は文の順で並び替わらない
                    <th key={j} className={`${HEAD_CELL} ${ALIGN[b.align[j] ?? "none"]}`}>
                      {inline(c)}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {b.rows.map((r, ri) => (
                  // biome-ignore lint/suspicious/noArrayIndexKey: 行は文の順で並び替わらない
                  <tr key={ri}>
                    {r.map((c, j) => (
                      // biome-ignore lint/suspicious/noArrayIndexKey: 列は文の順で並び替わらない
                      <td key={j} className={`${CELL} ${ALIGN[b.align[j] ?? "none"]}`}>
                        {inline(c)}
                      </td>
                    ))}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        );
      case "quote":
        return (
          <blockquote
            key={key}
            className="flex flex-col gap-1.5 border-line border-l-2 pl-3 text-fg2"
          >
            <Blocks blocks={b.children} />
          </blockquote>
        );
      default: {
        // 残りはリスト
        const items = b.items.map((it, j) => (
          // biome-ignore lint/suspicious/noArrayIndexKey: 項目は文の順で並び替わらない
          <li key={j} className="space-y-1 pl-0.5">
            <Blocks blocks={it} />
          </li>
        ));
        return b.ordered ? (
          <ol
            key={key}
            start={b.start === 1 ? undefined : b.start}
            className="list-decimal space-y-1 pl-5"
          >
            {items}
          </ol>
        ) : (
          <ul key={key} className="list-disc space-y-1 pl-5">
            {items}
          </ul>
        );
      }
    }
  });
}

/** AI の文を Markdown として出す（HTML は解釈しない） */
export function Markdown({ text, className = "" }: { text: string; className?: string }) {
  return (
    <div className={`flex flex-col gap-2 break-words text-body text-fg ${className}`.trim()}>
      <Blocks blocks={parseMarkdown(text)} />
    </div>
  );
}
