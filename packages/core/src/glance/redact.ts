/**
 * 秘密に見えるものの伏せ字（D-207 (2)、spec-glance §5.2、research §5.1）。表示用の文字列を組み立てる段で必ず通す
 * （デーモンの glance が返す前と、画面が文を組み立てるときの 2 回。何度通しても同じ結果になる）。
 *
 * - 見た目は `••••`（長さを表さない）。決まった前置きを持つもの（`sk-`・`ghp_`・`xoxb-`・`AKIA` など）だけ先頭 4 文字を残す
 * - 迷ったら伏せる側に倒す（誤って伏せたときの損は「読みにくい」だけ）。完全ではないので、本物はターミナルで見る
 * - 再表示はしない（伏せる前の文字列を画面に渡さない）
 */

export const MASK = "••••";

/** 先頭 4 文字を残す、決まった前置きの鍵 */
const PREFIXED =
  /\b(?:sk-ant-|sk-proj-|sk-|ghp_|gho_|ghu_|ghs_|ghr_|github_pat_|xox[abposr]-|AKIA|ASIA|AIza|glpat-|npm_|hf_|pk_live_|sk_live_|rk_live_|SG\.)[A-Za-z0-9_\-.]{8,}/g;
const JWT = /\beyJ[A-Za-z0-9_-]{6,}\.[A-Za-z0-9_-]{6,}\.[A-Za-z0-9_-]{6,}/g;
const PEM =
  /-----BEGIN [A-Z0-9 ]*PRIVATE KEY-----[\s\S]*?(?:-----END [A-Z0-9 ]*PRIVATE KEY-----|$)/g;
const SCHEME = /(?<![-\w])(Bearer|bearer|Basic|Token|Digest)(\s+)([^\s"'`,;]+)/g;
const HEADER =
  /\b(Authorization|Proxy-Authorization|X-Api-Key|X-Auth-Token|X-Access-Token|Api-Key|Private-Token|Cookie|Set-Cookie)(\s*:\s*)([^"'`\n]+)/gi;
const USERINFO = /\b([a-z][a-z0-9+.-]*:\/\/)([^\s/@:"'`]+)(?::([^\s/@"'`]*))?@/gi;
const QUERY = /([?&][^=\s&#"'`]+=)([^&\s#"'`]+)/g;
const SECRET_NAME =
  "(?:TOKEN|SECRET|PASSWORD|PASSWD|PASS|PWD|KEY|AUTH|CREDENTIAL|COOKIE|SESSION|DATABASE_URL|DSN)";
const ASSIGN = new RegExp(
  `\\b([A-Za-z0-9_]*${SECRET_NAME}[A-Za-z0-9_]*)(=)("[^"]*"|'[^']*'|[^\\s;&|]+)`,
  "gi",
);
const FLAG =
  /(--(?:password|passwd|pass|token|api-key|apikey|secret|auth|auth-token|access-token|client-secret|private-key))(=|\s+)("[^"]*"|'[^']*'|[^\s;&|]+)/gi;
const MYSQL_P = /\b(mysql|mysqldump|mariadb|mysqladmin)\b([^\n|;&]*?\s)-p([^\s;&|]+)/g;
const RANDOM = /[A-Za-z0-9+=_-]{24,}/g;

/** 引用符はそのまま残して中身を伏せる */
function maskValue(v: string): string {
  if (v.includes(MASK)) return v;
  const q = v[0];
  if ((q === '"' || q === "'") && v.endsWith(q) && v.length >= 2) return `${q}${MASK}${q}`;
  return MASK;
}

/** でたらめな文字列に見えるか（文字の種類の切り替わりが多い。単語・パスは当たりにくい） */
function looksRandom(s: string): boolean {
  if (!/[0-9]/.test(s) || !/[A-Za-z]/.test(s)) return false;
  let changes = 0;
  const cls = (c: string) => (/[0-9]/.test(c) ? 0 : /[a-z]/.test(c) ? 1 : /[A-Z]/.test(c) ? 2 : 3);
  for (let i = 1; i < s.length; i++) if (cls(s[i] as string) !== cls(s[i - 1] as string)) changes++;
  return changes / s.length >= 0.25;
}

/** 伏せ字にする。masked は 1 つでも伏せたら true */
export function redact(input: string): { text: string; masked: boolean } {
  let s = input.replace(PEM, MASK);
  s = s.replace(PREFIXED, (m) => `${m.slice(0, 4)}${MASK}`);
  s = s.replace(JWT, MASK);
  s = s.replace(SCHEME, (_m, w: string, sp: string, v: string) => `${w}${sp}${maskValue(v)}`);
  s = s.replace(HEADER, (m, h: string, sep: string, v: string) =>
    /^\s*(Bearer|Basic|Token|Digest)\b/i.test(v) || v.includes(MASK) ? m : `${h}${sep}${MASK}`,
  );
  s = s.replace(USERINFO, (_m, scheme: string, user: string, pass: string | undefined) =>
    pass === undefined ? `${scheme}${MASK}@` : `${scheme}${user}:${MASK}@`,
  );
  s = s.replace(QUERY, (_m, k: string, v: string) => `${k}${maskValue(v)}`);
  s = s.replace(ASSIGN, (_m, k: string, eq: string, v: string) => `${k}${eq}${maskValue(v)}`);
  s = s.replace(FLAG, (_m, f: string, sep: string, v: string) => `${f}${sep}${maskValue(v)}`);
  s = s.replace(MYSQL_P, (_m, cmd: string, mid: string) => `${cmd}${mid}-p${MASK}`);
  s = s.replace(RANDOM, (m) => (looksRandom(m) ? MASK : m));
  return { text: s, masked: s !== input };
}

/** 伏せ字だけを返す（masked を使わないとき） */
export function redactText(input: string): string {
  return redact(input).text;
}
