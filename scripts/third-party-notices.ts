/**
 * THIRD_PARTY_NOTICES.md を生成する（phase0-plan M6-1、ADR 0008・0015）。
 *
 *   bun scripts/third-party-notices.ts [--out THIRD_PARTY_NOTICES.md] [--check]
 *
 * - JavaScript: workspace（apps/*, packages/*）の `dependencies` から、実行時に配布物（turnlaned・turnlane・Web の dist）に
 *   入る npm パッケージを推移的に辿り、名前・版・ライセンス・ライセンス文（同梱の LICENSE / COPYING）を集める。
 *   `devDependencies`（Biome・TypeScript・Vite・Playwright など。配布物に入らない）は含めない。
 *   解決は `Bun.resolveSync` で行うので、node_modules の配置（hoisted / isolated）に依存しない
 * - Rust: デスクトップの殻（apps/desktop/src-tauri）の通常の依存を `cargo metadata --offline` から集める（名前・版・ライセンス式）。
 *   cargo が無ければその節は前回の生成物のまま残す
 * - --check: 生成した内容が今のファイルと同じなら 0、違えば 1（CI や公開前の確認用）
 */
import { existsSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";

const ROOT = resolve(import.meta.dir, "..");
const args = process.argv.slice(2);
const outIdx = args.indexOf("--out");
const OUT = resolve(ROOT, outIdx >= 0 ? (args[outIdx + 1] ?? "") : "THIRD_PARTY_NOTICES.md");
const CHECK = args.includes("--check");

interface JsPackage {
  name: string;
  version: string;
  license: string;
  homepage: string | null;
  licenseText: string | null;
  licenseFile: string | null;
}

/** package.json の license（文字列か {type} か、古い licenses 配列） */
function licenseOf(pkg: Record<string, unknown>): string {
  const l = pkg.license;
  if (typeof l === "string") return l;
  if (l && typeof l === "object" && typeof (l as { type?: unknown }).type === "string")
    return (l as { type: string }).type;
  const ls = pkg.licenses;
  if (Array.isArray(ls))
    return ls
      .map((x) => (typeof x === "string" ? x : ((x as { type?: string }).type ?? "")))
      .filter(Boolean)
      .join(" OR ");
  return "UNKNOWN";
}

function homepageOf(pkg: Record<string, unknown>): string | null {
  if (typeof pkg.homepage === "string") return pkg.homepage;
  const r = pkg.repository;
  const raw =
    typeof r === "string"
      ? r
      : r && typeof r === "object" && typeof (r as { url?: unknown }).url === "string"
        ? (r as { url: string }).url
        : null;
  if (!raw) return null;
  // "owner/repo" の省略形は GitHub
  if (/^[\w.-]+\/[\w.-]+$/.test(raw)) return `https://github.com/${raw}`;
  return raw.replace(/^git\+/, "").replace(/\.git$/, "");
}

/** 同梱のライセンス文（LICENSE / LICENCE / COPYING / OFL）。無ければ null */
function readLicenseFile(dir: string): { file: string; text: string } | null {
  let names: string[];
  try {
    names = readdirSync(dir);
  } catch {
    return null;
  }
  const hit = names
    .filter((n) => /^(licen[cs]e|copying|ofl)(\.|-|$)/i.test(n))
    .sort((a, b) => a.length - b.length)[0];
  if (!hit) return null;
  try {
    return { file: hit, text: readFileSync(join(dir, hit), "utf8").replace(/\r\n/g, "\n").trim() };
  } catch {
    return null;
  }
}

/** workspace の package.json（apps/*, packages/*） */
function workspacePackages(): { dir: string; pkg: Record<string, unknown> }[] {
  const root = JSON.parse(readFileSync(join(ROOT, "package.json"), "utf8")) as {
    workspaces: string[];
  };
  const out: { dir: string; pkg: Record<string, unknown> }[] = [];
  for (const pattern of root.workspaces) {
    const base = join(ROOT, pattern.replace(/\/\*$/, ""));
    for (const name of readdirSync(base)) {
      const file = join(base, name, "package.json");
      if (existsSync(file))
        out.push({ dir: join(base, name), pkg: JSON.parse(readFileSync(file, "utf8")) });
    }
  }
  return out;
}

/** 実行時の依存を推移的に辿る（devDependencies は見ない） */
export function collectJs(): JsPackage[] {
  const seen = new Map<string, JsPackage>();
  const queue: { name: string; from: string }[] = [];
  for (const { dir, pkg } of workspacePackages())
    for (const name of Object.keys((pkg.dependencies as Record<string, string>) ?? {}))
      if (!name.startsWith("@turnlane/")) queue.push({ name, from: dir });
  while (queue.length) {
    const { name, from } = queue.shift() as { name: string; from: string };
    let file: string;
    try {
      file = Bun.resolveSync(`${name}/package.json`, from);
    } catch {
      // exports で package.json を隠すパッケージ: 入口のファイルから遡る
      try {
        let d = dirname(Bun.resolveSync(name, from));
        while (!existsSync(join(d, "package.json")) && d !== dirname(d)) d = dirname(d);
        file = join(d, "package.json");
      } catch {
        console.error(`unresolved: ${name} (from ${from})`);
        continue;
      }
    }
    const pkg = JSON.parse(readFileSync(file, "utf8")) as Record<string, unknown>;
    const version = String(pkg.version ?? "");
    const key = `${name}@${version}`;
    if (seen.has(key)) continue;
    const dir = dirname(file);
    const lic = readLicenseFile(dir);
    seen.set(key, {
      name,
      version,
      license: licenseOf(pkg),
      homepage: homepageOf(pkg),
      licenseText: lic?.text ?? null,
      licenseFile: lic?.file ?? null,
    });
    for (const dep of Object.keys((pkg.dependencies as Record<string, string>) ?? {}))
      queue.push({ name: dep, from: dir });
    // peerDependencies は利用側（workspace）が持つものだけなので辿らない（例: react）
  }
  return [...seen.values()].sort(
    (a, b) => a.name.localeCompare(b.name) || a.version.localeCompare(b.version),
  );
}

interface CargoPackage {
  name: string;
  version: string;
  license: string;
  repository: string | null;
}

/** デスクトップの殻の通常の依存（build / dev の依存は配布物に入らない） */
export function collectCargo(): CargoPackage[] | null {
  const manifest = join(ROOT, "apps/desktop/src-tauri/Cargo.toml");
  if (!existsSync(manifest)) return [];
  const p = Bun.spawnSync(
    [
      "cargo",
      "metadata",
      "--offline",
      "--format-version",
      "1",
      "--filter-platform",
      "aarch64-apple-darwin",
      "--manifest-path",
      manifest,
    ],
    { stdout: "pipe", stderr: "pipe" },
  );
  if (p.exitCode !== 0) {
    console.error(`cargo metadata failed (Rust section kept as is): ${p.stderr.toString().trim()}`);
    return null;
  }
  const meta = JSON.parse(p.stdout.toString()) as {
    packages: {
      id: string;
      name: string;
      version: string;
      license: string | null;
      repository: string | null;
    }[];
    resolve: {
      root: string | null;
      nodes: { id: string; deps: { pkg: string; dep_kinds: { kind: string | null }[] }[] }[];
    };
    workspace_members: string[];
  };
  const byId = new Map(meta.packages.map((x) => [x.id, x]));
  const nodes = new Map(meta.resolve.nodes.map((n) => [n.id, n]));
  const roots = meta.resolve.root ? [meta.resolve.root] : meta.workspace_members;
  const seen = new Set<string>(roots);
  const queue = [...roots];
  while (queue.length) {
    const id = queue.shift() as string;
    const node = nodes.get(id);
    if (!node) continue;
    for (const d of node.deps) {
      if (!d.dep_kinds.some((k) => k.kind === null || k.kind === "normal")) continue;
      if (seen.has(d.pkg)) continue;
      seen.add(d.pkg);
      queue.push(d.pkg);
    }
  }
  const out: CargoPackage[] = [];
  for (const id of seen) {
    if (roots.includes(id)) continue;
    const pkg = byId.get(id);
    if (!pkg) continue;
    out.push({
      name: pkg.name,
      version: pkg.version,
      license: pkg.license ?? "UNKNOWN",
      repository: pkg.repository,
    });
  }
  return out.sort((a, b) => a.name.localeCompare(b.name) || a.version.localeCompare(b.version));
}

const RUST_BEGIN = "<!-- rust:begin -->";
const RUST_END = "<!-- rust:end -->";

function previousRustSection(): string | null {
  if (!existsSync(OUT)) return null;
  const cur = readFileSync(OUT, "utf8");
  const a = cur.indexOf(RUST_BEGIN);
  const b = cur.indexOf(RUST_END);
  if (a < 0 || b < 0) return null;
  return cur.slice(a + RUST_BEGIN.length, b).trim();
}

function renderRust(crates: CargoPackage[] | null): string {
  if (crates === null)
    return previousRustSection() ?? "_(cargo was not available when this file was generated)_";
  const rows = crates.map(
    (c) =>
      `| ${c.name} | ${c.version} | ${c.license} | ${c.repository ? `<${c.repository}>` : ""} |`,
  );
  return ["| Crate | Version | License | Source |", "|---|---|---|---|", ...rows].join("\n");
}

export function render(js: JsPackage[], crates: CargoPackage[] | null): string {
  const lines: string[] = [];
  lines.push("# Third-party notices");
  lines.push("");
  lines.push(
    "Turnlane itself is released under the MIT License (see [LICENSE](LICENSE)). The official, signed build may additionally include a separately licensed extension; that extension's terms are shown in the app's About screen and are not part of this repository.",
  );
  lines.push("");
  lines.push(
    "The binaries and the web UI bundle the open-source packages listed below. This file is generated by `bun scripts/third-party-notices.ts`; do not edit it by hand.",
  );
  lines.push("");
  lines.push("## Runtimes and toolchains");
  lines.push("");
  lines.push(
    "- `turnlaned` and `turnlane` are compiled with [Bun](https://bun.sh) (`bun build --compile`), which embeds the Bun runtime (MIT; it ships its own third-party notices, including JavaScriptCore under LGPL-2.1 and WebKit's BSD-style licenses).",
  );
  lines.push(
    "- `Turnlane.app` is a [Tauri 2](https://tauri.app) shell written in Rust (crates listed in the Rust section) and uses the system WebKit on macOS.",
  );
  lines.push(
    "- `TurnlaneCalendarHelper.app` is written in Swift and uses only Apple system frameworks (EventKit, Foundation).",
  );
  lines.push("");
  lines.push("## JavaScript packages");
  lines.push("");
  lines.push("| Package | Version | License | Source |");
  lines.push("|---|---|---|---|");
  for (const p of js)
    lines.push(
      `| ${p.name} | ${p.version} | ${p.license} | ${p.homepage ? `<${p.homepage}>` : ""} |`,
    );
  lines.push("");
  lines.push("## Rust crates (desktop shell)");
  lines.push("");
  lines.push(RUST_BEGIN);
  lines.push(renderRust(crates));
  lines.push(RUST_END);
  lines.push("");
  lines.push("## License texts (JavaScript packages)");
  lines.push("");
  for (const p of js) {
    lines.push(`### ${p.name} ${p.version} (${p.license})`);
    lines.push("");
    if (p.licenseText) {
      lines.push("```text");
      lines.push(p.licenseText);
      lines.push("```");
    } else {
      lines.push(
        `_(no license file is shipped in the package; license declared in package.json: ${p.license})_`,
      );
    }
    lines.push("");
  }
  return `${lines.join("\n").trimEnd()}\n`;
}

if (import.meta.main) {
  const text = render(collectJs(), collectCargo());
  if (CHECK) {
    const cur = existsSync(OUT) ? readFileSync(OUT, "utf8") : "";
    if (cur !== text) {
      console.error(`${OUT} is out of date; run: bun scripts/third-party-notices.ts`);
      process.exit(1);
    }
    console.log("THIRD_PARTY_NOTICES.md is up to date");
  } else {
    writeFileSync(OUT, text);
    console.log(`wrote ${OUT}`);
  }
}
