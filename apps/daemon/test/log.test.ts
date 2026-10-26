import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { meta } from "@turnlane/collectors";
import { FileLogger } from "../src/log.ts";

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "turnlane-log-"));
});
afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe("FileLogger", () => {
  test("JSON Lines で書く。値はメタデータだけ", () => {
    const log = new FileLogger({ path: join(dir, "d.log"), now: () => 0 });
    log.info("daemon.started", { port: 7317, ok: true, path: meta("/x"), n: null });
    const line = JSON.parse(readFileSync(join(dir, "d.log"), "utf8").trim());
    expect(line).toEqual({
      t: "1970-01-01T00:00:00.000Z",
      level: "info",
      event: "daemon.started",
      port: 7317,
      ok: true,
      path: "/x",
      n: null,
    });
  });

  test("meta() を通していない文字列は型エラー（本文を書けない）", () => {
    const log = new FileLogger({ path: join(dir, "d.log") });
    // @ts-expect-error 素の string はログに渡せない
    log.info("x", { body: "会話の本文" });
    expect(true).toBe(true);
  });

  test("meta() は長い文字列を切り詰め、イベント名の書式違反は置き換える", () => {
    const log = new FileLogger({ path: join(dir, "d.log") });
    log.warn("Bad Event Name!", { v: meta("x".repeat(1000)) });
    const line = JSON.parse(readFileSync(join(dir, "d.log"), "utf8").trim());
    expect(line.event).toBe("invalid_event_name");
    expect(line.v.length).toBe(201);
  });

  test("minLevel より低いレベルは書かない", () => {
    const log = new FileLogger({ path: join(dir, "d.log") });
    log.debug("x");
    expect(existsSync(join(dir, "d.log"))).toBe(false);
  });

  test("上限を超えたら回転し、世代数を超えた古いものを消す", () => {
    const path = join(dir, "d.log");
    const log = new FileLogger({ path, maxBytes: 200, generations: 3 });
    for (let i = 0; i < 20; i++) log.info("tick", { i });
    expect(existsSync(path)).toBe(true);
    expect(existsSync(`${path}.1`)).toBe(true);
    expect(existsSync(`${path}.2`)).toBe(true);
    expect(existsSync(`${path}.3`)).toBe(false);
    const last = readFileSync(path, "utf8").trim().split("\n").pop() ?? "";
    expect(JSON.parse(last).i).toBe(19);
  });
});
