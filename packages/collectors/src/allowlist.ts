/**
 * 許可リストによる抽出（ADR 0005、phase0-plan 3.1.1）。アダプタは JSON をパースした直後にこれを通し、
 * 以降は戻り値だけを使う。
 *
 * キーの書き方: ドット区切りのパス。配列の要素は `[]`（例 `message.content[].type`）。
 * - 葉に残すのは string / number / boolean / null だけ。葉の位置にオブジェクトや配列があれば落とす
 *   （本文を入れ物ごと持ち出せないようにする）
 * - 同じパスを葉と枝の両方に書ける（例 `payload.source` と `payload.source.subagent.other`。
 *   値が文字列なら葉として、オブジェクトなら枝として扱う）
 */

interface Node {
  leaf: boolean;
  children: Map<string, Node>;
}

const treeCache = new WeakMap<readonly string[], Node>();

function buildTree(keys: readonly string[]): Node {
  const cached = treeCache.get(keys);
  if (cached) return cached;
  const root: Node = { leaf: false, children: new Map() };
  for (const key of keys) {
    let n = root;
    for (const part of key.split(".")) {
      let c = n.children.get(part);
      if (!c) {
        c = { leaf: false, children: new Map() };
        n.children.set(part, c);
      }
      n = c;
    }
    n.leaf = true;
  }
  treeCache.set(keys, root);
  return root;
}

function isScalar(v: unknown): v is string | number | boolean | null {
  return v === null || typeof v === "string" || typeof v === "number" || typeof v === "boolean";
}

function project(value: unknown, node: Node): unknown {
  if (isScalar(value)) return node.leaf ? value : undefined;
  if (Array.isArray(value)) return undefined;
  if (typeof value !== "object" || node.children.size === 0) return undefined;
  const src = value as Record<string, unknown>;
  const out: Record<string, unknown> = {};
  for (const [name, child] of node.children) {
    const isArray = name.endsWith("[]");
    const key = isArray ? name.slice(0, -2) : name;
    if (!Object.hasOwn(src, key)) continue;
    const v = src[key];
    if (isArray) {
      if (!Array.isArray(v)) continue;
      out[key] = v.map((x) => project(x, child) ?? null);
    } else {
      const p = project(v, child);
      if (p !== undefined) out[key] = p;
    }
  }
  return Object.keys(out).length > 0 ? out : undefined;
}

/** 許可リストのキーだけを取り出す。何も残らなければ空のオブジェクト */
export function pickAllowed(record: unknown, keys: readonly string[]): Record<string, unknown> {
  const out = project(record, buildTree(keys));
  return (out as Record<string, unknown> | undefined) ?? {};
}
