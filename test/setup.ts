// bun test の preload。タイムゾーンを固定し、テストが実行環境の TZ に依存しないようにする。
// 時刻そのものは各テストで FakeClock（@turnlane/core の clock.ts）を渡して固定する。
process.env.TZ = "Asia/Tokyo";
