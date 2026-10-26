/**
 * ターン → WorkItem（カード）のグルーピング（phase0-plan 3.3、ai-session-ingestion 4.2。S3 で調整済み）。
 *
 * 1. ターンのブランチと cwd はターン終了時点の値（アダプタがそうしている）
 * 2. cwd から求めた repo_root が今は解決できない（cwd が消えた）ターンは、同じセッションで直前に解決できた
 *    ターンの repo_root を引き継ぐ。引き継げず、すでにカードに入っていればそのカードを保つ。どちらも無ければ git 管理外
 * 3. git 管理外・既定ブランチ → `session:<tool>:<セッション ID>`、それ以外 → `branch:<repo_root>#<branch>`
 * 4. 同じブランチで2本目以降の PR が出たら、前の PR が閉じた後のターンは `#pr<n>` を付けたカードに分ける
 * 5. PR は head ブランチ（gh の headRefName）のカードに付ける。そのカードが無ければ PR を起点に作る。
 *    カードのリポジトリは PR の属するリポジトリ（prRepoRoot。セッションの cwd ではない）。
 *    head が分からなければ PR が初めて出たターンのカードに付ける
 * 6. サブエージェントのターンは、親セッションでその時点に動いていたターンのカードに入れる
 * ユーザーの統合（merged_into_id）は runner がキー → カードの対応で優先する。
 */

export function sessionKey(tool: string, externalId: string): string {
  return `session:${tool}:${externalId}`;
}

export function branchKey(repoRoot: string, branch: string): string {
  return `branch:${repoRoot}#${branch}`;
}

export interface GroupTurnInput {
  turnId: string;
  sessionId: string;
  tool: string;
  sessionExternalId: string;
  /** サブエージェントのセッションなら親の ai_session.id */
  parentSessionId: string | null;
  startedAt: number;
  /** 解決した repo_root。null = git 管理外、undefined = cwd が無く解決できない */
  repoRoot: string | null | undefined;
  branch: string | null;
  /** 今入っているカードのキー（解決できないターンの割り当てを保つため） */
  existingKey: string | null;
}

export interface GroupPrInput {
  ref: string;
  number: number;
  /**
   * PR の属するリポジトリの repo_root（prRepoRoot で PR の owner/repo を手元のパスに結んだもの。
   * 手元に無ければ `owner/repo`）。セッションの cwd のリポジトリではない
   */
  repoRoot: string | null;
  headRef: string | null;
  firstTurnId: string | null;
  firstSeenAt: number;
  stateChangedAt: number | null;
}

export interface CardInfo {
  key: string;
  kind: "branch" | "session";
  repoRoot: string | null;
  branch: string | null;
  prRefs: string[];
  firstActivityAt: number;
  lastActivityAt: number;
}

export interface GroupResult {
  turnKeys: Map<string, string>;
  prKeys: Map<string, string>;
  cards: Map<string, CardInfo>;
  /** ターン → 確定した repo_root（引き継ぎ後） */
  turnRepos: Map<string, string | null>;
}

