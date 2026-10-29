/**
 * リリースの一本道（scripts/release.ts、phase0-plan M6-10、docs/release.md）の純粋な部分:
 * CHANGELOG の読み取り、前提の検査、公開のコマンド列。git・gh・ファイルには触れない（表駆動のテスト用）
 */
import { resolve } from "node:path";
import {
  CASK_TOKEN,
  HOMEBREW_INSTALL_COMMAND,
  LATEST_JSON_URL,
  LATEST_ZIP_NAME,
  RELEASE_REPO_URL,
  RELEASES_PAGE_URL,
  releaseZipName,
  TAP_REPO,
} from "../../packages/core/src/release-config.ts";
import { DEVELOPER_ID_PREFIX } from "../signing.ts";

const VERSION_HEADING =
  /^## \[(\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?)\](?:\s+-\s+(\d{4}-\d{2}-\d{2}))?\s*$/;

/** CHANGELOG.md の最上段の版の見出し（`## [Unreleased]` は飛ばす）。無ければ null */
export function changelogTopVersion(md: string): { version: string; date: string | null } | null {
  for (const line of md.split("\n")) {
    const m = VERSION_HEADING.exec(line);
    if (m) return { version: m[1] as string, date: m[2] ?? null };
  }
  return null;
}

/** その版の節の本文（見出しの次の行から、次の `## ` の前まで。前後の空行を除く）。無ければ null */
export function changelogSection(md: string, version: string): string | null {
  const lines = md.split("\n");
  const start = lines.findIndex((l) => VERSION_HEADING.exec(l)?.[1] === version);
  if (start < 0) return null;
  const rest = lines.slice(start + 1);
  const end = rest.findIndex((l) => l.startsWith("## ") || /^\[[^\]]+\]:\s/.test(l));
  const body = (end < 0 ? rest : rest.slice(0, end)).join("\n").trim();
  return body.length > 0 ? body : null;
}

export interface ReleaseFacts {
  /** 今のブランチ（detached なら null） */
  branch: string | null;
  /** 作業ツリーに変更が無い（無視するファイルは除く） */
  clean: boolean;
  /** package.json の version */
  version: string;
  /** CHANGELOG.md の中身（無ければ null） */
  changelog: string | null;
  /** タグ v<version> がもうある（手元） */
  tagExists: boolean;
  /**
   * 手元のタグ v<version> の指すコミット（無ければ null）。手元だけにあり、タグを付けるコミット（ビルドのコミット）を指して
   * いれば止めずにタグの手順を省く（localTagDecision）。省略時は今までどおり、タグがあれば止める
   */
  localTag?: string | null;
  /** origin にタグ v<version> があるか（git ls-remote。確かめられなければ null）。手元にタグがあるときだけ調べる */
  remoteTag?: boolean | null;
  /** TURNLANE_CODESIGN_IDENTITY */
  identity: string | null;
  /** TURNLANE_NOTARY_PROFILE */
  notaryProfile: string | null;
  /** --allow-adhoc（開発の確かめ用。署名・公証・ブランチを緩める。公開はできない） */
  allowAdhoc: boolean;
  /** --skip-notarize */
  skipNotarize: boolean;
}

export interface ReleaseCheck {
  /** 止める問題 */
  errors: string[];
  /** --allow-adhoc で緩めたもの */
  warnings: string[];
}

