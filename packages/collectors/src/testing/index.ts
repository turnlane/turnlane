/**
 * @turnlane/collectors/testing: アダプタ用テストキット（phase0-plan 3.1.1）。
 *
 * フィクスチャの置き場: `<fixturesDir>/<toolVersion>/<case>/` に検出ルート配下の構造をそのまま写す。
 * `<case>/case.json` に説明を書く（任意）。
 *
 * - runGoldenSuite: 各ケースを全部読んだ NormalizedEvent[] をスナップショットと比べる
 * - runIncrementalSuite: JSONL を任意のバイト位置（行の途中を含む）で分割して書き足しながら読み、
 *   一度に読んだ場合と畳み込んだ結果が一致することを確かめる。同じ範囲の二重読み、同じパスでの差し替え
 *   （inode の変化）も確かめる
 * - runSentinelSuite: 本文系のキーに番兵を埋め込んだ版を読み、出力に番兵が出ないことを確かめる
 * - withRootJail: 指定したルートの外を読んだら失敗させる
 */
import { describe, expect, test } from "bun:test";
import {
  cpSync,
  existsSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";
import { BODY_KEYS } from "../define.ts";
import { type CollectorIo, defaultIo, io } from "../io.ts";
import { nullLogger } from "../logger.ts";
import { type ReducedState, reduceEvents } from "../reduce.ts";
import type {
  Cursor,
  DetectedRoot,
  NormalizedEvent,
  ReadContext,
  SourceAdapter,
  StreamSpec,
} from "../types.ts";

export { type ReducedState, reduceEvents } from "../reduce.ts";

/** テストで使う固定の時刻（2026-10-01T00:00:00Z） */
export const FIXTURE_NOW = Date.UTC(2026, 9, 1);

export function fixtureCtx(overrides: Partial<ReadContext> = {}): ReadContext {
  return {
    now: FIXTURE_NOW,
    maxBytes: 4 * 1024 * 1024,
    privacy: { storeTitles: true },
    log: nullLogger,
    ...overrides,
  };
}

export interface FixtureCase {
  /** `<toolVersion>/<case>` */
  name: string;
  dir: string;
}

export function listFixtureCases(fixturesDir: string): FixtureCase[] {
  if (!existsSync(fixturesDir)) return [];
  const out: FixtureCase[] = [];
  for (const v of readdirSync(fixturesDir).sort()) {
    const vd = join(fixturesDir, v);
    if (!statSync(vd).isDirectory()) continue;
    for (const c of readdirSync(vd).sort()) {
      const cd = join(vd, c);
      if (statSync(cd).isDirectory()) out.push({ name: `${v}/${c}`, dir: cd });
    }
  }
  return out;
}

export function rootFor(adapter: SourceAdapter, dir: string): DetectedRoot {
  return { tool: adapter.tool, rootPath: dir, profileLabel: "fixture", evidence: [] };
}

/** 1つのストリームを最後まで読む（maxBytes ごとに続きを読む） */
export async function readStreamAll(
  adapter: SourceAdapter,
  stream: StreamSpec,
  ctx: ReadContext = fixtureCtx(),
  start: Cursor | null = null,
): Promise<{ events: NormalizedEvent[]; cursor: Cursor | null }> {
  const events: NormalizedEvent[] = [];
  let cursor = start;
  for (let i = 0; i < 100_000; i++) {
    const r = await adapter.read(stream, cursor, ctx);
    events.push(...r.events);
    cursor = r.next;
    if (r.done) break;
  }
  return { events, cursor };
}

/** ルート配下のすべてのストリームをキーの順に読む */
export async function readAll(
  adapter: SourceAdapter,
  root: DetectedRoot,
  ctx: ReadContext = fixtureCtx(),
): Promise<NormalizedEvent[]> {
  // priority は実行時の mtime で変わるので、テストではキーの順に読む（結果を時刻に依存させない）
  const streams = (await adapter.listStreams(root, {})).sort((a, b) => a.key.localeCompare(b.key));
  const out: NormalizedEvent[] = [];
  for (const s of streams) out.push(...(await readStreamAll(adapter, s, ctx)).events);
  if (adapter.probeLive) out.push(...(await adapter.probeLive(root)));
  return out;
}

/** 出力に入る絶対パスをルートからの相対にする（スナップショットを環境に依存させない） */
export function relativize<T>(value: T, root: string): T {
  return JSON.parse(JSON.stringify(value).replaceAll(root, "<root>")) as T;
}

/** 指定したルートの外を読んだら失敗させる（phase0-plan 3.1.1） */
export async function withRootJail<T>(roots: string[], fn: () => Promise<T>): Promise<T> {
  const inside = (p: string) => roots.some((r) => p === r || p.startsWith(`${r}/`));
  const guard =
    <F extends (path: string, ...rest: never[]) => unknown>(name: keyof CollectorIo, f: F) =>
    (path: string, ...rest: never[]) => {
      if (!inside(path)) throw new Error(`root jail: ${String(name)} outside the root: ${path}`);
      return f(path, ...rest);
    };
  const saved = { ...io };
  Object.assign(io, {
    exists: guard("exists", defaultIo.exists),
    stat: guard("stat", defaultIo.stat),
    readdir: guard("readdir", defaultIo.readdir),
    readText: guard("readText", defaultIo.readText),
    readRange: guard("readRange", defaultIo.readRange as (p: string, ...r: never[]) => Buffer),
  });
  try {
    return await fn();
  } finally {
    Object.assign(io, saved);
  }
}

function copyCase(dir: string): string {
  const tmp = mkdtempSync(join(tmpdir(), "turnlane-fixture-"));
  cpSync(dir, tmp, { recursive: true });
  return tmp;
}

/** 各ケースを全部読んだ NormalizedEvent[] をスナップショットと比べる */
export function runGoldenSuite(
  adapter: SourceAdapter,
  fixturesDir: string,
  opts: { ctx?: ReadContext } = {},
): void {
  describe(`${adapter.tool}: golden`, () => {
    const cases = listFixtureCases(fixturesDir);
    test("フィクスチャがある", () => expect(cases.length).toBeGreaterThan(0));
    for (const c of cases) {
      test(c.name, async () => {
        const events = await withRootJail([c.dir], () =>
          readAll(adapter, rootFor(adapter, c.dir), opts.ctx ?? fixtureCtx()),
        );
        expect(relativize(events, c.dir)).toMatchSnapshot();
      });
    }
  });
}

/** 分割位置: 行の途中を含む、ファイル全体に散らばる位置 */
function splitPoints(size: number, n: number): number[] {
  const pts = new Set<number>();
  for (let i = 1; i <= n; i++) pts.add(Math.floor((size * i) / (n + 1)) + (i % 3));
  return [...pts].filter((p) => p > 0 && p < size).sort((a, b) => a - b);
}

/** 増分読み込みの一致（phase0-plan 5.1）。JSONL のストリームごとに確かめる */
export function runIncrementalSuite(
  adapter: SourceAdapter,
  fixturesDir: string,
  opts: { splits?: number; ctx?: ReadContext } = {},
): void {
  describe(`${adapter.tool}: incremental`, () => {
    for (const c of listFixtureCases(fixturesDir)) {
      test(c.name, async () => {
        const ctx = opts.ctx ?? fixtureCtx();
        const tmp = copyCase(c.dir);
        try {
          const root = rootFor(adapter, tmp);
          const streams = (await adapter.listStreams(root, {})).filter((s) => s.kind === "jsonl");
          for (const s of streams) {
            const full = readFileSync(s.path);
            const once = reduceEvents((await readStreamAll(adapter, s, ctx)).events);

            // 分割して書き足しながら読む
            writeFileSync(s.path, "");
            let cursor: Cursor | null = null;
            const events: NormalizedEvent[] = [];
            let written = 0;
            for (const p of [...splitPoints(full.length, opts.splits ?? 7), full.length]) {
              writeFileSync(s.path, full.subarray(written, p), { flag: "a" });
              written = p;
              const r = await readStreamAll(adapter, s, ctx, cursor);
              events.push(...r.events);
              cursor = r.cursor;
              // 同じ範囲の二重読み（カーソルを進めずにもう一度）
              const again = await adapter.read(s, cursor, ctx);
              events.push(...again.events);
            }
            expect(normalizeState(reduceEvents(events), tmp, s)).toEqual(
              normalizeState(once, tmp, s),
            );

            // 同じパスでの差し替え（inode が変わる）→ 先頭から読み直して同じ結果
            rmSync(s.path);
            writeFileSync(s.path, full);
            const replaced = await readStreamAll(adapter, s, ctx, cursor);
            expect(normalizeState(reduceEvents([...events, ...replaced.events]), tmp, s)).toEqual(
              normalizeState(once, tmp, s),
            );
          }
        } finally {
          rmSync(tmp, { recursive: true, force: true });
        }
      });
    }
  });
}

function normalizeState(st: ReducedState, root: string, s: StreamSpec): unknown {
  return relativize({ stream: relative(root, s.path), ...st }, root);
}

export const SENTINEL_PREFIX = "SENTINEL_BODY_";

/** 本文系のキー（BODY_KEYS）の文字列に番兵を埋め込む。埋め込んだ数を返す */
export function injectSentinel(
  value: unknown,
  sentinel: string,
): { value: unknown; count: number } {
  let count = 0;
  const walk = (v: unknown, key: string | null): unknown => {
    if (typeof v === "string") {
      if (key !== null && (BODY_KEYS as readonly string[]).includes(key)) {
        count++;
        // 文末の記号（質問の判定に効く）を保つ
        return `${sentinel} ${v}`;
      }
      return v;
    }
    if (Array.isArray(v)) return v.map((x) => walk(x, key));
    if (v && typeof v === "object") {
      return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, walk(x, k)]));
    }
    return v;
  };
  return { value: walk(value, null), count };
}

