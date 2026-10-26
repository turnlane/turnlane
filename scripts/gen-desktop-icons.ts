/**
 * デスクトップアプリ（apps/desktop）のアイコンを作る。依存なしで PNG を書く（形は距離関数で描いてアンチエイリアスする）。
 *
 *   bun scripts/gen-desktop-icons.ts
 *
 * - メニューバー用（44×44 = 22pt@2x）: tray-template.png（白黒。外観に追従）、tray-needs.png（琥珀。needs_input 専用、D-037）、
 *   tray-offline.png（デーモンにつながらない。斜線）
 * - アプリ用: app-icon.png（1024×1024）。icns などは `bunx tauri icon` で作る（apps/desktop/README の手順）
 */
import { mkdirSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { deflateSync } from "node:zlib";

const OUT = resolve(import.meta.dir, "../apps/desktop/src-tauri/icons");

type Rgba = [number, number, number, number];
type Sdf = (x: number, y: number) => number;

const CRC = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();

function crc32(b: Uint8Array): number {
  let c = 0xffffffff;
  for (const x of b) c = (CRC[(c ^ x) & 0xff] as number) ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function chunk(type: string, data: Uint8Array): Uint8Array {
  const out = new Uint8Array(12 + data.length);
  const v = new DataView(out.buffer);
  v.setUint32(0, data.length);
  out.set(new TextEncoder().encode(type), 4);
  out.set(data, 8);
  v.setUint32(8 + data.length, crc32(out.subarray(4, 8 + data.length)));
  return out;
}

function png(w: number, h: number, px: (x: number, y: number) => Rgba): Uint8Array {
  const raw = new Uint8Array(h * (w * 4 + 1));
  for (let y = 0; y < h; y++) {
    const row = y * (w * 4 + 1);
    for (let x = 0; x < w; x++) raw.set(px(x + 0.5, y + 0.5), row + 1 + x * 4);
  }
  const ihdr = new Uint8Array(13);
  const v = new DataView(ihdr.buffer);
  v.setUint32(0, w);
  v.setUint32(4, h);
  ihdr.set([8, 6, 0, 0, 0], 8);
  const parts = [
    new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk("IHDR", ihdr),
    chunk("IDAT", deflateSync(raw, { level: 9 })),
    chunk("IEND", new Uint8Array()),
  ];
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let o = 0;
  for (const p of parts) {
    out.set(p, o);
    o += p.length;
  }
  return out;
}

/** 線分（端は丸い）までの距離 − 太さ */
const capsule =
  (ax: number, ay: number, bx: number, by: number, r: number): Sdf =>
  (x, y) => {
    const dx = bx - ax;
    const dy = by - ay;
    const t = Math.max(0, Math.min(1, ((x - ax) * dx + (y - ay) * dy) / (dx * dx + dy * dy)));
    return Math.hypot(x - ax - t * dx, y - ay - t * dy) - r;
  };

/** 上半分の円弧（地平線から昇る日） */
const arc =
  (cx: number, cy: number, radius: number, r: number): Sdf =>
  (x, y) => {
    if (y <= cy) return Math.abs(Math.hypot(x - cx, y - cy) - radius) - r;
    return Math.min(Math.hypot(x - cx - radius, y - cy), Math.hypot(x - cx + radius, y - cy)) - r;
  };

const union =
  (...fs: Sdf[]): Sdf =>
  (x, y) =>
    Math.min(...fs.map((f) => f(x, y)));

const cover = (d: number, aa = 1) => Math.max(0, Math.min(1, 0.5 - d / aa));

/** 1単位 = 44px のメニューバーアイコンの座標で描いた日の出の形 */
function glyph(s: number): Sdf {
  return union(
    capsule(7 * s, 29 * s, 37 * s, 29 * s, 1.9 * s),
    arc(22 * s, 29 * s, 9 * s, 1.9 * s),
  );
}

function tray(color: Rgba, offline: boolean): Uint8Array {
  const g = glyph(1);
  const slash = capsule(10, 38, 34, 8, 1.9);
  return png(44, 44, (x, y) => {
    let a = cover(g(x, y));
    if (offline) a = Math.max(a * (1 - cover(slash(x, y) - 2.2)), cover(slash(x, y)));
    return [color[0], color[1], color[2], Math.round(a * color[3])];
  });
}

function appIcon(): Uint8Array {
  const S = 1024;
  // macOS のアイコンの格子: 824×824 の角丸四角（半径 185）を中央に
  const box: Sdf = (x, y) => {
    const qx = Math.abs(x - S / 2) - (412 - 185);
    const qy = Math.abs(y - S / 2) - (412 - 185);
    return Math.hypot(Math.max(qx, 0), Math.max(qy, 0)) + Math.min(Math.max(qx, qy), 0) - 185;
  };
  const k = 15;
  const g = glyph(k);
  const ox = S / 2 - 22 * k;
  const oy = S / 2 - 24 * k;
  return png(S, S, (x, y) => {
    const b = cover(box(x, y), 1.5);
    if (b === 0) return [0, 0, 0, 0];
    const t = (y - 100) / 824;
    const bg: Rgba = [
      Math.round(30 - 12 * t),
      Math.round(32 - 12 * t),
      Math.round(38 - 12 * t),
      255,
    ];
    const a = cover(g(x - ox, y - oy), 1.5);
    const fg: Rgba = [242, 242, 244, 255];
    return [
      Math.round(bg[0] + (fg[0] - bg[0]) * a),
      Math.round(bg[1] + (fg[1] - bg[1]) * a),
      Math.round(bg[2] + (fg[2] - bg[2]) * a),
      Math.round(255 * b),
    ];
  });
}

mkdirSync(OUT, { recursive: true });
writeFileSync(join(OUT, "tray-template.png"), tray([0, 0, 0, 255], false));
writeFileSync(join(OUT, "tray-offline.png"), tray([0, 0, 0, 255], true));
writeFileSync(join(OUT, "tray-needs.png"), tray([0xf5, 0xa5, 0x24, 255], false));
writeFileSync(join(OUT, "app-icon.png"), appIcon());
console.log(`wrote icons to ${OUT}`);
