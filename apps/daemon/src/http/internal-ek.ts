/**
 * カレンダーヘルパ用の WebSocket（ws://127.0.0.1:<port>/internal/ek。phase0-plan 1.3・1.5）。
 * Hono を通さず Bun.serve の fetch の手前で upgrade する（AppType に WebSocket の型を持ち込まないため）。
 * - Host は 127.0.0.1:<port> / localhost:<port> だけ（DNS rebinding 対策。/api と同じ）
 * - Authorization: Bearer <token> が必要（ヘルパは token ファイルを読む）。クッキーは受け付けない
 * - Origin が付いていたら拒否する（ブラウザのページからの接続を受けない）
 */
import { tokenEquals } from "@turnlane/core";
import { allowedHosts } from "./auth.ts";

export const EK_PATH = "/internal/ek";

/** upgrade してよければ null、だめなら返す応答 */
export function ekUpgradeCheck(req: Request, token: string, port: number): Response | null {
  const host = req.headers.get("host") ?? "";
  if (!allowedHosts(port).has(host)) return new Response("Misdirected Request", { status: 421 });
  if (req.headers.get("origin") !== null) return new Response("Forbidden", { status: 403 });
  const h = req.headers.get("authorization");
  if (!h?.startsWith("Bearer ") || !tokenEquals(h.slice(7).trim(), token)) {
    return new Response("Unauthorized", { status: 401 });
  }
  if ((req.headers.get("upgrade") ?? "").toLowerCase() !== "websocket") {
    return new Response("Upgrade Required", { status: 426 });
  }
  return null;
}