/** 前提の検査（純粋） */
export function releaseCheck(f: ReleaseFacts): ReleaseCheck {
  const errors: string[] = [];
  const warnings: string[] = [];
  const relaxable = (msg: string) => (f.allowAdhoc ? warnings : errors).push(msg);

  if (f.branch !== "main") relaxable(`not on main (on ${f.branch ?? "a detached HEAD"})`);
  if (!f.clean) errors.push("the working tree has uncommitted changes");
  if (f.changelog === null) errors.push("CHANGELOG.md is missing");
  else {
    const top = changelogTopVersion(f.changelog);
    if (!top) errors.push("CHANGELOG.md has no version heading (## [x.y.z] - YYYY-MM-DD)");
    else if (top.version !== f.version)
      errors.push(
        `CHANGELOG.md's top version ${top.version} does not match package.json ${f.version}`,
      );
    else if (!top.date) errors.push(`CHANGELOG.md: ## [${top.version}] has no date`);
    else if (!changelogSection(f.changelog, f.version))
      errors.push(`CHANGELOG.md: ## [${f.version}] is empty`);
  }
  if (f.tagExists) {
    if (f.remoteTag === true)
      errors.push(
        `tag v${f.version} already exists on origin: the release was published or half-published. See docs/release.md (When something fails)`,
      );
    else if (f.localTag === undefined || f.localTag === null)
      errors.push(`tag v${f.version} already exists`);
    else if (f.remoteTag === null)
      errors.push(
        `tag v${f.version} exists locally and origin could not be checked (git ls-remote failed); delete it with \`git tag -d v${f.version}\` or check the network`,
      );
    // 手元だけのタグは、タグを付けるコミットが分かってから決める（localTagDecision）
  }

  const id = f.identity?.trim() ?? "";
  if (!id.startsWith(DEVELOPER_ID_PREFIX))
    relaxable(
      `TURNLANE_CODESIGN_IDENTITY is ${id ? "not a Developer ID Application certificate" : "not set"} (a release must be signed with Developer ID)`,
    );
  if (!f.notaryProfile)
    relaxable("TURNLANE_NOTARY_PROFILE is not set (a release must be notarized)");
  if (f.skipNotarize) relaxable("--skip-notarize (a release must be notarized)");
  return { errors, warnings };
}

/**
 * 手元だけにあるタグ v<version>（origin には無い）の扱い: タグを付けるコミット（ビルドのコミット）を指していればそのまま使い、
 * タグの手順を省く。違うコミットを指していれば止めて、消すコマンドを出す
 */
export function localTagDecision(o: {
  version: string;
  localTag: string | null | undefined;
  commit: string;
}): { skipTag: boolean; note?: string; error?: string } {
  if (!o.localTag || !o.commit) return { skipTag: false };
  const same =
    o.localTag === o.commit || o.localTag.startsWith(o.commit) || o.commit.startsWith(o.localTag);
  if (same)
    return {
      skipTag: true,
      note: `tag v${o.version} already exists locally on ${o.localTag} (not pushed), continuing`,
    };
  return {
    skipTag: false,
    error: `tag v${o.version} exists locally on ${o.localTag}, not on the build commit ${o.commit}. Delete it and run again: git tag -d v${o.version}`,
  };
}

/** 確かめの答え: y / yes（大文字小文字は問わない。前後の空白は落とす） */
export function isYes(answer: string): boolean {
  return /^(y|yes)$/i.test(answer.trim());
}

/**
 * 公開の手順を走らせる前に聞く手順（index → 先に確かめる手順の index。聞かないなら null）。手元の手順（タグ）の直後に
 * 外に出す手順（push）があれば、手元の手順の前にそちらを聞く（「いいえ」で何も残さない）。聞いた手順は二度聞かない
 */
export function askOrder(steps: readonly Pick<PublishStep, "remote">[]): (number | null)[] {
  const asked = new Set<number>();
  return steps.map((s, i) => {
    if (!s.remote) {
      const next = steps[i + 1];
      if (next?.remote) {
        asked.add(i + 1);
        return i + 1;
      }
      return null;
    }
    if (asked.has(i)) return null;
    return i;
  });
}

/** dist/release/v<version>/ に置くファイル（Releases に添付する 4 つと cask・リリースノート） */
export function releaseFiles(version: string) {
  const zip = releaseZipName(version);
  return {
    zip,
    /** zip の複製（版の付かない名前。サイトの Download ボタンの先） */
    latestZip: LATEST_ZIP_NAME,
    latest: "latest.json",
    sha256: `${zip}.sha256`,
    cask: `${CASK_TOKEN}.rb`,
    notes: "notes.md",
  } as const;
}

