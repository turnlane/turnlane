import type { AppType } from "@turnlane/daemon";
import { hc } from "hono/client";

// 同じオリジンのデーモンへ、クッキー認証で型付きクライアントを作る（phase0-plan 3.4）
export const api = hc<AppType>("/", { init: { credentials: "same-origin" } });

/** API のエラー（サーバーはメッセージ文を作らず、コードだけを返す。m2-api.md 6.2） */
export class ApiError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
  ) {
    super(code);
  }
}

/** hc の応答を JSON にする（失敗は ApiError） */
interface ResLike {
  ok: boolean;
  status: number;
  json(): Promise<unknown>;
}

export async function unwrap<T>(p: Promise<ResLike> | ResLike): Promise<T> {
  const res = await p;
  if (!res.ok) {
    let code = `http_${res.status}`;
    try {
      const b = (await res.json()) as { error?: unknown };
      if (typeof b.error === "string") code = b.error;
    } catch {}
    throw new ApiError(res.status, code);
  }
  return (await res.json()) as T;
}
