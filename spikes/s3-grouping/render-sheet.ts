// s3.ts の detail.json から、オーナー確認用シート（Markdown）を作る。
// シートには repo 名・ブランチ名・ツール生成タイトルが入るので、出力先はこのリポジトリの外にすること。
//
//   bun run spikes/s3-grouping/render-sheet.ts <detail.json> <出力.md>

import { readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';

const [inPath, outPath] = process.argv.slice(2);
if (!inPath || !outPath || resolve(outPath).startsWith(process.cwd())) {
  console.error('usage: render-sheet.ts <detail.json> <out.md>（出力先はリポジトリ外）');
  process.exit(2);
}
const { itemsA } = JSON.parse(readFileSync(inPath, 'utf8'));

const ST: Record<string, string> = { error: 'error', needs_input: 'needs_input', running: 'running', your_turn: 'your_turn', done: 'done' };
const REASON: Record<string, string> = {
  your_turn_edits: '最終ターンで編集あり（コミット有無は見ていない）',
  your_turn_question: '最終ターンが質問で終了',
  your_turn_open_pr: 'open な PR',
  your_turn_interrupted: '中断で終了・24h以内',
  done_timeout_24h: 'your_turn 条件なしで24h経過',
  done_pr_merged: 'PR が merged',
  done_pr_closed: 'PR が closed',
  done_archived: 'アーカイブ済み',
  done_moved_on: '同じセッションで別作業へ移った（後に人間入力あり）',
  gap_no_signal_lt24h: '仕様の空白: your_turn 条件なし・24h未満（暫定 done）',
  running_live_busy: 'sessions/<pid>.json が busy',
  running_recent_update: '最終ターン未完了・直近更新',
  needs_input_ask_pending: 'AskUserQuestion 未回答',
  needs_input_live_idle_unfinished: 'idle だが最終ターン未完了',
  error_api: 'API エラーで終了',
};
const AMB: Record<string, string> = {
  edits_on_default_branch: '既定ブランチ/管理外で編集',
  edits_repo_dirty_now: '今も未コミット変更あり',
  edits_repo_clean_now: '今は未コミット変更なし',
  branch_changed_within_turn: 'ターン内でブランチ切替',
  multiple_prs_in_item: '1カードに複数PR',
  spec_gap_no_signal_within_24h: '仕様の空白（24h未満）',
  codex_branch_estimated: 'Codex: ブランチ不明',
  pr_owned_by_default_branch_session: 'PRが既定ブランチのカードに帰属',
  pr_created_here_but_owned_by_other_item: 'このカードで作ったPRが別カードに帰属',
  moved_on_with_edits: '編集後に別作業へ',
  unfinished_last_turn: '最終ターン未完了',
  interrupted_last_turn: '最終ターン中断',
  multi_session: '複数セッション',
  multi_tool: '複数ツール',
};
const fmt = (ms: number) => {
  if (!ms) return '0m';
  const m = Math.round(ms / 60000);
  return m >= 60 ? `${Math.floor(m / 60)}h${String(m % 60).padStart(2, '0')}m` : `${m}m`;
};
const esc = (s: string | null | undefined) => (s ?? '').replace(/\|/g, '\\|').replace(/\n/g, ' ');

// 行 ID は最初の活動順
itemsA.sort((a: any, b: any) => a.firstAt - b.firstAt);
itemsA.forEach((it: any, i: number) => (it.id = `W${String(i + 1).padStart(2, '0')}`));

const dates = [...new Set(itemsA.flatMap((it: any) => Object.keys(it.byDate)))].sort().reverse() as string[];
let md = `# S3 オーナー確認シート（dayline、非公開）

- 生成: ${new Date().toISOString().slice(0, 16)}Z / 対象: 過去7日（日付の区切り 04:00 JST）
- 対象ソース: Claude Code（work を名前に含む設定ディレクトリは除外）、Claude Desktop Code（期間内の該当なし）、Codex（SQLite が開けず JSONL から）
- 規則: phase0-plan 3.3 のグルーピング（repo×branch、既定ブランチ/管理外はセッション単位、PR は属性）。PR はターンではなく gh の head ブランチでカードに帰属させた
- タイトル候補はツール生成の要約（Claude ai-title / Codex thread_name）のみ。会話本文・プロンプトは含めていない
- 状態は「現在（シート生成時点）」の判定。同じカードが複数日に出る場合、状態とフォローアップは各日で同じものを再掲している
- 待ち = AI のターン終了から次の人間入力まで（1回あたり上限24h、確定分）。「+」付きは現在も待ち中の経過時間
- フォローアップ: \`*\` は現在 open、それ以外は自動クローズ済み（理由は括弧内）。check_changes は既定オフだが、オンにした場合の件数を参考で出している

## 記入方法

- 粒度OK?: このカードの切り方が「自分の作業1件」として妥当なら ○。分けすぎ/まとめすぎなら × と、正しい単位をメモに
- 状態OK?: 今の実際の状態と合っていれば ○。違えば正しい状態（running / needs_input / your_turn / done / error）をメモに
- 特に見てほしい行は「要確認」列に ★ を付けた（迷いケースの類型の代表）

`;

const focus = new Set<string>();
for (const it of itemsA) {
  if (it.status === 'your_turn' || it.reason === 'gap_no_signal_lt24h' || it.reason === 'done_moved_on' || it.ambiguity.includes('multiple_prs_in_item')) focus.add(it.id);
}

for (const d of dates) {
  const its = itemsA.filter((it: any) => it.byDate[d]);
  md += `## ${d}（${its.length}件）\n\n`;
  md += '| ID | 要確認 | ツール | repo | branch | PR | タイトル候補 | 状態（根拠） | ターン | AI時間 | 待ち | 生成フォローアップ | 迷いの類型 | 粒度OK? | 状態OK? | メモ |\n';
  md += '|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|\n';
  for (const it of its) {
    const b = it.byDate[d];
    const repo = it.repo ?? (it.tools.includes('codex') ? '(git管理外: Codexのプロジェクトなしスレッド)' : '(git管理外)');
    const branch = it.kind === 'session' ? `${it.branch ?? '-'}（セッション単位）` : it.branch;
    const prs = it.prs.map((p: any) => `${p.ref.replace(/^.*#/, '#')} ${p.state.toLowerCase()}`).join(', ') || '-';
    const fus = it.followups.filter((f: any) => f.date === d);
    const fuCount: Record<string, number> = {};
    for (const f of fus) {
      const k = `${f.kind}${f.ref ? ` ${f.ref}` : ''}${f.open ? '*' : f.closedBy ? `(${f.closedBy})` : ''}`;
      fuCount[k] = (fuCount[k] ?? 0) + 1;
    }
    const fuStr = Object.entries(fuCount).map(([k, n]) => (n > 1 ? `${k}×${n}` : k)).join(', ') || '-';
    const wait = `${fmt(b.waitMs)}${b.waitOpenMs ? ` +${fmt(b.waitOpenMs)}` : ''}`;
    const amb = it.ambiguity.map((a: string) => AMB[a] ?? a).join('、') || '-';
    md += `| ${it.id} | ${focus.has(it.id) ? '★' : ''} | ${it.tools.join('+')} | ${esc(repo)} | ${esc(branch)} | ${prs} | ${esc(it.title) || '(なし)'} | ${ST[it.status]}（${REASON[it.reason] ?? it.reason}） | ${b.turns} | ${fmt(b.aiMs)} | ${wait} | ${esc(fuStr)} | ${amb} |  |  |  |\n`;
  }
  md += '\n';
}

md += `## 全体についての質問（自由記入）

1. 見落としている作業（このシートに出てこないが、この7日に AI にやらせた作業）はありますか:
2. 1行にまとまっているが、実際は別の作業だったものはありますか（ID）:
3. 別の行に分かれているが、実際は同じ作業だったものはありますか（ID の組）:
4. 個人用の設定ディレクトリで動かした作業のうち、取り込み対象から外したいリポジトリはありますか:
`;
writeFileSync(outPath, md);
console.log(`rows=${itemsA.length} dates=${dates.length} -> ${outPath}`);
