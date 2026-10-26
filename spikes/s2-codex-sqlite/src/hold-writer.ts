// Usage: bun src/hold-writer.ts <copyDbPath>
// COPIES ONLY. Simulates "Codex is running": opens the copy read-write, disables auto-checkpoint, creates a marker table
// (so the change lives only in -wal), prints "ready" and keeps the connection open until killed.
import { Database } from "bun:sqlite";

const path = process.argv[2];
if (!path || !path.includes("dayline-s2-lab")) {
  console.error("refusing: path must be inside a dayline-s2-lab scratch directory");
  process.exit(2);
}
const db = new Database(path);
db.exec("PRAGMA wal_autocheckpoint=0; CREATE TABLE IF NOT EXISTS _s2_marker(x INTEGER); INSERT INTO _s2_marker VALUES (1);");
console.log("ready");
setInterval(() => {}, 1 << 30);
process.on("SIGTERM", () => {
  db.close();
  process.exit(0);
});
