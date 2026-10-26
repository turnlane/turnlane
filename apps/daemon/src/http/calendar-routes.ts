/**
 * カレンダーと設定の API（phase0-plan 3.4、M3-2・M3-6）:
 * - GET /api/calendars、PATCH /api/calendars/:id（役割 source / ignored と、Turnlane の中だけの色 colorKey。D-125）
 * - GET /api/calendar/status（ヘルパの接続・権限、祝日カレンダー、稼働日、予定の書き先）、POST /api/calendar/sync（窓の再取得）
 * - GET /api/calendar-events/:id（予定の詳細）、POST /api/calendar-events/:id/open（Calendar.app で開く。D-070）
 * - POST /api/calendar-events（calendarId で書き先を選べる）、PATCH|DELETE /api/calendar-events/:id（予定の作成・編集・削除。D-093、m2-api 24章。
 *   PATCH の ifMatch は ⌘Z の逆の書き込みの前提。D-096）
 * - GET /api/calendar/timeblock-events、POST /api/calendar/timeblock-events/cleanup（M3-3 で書いた時間ブロックの予定の
 *   件数・期間と、確認後の削除。D-093）
 * - GET /api/config、GET|PUT /api/config/:key（turnlane config。既知のキーだけ、値は zod で検証）
 */
import { zValidator } from "@hono/zod-validator";
import { CALENDAR_COLOR_KEYS } from "@turnlane/core";
import { Hono } from "hono";
import { z } from "zod";
import type { CalendarDeps } from "../calendar/index.ts";
import { OpError } from "../derive/ops.ts";

const invalid = (r: { success: boolean }, c: { json: (b: unknown, s: 400) => Response }) => {
  if (!r.success) return c.json({ error: "invalid_input" }, 400);
};

const epoch = z.number().int().min(0);
const eventCreate = z
  .object({
    title: z.string().trim().min(1).max(500),
    start: epoch,
    end: epoch,
    /** 書き先（calendar.id）。省けば Calendar.app のデフォルトカレンダー */
    calendarId: z.string().min(1).max(256).optional(),
  })
  .refine((p) => p.end > p.start);
const eventPatch = z
  .object({
    title: z.string().trim().min(1).max(500).optional(),
    start: epoch.optional(),
    end: epoch.optional(),
    calendarId: z.string().min(1).max(256).optional(),
    /** ⌘Z の逆の書き込み: 予定が今この状態のときだけ書く（違えば 409 changed。D-096） */
    ifMatch: z
      .object({
        start: epoch,
        end: epoch,
        title: z.string().max(500).nullable().optional(),
        calendarId: z.string().min(1).max(256).optional(),
      })
      .optional(),
  })
  .refine((p) => p.start === undefined || p.end === undefined || p.end > p.start);

/** 役割（source / ignored）と、Turnlane の中だけの色（D-125。パレットのキー、null でカレンダーアプリの色に戻す） */
const calendarPatch = z
  .object({
    role: z.enum(["source", "ignored"]).optional(),
    colorKey: z.enum(CALENDAR_COLOR_KEYS).nullable().optional(),
  })
  .refine((p) => p.role !== undefined || p.colorKey !== undefined);

export function createCalendarRoutes(get: () => CalendarDeps | undefined) {
  const deps = () => {
    const d = get();
    if (!d) throw new OpError(409, "calendar_unavailable");
    return d;
  };
  return new Hono()
    .onError((e, c) => {
      if (e instanceof OpError) {
        const [code, ...detail] = e.message.split(": ");
        return c.json(
          { error: code, ...(detail.length > 0 ? { detail: detail.join(": ") } : {}) },
          e.status,
        );
      }
      throw e;
    })
    .get("/calendars", (c) => c.json({ calendars: deps().calendars() }))
    .patch("/calendars/:id", zValidator("json", calendarPatch, invalid), (c) => {
      const id = c.req.param("id");
      const p = c.req.valid("json");
      let v = p.role !== undefined ? deps().setRole(id, p.role) : undefined;
      if (p.colorKey !== undefined) v = deps().setColor(id, p.colorKey);
      return c.json({ calendar: v as NonNullable<typeof v> });
    })
    .post("/calendar-events", zValidator("json", eventCreate, invalid), async (c) => {
      const p = c.req.valid("json");
      return c.json({
        event: await deps().createEvent({
          title: p.title,
          start: p.start,
          end: p.end,
          ...(p.calendarId !== undefined ? { calendarId: p.calendarId } : {}),
        }),
      });
    })
    .get("/calendar-events/:id", (c) => c.json(deps().event(c.req.param("id"))))
    .patch("/calendar-events/:id", zValidator("json", eventPatch, invalid), async (c) => {
      const p = c.req.valid("json");
      return c.json(
        await deps().updateEvent(
          c.req.param("id"),
          {
            ...(p.title !== undefined ? { title: p.title } : {}),
            ...(p.start !== undefined ? { start: p.start } : {}),
            ...(p.end !== undefined ? { end: p.end } : {}),
            ...(p.calendarId !== undefined ? { calendarId: p.calendarId } : {}),
          },
          p.ifMatch
            ? {
                start: p.ifMatch.start,
                end: p.ifMatch.end,
                ...(p.ifMatch.title !== undefined ? { title: p.ifMatch.title } : {}),
                ...(p.ifMatch.calendarId !== undefined ? { calendarId: p.ifMatch.calendarId } : {}),
              }
            : undefined,
        ),
      );
    })
    .delete("/calendar-events/:id", async (c) => {
      await deps().deleteEvent(c.req.param("id"));
      return c.json({ ok: true as const });
    })
    .post("/calendar-events/:id/open", async (c) =>
      c.json(await deps().openEvent(c.req.param("id"))),
    )
    .get("/calendar/status", (c) => c.json(deps().status()))
    .get("/calendar/timeblock-events", async (c) => c.json(await deps().timeblockEvents()))
    .post(
      "/calendar/timeblock-events/cleanup",
      zValidator("json", z.object({ expected: z.number().int().min(0) }), invalid),
      async (c) => c.json(await deps().cleanupTimeblockEvents(c.req.valid("json").expected)),
    )
    .post("/calendar/sync", async (c) => c.json(await deps().sync()))
    .get("/config", (c) => c.json({ values: deps().config.list() }))
    .get("/config/:key", (c) => {
      const key = c.req.param("key");
      return c.json({ key, value: deps().config.get(key) });
    })
    .put("/config/:key", zValidator("json", z.object({ value: z.unknown() }), invalid), (c) => {
      const key = c.req.param("key");
      return c.json({ key, value: deps().config.set(key, c.req.valid("json").value) });
    });
}
