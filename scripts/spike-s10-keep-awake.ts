/**
 * S10: スリープさせない（ExtDeps.power.keepAwake = `caffeinate -i -w <pid>`）を一晩保持したとき、ふたを開けたまま・
 * ディスプレイのスリープ・その後の画面のロックで朝まで起きているか。手順と結果は docs/spikes/s10-keep-awake-overnight.md。
 *
 *   bun scripts/spike-s10-keep-awake.ts [--hours 8] [--interval 30] [--results <jsonl>] [--dry-run]
 *
 * - 本体と同じ引数で caffeinate を起こし（`-i -w <このプロセスの pid>`。ディスプレイは止めない）、interval 秒ごとに記録する:
 *   前の記録からの空き（スリープしていた区間）、`pmset -g assertions` にこの caffeinate の PreventUserIdleSystemSleep が
 *   出ているか・UserIsActive の数、在席の読み取り（本体と同じ SystemPresenceReader の最後の入力からの経過・ロック）、
 *   電源とふたの状態（本体の power.state と同じ読み方）
 * - 終わり（--hours か Ctrl-C）に要約を1行足す
 * - --dry-run: 2秒ごとに3回だけ記録する（手順の確かめ）
 *
 * 触るもの: caffeinate を1つ（このプロセスが終われば自分で終わる）。触らないもの: 電源の設定（pmset の値は読むだけ）・
 * 利用者の常駐デーモン・データ。記録にパス・ユーザー名・アプリの名前は書かない
 */