/** shasum -a 256 の形（`<hex>  <name>`。名前ごとに 1 行。同じ中身の複製は同じハッシュの行を並べる） */
export function sha256Line(sha: string, ...names: string[]): string {
  return names.map((n) => `${sha}  ${n}\n`).join("");
}

export interface PublishStep {
  /** 何をするか（印字用） */
  title: string;
  cmd: string[];
  /** 外に出す操作（push・Releases の作成）。--publish でも --yes か確認が要る */
  remote: boolean;
  cwd?: string;
}

/**
 * 公開のコマンド列（実行はしない。--publish のときだけ release.ts が順に実行する）。
 * タグ → push → Releases（4 つを添付）→ tap の push。cask は Releases の zip を指すので最後
 */
export function publishSteps(o: {
  version: string;
  dir: string;
  tapDir: string | null;
  tapCommitted: boolean;
  /** the commit to tag (the build commit). Omitted: HEAD */
  commit?: string;
  /** the tag already exists locally on the commit (not pushed): no `git tag` step */
  skipTag?: boolean;
}): PublishStep[] {
  const f = releaseFiles(o.version);
  const tag = `v${o.version}`;
  const at = (n: string) => `${o.dir}/${n}`;
  const steps: PublishStep[] = [
    {
      title: `tag ${tag}`,
      cmd: [
        "git",
        "tag",
        "-a",
        tag,
        "-m",
        `Turnlane ${o.version}`,
        ...(o.commit ? [o.commit] : []),
      ],
      remote: false,
    },
    {
      title: `push main and ${tag}`,
      cmd: ["git", "push", "origin", "main", tag],
      remote: true,
    },
    {
      title: `create the GitHub release ${tag}`,
      cmd: [
        "gh",
        "release",
        "create",
        tag,
        at(f.zip),
        at(f.latestZip),
        at(f.latest),
        at(f.sha256),
        "--verify-tag",
        "--title",
        `Turnlane ${o.version}`,
        "--notes-file",
        at(f.notes),
        ...(o.version.includes("-") ? ["--prerelease"] : []),
      ],
      remote: true,
    },
  ];
  if (o.skipTag) steps.shift();
  if (o.tapDir && o.tapCommitted)
    steps.push({
      title: "push the tap",
      cmd: ["git", "-C", o.tapDir, "push", "origin", "HEAD"],
      remote: true,
    });
  return steps;
}

/** --tap-dir の既定: 本体のリポジトリの隣の tap の clone（`<リポジトリ>/../<TAP_REPO>`） */
export function defaultTapDir(repoRoot: string): string {
  return resolve(repoRoot, "..", TAP_REPO);
}

/** tap の README（tap に無いときだけ置く） */
export function tapReadme(): string {
  return `# Turnlane Homebrew tap\n\nThe Homebrew tap for [Turnlane](${RELEASE_REPO_URL}).\n\n\`\`\`sh\n${HOMEBREW_INSTALL_COMMAND}\n\`\`\`\n`;
}

/**
 * cask と同じコミットで tap に足すファイル（tap に無いものだけ）。LICENSE は本体の LICENSE をそのまま写し、
 * README.md は短い案内。本体の LICENSE が読めないときは LICENSE を足さない
 */
export function tapScaffold(o: {
  hasLicense: boolean;
  hasReadme: boolean;
  license: string | null;
}): { path: string; content: string }[] {
  const out: { path: string; content: string }[] = [];
  if (!o.hasLicense && o.license) out.push({ path: "LICENSE", content: o.license });
  if (!o.hasReadme) out.push({ path: "README.md", content: tapReadme() });
  return out;
}

/** 公開の後に確かめる URL（印字用） */
export function afterPublishChecks(version: string): string[] {
  return [`${RELEASES_PAGE_URL}/tag/v${version}`, LATEST_JSON_URL];
}

const q = (a: string) => (/^[\w@%+=:,./-]+$/.test(a) ? a : `'${a.replaceAll("'", "'\\''")}'`);

/** シェルに貼れる形 */
export function shellLine(cmd: readonly string[]): string {
  return cmd.map(q).join(" ");
}
