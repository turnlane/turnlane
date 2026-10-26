/**
 * カードのタイトル（ai-session-ingestion 4.4。S3 で調整済み）。
 * カードのセッションが他のカードにまたがっていなければ、ツール生成の要約を最優先にする（D-066 (3)）。
 * またがる（ブランチを切り替えたセッションがある）場合は要約が他のカードと重複するので、種類ごとの次の順:
 * branch のカード: PR タイトル → ブランチ名の整形 → ツール生成の要約（ai-title / thread_name）
 * session のカード: PR タイトル → ツール生成の要約 → ブランチ名の整形 → リポジトリ名
 * ユーザーが付けた名前（title_user）は別の列で、表示側が優先する。
 * ツール生成の要約は cleanTitle を通し、空同然（相づち・貼り付けの印・3 文字以下・記号だけ）なら無い扱いで次の候補に落とす
 * （取り込み時にも通すが、保存済みの古い題名もここで直る）。
 */
import { cleanTitle } from "@turnlane/collectors";

export type TitleSource =
  | "pr"
  | "ai_title"
  | "thread_name"
  | "desktop_title"
  | "branch"
  | "session_name"
  | "repo";

export function formatBranch(branch: string): string {
  const last = branch.replace(
    /^(feat|feature|fix|chore|refactor|docs|test|hotfix|bugfix|spike|codex|claude)\//i,
    "",
  );
  return last.replace(/[-_/]+/g, " ").trim() || branch;
}

export interface TitleInput {
  kind: "branch" | "session";
  branch: string | null;
  repoRoot: string | null;
  prTitles: (string | null)[];
  /** 新しい順のセッションのタイトル（ツール生成） */
  sessionTitles: { title: string; source: string | null }[];
  /** カードのどのセッションも、他のカードにターンを持たない（D-066 (3)） */
  exclusive?: boolean;
}

export function cardTitle(i: TitleInput): { title: string | null; source: TitleSource | null } {
  const tool = i.sessionTitles[0];
  const cleaned = tool ? cleanTitle(tool.title) : null;
  const toolTitle =
    tool && cleaned
      ? {
          title: cleaned,
          source: (tool.source === "thread_name"
            ? "thread_name"
            : tool.source === "desktop_title"
              ? "desktop_title"
              : "ai_title") as TitleSource,
        }
      : null;
  if (i.exclusive && toolTitle) return toolTitle;
  const pr = i.prTitles.find((t): t is string => !!t);
  if (pr) return { title: pr, source: "pr" };
  const branch = i.branch ? { title: formatBranch(i.branch), source: "branch" as const } : null;
  if (i.kind === "branch") return branch ?? toolTitle ?? { title: null, source: null };
  if (toolTitle) return toolTitle;
  if (branch && !["main", "master", "develop", "HEAD"].includes(i.branch ?? "")) return branch;
  if (i.repoRoot)
    return { title: i.repoRoot.slice(i.repoRoot.lastIndexOf("/") + 1), source: "repo" };
  return { title: null, source: null };
}
