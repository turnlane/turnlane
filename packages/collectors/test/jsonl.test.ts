import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import {
  appendFileSync,
  mkdtempSync,
  renameSync,
  rmSync,
  truncateSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readJsonlIncremental } from "../src/readers/jsonl.ts";
import type { Cursor } from "../src/types.ts";

let dir: string;
let path: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "turnlane-jsonl-"));
  path = join(dir, "a.jsonl");
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

const cur = (c: { byteOffset: number; dev: number; inode: number }): Cursor => ({
  ...c,
  parserVersion: 1,
});

describe("readJsonlIncremental（phase0-plan 3.2）", () => {
  test("完全な行だけを返し、末尾の不完全な行ではカーソルを進めない", () => {
    writeFileSync(path, '{"a":1}\n{"a":2}\n{"a":');
    const r = readJsonlIncremental(path, null, { maxBytes: 1024 });
    expect(r?.lines.map((l) => l.value)).toEqual([{ a: 1 }, { a: 2 }]);
    expect(r?.lines.map((l) => l.offset)).toEqual([0, 8]);
    expect(r?.next.byteOffset).toBe(16);
    expect(r?.done).toBe(true);
    appendFileSync(path, "3}\n");
    const r2 = readJsonlIncremental(path, cur(r?.next as never), { maxBytes: 1024 });
    expect(r2?.lines.map((l) => l.value)).toEqual([{ a: 3 }]);
    expect(r2?.reset).toBe(false);
  });

  test("壊れた行は value: undefined", () => {
    writeFileSync(path, '{"a":1}\nnot json\n\n{"b":2}\n');
    const r = readJsonlIncremental(path, null, { maxBytes: 1024 });
    expect(r?.lines.map((l) => l.value)).toEqual([{ a: 1 }, undefined, { b: 2 }]);
  });

  test("maxBytes で分けて読む。1行が maxBytes より長ければその行の終わりまで読む", () => {
    const long = JSON.stringify({ x: "y".repeat(100) });
    writeFileSync(path, `{"a":1}\n${long}\n{"a":3}\n`);
    const r1 = readJsonlIncremental(path, null, { maxBytes: 10 });
    expect(r1?.lines.map((l) => l.value)).toEqual([{ a: 1 }]);
    expect(r1?.done).toBe(false);
    const values: unknown[] = [];
    let c = cur(r1?.next as never);
    for (let i = 0; i < 10; i++) {
      const r = readJsonlIncremental(path, c, { maxBytes: 10 });
      values.push(...(r?.lines.map((l) => l.value) ?? []));
      c = cur(r?.next as never);
      if (r?.done) break;
    }
    expect(values).toEqual([JSON.parse(long), { a: 3 }]);
  });

  test("切り詰め（size < byte_offset）は先頭から読み直す", () => {
    writeFileSync(path, '{"a":1}\n{"a":2}\n');
    const r = readJsonlIncremental(path, null, { maxBytes: 1024 });
    truncateSync(path, 0);
    writeFileSync(path, '{"b":1}\n');
    const r2 = readJsonlIncremental(path, cur(r?.next as never), { maxBytes: 1024 });
    expect(r2?.reset).toBe(true);
    expect(r2?.lines.map((l) => l.value)).toEqual([{ b: 1 }]);
  });

  test("同じパスでの差し替え（inode の変化）は先頭から読み直す", () => {
    writeFileSync(path, '{"a":1}\n');
    const r = readJsonlIncremental(path, null, { maxBytes: 1024 });
    const other = join(dir, "b.jsonl");
    writeFileSync(other, '{"a":1}\n{"a":2}\n');
    renameSync(other, path);
    const r2 = readJsonlIncremental(path, cur(r?.next as never), { maxBytes: 1024 });
    expect(r2?.reset).toBe(true);
    expect(r2?.lines).toHaveLength(2);
  });

  test("ファイルが無ければ null", () => {
    expect(readJsonlIncremental(join(dir, "none.jsonl"), null, { maxBytes: 10 })).toBeNull();
  });

  test("マルチバイト文字の途中で書き込みが止まっても、改行までは読まない", () => {
    const line = JSON.stringify({ t: "日本語のテキスト" });
    const buf = Buffer.from(`${line}\n`);
    writeFileSync(path, buf.subarray(0, 12));
    const r = readJsonlIncremental(path, null, { maxBytes: 1024 });
    expect(r?.lines).toHaveLength(0);
    expect(r?.next.byteOffset).toBe(0);
    appendFileSync(path, buf.subarray(12));
    const r2 = readJsonlIncremental(path, cur(r?.next as never), { maxBytes: 1024 });
    expect(r2?.lines.map((l) => l.value)).toEqual([{ t: "日本語のテキスト" }]);
  });
});
