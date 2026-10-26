// migrate.compile.test.ts が `bun build --compile` するエントリ。
// SQL をバイナリに埋め込み、引数の DB に適用して結果を JSON で出す。
import { migrate } from "../../../src/db/migrate.ts";
import { openDatabase } from "../../../src/db/open.ts";
import sql0000 from "./0000_test.sql" with { type: "text" };

const [dbPath, backupDir] = process.argv.slice(2);
if (!dbPath || !backupDir) throw new Error("usage: migrate-bin <db> <backupDir>");
const db = openDatabase(dbPath);
const r = migrate(db, [{ id: "0000_test", sql: sql0000 }], { backupDir });
console.log(JSON.stringify(r));
db.close();
