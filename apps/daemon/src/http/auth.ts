import { tokenEquals } from "@turnlane/core";
import type { Context, MiddlewareHandler } from "hono";
import { getCookie, setCookie } from "hono/cookie";

/**
 * localhost API の防御（phase0-plan 3.4、ADR 0001）。
 * - Host が 127.0.0.1:<port> / localhost:<port> 以外は 421（DNS rebinding 対策）
 * - /api は Bearer トークンかクッキーが必要
 * - 状態を変えるリクエストは、Origin があれば自分自身であること。クッキー認証なら Origin 必須
 * - ブラウザは GET /auth?t=<token> でクッキーを受け取る（turnlane open が開く）
 */

export const COOKIE_NAME = "turnlane_session";
const SAFE_METHODS = new Set(["GET", "HEAD", "OPTIONS"]);

export function allowedHosts(port: number): Set<string> {
  return new Set([`127.0.0.1:${port}`, `localhost:${port}`]);
}

export function allowedOrigins(port: number): Set<string> {
  return new Set([`http://127.0.0.1:${port}`, `http://localhost:${port}`]);
}

/** クッキーにはトークンそのものではなく派生値を入れる（クッキーが漏れても CLI 用のトークンにならない） */
export function cookieValue(token: string): string {
  return new Bun.CryptoHasher("sha256").update(`turnlane-cookie:${token}`).digest("hex");
}

export function hostGuard(port: number): MiddlewareHandler {
  const hosts = allowedHosts(port);
  return async (c, next) => {
    const host = c.req.header("host") ?? "";
    if (!hosts.has(host)) return c.text("Misdirected Request", 421);
    await next();
  };
}

type AuthKind = "bearer" | "cookie" | null;

export function authenticate(c: Context, token: string): AuthKind {
  const h = c.req.header("authorization");
  if (h?.startsWith("Bearer ") && tokenEquals(h.slice(7).trim(), token)) return "bearer";
  const ck = getCookie(c, COOKIE_NAME);
  if (ck && tokenEquals(ck, cookieValue(token))) return "cookie";
  return null;
}

export function apiAuth(token: string, port: number): MiddlewareHandler {
  const origins = allowedOrigins(port);
  return async (c, next) => {
    const kind = authenticate(c, token);
    if (!kind) return c.json({ error: "unauthorized" }, 401);
    if (!SAFE_METHODS.has(c.req.method)) {
      const origin = c.req.header("origin");
      if (origin !== undefined && !origins.has(origin)) {
        return c.json({ error: "forbidden_origin" }, 403);
      }
      if (kind === "cookie" && origin === undefined) {
        return c.json({ error: "origin_required" }, 403);
      }
    }
    await next();
  };
}

/** next= はアプリ内の相対パスだけを許す（オープンリダイレクト対策） */
export function safeNext(next: string | undefined): string {
  if (!next?.startsWith("/") || next.startsWith("//") || next.includes("\\")) return "/";
  return next;
}

export function issueCookie(c: Context, token: string): void {
  setCookie(c, COOKIE_NAME, cookieValue(token), {
    httpOnly: true,
    sameSite: "Strict",
    path: "/",
    // 有効期限は付けない（ブラウザを閉じるまで）。turnlane open でいつでも取り直せる
  });
}