function parseKey(key: string): {
  kind: "branch" | "session";
  repoRoot: string | null;
  branch: string | null;
} {
  if (key.startsWith("branch:")) {
    const body = key.slice("branch:".length).replace(/#pr\d+$/, "");
    const i = body.lastIndexOf("#");
    return { kind: "branch", repoRoot: body.slice(0, i), branch: body.slice(i + 1) };
  }
  return { kind: "session", repoRoot: null, branch: null };
}

export function groupTurns(
  turns: readonly GroupTurnInput[],
  prs: readonly GroupPrInput[],
  isDefault: (repoRoot: string, branch: string | null) => boolean,
): GroupResult {
  const turnKeys = new Map<string, string>();
  const turnRepos = new Map<string, string | null>();
  const bySession = new Map<string, GroupTurnInput[]>();
  for (const t of turns) {
    const list = bySession.get(t.sessionId) ?? [];
    list.push(t);
    bySession.set(t.sessionId, list);
  }
  for (const list of bySession.values()) list.sort((a, b) => a.startedAt - b.startedAt);

  // 1〜3: サブエージェント以外
  for (const list of bySession.values()) {
    let lastRepo: string | undefined;
    for (const t of list) {
      if (t.parentSessionId) continue;
      let repo = t.repoRoot;
      if (repo === undefined && lastRepo !== undefined) repo = lastRepo;
      if (repo === undefined && t.existingKey) {
        turnKeys.set(t.turnId, t.existingKey);
        turnRepos.set(t.turnId, parseKey(t.existingKey).repoRoot);
        continue;
      }
      const r = repo ?? null;
      if (r) lastRepo = r;
      turnRepos.set(t.turnId, r);
      turnKeys.set(
        t.turnId,
        r && t.branch && !isDefault(r, t.branch)
          ? branchKey(r, t.branch)
          : sessionKey(t.tool, t.sessionExternalId),
      );
    }
  }

  // 6: サブエージェント → 親セッションでその時点のターンのカード
  for (const list of bySession.values()) {
    for (const t of list) {
      if (!t.parentSessionId) continue;
      const parent = (bySession.get(t.parentSessionId) ?? []).filter((p) => turnKeys.has(p.turnId));
      const at = [...parent].reverse().find((p) => p.startedAt <= t.startedAt) ?? parent[0];
      const key = at ? turnKeys.get(at.turnId) : undefined;
      if (key) {
        turnKeys.set(t.turnId, key);
        turnRepos.set(t.turnId, turnRepos.get(at?.turnId ?? "") ?? null);
      } else {
        const r = t.repoRoot ?? null;
        turnRepos.set(t.turnId, r);
        turnKeys.set(
          t.turnId,
          r && t.branch && !isDefault(r, t.branch)
            ? branchKey(r, t.branch)
            : sessionKey(t.tool, t.sessionExternalId),
        );
      }
    }
  }

  // 4: 同じ head ブランチの2本目以降の PR
  const prKeys = new Map<string, string>();
  const byBranch = new Map<string, GroupPrInput[]>();
  for (const p of prs) {
    if (!p.repoRoot || !p.headRef || isDefault(p.repoRoot, p.headRef)) continue;
    const base = branchKey(p.repoRoot, p.headRef);
    const list = byBranch.get(base) ?? [];
    list.push(p);
    byBranch.set(base, list);
  }
  const turnStart = new Map(turns.map((t) => [t.turnId, t.startedAt]));
  for (const [base, list] of byBranch) {
    list.sort((a, b) => a.firstSeenAt - b.firstSeenAt);
    list.forEach((p, i) => {
      prKeys.set(p.ref, i === 0 ? base : `${base}#pr${p.number}`);
    });
    if (list.length < 2) continue;
    const starts = list.map((p, i) =>
      i === 0
        ? Number.NEGATIVE_INFINITY
        : ((list[i - 1] as GroupPrInput).stateChangedAt ?? p.firstSeenAt),
    );
    for (const [turnId, key] of turnKeys) {
      if (key !== base) continue;
      const at = turnStart.get(turnId) ?? 0;
      let k = 0;
      for (let i = 0; i < starts.length; i++) if ((starts[i] as number) <= at) k = i;
      if (k > 0) turnKeys.set(turnId, `${base}#pr${(list[k] as GroupPrInput).number}`);
    }
  }
  // 5: head が分からない PR は初出ターンのカード
  for (const p of prs) {
    if (prKeys.has(p.ref)) continue;
    const k = p.firstTurnId ? turnKeys.get(p.firstTurnId) : undefined;
    if (k) prKeys.set(p.ref, k);
  }

  // カードの情報
  const cards = new Map<string, CardInfo>();
  const touch = (key: string, at: number) => {
    const c = cards.get(key);
    if (c) {
      c.firstActivityAt = Math.min(c.firstActivityAt, at);
      c.lastActivityAt = Math.max(c.lastActivityAt, at);
      return;
    }
    const pk = parseKey(key);
    cards.set(key, { key, ...pk, prRefs: [], firstActivityAt: at, lastActivityAt: at });
  };
  for (const t of turns) {
    const k = turnKeys.get(t.turnId);
    if (k) touch(k, t.startedAt);
  }
  for (const p of prs) {
    const k = prKeys.get(p.ref);
    if (!k) continue;
    touch(k, p.firstSeenAt);
    cards.get(k)?.prRefs.push(p.ref);
  }
  return { turnKeys, prKeys, cards, turnRepos };
}

/**
 * 既定ブランチの session カードの repo_root（D-061）。カードのターン（開始順）のうち最後に解決できたもの。
 * 解決できるターンが無ければ、取り込んだ時点で解決できていたセッションの repo_root（新しい順の最初。
 * ディレクトリ名を変えて今は無いパスでも、その時点で git のルートだったことは確かめてある）。どちらも無ければ null（git 管理外）
 */
export function sessionCardRepoRoot(
  turnRepos: readonly (string | null | undefined)[],
  sessionRepos: readonly (string | null)[],
): string | null {
  for (let i = turnRepos.length - 1; i >= 0; i--) {
    const r = turnRepos[i];
    if (r) return r;
  }
  return sessionRepos.find((r) => r) ?? null;
}

/** PR の参照（`owner/repo#8`）→ `owner/repo`。形が違えば null */
export function prRepoOf(ref: string): string | null {
  const i = ref.lastIndexOf("#");
  const slug = i > 0 ? ref.slice(0, i) : "";
  return /^[\w.-]+\/[\w.-]+$/.test(slug) ? slug : null;
}

/**
 * PR のカードのリポジトリ（PR の属するリポジトリ）。別のディレクトリのセッションが `gh pr create -R` などで別の
 * リポジトリに PR を出しても、セッションの cwd のリポジトリにしない。
 * 1. リモートに owner/repo を持つ手元のリポジトリ（PR を出したセッションのリポジトリを先に、ほかはパスの順）
 * 2. リモートを持たない手元のリポジトリで、名前（最後の要素）が repo と同じもの（同じ順）
 * 3. 見つからなければ `owner/repo`（パスでない。表示の名前にだけ使い、フォルダとしては開かない）
 * PR の参照の形が読めなければセッションのリポジトリ（今までどおり）
 */
export function prRepoRoot(
  prRepo: string | null,
  sessionRepo: string | null,
  candidates: readonly string[],
  remotesOf: (repoRoot: string) => readonly string[],
): string | null {
  if (!prRepo) return sessionRepo;
  const want = prRepo.toLowerCase();
  const name = want.slice(want.indexOf("/") + 1);
  const order = [
    ...(sessionRepo ? [sessionRepo] : []),
    ...[...new Set(candidates)].filter((r) => r !== sessionRepo).sort(),
  ];
  const remotes = (r: string) => remotesOf(r).map((x) => x.toLowerCase());
  const byRemote = order.find((r) => remotes(r).includes(want));
  if (byRemote) return byRemote;
  const byName = order.find(
    (r) =>
      remotes(r).length === 0 && (r.split("/").filter(Boolean).at(-1) ?? "").toLowerCase() === name,
  );
  return byName ?? prRepo;
}
