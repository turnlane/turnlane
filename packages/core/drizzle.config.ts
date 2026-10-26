import { defineConfig } from "drizzle-kit";

// `bun run --cwd packages/core db:generate` でスキーマから SQL を生成する。
// 生成物は src/db/migrations/ にコミットし、migrations/index.ts の一覧に足す。
export default defineConfig({
  dialect: "sqlite",
  schema: "./src/db/schema.ts",
  out: "./src/db/migrations",
});
