映画データのマイグレーションテスト

通常実行はファイル確認だけです。Docker・DB・Supabaseへ接続しません。
DBテストは別途承認されたときだけ、明示的な --run-disposable-db で実行します。
今回の作業では、Docker起動・SQL実行・既存LOCAL操作は行いません。

```sh
python3 -B tests/movie-access/run.py
python3 -B -m unittest discover -s tests/movie-access -p 'test_*.py' -v
```

この確認は、既存4本のハッシュ、RPC引数型、Python構文、4パターンの計画、
テスト実行制御と安全ガードが対象です。SQL構文・SQL動作・RLSの合格を意味しません。
安全ガードのテストでは、外部コマンドを禁止または模擬応答へ置き換えます。

DBテストの入口（今回未実行。DBテスト承認後のみ）：

```sh
python3 -B tests/movie-access/run.py --run-disposable-db
```

4パターンを並列にせず、毎回別の新しいコンテナで順次実行します。

| パターン | 初期権限 | 適用方法 |
| --- | --- | --- |
| fresh-restricted | 自動公開OFF相当 | 空のアプリ用DBへ5本を連続適用。その後に架空データを作成 |
| fresh-broad | 広い既定権限 | 同じく5本を連続適用してから架空データを作成 |
| upgrade-restricted | 自動公開OFF相当 | 4本→架空データ・意図的な過剰権限→5本目 |
| upgrade-broad | 広い既定権限 | 同じく既存データ保持と権限修正を検証 |

自動公開OFF相当でも、PostgreSQL標準のPUBLIC関数実行権限は残します。
自動RLSは public の新規テーブルに作用するテスト用イベントトリガーで再現します。
これらはSupabaseクラウドの実設定を読み取ったものではありません。

適用するSQLは、以下の固定5本だけです。すべて非スーパーユーザーの postgres 接続で実行します。

1. 20261024000100_tmdb_rate_limit.sql
2. 20261031000100_google_invite_auth.sql
3. 20261103085903_movie_log_local_schema.sql
4. 20261103094134_movie_log_delete_function.sql
5. 20261104000100_movie_log_access_privileges.sql

各SQLは ON_ERROR_STOP=1 で実行し、失敗したら後続SQL・後続パターンへ進みません。
ファイルの場所、失敗パターン、段階、取得できるSQLSTATEを報告します。
SQL本文・生のエラー・引数・接続情報・パスワード・キー・トークンは出力しません。
不明な引数も入力値を表示せず拒否します。DB URL・既存コンテナを指定する機能はありません。

Docker隔離チェックで `unexpected_container_settings` が出た場合は、
不一致項目ごとに `MISMATCH` 行を追加し、`item`（設定項目）、`expected`（期待値）、
`actual`（安全に表示できる実際の値）をJSON形式で示します。
`phase` は `pre-start`（起動前）、`post-start`（起動後）、
`post-tests`（SQLテスト終了時）です。後片付けの失敗は従来どおり `cleanup-*` 段階で示します。

CPU・メモリ上限などの数値と、許可リストに含まれる設定文字列だけを表示します。
予期しないパス・ボリューム名・ネットワーク名・ポート設定の中身は伏せ、件数などで示します。
環境変数の値や生の `docker inspect` は出力しません。診断処理が失敗した場合もSQL実行へ進まず、
`unavailable-values-suppressed` として停止します。
診断用の表示は安全判定に使いません。たとえば `CAP_ALL` と `ALL`、
`size=512m` と `size=536870912` は表示できても同一視せず、従来どおり不一致として停止します。
この診断追加だけでは、前回のエラーの原因が確定・解消したことにはなりません。

起動後の `State.Running=false` は、隔離設定の不一致とは分けて扱います。
起動確認中は `stage=container-startup`、テスト終了時は `stage=container-runtime`、
理由は `reason=container_exited` として停止します。
`CONTAINER` 行には `ExitCode`（終了コード）、`OOMKilled`（Dockerが記録したOOM終了の有無）、
`Running`、固定の `message` を表示します。不明な値は `<unavailable>` とし、
終了コードだけからOOMが起きたと推測することはありません。

初期化とサーバー起動の区別には、このテストの起動スクリプトが出す固定の進捗マーカーを使います。
コンテナが終了した場合に限り、本人確認済みのテスト専用コンテナのログ末尾16行を
最大5秒・残り実行時間の範囲内で読み、完全一致するマーカーだけを判別します。
Dockerログの原文は表示・例外に保存しません。
`initdb` とPostgreSQL自身の出力は、コンテナ内の一時領域のログへ送ります。

| 固定メッセージ | 意味 |
| --- | --- |
| `initdb_failed` | 初期化コマンドが失敗して終了した |
| `initdb_did_not_complete` | 初期化開始まで確認できたが、完了は確認できない |
| `postgres_start_or_runtime_failed` | 初期化成功後、サーバー起動へ進んだ後に終了した |
| `startup_step_unknown` | マーカーを確認できず、どこまで進んだか不明 |

