/**
 * メタデータ専用のロガー（ADR 0005）。会話本文をログに書けないよう、受け取れる値を型で絞る。
 *
 * - 値は number / boolean / null と、meta() を通した文字列（MetaString）だけ
 * - meta() は長さを切り詰める（既定 200 文字）。本文を meta() に通すことはレビューで禁止する
 * - イベント名は `[a-z0-9_.:-]` だけ。違反したら実行時に置き換える
 */

declare const metaBrand: unique symbol;
/** ログに書いてよいと宣言した短い文字列（パス、ID、列挙値、エラー名など） */
export type MetaString = string & { readonly [metaBrand]: true };

export type LogValue = number | boolean | null | undefined | MetaString | readonly MetaString[];
export type LogFields = Readonly<Record<string, LogValue>>;
export type LogLevel = "debug" | "info" | "warn" | "error";

export interface MetaOnlyLogger {
  debug(event: string, fields?: LogFields): void;
  info(event: string, fields?: LogFields): void;
  warn(event: string, fields?: LogFields): void;
  error(event: string, fields?: LogFields): void;
}

export const META_MAX_LENGTH = 200;

export function meta(s: string, max = META_MAX_LENGTH): MetaString {
  return (s.length > max ? `${s.slice(0, max)}…` : s) as MetaString;
}

const EVENT_RE = /^[a-z0-9_.:-]{1,64}$/;

export function safeEventName(event: string): string {
  return EVENT_RE.test(event) ? event : "invalid_event_name";
}

/**
 * 例外をログ用のフィールドにする。message はパーサの例外だと入力の断片を含みうるので既定では出さない。
 */
export function errorFields(e: unknown, opts: { includeMessage?: boolean } = {}): LogFields {
  const err = e instanceof Error ? e : new Error(String(e));
  const code = (err as { code?: unknown }).code;
  return {
    error_name: meta(err.name, 64),
    ...(typeof code === "string" ? { error_code: meta(code, 64) } : {}),
    ...(opts.includeMessage ? { error_message: meta(err.message) } : {}),
  };
}

/** 何も出力しないロガー（テスト用） */
export const nullLogger: MetaOnlyLogger = {
  debug() {},
  info() {},
  warn() {},
  error() {},
};
