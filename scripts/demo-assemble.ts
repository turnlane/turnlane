/**
 * デモ動画（M6-30）の組み立て（docs/dev/demo-video.md、絵コンテ §1.3・§1.5・§6.4）。
 *
 *   bun scripts/demo-assemble.ts --lang ja|en [--rec <dir>] [--captures <dir>] [--out <dir>] [--gif]
 *
 * 入力
 * - --rec（既定 out/demo/rec/<lang>）: scripts/demo-record.ts の frames/ と timeline.json（場面 (1)(2)。2880×1800）
 * - --captures（既定 out/demo/captures/<lang>）: オーナーが実機で撮った素材と edit.json（無ければ場面 (1)(2) だけ）
 *     {
 *       "scene3": { "file": "scene3.mov", "stage": [x, y, w, h], "t0": 秒 },
 *       "banner": { "file": "banner.mov", "crop": [x, y, w, h], "t0": 秒 }
 *     }
 *   scene3.stage は録画の中の Turnlane のウインドウの中身（舞台 1440×900 pt。Retina なら 2880×1800 px）の画素の範囲、
 *   t0 は動画の 17.5 秒にあたる録画の秒。banner.crop は録画の中の通知のバナーの範囲、t0 はバナーが入り始める秒
 *   （動画の 7.6 秒に重ねる。5 秒）。どちらも素材を見て決める（docs/dev/demo-video.md の 5 章）
 *
 * 出力（既定 out/demo/build/<lang>）: master.mov（2880×2000、作業用）、demo-<lang>.mp4（1440×1000、H.264、yuv420p、
 * 音声なし、faststart）、--gif で demo-<lang>.gif（960 幅・12fps・128 色。16MB を超えたら 10fps → 800 幅に下げる）、
 * 代表フレーム frame-*.png（1440×1000）。字幕は Playwright で HTML から PNG にする（Noto Sans JP / Inter、500、28px/1440）。
 */
