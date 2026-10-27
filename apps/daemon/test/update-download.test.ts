/**
 * 更新の取得（ADR 0008 の追記 4）: 偽の HTTP サーバ（ループバック）で取得・sha256 の照合・上限・展開の中身・取得先の制限。
 * zip は合成の .app を ditto で固めたもの
 */
import { afterAll, afterEach, beforeAll, describe, expect, test } from "bun:test";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { downloadUrlAllowed, type LatestRelease } from "@turnlane/core";
import { downloadUpdate, updatesDir } from "../src/update/downloader.ts";

const work = mkdtempSync(join(tmpdir(), "turnlane-dl-"));
afterAll(() => rmSync(work, { recursive: true, force: true }));

function sha(b: Uint8Array): string {
  return new Bun.CryptoHasher("sha256").update(b).digest("hex");
}

/** 合成の .app を作り、ditto -c -k --keepParent で固める（extra は zip の中の 2 つ目） */
function makeZip(name: string, o: { extra?: boolean } = {}): Uint8Array {
  const src = join(work, `src-${name}`);
  const app = join(src, "Turnlane.app", "Contents");
  mkdirSync(app, { recursive: true });
  writeFileSync(join(app, "Info.plist"), "<plist><dict></dict></plist>\n");
  const zip = join(work, `${name}.zip`);
  const args = o.extra
    ? (() => {
        writeFileSync(join(src, "extra.txt"), "x");
        return ["/usr/bin/ditto", "-c", "-k", src, zip];
      })()
    : ["/usr/bin/ditto", "-c", "-k", "--keepParent", join(src, "Turnlane.app"), zip];
  const p = Bun.spawnSync(args);
  if (p.exitCode !== 0) throw new Error("ditto failed");
  return new Uint8Array(readFileSync(zip));
}

let good: Uint8Array;
let twoEntries: Uint8Array;
beforeAll(() => {
  good = makeZip("good");
  twoEntries = makeZip("two", { extra: true });
});

interface Seen {
  method: string;
  path: string;
  headers: Record<string, string>;
}

function server(routes: Record<string, () => Response>) {
  const seen: Seen[] = [];
  const s = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch(req) {
      const u = new URL(req.url);
      seen.push({ method: req.method, path: u.pathname, headers: Object.fromEntries(req.headers) });
      return routes[u.pathname]?.() ?? new Response("nope", { status: 404 });
    },
  });
  const origin = `http://127.0.0.1:${s.port}`;
  return { origin, seen, stop: () => s.stop(true) };
}

let srv: ReturnType<typeof server> | null = null;
let dataDir: string;
afterEach(() => {
  srv?.stop();
  srv = null;
});

function data(): string {
  dataDir = mkdtempSync(join(work, "data-"));
  return dataDir;
}

const latest = (url: string, sum: string | null, version = "0.7.2"): LatestRelease => ({
  version,
  url,
  sha256: sum,
});

