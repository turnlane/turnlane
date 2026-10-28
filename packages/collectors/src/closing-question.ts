/**
 * 最終 assistant メッセージの性質をその場で判定する（phase0-plan 3.3.1、ai-session-ingestion 4.3、ADR 0005）。
 * 本文は引数で受け取ってすぐ捨てる。戻り値（真偽値）だけを残す。
 *
 * 判定の対象は最後の段落（コードブロック・インラインコードを除く）。次のときは直前の段落も含める（最大 600 文字）:
 *   - 最後の段落が箇条書き・表だけ
 *   - 最後の段落に相手の判断待ちの条件文（「決まったら〜お見せします」「once you decide, I'll」）がある
 *   - 最後の段落が短い締め（1〜2 文・120 文字以内）で、直前の段落が箇条書き・表だけ
 *   含めた直前の段落が箇条書き・表だけなら、さらにその前の段落（見出し）も含める。
 * それを文に分け、文ごとに見る（D-066 (1)）。
 *
 * - 質問の文: `?` / `？` を含む、答え・判断を求める言い回しを含む（「回答を待っています」「教えてください」
 *   「どうしますか」「決めていただきたい」「let me know」「should I」等）、疑問の終止形で終わる、問いの見出し
 *   （「決めていただきたいこと」「Questions for you」）、判断待ちの条件文、「〜にするか」「whether 〜」で終わる・始まる
 *   箇条書きの項目。作業の依頼（「確認してください」「ご確認いただければ」）は含めない
 * - 条件文の一般化: 「〜して（もらえ|いただけ|くれ…）（れば|たら|次第）」のあと AI の続きの動作（「〜します」「〜できます」
 *   「進みます」）で終わる文は判断待ちの条件文（「貼ってもらえれば判断します」「if you paste …, I'll …」）。
 *   礼や気持ちで終わるもの（「確認してもらえれば助かります」）は作業の依頼で、含めない
 * - データを求める依頼: 情報を受け取る動詞だけ（「貼ってください」「送ってください」「please send」）。作業の依頼
 *   （「確認してください」「試してください」「please review」）は含めない
 * - 未来の出来事を待つ条件節（「グラフが出たら」「結果が分かったら」「結果次第」「once the graph is up」）を含む文は、データを
 *   求める依頼・質問でも今答えるものではないので問いにしない。相手の動作・判断を待つ形（「貼ってもらえれば判断します」
 *   「決まったら〜します」「ご判断次第」）は今までどおり判断待ち
 * - 締めの決まり文句: 「他に何かありますか？」「必要であれば〜」「Anything else?」「if you need anything else」等。
 *   質問の文がすべて締めの決まり文句なら締めとし、返答タスクを作らず your_turn の (c) にも数えない（D-021）
 */

/** 疑問の終止形（`？` が無いもの） */
const QUESTION_TAIL =
  /(しますか|でしょうか|ますか|ですか|ませんか|いかがですか|よろしいですか|ましょうか)$/;

/** `?` / `？`。URL のクエリやコードの `?a=b` のように直後に英数字・`=` が続くものは除く */
const QUESTION_MARK = /？|\?(?![A-Za-z0-9=_&])/;