import { existsSync, mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { chromium } from "playwright";
import {
  BANNER,
  CUTS_3,
  CUTS_12,
  type Cut,
  cropOf,
  FREEZE_AT,
  FULL_END,
  type Lang,
  SCENE12_END,
  subtitlesWithin,
} from "./demo/plan.ts";

const ROOT = resolve(import.meta.dir, "..");
const FFMPEG = existsSync("/opt/homebrew/bin/ffmpeg") ? "/opt/homebrew/bin/ffmpeg" : "ffmpeg";
const args = process.argv.slice(2);
const opt = (k: string) => {
  const i = args.indexOf(k);
  return i >= 0 ? args[i + 1] : undefined;
};
const lang = opt("--lang") as Lang;
if (lang !== "ja" && lang !== "en") throw new Error("--lang ja|en");
const rec = resolve(opt("--rec") ?? join(ROOT, "out/demo/rec", lang));
const captures = resolve(opt("--captures") ?? join(ROOT, "out/demo/captures", lang));
const out = resolve(opt("--out") ?? join(ROOT, "out/demo/build", lang));
const wantGif = args.includes("--gif");
mkdirSync(out, { recursive: true });
const work = join(out, "work");
rmSync(work, { recursive: true, force: true });
mkdirSync(work, { recursive: true });

/** 舞台（2 倍）と字幕の帯 */
const W = 2880;
const H = 1800;
const BAND = 200;
const FPS = 30;

interface Edit {
  scene3?: { file: string; stage: [number, number, number, number]; t0: number };
  banner?: { file: string; crop: [number, number, number, number]; t0: number };
}
const editPath = join(captures, "edit.json");
const edit: Edit = existsSync(editPath) ? JSON.parse(readFileSync(editPath, "utf8")) : {};
const hasScene3 = !!edit.scene3;
const END = hasScene3 ? FULL_END : SCENE12_END;

function ff(argv: string[]) {
  const p = Bun.spawnSync([FFMPEG, "-hide_banner", "-loglevel", "error", "-y", ...argv], {
    stdout: "inherit",
    stderr: "inherit",
  });
  if (p.exitCode !== 0) throw new Error(`ffmpeg failed: ${argv.join(" ").slice(0, 300)}`);
}

// ---------- 1. 場面 (1)(2): フレームを時刻どおりに並べる（ffconcat） ----------
const timeline = JSON.parse(readFileSync(join(rec, "timeline.json"), "utf8")) as {
  frames: { file: string; t: number }[];
};
{
  const fr = timeline.frames;
  const lines = ["ffconcat version 1.0"];
  for (const [i, f] of fr.entries()) {
    const start = Math.max(0, f.t);
    const next = fr[i + 1];
    const end = next ? Math.max(0, next.t) : SCENE12_END + 0.5;
    if (end <= start) continue;
    lines.push(`file '${join(rec, f.file)}'`, `duration ${(end - start).toFixed(4)}`);
  }
  // concat の demuxer は最後の duration を使わないので、最後のフレームをもう一度置く
  const last = fr.at(-1);
  if (last) lines.push(`file '${join(rec, last.file)}'`);
  writeFileSync(join(work, "scene12.ffconcat"), `${lines.join("\n")}\n`);
}

// ---------- 2. 字幕の帯（HTML → PNG） ----------
const subs = subtitlesWithin(END);
{
  const font = (pkg: string) =>
    `file://${join(ROOT, "apps/web/node_modules/@fontsource", pkg, "500.css")}`;
  const family = lang === "ja" ? "'Noto Sans JP'" : "'Inter'";
  const page = (body: string, bg: boolean) => `<!doctype html><html><head><meta charset="utf-8">
<link rel="stylesheet" href="${font("inter")}"><link rel="stylesheet" href="${font("noto-sans-jp")}">
<style>
html,body{margin:0;width:${W}px;height:${BAND}px;background:${bg ? "#0E0F11" : "transparent"};overflow:hidden}
body{box-sizing:border-box;${bg ? "border-top:2px solid #26282C;" : ""}display:flex;align-items:center;justify-content:center}
p{margin:0;font-family:${family},sans-serif;font-weight:500;font-size:56px;line-height:1.3;color:#E8E9EB;text-align:center;white-space:pre-line;
font-feature-settings:'palt' ${lang === "ja" ? 1 : 0};padding:0 120px}
</style></head><body>${body}</body></html>`;
  const browser = await chromium.launch();
  try {
    const p = await browser.newPage({ viewport: { width: W, height: BAND } });
    const shot = async (html: string, file: string, bg: boolean) => {
      const f = join(work, `${file}.html`);
      writeFileSync(f, html);
      await p.goto(`file://${f}`);
      await p.evaluate("document.fonts.ready");
      await p.screenshot({ path: join(work, `${file}.png`), omitBackground: !bg });
    };
    await shot(page("", true), "band", true);
    for (const [i, s] of subs.entries()) {
      const esc = s.text[lang].replaceAll("&", "&amp;").replaceAll("<", "&lt;");
      await shot(page(`<p>${esc}</p>`, false), `sub-${i}`, false);
    }
  } finally {
    await browser.close();
  }
}

// ---------- 3. ffmpeg の filter_complex ----------
const inputs: string[] = [];
const filters: string[] = [];
let nIn = 0;
const addInput = (...a: string[]) => {
  inputs.push(...a);
  return nIn++;
};
const s12 = addInput("-f", "concat", "-safe", "0", "-i", join(work, "scene12.ffconcat"));
filters.push(
  `[${s12}:v]fps=${FPS},format=yuv444p,split=${CUTS_12.length}${CUTS_12.map((_, i) => `[a${i}]`).join("")}`,
);
const segs: string[] = [];
const cutFilter = (src: string, c: Cut, offset: number, label: string, tail = "") => {
  filters.push(
    `${src}trim=start=${(c.from + offset).toFixed(3)}:end=${(c.to + offset).toFixed(3)},setpts=PTS-STARTPTS,crop=${cropOf(c.frame)},scale=${W}:${H}:flags=lanczos,setsar=1${tail}[${label}]`,
  );
  segs.push(`[${label}]`);
};
CUTS_12.forEach((c, i) => {
  cutFilter(`[a${i}]`, c, 0, `c12_${i}`);
});
if (edit.scene3) {
  const sc = edit.scene3;
  const s3 = addInput("-i", join(captures, sc.file));
  const [x, y, w, h] = sc.stage;
  filters.push(
    `[${s3}:v]fps=${FPS},format=yuv444p,crop=${w}:${h}:${x}:${y},scale=${W}:${H}:flags=lanczos,split=${CUTS_3.length}${CUTS_3.map((_, i) => `[b${i}]`).join("")}`,
  );
  CUTS_3.forEach((c, i) => {
    const freeze =
      i === CUTS_3.length - 1 && c.to === FREEZE_AT
        ? `,tpad=stop_mode=clone:stop_duration=${(FULL_END - FREEZE_AT).toFixed(2)}`
        : "";
    cutFilter(`[b${i}]`, c, sc.t0 - SCENE12_END, `c3_${i}`, freeze);
  });
}
filters.push(`${segs.join("")}concat=n=${segs.length}:v=1:a=0[stage0]`);
let stage = "[stage0]";
if (edit.banner) {
  const b = edit.banner;
  const bi = addInput("-i", join(captures, b.file));
  const [x, y, w, h] = b.crop;
  const dur = BANNER.to - BANNER.from;
  filters.push(
    `[${bi}:v]fps=${FPS},trim=start=${b.t0}:end=${b.t0 + dur},setpts=PTS-STARTPTS+${BANNER.from}/TB,crop=${w}:${h}:${x}:${y},format=yuva444p[ban]`,
    `${stage}[ban]overlay=x=W-w-48:y=48:eof_action=pass:format=yuv444:enable='between(t,${BANNER.from},${BANNER.to})'[stage1]`,
  );
  stage = "[stage1]";
}
// 字幕の帯: 地の帯に文字を 0.15 秒のフェードで重ねる
const band = addInput(
  "-loop",
  "1",
  "-framerate",
  String(FPS),
  "-t",
  String(END),
  "-i",
  join(work, "band.png"),
);
let bandLabel = `[${band}:v]`;
subs.forEach((s, i) => {
  const dur = s.to - s.from;
  const si = addInput(
    "-loop",
    "1",
    "-framerate",
    String(FPS),
    "-t",
    dur.toFixed(3),
    "-i",
    join(work, `sub-${i}.png`),
  );
  filters.push(
    // 0.0 の字幕はフェードせずに出す（最初のフレーム・GIF の 1 枚目に字幕が無い形にしない）
    `[${si}:v]format=rgba,${s.from > 0 ? "fade=t=in:st=0:d=0.15:alpha=1," : ""}fade=t=out:st=${(dur - 0.15).toFixed(3)}:d=0.15:alpha=1,setpts=PTS-STARTPTS+${s.from}/TB[s${i}]`,
    `${bandLabel}[s${i}]overlay=0:0:eof_action=pass:format=yuv444[band${i}]`,
  );
  bandLabel = `[band${i}]`;
});
filters.push(
  `${bandLabel}format=yuv444p[bandv]`,
  `${stage}format=yuv444p[stagev]`,
  `[stagev][bandv]vstack=inputs=2,trim=duration=${END},format=yuv444p[master]`,
);

const master = join(out, "master.mov");
ff([
  ...inputs,
  "-filter_complex",
  filters.join(";\n"),
  "-map",
  "[master]",
  "-r",
  String(FPS),
  "-c:v",
  "libx264",
  "-preset",
  "medium",
  "-crf",
  "12",
  "-pix_fmt",
  "yuv444p",
  "-an",
  master,
]);

// ---------- 4. 書き出し ----------
const mp4 = join(out, `demo-${lang}.mp4`);
ff([
  "-i",
  master,
  "-vf",
  "scale=1440:1000:flags=lanczos",
  "-c:v",
  "libx264",
  "-profile:v",
  "high",
  "-pix_fmt",
  "yuv420p",
  "-crf",
  "18",
  "-r",
  String(FPS),
  "-an",
  "-movflags",
  "+faststart",
  mp4,
]);
const mb = (f: string) => statSync(f).size / 1024 / 1024;
console.log(`wrote ${mp4} (${mb(mp4).toFixed(1)} MB, ${END}s)`);

if (wantGif) {
  const gif = join(out, `demo-${lang}.gif`);
  for (const [fps, width] of [
    [12, 960],
    [10, 960],
    [10, 800],
  ] as const) {
    ff([
      "-i",
      master,
      "-vf",
      `fps=${fps},scale=${width}:-1:flags=lanczos,split[a][b];[a]palettegen=max_colors=128:stats_mode=diff[p];[b][p]paletteuse=dither=bayer:bayer_scale=4:diff_mode=rectangle`,
      "-loop",
      "0",
      gif,
    ]);
    console.log(`wrote ${gif} (${mb(gif).toFixed(1)} MB, ${fps}fps, ${width}px)`);
    if (mb(gif) <= 16) break;
  }
}

// 代表フレーム（PO が見る。D-114）: 0 秒、合図の直後、通知が消える 12.6 秒、場面 (3) があればその要所
const stills: [string, number][] = [
  ["00.0-F1", 0],
  ["07.9-F2", 7.9],
  ["12.6-F2", 12.6],
  ...(hasScene3
    ? ([
        ["21.5-F3", 21.5],
        ["24.0-F4", 24.0],
        ["29.0-F3", 29.0],
      ] as [string, number][])
    : []),
];
for (const [name, t] of stills)
  ff(["-ss", t.toFixed(2), "-i", mp4, "-frames:v", "1", join(out, `frame-${lang}-${name}.png`)]);
rmSync(work, { recursive: true, force: true });
console.log(`frames: ${stills.map(([n]) => `frame-${lang}-${n}.png`).join(", ")}`);
