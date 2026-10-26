// Same as dl.ts but with static imports (to measure the cost of evaluating
// every dependency on `dl hook`).
import { runDbCheck } from "./db";
import { runHook } from "./hook";
import { runMcp } from "./mcp";
import { runServer } from "./server";
import { runWatch } from "./watch";

const [cmd, ...rest] = process.argv.slice(2);
if (cmd === "hook") await runHook(rest);
else if (cmd === "db") await runDbCheck(rest);
else if (cmd === "serve") runServer(rest);
else if (cmd === "watch") await runWatch(rest);
else if (cmd === "mcp") await runMcp(rest);
