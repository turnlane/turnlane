import { afterAll, beforeAll, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { generateWebAssetsModule } from "../scripts/gen-web-assets.ts";

// M0-9: dist/ の一覧から生成した import でバイナリに埋め込み、元の dist/ を消しても配信できる。
// Vite の出力の代わりに、同じ形（index.html と assets/）の偽の dist を使う。

const ROOT = resolve(import.meta.dir, "..");
let dir: string;
let bin: string;
let proc: ReturnType<typeof Bun.spawn> | null = null;
let port = 0;

beforeAll(async () => {
  dir = mkdtempSync(join(tmpdir(), "turnlane-embed-"));
  const dist = join(dir, "dist");
  mkdirSync(join(dist, "assets"), { recursive: true });
  writeFileSync(join(dist, "index.html"), "<!doctype html><title>embedded-index</title>");
  writeFileSync(join(dist, "assets", "app-abc123.js"), "console.log('embedded-js');");
  writeFileSync(join(dist, "assets", "style.css"), "body{}");
  const gen = join(dir, "build", "web-assets.gen.ts");
  await generateWebAssetsModule(dist, gen);
  const entry = join(dir, "build", "entry.ts");
  const app = join(ROOT, "apps/daemon/src/http/app.ts");
  const sse = join(ROOT, "apps/daemon/src/http/sse.ts");
  writeFileSync(
    entry,
    [
      `import { createApp } from ${JSON.stringify(app)};`,
      `import { SseHub } from ${JSON.stringify(sse)};`,
      'import { webAssets } from "./web-assets.gen.ts";',
      "const server = Bun.serve({ hostname: '127.0.0.1', port: 0, fetch: () => new Response() });",
      "const port = server.port;",
      "const health = () => ({}) as never;",
      "server.reload({ fetch: createApp({ token: 'x'.repeat(64), port, hub: new SseHub(), health, admin: { backup: () => ({ date: '', path: '' }) }, assets: webAssets }).fetch });",
      "console.log(JSON.stringify({ port, embedded: Bun.embeddedFiles.length }));",
    ].join("\n"),
  );
  bin = join(dir, "embed-bin");
  const b = Bun.spawnSync(
    [
      process.execPath,
      "build",
      "--compile",
      "--minify",
      "--bytecode",
      "--format=esm",
      entry,
      "--outfile",
      bin,
    ],
    { stdout: "pipe", stderr: "pipe" },
  );
  if (b.exitCode !== 0) throw new Error(b.stderr.toString());
  // 元の dist/ と生成物を消してから起動する
  rmSync(dist, { recursive: true, force: true });
  rmSync(join(dir, "build"), { recursive: true, force: true });
  proc = Bun.spawn([bin], { cwd: tmpdir(), stdout: "pipe", stderr: "pipe" });
  const reader = (proc.stdout as ReadableStream<Uint8Array>).getReader();
  const { value } = await reader.read();
  const info = JSON.parse(new TextDecoder().decode(value)) as { port: number; embedded: number };
  port = info.port;
  expect(info.embedded).toBe(3);
}, 60_000);

afterAll(() => {
  proc?.kill();
  rmSync(dir, { recursive: true, force: true });
});

const get = (path: string) =>
  fetch(`http://127.0.0.1:${port}${path}`, { headers: { host: `127.0.0.1:${port}` } });

test("dist/ を消しても index.html と assets を配信する", async () => {
  const index = await get("/");
  expect(index.headers.get("content-type")).toBe("text/html; charset=utf-8");
  expect(await index.text()).toContain("embedded-index");
  const js = await get("/assets/app-abc123.js");
  expect(js.headers.get("content-type")).toBe("text/javascript; charset=utf-8");
  expect(await js.text()).toContain("embedded-js");
  expect((await get("/assets/style.css")).headers.get("content-type")).toBe(
    "text/css; charset=utf-8",
  );
});

test("クライアントルートは index.html にフォールバック、存在しない assets は 404", async () => {
  expect(await (await get("/board/2026-10-02")).text()).toContain("embedded-index");
  expect((await get("/assets/missing.js")).status).toBe(404);
});
