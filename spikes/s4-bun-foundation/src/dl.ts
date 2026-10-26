// Entry for the combined `dl` binary. Subcommands are loaded with dynamic
// import so that `dl hook` does not evaluate Hono / Drizzle / MCP SDK.
const [cmd, ...rest] = process.argv.slice(2);
switch (cmd) {
  case "hook":
    await (await import("./hook")).runHook(rest);
    break;
  case "db":
    await (await import("./db")).runDbCheck(rest);
    break;
  case "db-writer":
    await (await import("./db")).runDbWriter(rest);
    break;
  case "db-reader":
    await (await import("./db")).runDbReader(rest);
    break;
  case "serve":
    (await import("./server")).runServer(rest);
    break;
  case "watch":
    await (await import("./watch")).runWatch(rest);
    break;
  case "mcp":
    await (await import("./mcp")).runMcp(rest);
    break;
  default:
    console.error("usage: dl <hook|db|db-writer|db-reader|serve|watch|mcp>");
    process.exit(2);
}
