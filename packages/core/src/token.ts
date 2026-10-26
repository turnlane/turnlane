import { randomBytes, timingSafeEqual } from "node:crypto";
import { chmodSync, existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";

/**
 * 認証トークン（phase0-plan 1.4、3.4）。CLI・ヘルパ・ブラウザ認証で共用する。
 * ファイルは 600。無ければ 32 バイトの乱数（hex）で作る。
 */
export function ensureToken(path: string): string {
  if (existsSync(path)) {
    if ((statSync(path).mode & 0o077) !== 0) chmodSync(path, 0o600);
    return readToken(path);
  }
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  const token = randomBytes(32).toString("hex");
  try {
    writeFileSync(path, `${token}\n`, { mode: 0o600, flag: "wx" });
    return token;
  } catch (e) {
    // 同時に起動した別プロセスが先に作った
    if ((e as { code?: string }).code === "EEXIST") return readToken(path);
    throw e;
  }
}

export function readToken(path: string): string {
  const t = readFileSync(path, "utf8").trim();
  if (!/^[0-9a-f]{64}$/.test(t)) throw new Error("token file is malformed");
  return t;
}

/** 長さの違いも含めて一定時間で比較する */
export function tokenEquals(a: string, b: string): boolean {
  const x = Buffer.from(a);
  const y = Buffer.from(b);
  if (x.length !== y.length) {
    timingSafeEqual(x, x);
    return false;
  }
  return timingSafeEqual(x, y);
}
