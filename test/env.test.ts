import { expect, test } from "bun:test";

test("preload がタイムゾーンを Asia/Tokyo に固定する", () => {
  expect(process.env.TZ).toBe("Asia/Tokyo");
  // 2026-01-01T00:00:00Z は東京で 09:00
  expect(new Date(Date.UTC(2026, 0, 1)).getHours()).toBe(9);
});
