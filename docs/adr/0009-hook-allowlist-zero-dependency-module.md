# ADR 0009: hooks の許可リストを collectors の依存ゼロのモジュールに置き、dl hook の import 制限を緩める

- ステータス: Accepted / Amends [ADR 0007](./0007-bun-1-4-pin-and-build-conditions.md)
- 日付: 2026-10-03
- 関係: ADR 0007 の決定 3 のうち「`hook` のモジュールは `node:fs` 以外を import しない」を、下の決定 2 に置き換える。0007 の他の決定はそのまま有効

## Context

仕様の中に、互いに両立しない記述が2つあった。

- ADR 0007 の決定 3 と phase0-plan 3.6: `dl hook` の起動時間（目標 50ms、S4 で p95 8.9ms）を保つため、`hook` のモジュールは `node:fs` 以外を import しない。
- phase0-plan 3.1 と 3.1.1: `dl hook` は collectors の `HookSpec.allowlist`（各アダプタが宣言する、spool に残すキー）を使う。依存方向の図にも `apps/cli ──▶ packages/collectors（dl hook が HookSpec.allowlist を使う）` とある。

`HookSpec` はアダプタのオブジェクトの一部なので、そのまま使うとアダプタ本体（パーサ、リーダ）を import することになり、0007 の制限に反する。M0 の実装はこの矛盾を避けるため、許可リストを `apps/cli/src/hook/allowlist.ts` に複製して置いた（コメントに「M1 でアダプタの HookSpec.allowlist に移す」とある）。複製のままだと、アダプタ側の許可リストと `dl hook` が実際に残すキーがずれても気づけない。許可リストは本文を spool に入れないための境界（ADR 0005）なので、正は1か所にしたい。

あわせて、`dl hook --tool claude|codex` の値と、アダプタの識別子（ToolId: `claude_code`、`codex`）の対応が決まっていなかった。

S4 で分かっているのは、起動時間を悪化させるのは「重いモジュールの評価」（全サブコマンドの静的 import、bytecode なし）だという点。`bun build --compile` は import を1つのバイナリに束ねるので、import を持たない定数だけのモジュールを1つ足しても、評価の費用はほぼ無い。

## 検討した案

| 案 | 内容 | 正が1か所 | 起動時間 | 守りやすさ | collectors の境界 |
|---|---|---|---|---|---|
| **A. collectors に依存ゼロのモジュールを置く（採用）** | `packages/collectors/src/hook-allowlist.ts`（import なし、定数のみ）。`dl hook` とアダプタの両方がこれを import する | ◎ | ◎ 定数の評価だけ | ○ Biome で「このファイルは import 禁止」「hook/ はこのモジュールだけ追加で許可」の2規則 | ○ `exports` に `./hook-allowlist` を1つ足す |
| B. 現状のまま apps/cli に置き、アダプタは spool の正規化だけをする | `dl hook` 側の許可リストを正とし、`HookSpec.allowlist` を廃止 | ○ | ◎ | ◎ | △ hooks を持つアダプタの PR が apps/cli の変更を伴う。アダプタ作者が許可リストを宣言する場所が2つに分かれる |
| C. ビルド時に生成する | アダプタの `HookSpec.allowlist` からビルドスクリプトが `apps/cli/src/hook/allowlist.gen.ts` を生成 | ◎ | ◎ | △ 生成物の更新忘れを CI で検査する仕組みが要る | ◎ |
| D. `dl hook` がアダプタを直接 import する | `adapters/<tool>/hooks.ts` を import | ◎ | × アダプタの依存（リーダ等）を評価する | × 0007 に反する | ◎ |

A は C と同じく正が1か所になり、生成の手順が要らない。B は手間が最も少ないが、「アダプタの許可リストは collectors で宣言する」という 3.1.1 の方針（コミュニティのアダプタ PR を collectors の中で完結させる）と合わない。

## Decision

1. **hooks の spool に残すキーは `packages/collectors/src/hook-allowlist.ts` を正とする。** このファイルは import を1つも持たず、定数だけを export する:
   - `HOOK_TOOL_IDS`: hooks を持つアダプタの ToolId（Phase0 は `['claude_code', 'codex']`）
   - `HOOK_ALLOWLIST`: ToolId → `{ events: readonly string[]; keys: readonly string[]; droppable: readonly string[] }`（`keys` は spool に残す順、`droppable` は 1 行 4KB を超えたときに後ろから落とすキー）
   - `package.json` の `exports` に `"./hook-allowlist": "./src/hook-allowlist.ts"` を足す。公開 IF の一部として扱う（phase0-plan 3.1.1）。
   - 各アダプタの `HookSpec.allowlist`（イベント名 → キー）はこの定数から作る。アダプタの中で別にキーを書かない。
2. **`dl hook` の import 制限を「`node:fs`、`hook/` 内のファイル、依存ゼロのモジュールとして登録したもの」に緩める。** 登録するのは現時点で `@dayline/collectors/hook-allowlist` だけ。依存ゼロであることは次の2つで守る:
   - Biome の override で `packages/collectors/src/hook-allowlist.ts` からの import をすべて禁止する（`noRestrictedImports` の `group: ["**"]`）。
   - `apps/cli/src/hook/**` の override の許可に `@dayline/collectors/hook-allowlist` を足す。登録を増やすときはこの ADR に追記する。
   - 起動時間の CI ベンチ（M0-10、p95 50ms 超で失敗）は従来どおり回す。
3. **`dl hook --tool` の値はアダプタの ToolId をそのまま使う**（`--tool claude_code` / `--tool codex`）。短い別名（`claude`）は置かない。spool の `tool`、`hook_event.tool`、`ai_source.tool` がすべて同じ値になり、変換表が要らない。M0 時点ではまだ hooks をユーザーの設定ファイルにインストールしていない（`dl hooks install` は M1-10）ので、互換のための別名も要らない。`--tool` が `HOOK_TOOL_IDS` に無ければ何もせず exit 0 にする（ツールを止めない）。
4. **移設は M1-14 で行う。** `apps/cli/src/hook/allowlist.ts` の `HOOK_KEYS` / `DROPPABLE_KEYS` を `hook-allowlist.ts` の `claude_code` と `codex` のエントリへ移し、`HOOK_TOOLS = ['claude', 'codex']` を `HOOK_TOOL_IDS` に置き換える。`dl --help` の表記（`dl hook --tool claude|codex`）とテストも直す。

## Consequences

- 本文を spool に入れないための許可リストが1か所になり、アダプタの宣言と `dl hook` の挙動がずれない。番兵テスト（phase0-plan 5.3）は hook-spool の経路も含めてこの定数を通る。
- `hook-allowlist.ts` に関数や import を足したくなっても足せない（lint で落ちる）。キーの抽出ロジック（長さの上限、4KB の切り詰め）は今までどおり `apps/cli/src/hook/run.ts` に置く。
- hooks を持つ新しいアダプタは、collectors の中で `hook-allowlist.ts` にエントリを足すだけで `dl hook` が受け付ける。インストーラ（`apps/cli/src/hooks-install/`）は別 PR のまま（phase0-plan 3.1.1 の手順 7）。
- ユーザーの hooks 設定に書かれるコマンドは `... hook --tool claude_code ...` になる。ToolId を変えると設定の書き換え（再インストール。Codex は再承認）が要るので、ToolId は一度決めたら変えない。
