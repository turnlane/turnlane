// Shared helpers for spike S2. Prints only labels, sizes, times and error codes — never paths of real data or row values.
import { Database } from "bun:sqlite";
import { createHash } from "node:crypto";
import { readFileSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

export const CODEX_HOME = process.env.CODEX_HOME ?? join(homedir(), ".codex");
export const TARGETS = ["state_5", "thread_history_1", "goals_1"] as const;
export const SIDECARS = ["", "-wal", "-shm", "-journal"] as const;

export type Method = "readonly" | "uri_ro" | "uri_ro_immutable" | "uri_ro_readonly_shm";
export const METHODS: Method[] = ["readonly", "uri_ro", "uri_ro_immutable", "uri_ro_readonly_shm"];

export function openWith(path: string, m: Method): Database {
  switch (m) {
    case "readonly":
      return new Database(path, { readonly: true });
    case "uri_ro":
      return new Database(`file:${path}?mode=ro`, { readonly: true });
    case "uri_ro_immutable":
      return new Database(`file:${path}?mode=ro&immutable=1`, { readonly: true });
    case "uri_ro_readonly_shm":
      return new Database(`file:${path}?mode=ro&readonly_shm=1`, { readonly: true });
  }
}

/** Open and run a schema-only query. Returns the number of tables, never row contents. */
export function probe(path: string, m: Method): { ok: boolean; tables?: number; err?: string } {
  let db: Database | undefined;
  try {
    db = openWith(path, m);
    const r = db.query("select count(*) as n from sqlite_master where type='table'").get() as { n: number };
    return { ok: true, tables: r.n };
  } catch (e) {
    return { ok: false, err: sanitize(String((e as Error).message ?? e)) };
  } finally {
    try {
      db?.close();
    } catch {}
  }
}

export type FileState = { exists: boolean; size?: number; mtimeMs?: number; ino?: number; sha?: string };

export function fileState(p: string, hash = false): FileState {
  let s: ReturnType<typeof statSync>;
  try {
    s = statSync(p);
  } catch {
    return { exists: false }; // also covers the file disappearing between checks (the writer removes -wal/-shm on close)
  }
  const out: FileState = { exists: true, size: s.size, mtimeMs: s.mtimeMs, ino: s.ino };
  if (hash) out.sha = createHash("sha256").update(readFileSync(p)).digest("hex").slice(0, 16);
  return out;
}

export function snapshot(base: string, hash = false): Record<string, FileState> {
  const o: Record<string, FileState> = {};
  for (const s of SIDECARS) o[s || "main"] = fileState(base + s, hash);
  return o;
}

export function diff(a: Record<string, FileState>, b: Record<string, FileState>): string[] {
  const out: string[] = [];
  for (const k of Object.keys(a)) {
    const x = a[k]!;
    const y = b[k]!;
    if (x.exists !== y.exists) out.push(`${k}:${x.exists ? "removed" : "created"}`);
    else if (x.exists) {
      if (x.size !== y.size) out.push(`${k}:size`);
      if (x.mtimeMs !== y.mtimeMs) out.push(`${k}:mtime`);
      if (x.ino !== y.ino) out.push(`${k}:ino`);
      if (x.sha && y.sha && x.sha !== y.sha) out.push(`${k}:content`);
    }
  }
  return out;
}

export function sanitize(s: string): string {
  return s.split(homedir()).join("~").replace(/\/(private\/)?(tmp|var\/folders)\/[^\s'"]*/g, "<tmp>");
}
