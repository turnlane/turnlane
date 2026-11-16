/**
 * 図つきの問い（MCP の ask_user。ADR 0022）: 中身（GET /api/asks/:id。表示の瞬間に読み、閉じたら捨てる。キャッシュに残さない）
 * と、返す（POST /api/asks/:id/answer）。返した印（「10:25 に返しました」）は web の状態だけに持つ（DB に保存しない）
 */
import { useQuery } from "@tanstack/react-query";
import type { AskAnswerResponse, AskView } from "@turnlane/core/web";
import { useSyncExternalStore } from "react";
import { getLocale } from "../i18n/current.ts";
import { translate } from "../i18n/index.tsx";
import { ApiError, api, unwrap } from "../lib/api.ts";
import { toast } from "../lib/store.ts";
import { queryClient } from "./client.ts";
import { glanceKey } from "./glance.ts";

export const askKey = (id: string) => ["ask", id] as const;

/** 問いの中身（開いている間だけ取りに行き、閉じたら捨てる） */
export function useAsk(id: string | null) {
  return useQuery({
    queryKey: askKey(id ?? ""),
    queryFn: () => unwrap<AskView>(api.api.asks[":id"].$get({ param: { id: id ?? "" } })),
    enabled: !!id,
    staleTime: 0,
    gcTime: 0,
    retry: false,
    refetchOnWindowFocus: false,
  });
}

const sent = new Map<string, number>();
const listeners = new Set<() => void>();

/** 返した時刻（返していなければ null） */
export function useAskSent(id: string): number | null {
  return useSyncExternalStore(
    (f) => {
      listeners.add(f);
      return () => listeners.delete(f);
    },
    () => sent.get(id) ?? null,
    () => null,
  );
}

export type AskOutcome = { ok: true; at: number } | { ok: false; code: "closed" | "failed" };

const isQueue = (q: { queryKey: readonly unknown[] }) => q.queryKey[0] === "queue";

/** 案（名前）とメモを AI に返す。閉じていた問いは「もう進んでいます」 */
export async function sendAsk(
  id: string,
  workItemId: string | null,
  input: { choice?: string; note?: string },
): Promise<AskOutcome> {
  const loc = getLocale();
  try {
    const r = await unwrap<AskAnswerResponse>(
      api.api.asks[":id"].answer.$post({ param: { id }, json: input }),
    );
    sent.set(id, r.answeredAt);
    for (const f of listeners) f();
    return { ok: true, at: r.answeredAt };
  } catch (e) {
    const code = e instanceof ApiError ? e.code : "";
    if (code === "ask_closed" || code === "ask_not_found") {
      toast(translate(loc, "answer.closed"));
      return { ok: false, code: "closed" };
    }
    toast(translate(loc, "ask.failed"));
    return { ok: false, code: "failed" };
  } finally {
    void queryClient.invalidateQueries({ predicate: isQueue });
    if (workItemId) void queryClient.invalidateQueries({ queryKey: glanceKey(workItemId) });
    void queryClient.invalidateQueries({ queryKey: askKey(id) });
  }
}
