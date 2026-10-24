Movie Log TMDbレート制限のローカルテスト

このディレクトリのテストは本番キー・本番DBを必要としません。実際のキーを渡さないでください。
テスト依存パッケージ・ブラウザ・検証結果は、リポジトリ外の一時ディレクトリへ配置できます。

1. `edge.test.ts`：実Functionと固定バージョンのSupabase
   SDKを実行します。Authは署名・発行元・期限を検証する模擬実装、制限ストアとTMDbも模擬です。実行時のネットワークを禁止できます。

```sh
deno check --no-config --node-modules-dir=none --no-lock supabase/functions/tmdb/index.ts
deno test --no-check --no-config --node-modules-dir=none --no-lock --cached-only --deny-net --allow-read tests/tmdb-rate-limit/edge.test.ts
```

最初の型チェックでSDKをキャッシュしてからテストします。結果をJSONに保存する場合は、許可する一時出力先を`--allow-write`へ追加し、`-- <出力JSONパス>`を末尾に付けてください。鍵と署名付き架空JWTはメモリ内だけで扱います。

2. `postgres.cjs`：新しい一時PostgreSQLクラスタを作り、マイグレーションを適用します。PostgREST、Supabase
   JS、Functionからの呼び出し、権限拒否、3制限と並列アクセスを実際のPostgreSQLで検証します。

必要な実行環境：Node.js（`node:module.stripTypeScriptTypes`対応）、PostgreSQL
16以降の`initdb`・`pg_ctl`・`postgres`、PostgREST、`pg`、`@supabase/supabase-js@2.117.2`。

クラスタ初期構築と比較用データ作成だけをsuperuserで行います。マイグレーションは別の非superuser接続で実行します。検証用postgresはCREATEROLEあり、SUPERUSER・BYPASSRLS・INHERITなしです。管理者属性を持たず、postgresへのSETだけを許可されたCLI用一時ロールからの適用・撤去も確認します。本番Supabaseの管理者権限・バージョン・独自トリガーを再現し尽くしたテストではありません。

- `MOVIE_LOG_TEST_PG_BIN`：PostgreSQLのbinディレクトリ。
- `MOVIE_LOG_TEST_POSTGREST`：PostgREST実行ファイルの絶対パス。
- `MOVIE_LOG_TEST_DEPS`：`pg`とSupabase JSを配置したnode_modulesディレクトリ。

```sh
node tests/tmdb-rate-limit/postgres.cjs
```

DBはループバックだけで待ち受け、終了時に停止します。リモートDBのURLは受け付けません。作成先と結果JSONのパスを表示します。既存作品・4RPC・RLSは隔離DBに用意した比較用の模擬オブジェクトであり、本番定義の検証ではありません。

PostgRESTのJWT検証・ACL・RPC・SQLトランザクションは実物です。Supabaseホスティング側のSecretキーからservice_roleへの変換だけはローカルHTTPゲートウェイで模擬します。これは本番Supabase
APIゲートウェイの検証を意味しません。

3. `browser.cjs`：実フロントエンドと実SDKを使い、Auth・RPC・TMDbは模擬します。Chromium・WebKitそれぞれ1440×1000、390×844、375×667で、JWT、キャンセル、タイムアウト、429・503、手動保存と表示を確認します。

追加で必要：Playwrightと対応ブラウザ、ローカルのTailwindブラウザ用バンドル。

- `MOVIE_LOG_TEST_DEPS`：PlaywrightとSupabase JSのnode_modulesディレクトリ。
- `MOVIE_LOG_TEST_OUTPUT`：結果・画像を保存する一時ディレクトリ。
- `MOVIE_LOG_TEST_TAILWIND`：ローカルTailwindバンドルのパス。
- `MOVIE_LOG_TEST_CHROMIUM`：任意。既存Chromium／Chromeの実行ファイル。
- `PLAYWRIGHT_BROWSERS_PATH`：任意。インストール済みPlaywrightブラウザの配置先。

```sh
node tests/tmdb-rate-limit/browser.cjs
```

外部URLへのブラウザ通信を遮断します。フォント用リンクも除外するため、本番Webフォント・iPhone実機の確認の代わりにはなりません。HTML・CSSの変更有無はGitのHEADとも比較します。

4. マイグレーションと復旧について

SQLは公開の`public.consume_tmdb_rate_limit(uuid)`をSECURITY
INVOKERとし、非公開の`tmdb_rate_limit_private.consume_internal(uuid)`だけをSECURITY
DEFINERにします。公開RPCはpostgres、内部関数・2テーブルは専用NOLOGINロールが所有します。service_roleには両関数のEXECUTEと非公開スキーマのUSAGEだけを付与し、テーブル・シーケンスへの直接操作は拒否します。

専用所有者にpublicスキーマのCREATEは付与しません。マイグレーション中だけpostgresにSET許可を付け、INHERITは許可せず、終了時に自分が付けたメンバーシップを撤去します。PostgreSQLがbootstrap
superuser名義で自動付与するADMINメンバーシップは管理用に残り、SET・INHERITはfalseです。Supabase管理の付与を無理に撤回しません。

GRANTのSET・INHERITオプションを使うためSQLはPostgreSQL
16以降が前提です。接続セッションからSET ROLE
postgresでき、postgresにロール作成・DB内スキーマ作成・public内関数作成が許可されている必要があります。本番適用前に読み取りで確認してください。

既存名に衝突したら、未知の定義を再利用せず中止します。制限の調整は管理者による専用settings行の変更で行い、APIの引数や環境変数で上限を指定しません。

本番適用はこのテストの対象外です。後日承認後、既存オブジェクト・権限を事前確認し、SQL、JWT送信・429表示対応フロントエンド、Functionの順で反映して確認します。Functionを先に反映すると、旧公開版や未準備のRPC／Secretで検索が失敗します。

復旧時はまずJWT認証を維持したレート制限追加前のFunctionへ戻します。参照がなくなった後、公開RPCを撤去し、内部オブジェクト撤去用に専用所有者への一時SET許可だけを再付与します。内部関数・2テーブル・専用スキーマを撤去し、postgresへ戻り、自分で付けたSET用メンバーシップを撤回してから専用ロールを削除します。この順序は非superuserのpostgres／CLI接続でテストしています。

既存作品や4RPCを削除したり、スキーマpublic全体へREVOKEしたりしません。DROP
ROLEの前には所有・権限の依存関係を確認します。bootstrap
superuserによる自動ADMIN付与の撤回は不要で、postgresから無理に撤回しようとしません。

Secretキーは共通service_role権限を持ち、専用名でもRPC限定キーにはなりません。実キーをコード・ログ・ブラウザへ渡さず、ユーザー用clientと管理用clientを混用しないことが前提です。
