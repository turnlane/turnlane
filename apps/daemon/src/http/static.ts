/**
 * Web UI の静的ファイル（M0-9）。単一バイナリでは Vite の dist/ をビルド時に埋め込み、
 * パス → { ファイル, MIME } の表をここへ渡す。開発中はディスク上の dist/ を読む。
 */
export interface StaticAsset {
  /** Bun.file() で読めるパス（埋め込みなら /$bunfs/...） */
  file: string;
  type: string;
}

/** URL パス（先頭 /）→ 静的ファイル。'/index.html' が SPA のフォールバック */
export type StaticAssets = Readonly<Record<string, StaticAsset>>;

const MIME: Record<string, string> = {
  html: "text/html; charset=utf-8",
  js: "text/javascript; charset=utf-8",
  mjs: "text/javascript; charset=utf-8",
  css: "text/css; charset=utf-8",
  json: "application/json; charset=utf-8",
  map: "application/json; charset=utf-8",
  svg: "image/svg+xml",
  png: "image/png",
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  gif: "image/gif",
  webp: "image/webp",
  ico: "image/x-icon",
  woff: "font/woff",
  woff2: "font/woff2",
  txt: "text/plain; charset=utf-8",
  webmanifest: "application/manifest+json",
};

export function mimeFor(path: string): string {
  const ext = path.slice(path.lastIndexOf(".") + 1).toLowerCase();
  return MIME[ext] ?? "application/octet-stream";
}

/** ディスク上のディレクトリ（開発時の apps/web/dist）から表を作る */
export async function assetsFromDir(dir: string): Promise<StaticAssets> {
  const out: Record<string, StaticAsset> = {};
  const glob = new Bun.Glob("**/*");
  for await (const rel of glob.scan({ cwd: dir, onlyFiles: true })) {
    out[`/${rel}`] = { file: `${dir}/${rel}`, type: mimeFor(rel) };
  }
  return out;
}

/** UI が無いとき（web 未ビルドの開発時）の最小の画面 */
export const PLACEHOLDER_HTML = `<!doctype html>
<html lang="ja"><head><meta charset="utf-8"><title>turnlane</title></head>
<body><h1>turnlane</h1><p>Web UI はビルドされていません。<code>bun run build:web</code> を実行してください。</p>
<p><a href="/api/health">/api/health</a></p></body></html>`;
