// S4 spike: Hono static serving (assets embedded in the binary) + WebSocket.
// Not production code.
import { Hono } from "hono";
import { upgradeWebSocket, websocket } from "hono/bun";
// Assets embedded with `with { type: "file" }`. In a compiled binary these
// resolve to /$bunfs/... paths readable via Bun.file().
import appJs from "../public/assets/app.js" with { type: "file" };
import indexHtml from "../public/index.html" with { type: "file" };

const embedded: Record<string, { path: string; type: string }> = {
  "/": { path: indexHtml, type: "text/html; charset=utf-8" },
  "/index.html": { path: indexHtml, type: "text/html; charset=utf-8" },
  "/assets/app.js": { path: appJs, type: "text/javascript; charset=utf-8" },
};

export function buildApp() {
  const app = new Hono();
  const clients = new Set<{ send: (s: string) => void }>();

  app.get("/api/health", (c) =>
    c.json({ ok: true, bun: Bun.version, embeddedFiles: Bun.embeddedFiles.length }),
  );

  app.get(
    "/ws",
    upgradeWebSocket(() => ({
      onOpen(_evt, ws) {
        clients.add(ws);
        ws.send(JSON.stringify({ type: "hello" }));
      },
      onMessage(evt, ws) {
        ws.send(JSON.stringify({ type: "echo", data: String(evt.data) }));
      },
      onClose(_evt, ws) {
        clients.delete(ws);
      },
    })),
  );

  app.post("/api/broadcast", async (c) => {
    const body = await c.req.text();
    for (const ws of clients) ws.send(JSON.stringify({ type: "invalidate", body }));
    return c.json({ sent: clients.size });
  });

  // Static from embedded files; SPA fallback to index.html.
  app.get("*", (c) => {
    const hit = embedded[c.req.path] ?? embedded["/"];
    return new Response(Bun.file(hit.path), { headers: { "content-type": hit.type } });
  });

  return app;
}

export function runServer(args: string[]) {
  const port = Number(args[0] ?? 7399);
  const app = buildApp();
  const server = Bun.serve({ hostname: "127.0.0.1", port, fetch: app.fetch, websocket });
  console.log(`listening http://127.0.0.1:${server.port}/`);
}
