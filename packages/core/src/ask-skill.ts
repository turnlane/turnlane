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
description: Ask the user to decide between concrete alternatives through Turnlane's ask_user tool, with one small figure per option and an explanation page. Use when you need the user's decision before you continue.
allowed-tools: mcp__turnlane__ask_user
---
${ASK_SKILL_MARK}

# Ask the user with figures (Turnlane)

When you need the user's decision between concrete alternatives, call the \`ask_user\` tool of the \`turnlane\` MCP server instead of asking in the terminal. The question shows on the user's Your turn in Turnlane, and the tool returns their answer.

1. Write one small figure per option: a static HTML or SVG file (about 240×160) that shows what the option looks like or changes.
2. Write one explanation page (static HTML): why this needs deciding now, the alternatives side by side, and what you actually looked at (files, numbers, logs).
3. Call \`ask_user\` with \`question\` (one line, at most 120 characters), \`context\` (2–3 sentences, at most 600), \`options\` (2–4, each with \`label\`, \`description\`, \`recommended: true\` on at most one, and \`figure_path\`), and \`explain_path\`.
4. Continue with the returned \`choice\`. If there is a \`note\`, read it first; it may be a question for you. \`{"dismissed": true}\` means none of the options; ask in the terminal what to do next.

Figures:

- Static HTML, SVG and inline CSS only. Scripts do not run, and nothing inside can reach the network, so do not use external images, fonts or links.
- Use these CSS variables so the figures read in light and dark: ${vars}.
- Keep each file under 200 KB. Write them to a scratch folder outside the repository (for example under \`$TMPDIR\`).
- One question per call. To ask another, call again.

If \`ask_user\` returns an error or is not available, ask the user in the terminal instead.
`;

/** CLAUDE.md / AGENTS.md に貼る 1 節（始まりと終わりの印を含む） */
export const ASK_SNIPPET = `${ASK_BLOCK_START}
## Asking the user to decide

When you need the user's decision between concrete alternatives, call the \`ask_user\` tool (Turnlane MCP server) instead of asking in the terminal. Write one small figure per option and one explanation page (why now, the alternatives side by side, what you actually looked at) as static HTML/SVG files with inline CSS only, using Turnlane's CSS variables (${vars}). If \`ask_user\` fails or is not available, ask in the terminal.
${ASK_BLOCK_END}
`;

/** 節があるか */
export function hasAskBlock(text: string): boolean {
  return text.includes(ASK_BLOCK_START) && text.includes(ASK_BLOCK_END);
}

/** 節を足す（あれば今の文に置き換える）。変わらなければ同じ文を返す */
export function addAskBlock(text: string): string {
  if (hasAskBlock(text)) {
    const s = text.indexOf(ASK_BLOCK_START);
    const e = text.indexOf(ASK_BLOCK_END, s) + ASK_BLOCK_END.length;
    const after = text.slice(e).replace(/^\n/, "");
    return `${text.slice(0, s)}${ASK_SNIPPET}${after}`;
  }
  if (text.length === 0) return ASK_SNIPPET;
  const sep = text.endsWith("\n\n") ? "" : text.endsWith("\n") ? "\n" : "\n\n";
  return `${text}${sep}${ASK_SNIPPET}`;
}

/** 節を外す（足したときの前の空行も）。無ければ同じ文を返す */
export function removeAskBlock(text: string): string {
  if (!hasAskBlock(text)) return text;
  const s = text.indexOf(ASK_BLOCK_START);
  const e = text.indexOf(ASK_BLOCK_END, s) + ASK_BLOCK_END.length;
  const before = text.slice(0, s).replace(/\n\n$/, "\n");
  const after = text.slice(e).replace(/^\n/, "");
  const out = `${before}${after}`;
  return out === "\n" ? "" : out;
}
