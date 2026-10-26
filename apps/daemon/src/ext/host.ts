/**
 * 拡張の組み込み（デーモン側。ADR 0015）: 検査 → マイグレーション → 設定のキー → ルート → start / stop。
 * 拡張の一覧はビルドのときに決まる（scripts/build.ts の .build/extensions.gen.ts。公開のビルドでは空）
 */
import type { Database } from "bun:sqlite";
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { errorFields, type MetaOnlyLogger, meta } from "@turnlane/collectors";
import {
  EXT_API_VERSION,
  EXT_CONFIG_KEY_RE,
  EXT_ID_RE,
  type ExtraConfigSchemas,
  migrateExtension,
} from "@turnlane/core";
import { Hono } from "hono";
import { z } from "zod";
import type { DaemonExtension, DaemonExtensionFactory, ExtDeps, ExtStarted } from "./types.ts";

export const extHost = { apiVersion: EXT_API_VERSION, z } as const;

export class ExtensionError extends Error {
  override name = "ExtensionError";
}

/** 拡張の作成と検査。版の合わないもの・id の重複・接頭辞の違うキーは組み込まず、ログに残す */
export function loadExtensions(
  factories: readonly DaemonExtensionFactory[],
  logger: MetaOnlyLogger,
): DaemonExtension[] {
  const out: DaemonExtension[] = [];
  for (const f of factories) {
    let ext: DaemonExtension;
    try {
      ext = f(extHost);
      checkExtension(ext);
      if (out.some((x) => x.id === ext.id)) throw new ExtensionError(`duplicate id: ${ext.id}`);
    } catch (e) {
      logger.error("ext.rejected", errorFields(e, { includeMessage: true }));
      continue;
    }
    out.push(ext);
  }
  return out;
}

/** 拡張の形の検査（失敗なら例外） */
export function checkExtension(ext: DaemonExtension): void {
  if (!EXT_ID_RE.test(ext.id)) throw new ExtensionError(`invalid extension id: ${ext.id}`);
  if (ext.apiVersion !== EXT_API_VERSION)
    throw new ExtensionError(
      `extension ${ext.id} targets api ${ext.apiVersion}, this build provides ${EXT_API_VERSION}`,
    );
  for (const k of Object.keys(ext.configSchemas ?? {}))
    if (!EXT_CONFIG_KEY_RE.test(k) || !k.startsWith(`ext.${ext.id}.`))
      throw new ExtensionError(`config key ${k} must start with ext.${ext.id}.`);
}

/** 拡張の設定のキー（本体の CONFIG_SCHEMAS に足す分） */
export function extConfigSchemas(exts: readonly DaemonExtension[]): ExtraConfigSchemas {
  const out: Record<string, z.ZodType> = {};
  for (const e of exts) Object.assign(out, e.configSchemas ?? {});
  return out;
}

/** 拡張のマイグレーション（本体のマイグレーションの後）。失敗したら例外（デーモンは起動しない） */
export function migrateExtensions(
  sqlite: Database,
  exts: readonly DaemonExtension[],
  o: { backupDir?: string; now?: () => number; logger: MetaOnlyLogger },
): void {
  for (const e of exts) {
    if (!e.migrations?.length) continue;
    const r = migrateExtension(sqlite, e.id, e.migrations, {
      ...(o.backupDir ? { backupDir: o.backupDir } : {}),
      ...(o.now ? { now: o.now } : {}),
    });
    if (r.applied.length > 0)
      o.logger.info("db.ext_migrated", {
        ext: meta(e.id),
        applied: r.applied.map((id) => meta(id)),
        backup: r.backupPath ? meta(r.backupPath) : null,
      });
  }
}

/** 拡張用のディレクトリ */
export function extDataDir(dataDir: string, id: string): string {
  const d = join(dataDir, "ext", id);
  mkdirSync(d, { recursive: true, mode: 0o700 });
  return d;
}

/** 組み込んだ拡張の実行（ルートの作成と start / stop） */
export class ExtRuntime {
  readonly #started: { id: string; s: ExtStarted }[] = [];

  constructor(
    readonly list: readonly DaemonExtension[],
    private readonly deps: (id: string) => ExtDeps,
    private readonly logger: MetaOnlyLogger,
  ) {}

  /** `/api/ext/<id>` に付けるルート（routes を持つ拡張だけ） */
  routes(): { id: string; app: Hono }[] {
    const out: { id: string; app: Hono }[] = [];
    for (const e of this.list) {
      if (!e.routes) continue;
      const app = new Hono();
      e.routes(app, this.deps(e.id));
      out.push({ id: e.id, app });
    }
    return out;
  }

  start(): void {
    for (const e of this.list) {
      if (!e.start) continue;
      try {
        const s = e.start(this.deps(e.id));
        if (s) this.#started.push({ id: e.id, s });
        this.logger.info("ext.started", { ext: meta(e.id) });
      } catch (err) {
        this.logger.error("ext.start_failed", { ext: meta(e.id), ...errorFields(err) });
      }
    }
  }

  async stop(): Promise<void> {
    for (const { id, s } of this.#started.splice(0).reverse()) {
      try {
        await s.stop();
      } catch (err) {
        this.logger.warn("ext.stop_failed", { ext: meta(id), ...errorFields(err) });
      }
    }
  }
}
