import { eq } from "drizzle-orm";
import type { Clock } from "../clock.ts";
import { newId } from "../ids.ts";
import type { DB } from "./client.ts";
import { device } from "./schema.ts";

/**
 * この端末の device 行（is_self=1）を返す。無ければ作る。
 * device_id は同期カラム・HLC の node に使う。端末名は表示用で、既定はホスト名を使わない（公開時に個人情報を残さないため）。
 */
export function ensureSelfDevice(db: DB, clock: Clock, name = "this-mac"): string {
  const existing = db.select({ id: device.id }).from(device).where(eq(device.isSelf, 1)).get();
  if (existing) return existing.id;
  const id = newId(clock);
  db.insert(device).values({ id, name, isSelf: 1, createdAt: clock.now() }).run();
  return id;
}
