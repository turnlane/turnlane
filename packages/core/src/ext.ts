/**
 * 拡張点の版（ADR 0015）。デーモン（apps/daemon/src/ext/types.ts）と Web（apps/web/src/ext/types.ts）の拡張の型を
 * 互換でない形に変えたら上げる。版の合わない拡張は組み込まない
 */
export const EXT_API_VERSION = 2;
