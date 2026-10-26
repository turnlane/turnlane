// Entry for the minimal hook-only binary.
import { runHook } from "./hook";

await runHook(process.argv.slice(2));
