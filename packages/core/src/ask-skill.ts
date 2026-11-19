/**
 * 図つきの問い（ADR 0022）を AI に使ってもらうための指示: Claude Code のスキル（SKILL.md）と、CLAUDE.md / AGENTS.md に貼る
 * 1 節。`turnlane skill install|uninstall` が識別子付きで足し・外す（hooks と同じく、Turnlane のものだけを冪等に）。
 * ここは文と、Markdown に節を足す・外す純粋な関数だけ（ファイルは CLI が読み書きする）
 */
import { ASK_FIGURE_VARS } from "./ask.ts";

/** スキルのフォルダの名前（`<Claude の設定ディレクトリ>/skills/<この名前>/SKILL.md`） */
export const ASK_SKILL_NAME = "turnlane-ask";
/** スキルが Turnlane のものだと分かる印（この印のあるものだけを書き換え・削除する） */
export const ASK_SKILL_MARK = "<!-- managed-by: turnlane -->";
/** CLAUDE.md / AGENTS.md の節の始まりと終わり */
export const ASK_BLOCK_START = "<!-- turnlane:ask-user:start -->";
export const ASK_BLOCK_END = "<!-- turnlane:ask-user:end -->";

const vars = ASK_FIGURE_VARS.map((v) => `\`${v}\``).join(", ");

export const ASK_SKILL_MD = `---
name: ${ASK_SKILL_NAME}
description: ALWAYS use when you are about to ask the user to decide or confirm something that a figure can explain, not only text (a screen layout, a structure or architecture, a flow or sequence, the before and after of a change, numbers side by side). Ask through Turnlane's ask_user tool with 2–4 options and one small figure each, instead of the built-in AskUserQuestion tool and instead of ending your turn with a question in text.
allowed-tools: mcp__turnlane__ask_user
---
${ASK_SKILL_MARK}

# Ask the user with figures (Turnlane)

When you are about to ask the user to decide or confirm something, and a figure can explain it, not only text, ALWAYS call the \`ask_user\` tool of the \`turnlane\` MCP server. A figure helps when the choice is about a screen layout, a structure or architecture, a flow or sequence, the before and after of a change, or numbers side by side. This replaces the built-in AskUserQuestion tool, and it replaces ending your turn with a question in text. The question shows on the user's Your turn in Turnlane, and the tool returns their answer.

\`ask_user\` is for decisions: it needs 2–4 options, so do not use it for explanations with nothing to decide. Ask text-only matters (yes or no, a name, a path) the usual way.

1. Write one figure per option: a static HTML or SVG file that shows what the option looks like or changes. Draw it at 480×320 (3:2) with an SVG \`viewBox\` or fluid widths so it scales.
2. Write one explanation page (static HTML): why this needs deciding now, the alternatives side by side, and what you actually looked at (files, numbers, logs).
3. Call \`ask_user\` with \`question\` (one line, at most 120 characters), \`context\` (2–3 sentences, at most 600), \`options\` (2–4, each with \`label\`, \`description\`, \`recommended: true\` on at most one, and \`figure_path\`), and \`explain_path\`.
4. Continue with the returned \`choice\`. If there is a \`note\`, read it first; it may be a question for you. \`{"dismissed": true}\` means none of the options; ask in the terminal what to do next.

Figures:

- Figures are shown small first (a thumbnail beside each option, then a card's width when the user expands the question). Draw a few large shapes and no small text: the option's name and meaning belong in \`label\` and \`description\`, and details belong on the explanation page.
- Static HTML, SVG and inline CSS only. Scripts do not run, and nothing inside can reach the network, so do not use external images, fonts or links.
- Use these CSS variables so the figures read in light and dark: ${vars}.
- Keep each file under 200 KB. Write them to a scratch folder outside the repository (for example under \`$TMPDIR\`).
- One question per call. To ask another, call again.

If \`ask_user\` returns an error or is not available, ask the user in the terminal instead.
`;

/** CLAUDE.md / AGENTS.md に貼る 1 節（始まりと終わりの印を含む） */
export const ASK_SNIPPET = `${ASK_BLOCK_START}
## Asking the user to decide or confirm

When you are about to ask the user to decide or confirm something, and a figure can explain it, not only text (a screen layout, a structure or architecture, a flow or sequence, the before and after of a change, numbers side by side), ALWAYS call the \`ask_user\` tool (Turnlane MCP server) with 2–4 options. It replaces the built-in AskUserQuestion tool and ending your turn with a question in text. Write one figure per option (480×320 with an SVG viewBox or fluid widths; a few large shapes, no small text) and one explanation page (why now, the alternatives side by side, what you actually looked at) as static HTML/SVG files with inline CSS only, using Turnlane's CSS variables (${vars}). Ask text-only matters (yes or no, a name, a path) the usual way. If \`ask_user\` fails or is not available, ask in the terminal.
${ASK_BLOCK_END}
`;

/** 節があるか */
export function hasAskBlock(text: string): boolean {
  return text.includes(ASK_BLOCK_START) && text.includes(ASK_BLOCK_END);
}

/** 始まりから終わりの印までの範囲（終わりの印の直後の改行 1 つを含む）。順に全部 */
function askBlockRanges(text: string): [number, number][] {
  const out: [number, number][] = [];
  let from = 0;
  for (;;) {
    const s = text.indexOf(ASK_BLOCK_START, from);
    if (s < 0) break;
    const e0 = text.indexOf(ASK_BLOCK_END, s);
    if (e0 < 0) break;
    let e = e0 + ASK_BLOCK_END.length;
    if (text[e] === "\n") e++;
    out.push([s, e]);
    from = e;
  }
  return out;
}

/**
 * 節の状態: installed（今の文の節が 1 つ）/ outdated（古い文の節、または節が 2 つ以上）/ none。
 * 古い版の Turnlane が入れた節も `turnlane skill install` で今の文に置き換わる
 */
export function askBlockState(text: string): "installed" | "outdated" | "none" {
  const r = askBlockRanges(text);
  if (r.length === 0) return "none";
  if (r.length > 1) return "outdated";
  const [s, e] = r[0] as [number, number];
  return text.slice(s, e).trimEnd() === ASK_SNIPPET.trimEnd() ? "installed" : "outdated";
}

/** 節を足す（あれば最初の節を今の文に置き換え、2 つ目からは外す）。変わらなければ同じ文を返す */
export function addAskBlock(text: string): string {
  const r = askBlockRanges(text);
  if (r.length > 0) {
    let out = "";
    let pos = 0;
    r.forEach(([s, e], i) => {
      if (i === 0) out += text.slice(pos, s) + ASK_SNIPPET;
      else out += text.slice(pos, s).replace(/\n\n$/, "\n");
      pos = e;
    });
    return out + text.slice(pos);
  }
  if (text.length === 0) return ASK_SNIPPET;
  const sep = text.endsWith("\n\n") ? "" : text.endsWith("\n") ? "\n" : "\n\n";
  return `${text}${sep}${ASK_SNIPPET}`;
}

/** 節を外す（足したときの前の空行も。2 つ以上あれば全部）。無ければ同じ文を返す */
export function removeAskBlock(text: string): string {
  const r = askBlockRanges(text);
  if (r.length === 0) return text;
  let out = "";
  let pos = 0;
  for (const [s, e] of r) {
    out += text.slice(pos, s).replace(/\n\n$/, "\n");
    pos = e;
  }
  out += text.slice(pos);
  return out === "\n" ? "" : out;
}
