/**
 * 開くアプリの一覧と検出（D-059。ux-mvp 4.11）。設定（open.editor / open.terminal / open.diff）のアプリが
 * 無ければ、同じ種類で次に見つかったものへフォールバックする。検出は既知の場所にある `.app` を見るだけ。
 */
import { join } from "node:path";
import { OPEN_APP_DEFAULTS, OPEN_APP_IDS } from "@turnlane/core";
import type { OpenAppKind } from "@turnlane/core/api";
import type { OpenSystem } from "./system.ts";

interface AppSpec {
  id: string;
  name: string;
  /** 探す `.app` の名前（先に見つかったもの） */
  bundles: readonly string[];
}

const CATALOG: Record<OpenAppKind, readonly AppSpec[]> = {
  editor: [
    { id: "zed", name: "Zed", bundles: ["Zed.app", "Zed Preview.app"] },
    { id: "cursor", name: "Cursor", bundles: ["Cursor.app"] },
    { id: "vscode", name: "VS Code", bundles: ["Visual Studio Code.app"] },
    { id: "sublime", name: "Sublime Text", bundles: ["Sublime Text.app"] },
  ],
  terminal: [
    { id: "ghostty", name: "Ghostty", bundles: ["Ghostty.app"] },
    { id: "warp", name: "Warp", bundles: ["Warp.app"] },
    { id: "iterm", name: "iTerm2", bundles: ["iTerm.app"] },
    { id: "terminal", name: "Terminal", bundles: ["Terminal.app"] },
    // Orca（D-122）: 端末は同梱の CLI（orca terminal create）で開く。launch/terminal.ts・open/index.ts
    { id: "orca", name: "Orca", bundles: ["Orca.app"] },
  ],
  diff: [
    { id: "github_desktop", name: "GitHub Desktop", bundles: ["GitHub Desktop.app"] },
    { id: "fork", name: "Fork", bundles: ["Fork.app"] },
    { id: "tower", name: "Tower", bundles: ["Tower.app"] },
  ],
};

export interface FoundApp {
  id: string;
  name: string;
  path: string;
}

/** 設定の値（id）の表示名。入っていなくても名前は分かる（B-5 の「{app} を開けなかった」） */
export function appName(kind: OpenAppKind, id: string): string | null {
  return CATALOG[kind].find((s) => s.id === id)?.name ?? null;
}

export function appDirs(home: string): string[] {
  return [
    "/Applications",
    join(home, "Applications"),
    "/Applications/Utilities",
    "/System/Applications",
    "/System/Applications/Utilities",
  ];
}

const CACHE_MS = 60_000;

export class AppFinder {
  #cache = new Map<string, { at: number; path: string | null }>();

  constructor(
    private readonly sys: OpenSystem,
    private readonly home: string,
    private readonly now: () => number = Date.now,
  ) {}

  #locate(spec: AppSpec): string | null {
    const hit = this.#cache.get(spec.id);
    const t = this.now();
    if (hit && t - hit.at < CACHE_MS) return hit.path;
    let path: string | null = null;
    outer: for (const dir of appDirs(this.home)) {
      for (const b of spec.bundles) {
        const p = join(dir, b);
        if (this.sys.exists(p)) {
          path = p;
          break outer;
        }
      }
    }
    this.#cache.set(spec.id, { at: t, path });
    return path;
  }

  installed(kind: OpenAppKind): FoundApp[] {
    const out: FoundApp[] = [];
    for (const s of CATALOG[kind]) {
      const path = this.#locate(s);
      if (path) out.push({ id: s.id, name: s.name, path });
    }
    return out;
  }

  /** 設定のアプリ。無ければ同じ種類で次に見つかったもの。どれも無ければ null */
  resolve(kind: OpenAppKind, selected: string | null | undefined): FoundApp | null {
    const list = this.installed(kind);
    return list.find((a) => a.id === selected) ?? list[0] ?? null;
  }
}

/**
 * Codex のアプリ（D-135）。`Codex.app` か、bundle ID が com.openai.codex の `.app`（今の版は `ChatGPT.app` の名前で入る）。
 * 見つけた場所を CACHE_MS だけ覚える
 */
export const CODEX_BUNDLE_ID = "com.openai.codex";
const CODEX_BUNDLES = ["Codex.app", "ChatGPT.app"] as const;

export class CodexAppFinder {
  #cache: { at: number; app: FoundApp | null } | null = null;

  constructor(
    private readonly sys: OpenSystem,
    private readonly home: string,
    private readonly now: () => number = Date.now,
  ) {}

  find(): FoundApp | null {
    const t = this.now();
    if (this.#cache && t - this.#cache.at < CACHE_MS) return this.#cache.app;
    let app: FoundApp | null = null;
    outer: for (const dir of appDirs(this.home)) {
      for (const b of CODEX_BUNDLES) {
        const p = join(dir, b);
        if (this.sys.exists(p) && this.sys.bundleId(p) === CODEX_BUNDLE_ID) {
          app = { id: "codex", name: "Codex", path: p };
          break outer;
        }
      }
    }
    this.#cache = { at: t, app };
    return app;
  }
}

/** 設定の値（不明な値は既定） */
export function selectedApp(kind: OpenAppKind, v: unknown): string {
  const ids = OPEN_APP_IDS[kind] as readonly string[];
  return typeof v === "string" && ids.includes(v) ? v : OPEN_APP_DEFAULTS[kind];
}
