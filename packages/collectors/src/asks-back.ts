/**
 * 利用者の入力の 1 行目が「問い返し」か（Issue #3）: AI の問いに、答えでなく問いで返した（「どうやって見るの？」
 * 「how do I see that?」）。判定は保存した 1 行目（伏せ字の後。ADR 0018）だけで行い、本文は読まない。
 *
 * 問いの形: `?` / `？` で終わる・含む、問いの言い回し（日本語「教えて」「とは」「どうやって」「どうすれば」「なぜ」
 * 「どこ」「どれ」「何が」…、英語 how / what / why / where / which / when で始まる、how do I・what is …）。
 * ただし頼みごとの形（「〜してもらえますか」「〜してくれる？」「can you …?」「could you …?」「please …」）は、
 * 答えに続けて次の作業を頼んだことが多いので問い返しにしない（問いへの答えとして扱う）
 */

/** 頼みごとの形（問いではなく次の作業の依頼） */
const REQUEST_JA =
  /(して|て)(もらえ|もらえる|くれ|くれる|いただけ|ください|下さい|ほしい|欲しい)|お願い|頼む|やって(み)?て|直して|進めて/;
const REQUEST_EN =
  /^(please\b|can you\b|could you\b|would you\b|will you\b|can u\b|pls\b|kindly\b)|\bplease\b/;

/** 問いの言い回し（日本語）。文のどこかにあれば問い */
const ASK_JA: RegExp[] = [
  /教えて/,
  /とは(何|なに)?[?？。]?$|って(何|なに)/,
  /どうやって|どうすれば|どうしたら|どうやる|どうやれば|どうなって/,
  /なぜ|なんで|どうして/,
  /(何|なに|どこ|どれ|どっち|どちら|いつ|誰|だれ)(が|を|で|に|の|は|から|まで)?.*(の|か|ですか|ますか|でしょう)[?？]?$/,
  /(ですか|ますか|でしょうか|のか|の？|かな)[?？]?$/,
  /(分から|わから|分かりません|わかりません)/,
];

/** 問いの言い回し（英語。小文字で比べる） */
const ASK_EN: RegExp[] = [
  /^(how|what|why|where|which|when|who|whose)\b/,
  /\b(how do i|how can i|how to|what is|what's|what are|what does|why is|why does|why did|where is|where do)\b/,
  /^(is|are|does|do|did|was|were|should|shall)\s+(it|this|that|there|i|we|you|they)\b/,
  /\bi (don't|do not|didn't) (understand|get it|know how)\b/,
];

/** 入力の 1 行目が問い返しか */
export function asksBack(line: string | null | undefined): boolean {
  const s = (line ?? "").trim();
  if (!s) return false;
  const en = s.toLowerCase().replace(/[’]/g, "'");
  // 情報を求める頼み（「教えて」「知りたい」）は問い返し
  if (/教えて|知りたい|聞きたい/.test(s)) return true;
  if (REQUEST_JA.test(s) || REQUEST_EN.test(en)) return false;
  if (/[?？]/.test(s)) return true;
  if (ASK_JA.some((re) => re.test(s))) return true;
  return ASK_EN.some((re) => re.test(en));
}
