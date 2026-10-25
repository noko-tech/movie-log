tmdb-v2のローカル検証と将来のデプロイ確認

新しいFunctionは既存tmdbをそのまま独立コピーしたものです。旧Function・HTMLの接続先・SQLは変更しません。最初のバージョンでは両ソースのバイト一致を検証します。

supabase/config.tomlは今回新規作成しています。ローカル識別子project_idは本番のproject refではありません。functions.tmdb-v2だけを設定し、enabled=true、verify_jwt=false、entrypointを新ファイルへ固定します。tmdbのセクションや全Function共通設定は追加しません。

verify_jwt=falseはプラットフォーム側の検査を無効にする設定です。Function内部では固定プロジェクトのauth.getUser(jwt)で検証し、未認証・不正・期限切れ・別プロジェクトのJWTを拒否します。認証後に検証済みuser.idで制限RPCを呼びます。OPTIONSは既存仕様どおり認証なしで応答し、TMDbへ通信しません。

既存の実行方法は変更せず、テスト対象を追加指定できます。DenoのSDKをあらかじめキャッシュした環境で、実行時ネットワークを禁止します。結果の書き込みはリポジトリ外の一時フォルダだけに許可してください。

```sh
deno check --no-config --no-lock --node-modules-dir=none --cached-only supabase/functions/tmdb-v2/index.ts
deno test --no-config --no-lock --no-check --node-modules-dir=none --cached-only --deny-net --allow-read tests/tmdb-v2/separation.test.ts
deno test --no-config --no-lock --no-check --node-modules-dir=none --cached-only --deny-net --allow-read --allow-write=/tmp/movie-log-v2-test tests/tmdb-rate-limit/edge.test.ts -- /tmp/movie-log-v2-test/edge.json tmdb-v2
```

実PostgreSQL/PostgRESTのローカルテストは、既存READMEの実行環境にMOVIE_LOG_TEST_FUNCTION=tmdb-v2を追加します。指定なしでは従来のtmdbを検証します。新しい一時クラスタだけを使用し、本番のDB URLやキーを渡しません。

```sh
MOVIE_LOG_TEST_FUNCTION=tmdb-v2 node tests/tmdb-rate-limit/postgres.cjs
```

Auth・TMDb・ホスティング側Secret変換は模擬です。PostgreSQL/PostgRESTの権限・RPC・トランザクションは実物で検証できます。Denoの型検査やハンドラーのテストは、Supabaseホストのゲートウェイや実際のデプロイの検証ではありません。

将来、承認後に本番へ反映する際の確認（今回は実行しない）：

1. 専用SQLの適用・権限検証、Supabaseのプロジェクトと既存Functionを確認する。
2. TMDB_ACCESS_TOKEN、SUPABASE_PUBLISHABLE_KEYS、SUPABASE_SECRET_KEYSと使用するキー名が利用できることだけを確認する。値はログ・Git・ブラウザへ出さない。キーを新旧Functionで共有している場合、旧版のキーを削除・変更しない。
3. 対象名を必ず指定し、プロジェクトrefを明示してtmdb-v2だけをデプロイする。例：supabase functions deploy tmdb-v2 --project-ref <対象のproject-ref>。名前なしの一括deployと--pruneは使用しない。
4. config.tomlのverify_jwt=falseとentrypointをデプロイ前に確認し、デプロイ後もDashboardのtmdb-v2のLegacy JWT設定がOFFになっていることを確認する。既存tmdbの設定は変更しない。
5. 正常なA/BのJWTで少数のsearch/details、JWTなし・不正・期限切れで401を確認する。publishableキーだけでは利用できないことを確認する。429や障害の負荷再現は模擬環境で行う。
6. 旧公開版のtmdbが引き続き動くことを確認する。index.htmlの接続先切り替えと旧Function停止は別の承認・作業で行う。

Secretは共通service_roleの強い権限を持ち、RPC限定キーにはなりません。新旧の独立コピーには将来の修正差分が生じる可能性があるため、更新対象を明示して管理します。CORS等は従来のままです。
