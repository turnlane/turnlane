/**
 * 件名に使う自動の題名（spec-glance §2.2。fix-stale-title）。
 *
 * カードの自動の題名（work_item.title_auto）は、セッションが他のカードにまたがると PR の題名を最優先にする（titles.ts）。
 * そのままだと PR をマージした後に同じセッションで別の作業を頼んでも、件名が古い PR の題名に残る。件名の順は
 * 自分で付けた名前 → 直近の指示（表示の瞬間に画面が読み、その日の最初の 1 つに固定する）→ ai-title → PR の題名 →
 * ブランチ名 → リポジトリ名 なので、PR 由来の自動の題名はここで ai-title を先に組み立て直す。保存はしない（読むときに組む）。
 * PR の題名はブランチ名・リポジトリ名より上（fix-subject-pr。ブランチ名を空白で区切っただけの件名より意味が分かる。別の
 * ディレクトリのセッションが出した PR だけのカードは指示も ai-title も無い）。同じカードで AI の問い・許可を待っている
 * （reply / approve が open）間は PR の題名を件名にしない（そちらが自分の番。D-213 の 問い > PR > 編集）。
 */
import type { Database } from "bun:sqlite";
import { cleanTitle } from "@turnlane/collectors";
import { formatBranch } from "./titles.ts";

export interface TitleRow {
  id: string;
  title_user: string | null;
  title_auto: string | null;
  title_source: string | null;
  branch: string | null;
  repo_root: string | null;
}

export interface ResolvedTitle {
  title: string | null;
  /** user / pr / ai_title / thread_name / desktop_title / branch / session_name / repo（pr は件名が PR の題名） */
  source: string | null;
}

const DEFAULT_BRANCHES = ["main", "master", "develop", "HEAD"];

export interface TitleResolver {
  /** 件名の自動の部分（自分で付けた名前 → ai-title → PR の題名 → ブランチ → リポジトリ）。タスクの題名・通知・画面 */
  subject(w: TitleRow): ResolvedTitle;
  /** 画面の題名（subject と同じ） */
  display(w: TitleRow): ResolvedTitle;
}

export function titleResolver(db: Database): TitleResolver {
  // PR の題名が自動の題名になっているカードの、最後のターンのセッションのツール生成の題名
  const tool = new Map(
    db
      .query<{ work_item_id: string; title: string; title_source: string | null }, []>(
        `SELECT work_item_id, title, title_source FROM (
           SELECT t.work_item_id, s.title, s.title_source,
                  ROW_NUMBER() OVER (PARTITION BY t.work_item_id ORDER BY t.started_at DESC) AS rn
           FROM ai_turn t JOIN ai_session s ON s.id = t.session_id
           WHERE s.title IS NOT NULL AND s.title != ''
             AND t.work_item_id IN (SELECT id FROM work_item WHERE title_source = 'pr' AND deleted_at IS NULL)
         ) WHERE rn = 1`,
      )
      .all()
      .map((r) => [r.work_item_id, r]),
  );
  // AI の問い・許可を待っているカード（PR の題名を件名にしない）
  const asking = new Set(
    db
      .query<{ work_item_id: string }, []>(
        `SELECT DISTINCT work_item_id FROM follow_up
         WHERE deleted_at IS NULL AND status = 'open' AND kind IN ('reply', 'approve')`,
      )
      .all()
      .map((r) => r.work_item_id),
  );
  const auto = (w: TitleRow): ResolvedTitle => {
    if (w.title_source !== "pr") return { title: w.title_auto, source: w.title_source };
    const t = tool.get(w.id);
    // ツール生成の題名は掃除してから（空同然なら次の候補。titles.ts の cardTitle と同じ）
    const toolTitle = t ? cleanTitle(t.title) : null;
    if (t && toolTitle) {
      const source =
        t.title_source === "thread_name" || t.title_source === "desktop_title"
          ? t.title_source
          : "ai_title";
      return { title: toolTitle, source };
    }
    if (w.title_auto && !asking.has(w.id)) return { title: w.title_auto, source: "pr" };
    if (w.branch && !DEFAULT_BRANCHES.includes(w.branch))
      return { title: formatBranch(w.branch), source: "branch" };
    if (w.repo_root)
      return { title: w.repo_root.slice(w.repo_root.lastIndexOf("/") + 1), source: "repo" };
    return { title: null, source: null };
  };
  const subject = (w: TitleRow): ResolvedTitle =>
    w.title_user ? { title: w.title_user, source: "user" } : auto(w);
  return { subject, display: subject };
}
