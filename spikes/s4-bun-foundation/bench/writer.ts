// Writes synthetic JSONL into a scratch directory. Never point this at real
// tool data directories. Prints {"expected": N} (complete lines written).
import {
  appendFileSync,
  closeSync,
  mkdirSync,
  openSync,
  renameSync,
  writeSync,
} from "node:fs";
import { join } from "node:path";

const [scenario, root] = process.argv.slice(2);
if (!root || !root.includes("dayline-s4-")) throw new Error("refusing: root must be a scratch dir");

const line = (i: number, pad = 0) =>
  `${JSON.stringify({ type: "assistant", i, ts: Date.now(), pad: "x".repeat(pad) })}\n`;

function burstAppendFile(file: string, n: number) {
  for (let i = 0; i < n; i++) appendFileSync(file, line(i));
  return n;
}
function burstFd(file: string, n: number, pad = 0) {
  const fd = openSync(file, "a");
  for (let i = 0; i < n; i++) writeSync(fd, line(i, pad));
  closeSync(fd);
  return n;
}

let expected = 0;
switch (scenario) {
  case "burst": {
    // one file, 5000 lines, open/append/close per line
    mkdirSync(join(root, "projects/-proj-a"), { recursive: true });
    expected += burstAppendFile(join(root, "projects/-proj-a/s1.jsonl"), 5000);
    break;
  }
  case "burst-fd": {
    // one file, 20000 lines through one fd as fast as possible
    mkdirSync(join(root, "projects/-proj-b"), { recursive: true });
    expected += burstFd(join(root, "projects/-proj-b/s1.jsonl"), 20000);
    break;
  }
  case "parallel-child": {
    // used by "parallel": one child process per file
    const [file, n] = process.argv.slice(4);
    mkdirSync(join(file, ".."), { recursive: true });
    const fd = openSync(file, "a");
    for (let i = 0; i < Number(n); i++) {
      writeSync(fd, line(i));
      if (i % 100 === 0) await Bun.sleep(0);
    }
    closeSync(fd);
    expected += Number(n);
    break;
  }
  case "parallel": {
    // 8 processes x 2000 lines, different project dirs
    const procs = Array.from({ length: 8 }, (_, k) =>
      Bun.spawn(
        [
          process.execPath,
          import.meta.path,
          "parallel-child",
          root,
          join(root, `projects/-proj-p${k}/sess-${k}.jsonl`),
          "2000",
        ],
        { stdout: "ignore" },
      ),
    );
    await Promise.all(procs.map((p) => p.exited));
    expected += 8 * 2000;
    break;
  }
  case "newfiles": {
    // 50 new nested dirs/files (incl. subagents/), 100 lines each, created rapidly
    for (let k = 0; k < 50; k++) {
      const dir = join(root, `projects/-new-${k}`, k % 2 ? `sess-${k}/subagents` : "");
      mkdirSync(dir, { recursive: true });
      expected += burstFd(join(dir, `agent-${k}.jsonl`), 100);
    }
    break;
  }
  case "rotate": {
    // write, rename (same inode keeps cursor), recreate at old path, keep writing both
    const dir = join(root, "rollouts/2026/10/02");
    mkdirSync(dir, { recursive: true });
    const a = join(dir, "rollout-a.jsonl");
    expected += burstFd(a, 1000);
    const archived = join(dir, "rollout-a.old.jsonl");
    renameSync(a, archived);
    expected += burstFd(a, 1000);
    expected += burstFd(archived, 500);
    // rotate again quickly without pause
    renameSync(a, join(dir, "rollout-a.old2.jsonl"));
    expected += burstFd(a, 300);
    break;
  }
  case "biglines": {
    // 200 lines of ~64KB, written in 3 chunks each to create partial lines
    mkdirSync(join(root, "projects/-big"), { recursive: true });
    const fd = openSync(join(root, "projects/-big/big.jsonl"), "a");
    for (let i = 0; i < 200; i++) {
      const s = line(i, 64 * 1024);
      const third = Math.floor(s.length / 3);
      writeSync(fd, s.slice(0, third));
      writeSync(fd, s.slice(third, 2 * third));
      writeSync(fd, s.slice(2 * third));
    }
    closeSync(fd);
    expected += 200;
    break;
  }
  case "trickle": {
    // 300 lines at ~10ms intervals (normal live session pace, measures latency)
    mkdirSync(join(root, "projects/-trickle"), { recursive: true });
    const f = join(root, "projects/-trickle/t.jsonl");
    for (let i = 0; i < 300; i++) {
      appendFileSync(f, line(i));
      await Bun.sleep(10);
    }
    expected += 300;
    break;
  }
  default:
    throw new Error(`unknown scenario ${scenario}`);
}
console.log(JSON.stringify({ expected }));
