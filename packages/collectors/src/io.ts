/**
 * アダプタのファイル読み取りはすべてここを通す（phase0-plan 3.1.1）。
 * テストキットの withRootJail() がこのオブジェクトの関数を差し替え、検出したルートの外を読んだら失敗させる。
 * 書き込み系の関数は置かない（アダプタは読み取り専用）。
 */
import {
  closeSync,
  type Dirent,
  existsSync,
  openSync,
  readdirSync,
  readFileSync,
  readSync,
  type Stats,
  statSync,
} from "node:fs";

export interface CollectorIo {
  exists(path: string): boolean;
  stat(path: string): Stats | null;
  readdir(path: string): Dirent[];
  readText(path: string): string;
  /** position から最大 length バイトを読む */
  readRange(path: string, position: number, length: number): Buffer;
  /** pid の生存確認（kill(pid, 0)）。子プロセスは起動しない */
  pidAlive(pid: number): boolean;
}

export const defaultIo: CollectorIo = {
  exists: (p) => existsSync(p),
  stat: (p) => {
    try {
      return statSync(p);
    } catch {
      return null;
    }
  },
  readdir: (p) => {
    try {
      return readdirSync(p, { withFileTypes: true });
    } catch {
      return [];
    }
  },
  readText: (p) => readFileSync(p, "utf8"),
  readRange: (p, position, length) => {
    const fd = openSync(p, "r");
    try {
      const buf = Buffer.alloc(length);
      const n = readSync(fd, buf, 0, length, position);
      return n === length ? buf : buf.subarray(0, n);
    } finally {
      closeSync(fd);
    }
  },
  pidAlive: (pid) => {
    try {
      process.kill(pid, 0);
      return true;
    } catch (e) {
      // EPERM は存在するが権限が無い（別ユーザーのプロセス）
      return (e as { code?: string }).code === "EPERM";
    }
  },
};

/** 実際に使う io。withRootJail() だけが差し替える */
export const io: CollectorIo = { ...defaultIo };

/** 開かないファイル（ADR 0005、ai-session-ingestion 6.2）。パスの末尾の名前で判定する */
const FORBIDDEN_NAME = [
  /^auth\.json$/,
  /\.key$/,
  /^Cookies/,
  /token/i,
  /^oauth_creds\.json$/,
  /^\.audit-key$/,
  /^ant-device-registry\.json$/,
  /^bridge-state\.json$/,
];

export function isForbiddenFile(path: string): boolean {
  const name = path.slice(path.lastIndexOf("/") + 1);
  return FORBIDDEN_NAME.some((re) => re.test(name));
}

/** 再帰的にファイルを列挙する（シンボリックリンクのディレクトリは辿らない） */
export function walkFiles(dir: string, pred: (absPath: string) => boolean, out: string[] = []) {
  for (const e of io.readdir(dir)) {
    const p = `${dir}/${e.name}`;
    if (e.isDirectory()) walkFiles(p, pred, out);
    else if (e.isFile() && !isForbiddenFile(p) && pred(p)) out.push(p);
  }
  return out;
}