/** 答え・判断を求める言い回し（日本語）。文のどこかにあれば質問 */
const ASK_JA: RegExp[] = [
  /(回答|返答|返事|ご回答|ご返答|お返事|ご指示|指示|ご判断|判断|ご決定|決定|ご意見|意見|フィードバック|ご確認|確認|お答え|答え)(を|が)?(お)?待(って|ち)(い|お)?(ます|ております|る|して)/,
  /(教えて|お教え)(ください|下さい|くださ|もらえ|いただけ|頂け|ほしい|欲しい)/,
  /お聞かせ(ください|下さい|いただけ)/,
  /(決めて|お決め|選んで|お選び|選択して|ご選択|指定して|ご指定)(ください|下さい|いただけ|頂け|もらえ|ほしい|欲しい)/,
  /(ご指示|指示して|ご判断|判断して|ご承認|承認して|ご回答|回答して|ご返答|返答して)(ください|下さい|いただけ|頂け|もらえ|をお願い)/,
  /(回答|返答|ご回答|ご返答|ご指示|ご判断|お返事)をお願い/,
  /どう(します|しましょう|されます|いたしましょう|すれば|したら|すべき)/,
  /いかが(します|しましょう|いたしましょう|でしょう|ですか|なさいますか)/,
  /(よい|良い|いい|よろしい|大丈夫|問題ない|OK|ok)(です|でしょう)か/,
  /(確認|質問)させて(ください|下さい|いただけ|頂け|もらえ)/,
  /(お)?伺い(したい|させて|します)/,
  /(か|かどうか)(を)?(ご確認|お知らせ|教えて|お教え)(ください|下さい|いただけ|頂け)/,
  /(進めて|実行して|続けて|マージして|適用して|削除して|上書きして)(も)?(よい|良い|いい|よろしい|大丈夫)(です|でしょう)?か/,
  // 判断・答えを頼む形。「ご確認いただければ」は作業の依頼（レビューの依頼）なので入れない
  /(決めて|お決め|教えて|お教え|選んで|お選び|ご判断|ご指示|ご回答|ご返答|お返事)(いただきたい|頂きたい|いただけますか|いただければ|頂ければ|いただけると|頂けると|もらえますか|もらえれば|もらえると|ほしい|欲しい)/,
  // データを求める依頼（相手から情報を受け取る動詞だけ）。「確認してください」「試してください」は作業の依頼なので入れない
  /(貼って|貼り付けて|送って|共有して|見せて|載せて|書いて|記入して|記載して)(ください|下さい|もらえ(ます|ません)か|いただけ(ます|ません)か|ほしい|欲しい)/,
];

/**
 * 問いの見出し（文全体がこの形のとき）。「決めていただきたいこと」「ご判断いただきたい点」「確認したいこと」「質問」。
 * 「確認したいことがあれば」のような続きのある文には当てない
 */
const HEADING_JA: RegExp[] = [
  /^(決めて|お決め|選んで|お選び|ご判断|ご確認|ご指示|ご回答|教えて|お教え|お聞き|お伺い|伺い|確認|判断|相談|ご相談)(いただき|頂き|して(いただき|頂き|もらい)|し)?たい(こと|点|事項|項目)(が ?(あります|ございます|[0-9０-９一二三四五]+ ?(点|つ)(あります|ございます)?))?([（(][^）)]*[)）])?[:：]?$/,
  /^(質問|ご質問|ご相談|相談|確認事項|要確認|未決事項|決めること|判断が必要なこと|判断待ち)([（(][^）)]*[)）])?[:：]?$/,
];

/** 問いの見出し（英語。文全体。小文字にして比べる） */
const HEADING_EN: RegExp[] = [
  /^(open questions|questions for you|questions|decisions? (i need|needed|for you)( from you)?|things i need (from you|you to decide)|what i need from you)( \([^)]*\))?:?$/,
  /\bi need you to (decide|confirm|choose|pick)\b/,
];

/**
 * 相手の判断待ちの条件文: 「決まったら〜します」「ご指示があれば進めます」「OK なら〜」「よければ〜」。
 * 「必要であれば」「何かあれば」は締め（CLOSING_JA）で、ここには入れない
 */
const PENDING_JA: RegExp[] = [
  /(決まったら|決まりましたら|決まり次第|決まれば|決めていただけ(れば|たら)|ご判断(いただけ(れば|たら)|をいただけ(れば|たら))|ご指示(が(あれば|ありましたら)|をいただけ(れば|たら)|いただけ(れば|たら))|(お返事|ご返事|ご返答|ご回答)(を)?いただけ(れば|たら)|お選びいただけ(れば|たら)|(OK|ok|ＯＫ) ?(なら|でしたら|であれば)|(これで|この方針で|この案で)?(よろしければ|よければ))/,
];
/** 条件文の結び（「〜します」「進めます」「お見せします」。「〜ました」は除く）。条件の言い回しと両方あるときだけ条件文 */
const PENDING_JA_TAIL = /ます$/;
/** 礼や気持ちで終わる結び（「助かります」「幸いに存じます」「安心できます」）。条件文にしない */
const PENDING_JA_THANKS = /(助かり|幸い|ありがた|嬉し|うれし|安心)[^、。]{0,8}$/;

/**
 * 条件文の一般化: 「〜して（もらえ|いただけ…）（れば|たら|次第）」。結びは AI の続きの動作に限る（PENDING_JA_GENERAL_TAIL）。
 * 「見てもらえれば分かります」のような説明の文は結びで外れる
 */