import { appendFileSync, mkdirSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { CAFFEINATE, readPowerState } from "../apps/daemon/src/ext/power.ts";
import { SystemPresenceReader } from "../apps/daemon/src/presence/reader.ts";

const ROOT = resolve(import.meta.dir, "..");
const args = process.argv.slice(2);
const opt = (k: string, d: string) => {
  const i = args.indexOf(k);
  return i >= 0 ? (args[i + 1] ?? d) : d;
};
const dry = args.includes("--dry-run");
const hours = Number(opt("--hours", "8"));
const intervalSec = dry ? 2 : Number(opt("--interval", "30"));
const results = resolve(opt("--results", join(ROOT, "out", "s10-results.jsonl")));
if (!(hours > 0) || !(intervalSec >= 1)) throw new Error("--hours と --interval は正の数");
const started = Date.now();
const samplesPath = join(dirname(results), `s10-samples-${started}.jsonl`);
mkdirSync(dirname(results), { recursive: true });

const sh = async (argv: string[]) => {
  try {
    const p = Bun.spawn(argv, { stdout: "pipe", stderr: "ignore", stdin: "ignore" });
    const out = await new Response(p.stdout).text();
    return (await p.exited) === 0 ? out : "";
  } catch {
    return "";
  }
};

/** pmset -g の電源の設定のうち、スリープに関わる値だけ（読むだけ） */
async function sleepSettings(): Promise<Record<string, string>> {
  const out = await sh(["/usr/bin/pmset", "-g"]);
  const keep = ["sleep", "displaysleep", "standby", "powernap", "hibernatemode", "tcpkeepalive"];
  const r: Record<string, string> = {};
  for (const line of out.split("\n")) {
    const m = /^\s*(\w+)\s+(\d+)/.exec(line);
    if (m && keep.includes(m[1] as string)) r[m[1] as string] = m[2] as string;
  }
  return r;
}

// 本体（ext/power.ts の systemPower）と同じ引数
const caf = Bun.spawn([CAFFEINATE, "-i", "-w", String(process.pid)], {
  stdin: "ignore",
  stdout: "ignore",
  stderr: "ignore",
});
const presence = new SystemPresenceReader();

interface Sample {
  at: number;
  /** 前の記録からの秒（最初は 0） */
  gapSec: number;
  /** この caffeinate の PreventUserIdleSystemSleep が assertions に出ているか */
  holding: boolean;
  /** UserIsActive の数（0 でなければ macOS が「使っている」と見ている） */
  userIsActive: number | null;
  /** 最後の入力からの秒（本体の在席の読み取りと同じ） */
  idleSec: number | null;
  locked: boolean;
  ac: boolean | null;
  lidClosed: boolean | null;
}

const samples: Sample[] = [];
async function sample(prev: number | null): Promise<Sample> {
  const [a, p, pw] = await Promise.all([
    sh(["/usr/bin/pmset", "-g", "assertions"]),
    presence.read().catch(() => ({ idleMs: null, locked: false, offConsole: false })),
    readPowerState(),
  ]);
  const holding = new RegExp(
    `pid ${caf.pid}\\(caffeinate\\):[^\\n]*PreventUserIdleSystemSleep`,
  ).test(a);
  const ua = /^\s*UserIsActive\s+(\d+)/m.exec(a);
  const now = Date.now();
  return {
    at: now,
    gapSec: prev === null ? 0 : Math.round((now - prev) / 1000),
    holding,
    userIsActive: ua ? Number(ua[1]) : null,
    idleSec: p.idleMs === null ? null : Math.round(p.idleMs / 1000),
    locked: p.locked,
    ac: pw.ac,
    lidClosed: pw.lidClosed,
  };
}

const hhmm = (ms: number) => {
  const d = new Date(ms);
  return `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
};

async function finish(reason: string): Promise<never> {
  try {
    caf.kill();
  } catch {}
  const gaps = samples
    .filter((s) => s.gapSec > Math.max(120, intervalSec * 4))
    .map((s) => ({
      from: hhmm(s.at - s.gapSec * 1000),
      to: hhmm(s.at),
      min: Math.round(s.gapSec / 60),
    }));
  // 在席に見えたか: ロックの後に最後の入力からの経過が interval より短くなった（誰かが触った・何かが入力に見えた）記録
  const firstLock = samples.findIndex((x) => x.locked);
  const afterLock = firstLock < 0 ? [] : samples.slice(firstLock + 1);
  const summary = {
    spike: "s10",
    macos: (await sh(["/usr/bin/sw_vers", "-productVersion"])).trim(),
    reason,
    settings: settingsAtStart,
    hours: Math.round(((Date.now() - started) / 3_600_000) * 100) / 100,
    samples: samples.length,
    maxGapSec: Math.max(0, ...samples.map((s) => s.gapSec)),
    sleptGaps: gaps,
    holdingAlways: samples.length > 0 && samples.every((s) => s.holding),
    holdingRatio:
      samples.length > 0
        ? Math.round((samples.filter((s) => s.holding).length / samples.length) * 100) / 100
        : null,
    lockedSamples: samples.filter((s) => s.locked).length,
    lidClosedSamples: samples.filter((s) => s.lidClosed === true).length,
    batterySamples: samples.filter((s) => s.ac === false).length,
    userIsActiveSamples: samples.filter((s) => (s.userIsActive ?? 0) > 0).length,
    shortIdleAfterLock: afterLock.filter((s) => s.idleSec !== null && s.idleSec < intervalSec)
      .length,
    maxIdleSec: Math.max(0, ...samples.map((s) => s.idleSec ?? 0)),
  };
  appendFileSync(results, `${JSON.stringify(summary)}\n`);
  console.log(JSON.stringify(summary, null, 2));
  console.log(`\n記録: ${results}\n1回ごとの記録: ${samplesPath}`);
  process.exit(0);
}

const settingsAtStart = await sleepSettings();
console.log(
  `S10: caffeinate -i -w ${process.pid} を保持しました（pid ${caf.pid}）。${intervalSec} 秒ごとに記録します。`,
);
console.log(`電源の設定（読むだけ）: ${JSON.stringify(settingsAtStart)}`);
if (settingsAtStart.sleep === "0")
  console.log(
    "メモ: システムのスリープが「しない」（sleep 0）なので、caffeinate が無くても眠りません。保持が assertions に出ていることと、在席に見えないことだけを確かめます。",
  );
console.log("止めるときは Ctrl-C（要約を書いてから終わります）。\n");
process.on("SIGINT", () => void finish("interrupted"));
process.on("SIGTERM", () => void finish("terminated"));

const end = dry ? started + 5_000 : started + hours * 3_600_000;
let prev: number | null = null;
while (Date.now() < end) {
  const s = await sample(prev);
  prev = s.at;
  samples.push(s);
  appendFileSync(samplesPath, `${JSON.stringify(s)}\n`);
  if (dry || samples.length % 20 === 1)
    console.log(
      `${hhmm(s.at)} 空き ${s.gapSec}s · 保持 ${s.holding ? "あり" : "なし"} · 無操作 ${s.idleSec ?? "?"}s · ロック ${s.locked ? "中" : "なし"} · 電源 ${s.ac === null ? "?" : s.ac ? "AC" : "電池"} · ふた ${s.lidClosed === null ? "?" : s.lidClosed ? "閉" : "開"}`,
    );
  await Bun.sleep(intervalSec * 1000);
}
await finish("done");
