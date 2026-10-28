/**
 * 最後の返答（GET /api/work-items/:id/last-reply。ADR 0019 の Decision 10）: AI の詳細パネルを開いている間だけ取りに行き、
 * 閉じたら捨てる（キャッシュに残さない。gcTime 0）。一覧（/api/queue）・SSE には入っていない。
 * version は項目の状態・最後の活動が変わったら読み直すための鍵（動作中は、その時点での最新の発言を出す）
 */
import { useQuery } from "@tanstack/react-query";
import type { LastReplyResponse } from "@turnlane/core/web";
import { api, unwrap } from "../lib/api.ts";

export const lastReplyKey = (workItemId: string) => ["last-reply", workItemId] as const;

export function useLastReply(workItemId: string, version: string, enabled = true) {
  return useQuery({
    queryKey: [...lastReplyKey(workItemId), version],
    queryFn: () =>
      unwrap<LastReplyResponse>(
        api.api["work-items"][":id"]["last-reply"].$get({ param: { id: workItemId } }),
      ),
    enabled,
    staleTime: 0,
    gcTime: 0,
    retry: false,
    refetchOnWindowFocus: false,
    placeholderData: (prev) => prev,
  });
}