これは失敗段階の判別であり、細かな原因の確定ではありません。
ログ取得失敗や時間切れでも終了状態の報告と後片付けを続け、自動再起動はしません。
稼働状態が不明な場合も `container_state_unavailable` として停止します。
隔離違反と終了が同時に見つかった場合は、隔離違反の報告を優先します。
稼働中はネットワーク `none` の接続確認も必須で、停止中の接続情報が消えていてもSQLへ進みません。
Docker自体の起動コマンドが失敗した場合は `docker_start_failed`、
そのコマンドの時間切れは `command_timeout` として `container-startup` 段階で報告します。

隔離と上限：

- ローカルDocker Unixソケットだけを認め、確定した接続先を全操作に使用。
- 保存済み public.ecr.aws/supabase/postgres:17.11.0.002 をイメージIDに固定して使用。
  見つからなければ停止し、ダウンロードしません。
- ネットワーク none、公開ポートなし、ホスト共有なし、既存ボリューム共有なし。
  VOLUMEを宣言するイメージも拒否します。
- 非rootのOSユーザー、読み取り専用ルート、全capability削除、権限昇格禁止。
- CPU 1個分、メモリ1GiB、追加swapなし、プロセス数128、一時領域 /tmp 512MiB。
- 各パターン240秒、全体1200秒、通常コマンド最大20秒、SQL実行クライアント最大15秒。
- DB文の実行10秒・ロック待ち2秒・アイドルトランザクション15秒。
- コンテナ内のBusyBox timeoutも240秒＋強制終了猶予5秒でDB寿命を制限。
  BusyBox 1.37対応の `timeout -s TERM -k 5 240 ...` を使用します。
  キャッシュ済みイメージにこのコマンドがなければ、起動失敗として停止します。
- 起動前後に実設定を確認し、隔離・上限に不一致があればSQL実行へ進みません。
- テスト失敗や時間切れでも、別枠の20秒で後片付けを試みます。
  ラベル・固有名・コンテナIDが一致する今回のコンテナだけを削除します。
- volume rm、prune、rm -v、既存Supabaseの停止・起動・db reset等は使用しません。
  後片付けを確認できない場合もエラーで止まり、他の資源を削除して対処しません。

検証対象：

- テーブル5個と関数7個の所有者、関数のSECURITY INVOKER/DEFINER。
- 映画RPC所有者は postgres。利用者は非所有者・非スーパーユーザー・RLS回避権限なし。
- 3RPCは authenticated のみ実行可。匿名、UIDなし、他ユーザーの操作を拒否。
- 本人の登録・編集・削除の戻り値に加え、保存値、更新日時、削除後の行消失を確認。
- シリーズ順変更で他人の行を変えないことを、Bの行全体との比較で確認。
- RLS有効化・ポリシー数・テーブルと列の権限・権限委譲・TRUNCATE等を検査。
- 権限修正でデータ、関数本体、ポリシー、トリガー、無関係な権限を保持。
- 招待HookがAuth専用ロールで架空の招待済みGoogleイベントを許可し、TMDb制限が動く。

拒否テストでは、権限不足（42501）だけを想定したエラー成功とします。
他人の行はRLSにより0件や not_found になる場合があるため、実データの無変更も確認します。
単なるSQL構文エラーを「拒否できた」とは扱いません。
TMDb内部のDEFINERは意図されたものです。専用NOLOGIN所有者と限定した実行権限を検査します。

ファイルの役割：

- bootstrap.sql：空クラスタに模擬Auth・ロール・自動RLSを作成。ユーザー行はまだ作らない。
- seed.sql：架空のユーザー2人・作品・招待を作成。
- inject_legacy.sql：権限修正パターンだけで過剰なACL・旧DEFINER属性を再現。
- prepare.sql：共通の検査用関数と、保持すべきデータ・権限のスナップショット。
- catalog.test.sql：所有者・ロール属性・RLS・ポリシー数・未実装機能の確認。
- access.test.sql：アクセス制限、本人の正常操作、他ユーザーのデータ保持、互換性。
- test_safety.py：Dockerを呼ばない実行制御・隔離・削除・時間制限・エラー表示テスト。
- test_diagnostics.py：不一致項目・期待値・実際値、3段階の区別、秘密情報の伏せ字、厳密な拒否の静的テスト。
- test_startup.py：起動失敗と隔離違反の区別、終了コード・OOM、固定進捗マーカー、失敗時の後片付けの静的テスト。

模擬認証と実際のSupabase認証の違い：

このDBでは auth.users と auth.uid() を最小限のSQLで再現し、SET ROLEと架空のsubjectで
PostgreSQLの権限・RLS・関数を検証します。JWT署名の検証や実ログインは行いません。
Supabase Authの内部スキーマ、予約ロールへの接続制限、PostgREST/Data APIの公開設定、
実際のGoogle OAuth・リダイレクト・キャンセル・ブラウザー保存は合格対象に含みません。
これらは後日、別途承認された隔離Supabase環境で統合試験が必要です。
service_roleはサーバー用でRLSを回避します。ブラウザーにキーを渡してはいけません。

バックアップ復元関数 restore_movie_logs_from_backup は5本のSQLに存在しません。
この未実装状態を明示的に確認しますが、復元機能の成功とは扱いません。
復元は別途実装・試験するか、STAGINGの公開対象から外す必要があります。
既存LOCAL・STAGING・PRODUCTIONのユーザーや映画データは読み取りもコピーも行いません。