const PENDING_JA_GENERAL =
  /[てで](もらえ|いただけ|頂け|くれ|もらっ|いただい|頂い|くださっ)(れば|たら|次第)/;
const PENDING_JA_GENERAL_TAIL =
  /(します|できます|しておきます|進みます|進めます|比べます|調べます|まとめます|切り分けます|考えます|作ります|書きます|続けます|戻します|決めます|絞ります|整えます|見ます|探します)$/;

/**
 * 未来の出来事を待つ条件節（日本語）: 「〜が出たら / できたら / 来たら / 届いたら / 分かったら / 終わったら / 上がったら /
 * 揃ったら / 取れたら」（主語の「が」「は」があるものだけ。「できたら教えてください」の「できれば」の意味は外す）と「〜次第」。
 * 相手の動作・判断を待つ形（「〜してもらえたら」「決まり次第」「ご判断次第」「いただき次第」）は入れない
 */
const FUTURE_JA: RegExp[] = [
  /[がは][^、。]{0,12}?(出|でき|来|届い|分かっ|わかっ|終わっ|上がっ|揃っ|そろっ|取れ|反映され|公開され|出揃っ)たら/,
  /(?<!(決まり|判断|指示|返事|返答|回答|都合|意見|確認|いただき|頂き|もらい|くれ))次第/,
];
/** 未来の出来事を待つ条件節（英語。小文字にして比べる）: "once / when / after X is (ready|available|in|up|out) …" */
const FUTURE_EN =
  /\b(once|when|after)\s+(?!you\b|i\b|we\b)[^,.;:]{1,60}?\b(is|are|has been|have been|gets|get|comes|come)\s+(ready|available|in|up|out|done|finished|back|published|deployed|live)\b/;

/** 未来の出来事を待つ条件節を含む文か（今答えるものではない） */
export function isFutureWaitSentence(s: string): boolean {
  const body = s.replace(/[。.!！]+$/, "");
  if (PENDING_JA_GENERAL.test(body) || PENDING_JA.some((re) => re.test(body))) return false;
  if (FUTURE_JA.some((re) => re.test(body))) return true;
  return FUTURE_EN.test(lower(s));
}

