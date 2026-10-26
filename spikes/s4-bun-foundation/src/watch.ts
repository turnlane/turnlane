// S4 spike: tail-follow *.jsonl under a root using fs.watch(recursive) or
// @parcel/watcher. Purely event-driven (no periodic rescan) so that missed
// events show up as a line-count shortfall.
// Cursors are keyed by (dev, ino) so that a renamed file keeps its offset and a
// new file created at the old path starts from 0.
// Not production code.
import { closeSync, fstatSync, openSync, readSync, statSync, watch } from "node:fs";
import { join } from "node:path";

type Cursor = { offset: number; path: string };

export async function runWatch(args: string[]) {
  const root = args[0];
  const backend = args[1] ?? "fs"; // fs | parcel
  if (!root) throw new Error("usage: watch <root> [fs|parcel]");

  const cursors = new Map<string, Cursor>();
  let lines = 0;
  let bytes = 0;
  let rawEvents = 0;
  let reads = 0;
  const lags: number[] = []; // ms from writer timestamp to read (last line per read)
  const pending = new Set<string>();
  let scheduled = false;
  const buf = Buffer.allocUnsafe(4 * 1024 * 1024);

  function drain(path: string) {
    if (!path.endsWith(".jsonl")) return;
    let fd: number;
    try {
      fd = openSync(path, "r");
    } catch {
      return; // deleted or renamed away; the rename target gets its own event
    }
    try {
      const st = fstatSync(fd);
      const key = `${st.dev}:${st.ino}`;
      let cur = cursors.get(key);
      if (!cur) {
        cur = { offset: 0, path };
        cursors.set(key, cur);
      }
      cur.path = path;
      if (st.size < cur.offset) cur.offset = 0; // truncated
      while (cur.offset < st.size) {
        const n = readSync(fd, buf, 0, Math.min(buf.length, st.size - cur.offset), cur.offset);
        if (n <= 0) break;
        reads++;
        const last = buf.lastIndexOf(10, n - 1);
        if (last < 0) break; // only a partial line so far
        for (let i = 0; i <= last; i++) if (buf[i] === 10) lines++;
        const prev = buf.lastIndexOf(10, last - 1);
        if (last - prev < 2000) {
          try {
            const ts = JSON.parse(buf.toString("utf8", prev + 1, last)).ts;
            if (typeof ts === "number") lags.push(Date.now() - ts);
          } catch {}
        }
        cur.offset += last + 1;
        bytes += last + 1;
      }
    } finally {
      closeSync(fd);
    }
  }

  function flush() {
    scheduled = false;
    const paths = [...pending];
    pending.clear();
    for (const p of paths) drain(p);
  }

  function onPath(p: string) {
    rawEvents++;
    pending.add(p);
    if (!scheduled) {
      scheduled = true;
      setImmediate(flush);
    }
  }

  if (backend === "fs") {
    const w = watch(root, { recursive: true }, (_type, filename) => {
      if (filename) onPath(join(root, filename.toString()));
    });
    w.on("error", (e) => console.error("watch error", String(e)));
  } else {
    // @parcel/watcher's index.js picks the native module with a template-string
    // require, which `bun build --compile` cannot embed. Require the prebuilt
    // .node statically and build the public API with its wrapper instead.
    // @ts-ignore no types for wrapper
    const { createWrapper } = await import("@parcel/watcher/wrapper");
    // @ts-ignore native module
    const binding = require("@parcel/watcher-darwin-arm64/watcher.node");
    const parcel = createWrapper(binding) as typeof import("@parcel/watcher");
    await parcel.subscribe(root, (err, evts) => {
      if (err) console.error("parcel error", String(err));
      for (const e of evts) if (e.type !== "delete") onPath(e.path);
    });
  }

  // Optional: simulate a busy daemon (e.g. long DB transaction / backfill) by
  // blocking the JS thread for DL_BLOCK_MS every 300ms.
  const blockMs = Number(process.env.DL_BLOCK_MS ?? 0);
  if (blockMs > 0) {
    setInterval(() => {
      const end = Date.now() + blockMs;
      while (Date.now() < end) {}
    }, 300);
  }

  // Do not scan existing files: the bench starts from an empty root.
  statSync(root);
  console.log(JSON.stringify({ ready: true, backend }));
  setInterval(() => {
    const s = [...lags].sort((a, b) => a - b);
    const q = (p: number) => (s.length ? s[Math.min(s.length - 1, Math.floor(p * s.length))] : null);
    console.log(
      JSON.stringify({ lines, bytes, rawEvents, reads, files: cursors.size, lagP50: q(0.5), lagP95: q(0.95), lagMax: q(1) }),
    );
  }, 50);
}
