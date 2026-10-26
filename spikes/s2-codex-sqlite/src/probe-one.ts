// Usage: bun src/probe-one.ts <dbPath> <method>
// Opens the DB with one method, counts tables in sqlite_master, prints JSON. Used as a child process so that it can run under sandbox-exec.
import { type Method, probe } from "./common";

const [path, method] = process.argv.slice(2);
if (!path || !method) {
  console.error("usage: probe-one <dbPath> <method>");
  process.exit(2);
}
console.log(JSON.stringify(probe(path, method as Method)));