/** 相手の判断待ちの条件文（英語。小文字にして比べる） */
const PENDING_EN: RegExp[] = [
  /\bonce you('ve| have)? (decide|decided|confirm|confirmed|choose|chosen|pick|picked|approve|approved|reply|replied)\b/,
  /\bwhen you('ve| have) (decided|confirmed|chosen|picked|approved)\b/,
  /\bafter you (decide|confirm|choose|pick|approve|reply)\b/,
  /\bif (that|this|it) (works|sounds good|looks good|is ok|is okay|is fine)( (for|to) you)?,? i('ll| will)\b/,
  /\blet me know and i('ll| will)\b/,
  // 条件文の一般化: 相手がデータを渡すまで AI が進めない（"if you paste the numbers here, i'll compare …"）
  /\bif you (can |could )?(paste|send|share|post|give me|drop|tell me|let me know)\b.*\bi('ll| will| can)\b/,
];

/**
 * 箇条書きの項目の問い（日本語）: 「〜にするか」「進めてよいか」「含めるかどうか」で終わる。
 * 過去形（「なぜ落ちていたか」）や「〜のか」は報告の項目に多いので入れない
 */
const ITEM_JA = /([うくぐすつぬぶむるい]|べき)(か|かどうか)(を)?$/;
/** 箇条書きの項目の問い（英語）: whether で始まる、which で始まり to / should 等が続く（"Which files changed" は見出しなので除く） */
const ITEM_EN_HEAD = /^whether\s|^which\s.*\b(to|should|do|would|is better|works better)\b/;
/** 箇条書きの項目の問い（英語）: 短い「A or B」。過去形・三単現で始まる報告（"Fixed A or B", "Supports A or B"）は除く */
const ITEM_EN_OR = /^(?!\w+(ed|s)\b)[^,.;:]{1,60}\bor\b[^,.;:]{1,60}$/;

/** 答え・判断を求める言い回し（英語。小文字にして比べる） */
const ASK_EN: RegExp[] = [
  /\blet me know\b/,
  /\bwhich (one|option|approach|way|version|do you|would you|should|of these|of the)\b/,
  /\b(should|shall) i\b/,
  /\b(do|would) you (want|like|prefer) me to\b/,
  /\b(do|would) you prefer\b/,
  /\bwhat would you like\b/,
  /\bhow would you like\b/,
  /\b(waiting|wait) (for|on) your\b/,
  /\bawaiting your\b/,
  /\bi need your (input|decision|answer|confirmation|approval|go-ahead)\b/,
  /\bplease (confirm|choose|pick|select|decide|advise|answer|reply|respond|clarify|approve)\b/,
  /\b(can|could) you (confirm|clarify|choose|decide|tell me)\b/,
  /\b(is it|is that|is this) (ok|okay|fine|alright)\b/,
  /\b(ok|okay) to (proceed|continue|merge|apply|delete|push)\b/,
  /(^|\b(it'?s|that'?s) )your call\b/,
  // データを求める依頼。"please review / check / run" は作業の依頼なので入れない
  /\bplease (paste|send|share|post)\b/,
  /^(can you |could you )?(paste|send|share)\b.*\b(here|below|and i('ll| will))\b/,
];

/** 締めの決まり文句（日本語）。文に対して判定する */
const CLOSING_JA: RegExp[] = [
  /^(他|ほか)に(も)?(何か|なにか)?(ご質問|ご要望|お手伝い|お手伝いできること|対応すること|やること|気になる(点|こと)|確認したいこと|必要なこと)?(は|が)?(あります|ございます|あれば)/,
  /^(何か|なにか)(他|ほか)に(も)?(ご質問|ご要望|お手伝い(できること)?|必要なこと|気になる(点|こと))?(は|が)?(あります|ございます)/,
  /^(何か|なにか)(ご質問|ご不明な点|不明な点|気になる(点|こと))(は|が)?(あります|ございます)/,
  /^(ご質問|ご不明な点|不明な点|気になる(点|こと))(は|が)(あります|ございます)/,
  /(他|ほか)に(も)?(何か|なにか)?(お手伝い|手伝え|お役に立て)(できる|る)?(こと)?(は|が)(あります|ございます)/,
  /(何か|なにか)(あれば|ありましたら|ございましたら)/,
  /(他|ほか)に(も)?(何か|なにか)?(あれば|ありましたら|ございましたら)/,
  /(必要|ご必要|要望|ご要望|希望|ご希望)(が|で)?(あれば|ありましたら|ございましたら|でしたら|であれば|に応じて)/,
  /(ご不明な点|不明な点|ご質問|質問|気になる点|追加のご要望)(が|は)?(あれば|ありましたら|ございましたら)/,
  /^(他|ほか)に(も)?(何か|なにか)?(ありますか|ありませんか|ございますか)/,
  /^以上(です|になります)(が|。)?(他|ほか)に/,
  /(続けて|引き続き)(何か)?(お手伝い|対応)(できること|すること)?(は|が)?(あります|ございます)/,
  /お気軽に/,
];

/** 締めの決まり文句（英語）。文に対して判定する（小文字にして比べる） */
const CLOSING_EN: RegExp[] = [
  /^(is there )?anything else( (i can|you'?d like me to|you want me to|you need|to)\b.*)?[?.!]?$/,
  /^(do you )?need anything else\b/,
  /^let me know if (you('d| would)? (like|want|need)|there('s| is) anything|anything|you have (any )?(other |more |further )?questions|i can help|you('d| would) like any)/,
  /^(please )?(feel free|don'?t hesitate) to (ask|let me know|reach out)/,
  /^(any|do you have any) (other |more |further )?questions\b/,
  /^(i )?hope (this|that) helps\b/,
  /^happy to help( with anything else| further)?\b/,
  /^what else can i (help|do)\b/,
  /^(can|may|could) i help (you )?with anything else\b/,
  /^is there anything (else )?(i can|you'?d like|you want)\b/,
  /^just let me know if\b/,
  /^shall i help with anything else\b/,
  /\bif (you need|there'?s|there is|you have) anything else\b/,
  /\bif you (have|need) (any )?(other |more |further )?(questions|help|changes)\b/,
  /\b(feel free|don'?t hesitate) to\b/,
  /\bhappy to (help|adjust|make (any )?(further )?changes)\b/,
];

/** コードブロック・インラインコードを除き、行末の空白をそろえる */
function stripCode(text: string): string {
  return text
    .replace(/```[\s\S]*?(```|$)/g, "\n\n")
    .replace(/~~~[\s\S]*?(~~~|$)/g, "\n\n")
    .replace(/`[^`\n]*`/g, "X")
    .replace(/\r\n?/g, "\n");
}

const LIST_LINE = /^\s*([-*+•]|\d+[.)]|\|)/;

/** 表示用: コードブロックは除き、インラインコードは中身を残す（glance。spec-glance §4.2） */
function stripCodeForDisplay(text: string): string {
  return text
    .replace(/```[\s\S]*?(```|$)/g, "\n\n")
    .replace(/~~~[\s\S]*?(~~~|$)/g, "\n\n")
    .replace(/`([^`\n]*)`/g, "$1")
    .replace(/\[([^\]\n]+)\]\([^)\s]+\)/g, "$1")
    .replace(/\r\n?/g, "\n");
}

/** 文の分け目（文末の記号を含む。行は先に分ける） */
const SENTENCE_END = /(?<=[。！!？]|[.?](?=\s|$))/;

const isListOnly = (para: string): boolean => {
  const lines = para.split("\n").filter((l) => l.trim().length > 0);
  return lines.length > 0 && lines.every((l) => LIST_LINE.test(l));
};

/** 段落を文に分ける（行の中を文末で分ける。箇条書き・表の行から来た文には item を付ける） */
function splitSentences(para: string): { s: string; item: boolean }[] {
  return para.split("\n").flatMap((line) => {
    const item = LIST_LINE.test(line);
    return line
      .split(SENTENCE_END)
      .map(clean)
      .filter((s) => s.length > 0)
      .map((s) => ({ s, item }));
  });
}

/** 短い締め: 1〜2 文・合計 120 文字以内 */
function isShortTail(para: string): boolean {
  const ss = splitSentences(para);
  return ss.length > 0 && ss.length <= 2 && ss.reduce((n, x) => n + x.s.length, 0) <= 120;
}

/**
 * 判定の対象（最大 600 文字）。最後の段落。次のときは直前の段落も含める: 最後の段落が箇条書き・表だけ、
 * 最後の段落に判断待ちの条件文がある、最後の段落が短い締めで直前の段落が箇条書き・表だけ。
 * 含めた直前の段落が箇条書き・表だけなら、その前の段落（見出し）も含める
 */
export function lastParagraph(text: string, strip: (s: string) => string = stripCode): string {
  const paras = strip(text)
    .split(/\n\s*\n/)
    .map((p) => p.trim())
    .filter((p) => p.length > 0);
  const last = paras.at(-1);
  if (last === undefined) return "";
  const prev = paras.at(-2);
  if (prev === undefined) return last.slice(-600);
  if (isListOnly(last)) return `${prev}\n${last}`.slice(-600);
  const pending = splitSentences(last).some((x) => isPendingSentence(x.s));
  const prevList = isListOnly(prev);
  if (!pending && !(prevList && isShortTail(last))) return last.slice(-600);
  const head = prevList ? paras.at(-3) : undefined;
  const target = head !== undefined ? `${head}\n${prev}\n${last}` : `${prev}\n${last}`;
  return target.slice(-600);
}

/** Markdown の装飾や末尾の閉じ括弧を外す */
function clean(s: string): string {
  return s
    .replace(/^\s*([-*+•>#]+|\d+[.)])\s*/, "")
    .replace(/[*_~]+/g, "")
    .replace(/[\s)）」』"'】]+$/g, "")
    .trim();
}

/** 判定の対象を文に分ける（文末の記号を含む） */
function sentences(
  text: string,
  strip: (s: string) => string = stripCode,
): { s: string; item: boolean }[] {
  return splitSentences(lastParagraph(text, strip));
}

function lower(s: string): string {
  return s.toLowerCase().replace(/[’]/g, "'");
}

/** 相手の判断待ちの条件文か（「決まったら〜お見せします」「once you decide, I'll …」） */
export function isPendingSentence(s: string): boolean {
  const body = s.replace(/[。.!！]+$/, "");
  if (!PENDING_JA_THANKS.test(body)) {
    if (PENDING_JA.some((re) => re.test(body)) && PENDING_JA_TAIL.test(body)) return true;
    if (PENDING_JA_GENERAL.test(body) && PENDING_JA_GENERAL_TAIL.test(body)) return true;
  }
  const en = lower(s);
  return PENDING_EN.some((re) => re.test(en));
}

/** 答え・判断を求める文か */
export function isAskingSentence(s: string): boolean {
  // 未来の出来事を待つ依頼・質問（「グラフが出たら見せてください」）は今答えるものではない
  if (isFutureWaitSentence(s)) return false;
  if (QUESTION_MARK.test(s)) return true;
  const body = s.replace(/[。.!！]+$/, "");
  if (QUESTION_TAIL.test(body)) return true;
  if (ASK_JA.some((re) => re.test(s))) return true;
  if (HEADING_JA.some((re) => re.test(body))) return true;
  const en = lower(s);
  if (ASK_EN.some((re) => re.test(en))) return true;
  if (HEADING_EN.some((re) => re.test(lower(body)))) return true;
  return isPendingSentence(s);
}

/** 箇条書きの項目の問いか（「A にするか B にするか」「whether …」「A or B」） */
function isAskingItem(s: string): boolean {
  const body = s.replace(/[。.!！]+$/, "");
  if (ITEM_JA.test(body)) return true;
  const en = lower(body);
  return ITEM_EN_HEAD.test(en) || (ITEM_EN_OR.test(en) && en.split(/\s+/).length <= 8);
}

const asks = (x: { s: string; item: boolean }): boolean =>
  isAskingSentence(x.s) || (x.item && isAskingItem(x.s));

/** 締めの決まり文句の文か */
export function isClosingSentence(s: string): boolean {
  if (CLOSING_JA.some((re) => re.test(s))) return true;
  const en = lower(s);
  return CLOSING_EN.some((re) => re.test(en));
}

/** 判定の対象に答え・判断を求める文があるか（締めの決まり文句も含む） */
export function endsWithQuestion(text: unknown): boolean {
  if (typeof text !== "string") return false;
  return sentences(text).some(asks);
}

/** 判定の対象の質問の文がすべて締めの決まり文句か（質問の文が無ければ、最後の文が締めの決まり文句か） */
export function isClosingQuestion(text: unknown): boolean {
  if (typeof text !== "string") return false;
  const ss = sentences(text);
  const asking = ss.filter(asks);
  if (asking.length === 0) {
    const last = ss.at(-1);
    return last !== undefined && isClosingSentence(last.s);
  }
  return asking.every((x) => isClosingSentence(x.s));
}

/** アダプタ用: 最終テキストの性質（本文は返さない） */
export function textTraits(text: unknown): { question: boolean; closing: boolean } {
  if (typeof text !== "string") return { question: false, closing: false };
  const asking = sentences(text).filter(asks);
  const question = asking.length > 0;
  return { question, closing: question && asking.every((x) => isClosingSentence(x.s)) };
}

const cut = (s: string, n: number) => (s.length > n ? `${s.slice(0, n - 1)}…` : s);

/**
 * 表示用（glance。D-207、spec-glance §4.2）: 最後のメッセージの問いの文。締めの決まり文句を除いた問いの文の最後の 2 文、
 * 無ければ最後の文。判断待ちの条件文（「決まったら〜します」）は、ほかに問いの文があればそちらを出す。
 * row は行に出す 1 文（80 文字まで）、detail は詳細に出す 2 文（300 文字まで）。
 * 本文を返すので、表示の瞬間にだけ呼ぶ（戻り値を保存・ログに出さない。ADR 0005 の追記）
 */
export function questionExcerpt(text: unknown): { row: string; detail: string } | null {
  if (typeof text !== "string") return null;
  const ss = sentences(text, stripCodeForDisplay);
  const asking = ss.filter((x) => asks(x) && !isClosingSentence(x.s));
  const core = asking.filter((x) => !isPendingSentence(x.s));
  const picked = (core.length > 0 ? core : asking.length > 0 ? asking : ss).slice(
    core.length > 0 || asking.length > 0 ? -2 : -1,
  );
  const last = picked.at(-1);
  if (last === undefined) return null;
  return { row: cut(last.s, 80), detail: cut(picked.map((x) => x.s).join(" "), 300) };
}