/** 番兵テスト（phase0-plan 5.3）。フィクスチャの本文系フィールドに番兵を入れ、出力に漏れないことを確かめる */
export function runSentinelSuite(adapter: SourceAdapter, fixturesDir: string): void {
  describe(`${adapter.tool}: sentinel`, () => {
    for (const c of listFixtureCases(fixturesDir)) {
      test(c.name, async () => {
        const sentinel = `${SENTINEL_PREFIX}${crypto.randomUUID()}`;
        const tmp = copyCase(c.dir);
        try {
          const injected = sentinelizeTree(tmp, sentinel);
          expect(injected).toBeGreaterThan(0);
          const events = await readAll(adapter, rootFor(adapter, tmp));
          expect(JSON.stringify(events)).not.toContain(SENTINEL_PREFIX);
        } finally {
          rmSync(tmp, { recursive: true, force: true });
        }
      });
    }
  });
}

/** ディレクトリ配下の .jsonl / .json の本文系フィールドに番兵を入れる。埋め込んだ数を返す */
export function sentinelizeTree(dir: string, sentinel: string): number {
  let total = 0;
  const walk = (d: string) => {
    for (const e of readdirSync(d, { withFileTypes: true })) {
      const p = join(d, e.name);
      if (e.isDirectory()) walk(p);
      else if (p.endsWith(".jsonl")) {
        const lines = readFileSync(p, "utf8").split("\n");
        const out = lines.map((l) => {
          if (!l.trim()) return l;
          try {
            const r = injectSentinel(JSON.parse(l), sentinel);
            total += r.count;
            return JSON.stringify(r.value);
          } catch {
            return l;
          }
        });
        writeFileSync(p, out.join("\n"));
      } else if (p.endsWith(".json") && !p.endsWith("case.json")) {
        try {
          const r = injectSentinel(JSON.parse(readFileSync(p, "utf8")), sentinel);
          total += r.count;
          writeFileSync(p, JSON.stringify(r.value));
        } catch {}
      }
    }
  };
  walk(dir);
  return total;
}
