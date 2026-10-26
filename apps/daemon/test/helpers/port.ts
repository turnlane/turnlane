/**
 * 空いているポート。OS に port 0 で選ばせてすぐ閉じる（e2e/harness.ts の freePort と同じ方法）。
 * 乱数で選ぶと他のプロセスが使っている番号に当たり、デーモンの起動が EADDRINUSE で落ちることがある。
 * paths.port のように起動前に番号を決めておく必要があるテストで使う（startDaemon だけなら port: 0 を渡す）
 */
export function freePort(): number {
  const s = Bun.listen({ hostname: "127.0.0.1", port: 0, socket: { data() {} } });
  const p = s.port;
  s.stop(true);
  return p;
}