describe("取得", () => {
  test("転送を追って取得し、sha256 が合えば展開した Turnlane.app を返す。zip と他の版のフォルダは消す", async () => {
    srv = server({
      "/releases/download/v0.7.2/Turnlane-0.7.2.zip": () =>
        new Response(null, { status: 302, headers: { location: "/asset" } }),
      "/asset": () => new Response(good, { headers: { "content-length": String(good.length) } }),
    });
    const d = data();
    mkdirSync(join(updatesDir(d), "0.7.1", "app"), { recursive: true });
    const r = await downloadUpdate(
      latest(`${srv.origin}/releases/download/v0.7.2/Turnlane-0.7.2.zip`, sha(good)),
      { dataDir: d, version: "0.7.1", loopbackOrigin: srv.origin },
    );
    expect(r).toEqual({ ok: true, app: join(updatesDir(d), "0.7.2", "app", "Turnlane.app") });
    expect(
      existsSync(join(updatesDir(d), "0.7.2", "app", "Turnlane.app", "Contents", "Info.plist")),
    ).toBe(true);
    expect(readdirSync(updatesDir(d))).toEqual(["0.7.2"]);
    expect(readdirSync(join(updatesDir(d), "0.7.2"))).toEqual(["app"]);
    // GET だけ。User-Agent は turnlane/<version>。Cookie・Authorization を付けない
    expect(srv.seen.map((s) => s.method)).toEqual(["GET", "GET"]);
    for (const s of srv.seen) {
      expect(s.headers["user-agent"]).toBe("turnlane/0.7.1");
      expect(s.headers.cookie).toBeUndefined();
      expect(s.headers.authorization).toBeUndefined();
    }
  });

  test("sha256 が合わなければ入れない（フォルダを消す）", async () => {
    srv = server({ "/z.zip": () => new Response(good) });
    const d = data();
    const r = await downloadUpdate(latest(`${srv.origin}/z.zip`, "0".repeat(64)), {
      dataDir: d,
      version: "0.7.1",
      loopbackOrigin: srv.origin,
    });
    expect(r).toEqual({ ok: false, error: "sha256" });
    expect(readdirSync(updatesDir(d))).toEqual([]);
  });

  test("latest.json に sha256 が無ければ取得しない", async () => {
    srv = server({ "/z.zip": () => new Response(good) });
    const r = await downloadUpdate(latest(`${srv.origin}/z.zip`, null), {
      dataDir: data(),
      version: "0.7.1",
      loopbackOrigin: srv.origin,
    });
    expect(r).toEqual({ ok: false, error: "sha256" });
    expect(srv.seen).toHaveLength(0);
  });

  test("GitHub 以外（差し替えていないときのループバック）には接続しない", async () => {
    srv = server({ "/z.zip": () => new Response(good) });
    const r = await downloadUpdate(latest(`${srv.origin}/z.zip`, sha(good)), {
      dataDir: data(),
      version: "0.7.1",
      loopbackOrigin: null,
    });
    expect(r).toEqual({ ok: false, error: "io" });
    expect(srv.seen).toHaveLength(0);
  });

  test("転送先が認められない場所なら追わない", async () => {
    srv = server({
      "/z.zip": () =>
        new Response(null, { status: 302, headers: { location: "https://example.com/z.zip" } }),
    });
    let outside = 0;
    const r = await downloadUpdate(latest(`${srv.origin}/z.zip`, sha(good)), {
      dataDir: data(),
      version: "0.7.1",
      loopbackOrigin: srv.origin,
      fetch: (u, init) => {
        if (!u.startsWith(srv?.origin ?? "")) outside++;
        return fetch(u, init);
      },
    });
    expect(r).toEqual({ ok: false, error: "io" });
    expect(outside).toBe(0);
  });

  test("上限を超えたら途中で止め、途中のファイルを残さない（content-length が無くても）", async () => {
    srv = server({
      "/big.zip": () =>
        new Response(
          new ReadableStream({
            start(c) {
              c.enqueue(new Uint8Array(4096));
              c.enqueue(new Uint8Array(4096));
              c.close();
            },
          }),
        ),
      "/declared.zip": () =>
        new Response(good, { headers: { "content-length": String(good.length) } }),
    });
    const d = data();
    const o = { dataDir: d, version: "0.7.1", loopbackOrigin: srv.origin, maxBytes: 5000 };
    expect(await downloadUpdate(latest(`${srv.origin}/big.zip`, sha(good)), o)).toEqual({
      ok: false,
      error: "io",
    });
    expect(readdirSync(updatesDir(d))).toEqual([]);
    expect(
      await downloadUpdate(latest(`${srv.origin}/declared.zip`, sha(good)), { ...o, maxBytes: 10 }),
    ).toEqual({ ok: false, error: "io" });
  });

  test("HTTP の失敗・時間切れは io", async () => {
    srv = server({
      "/slow.zip": () =>
        new Response(
          new ReadableStream({
            async pull(c) {
              await Bun.sleep(200);
              c.enqueue(new Uint8Array(1));
            },
          }),
        ),
    });
    const o = { dataDir: data(), version: "0.7.1", loopbackOrigin: srv.origin };
    expect(await downloadUpdate(latest(`${srv.origin}/missing.zip`, sha(good)), o)).toEqual({
      ok: false,
      error: "io",
    });
    expect(
      await downloadUpdate(latest(`${srv.origin}/slow.zip`, sha(good)), { ...o, timeoutMs: 100 }),
    ).toEqual({ ok: false, error: "io" });
  });

  test("中身が Turnlane.app 1 つだけでなければ入れない", async () => {
    srv = server({ "/two.zip": () => new Response(twoEntries) });
    const d = data();
    const r = await downloadUpdate(latest(`${srv.origin}/two.zip`, sha(twoEntries)), {
      dataDir: d,
      version: "0.7.1",
      loopbackOrigin: srv.origin,
    });
    expect(r).toEqual({ ok: false, error: "io" });
    expect(readdirSync(updatesDir(d))).toEqual([]);
  });
});

describe("取得してよい URL（downloadUrlAllowed）", () => {
  const no = { redirect: false, loopbackOrigin: null };
  const redir = { redirect: true, loopbackOrigin: null };
  test.each([
    ["https://github.com/o/r/releases/download/v1/T.zip", no, true],
    ["http://github.com/o/r/T.zip", no, false],
    ["https://github.com:8443/o/r/T.zip", no, false],
    ["https://user:pw@github.com/o/r/T.zip", no, false],
    ["https://objects.githubusercontent.com/x", no, false],
    ["https://objects.githubusercontent.com/x", redir, true],
    ["https://release-assets.githubusercontent.com/x", redir, true],
    ["https://githubusercontent.com.example.com/x", redir, false],
    ["https://example.com/x", redir, false],
    ["http://127.0.0.1:9/x", no, false],
    ["http://127.0.0.1:9/x", { redirect: false, loopbackOrigin: "http://127.0.0.1:9" }, true],
    ["http://127.0.0.1:10/x", { redirect: false, loopbackOrigin: "http://127.0.0.1:9" }, false],
    ["https://example.com/x", { redirect: false, loopbackOrigin: "https://example.com" }, false],
    ["not a url", no, false],
  ] as const)("%s", (url, o, want) => {
    expect(downloadUrlAllowed(url, o)).toBe(want);
  });
});
