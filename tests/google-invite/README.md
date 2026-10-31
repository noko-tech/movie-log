# Google招待制：設計・ローカルテスト・管理手順

この変更はデータベースの定義とテストだけです。マイグレーションを作成しただけでは招待制は有効になりません。現在のUI、Google Provider、本番Hook、本番DBの設定は変更していません。

## 作成するもの

`supabase/migrations/20261031000100_google_invite_auth.sql` は、専用の非公開スキーマ `google_invite_private` 内に以下を作成します。

| オブジェクト | 役割 |
| --- | --- |
| `invitations` | メールアドレス、有効・無効、認証プロバイダー、作成・更新日時を保持 |
| `signup_policy` | 新規登録のモードを1行だけで管理 |
| `before_user_created(event jsonb)` | Supabase Authから呼ばれる新規ユーザー作成前の判定関数 |

招待の有効期限・使用回数制限はありません。メールは小文字化し、前後の半角スペースを除いて完全一致で照合します。Gmailのドットや `+` エイリアスは統合しません。Google Workspaceなど、`gmail.com` 以外のGoogleアカウントも対象です。

初期モードは `invite_only`、招待テーブルは空です。実際の招待先はマイグレーションやテストに追加しないでください。

| モード | 新規登録 |
| --- | --- |
| `invite_only` | 有効な招待と一致するGoogleアカウントだけ許可 |
| `public_google` | 招待の照合を省略し、Googleアカウントを許可 |
| `closed` | 全件拒否 |

どのモードでもメール＋パスワードによる新規登録は許可しません。`public_google` は将来の一般公開用に準備した切り替えで、今回有効にしていません。他の認証方式の一般公開には別の設計・テストが必要です。

## 判定と権限

Hookは公式のイベント形式のうち、リクエスト種別、ユーザーID、メール、匿名ユーザーのフラグ、Authが設定する `app_metadata.provider` / `providers` を確認します。`provider` が `google`、`providers` が `["google"]` の新規作成だけを対象にします。プロバイダーの認証自体はSupabase Authが担当します。利用者が変更できる `user_metadata` のメール・プロバイダー・確認済みフラグは判定に使いません。

戻り値は、許可時に `{}`、拒否時に次の共通形式です。未招待、無効な招待、入力不備、関数内の権限エラーを区別して表示しません。

```json
{"error":{"http_code":403,"message":"新規登録は現在許可されていません。"}}
```

設定行がない場合やテーブルの参照に失敗した場合も拒否します。エラーの詳細・招待情報・入力イベントを戻り値や独自ログへ出力する処理はありません。関数の実行権限自体がない場合、キャンセル、タイムアウトなどは関数の外側で失敗します。その場合も作成が進まないこと、クライアント表示に詳細が漏れないことは、別途Authを含むテストが必要です。

関数は `SECURITY INVOKER` で動き、所有者の強い権限への昇格は行いません。`search_path` は空で、参照テーブルはスキーマ名付きです。

| ロール | 専用スキーマの権限 |
| --- | --- |
| 所有者 `postgres` | 招待・モードの管理 |
| `supabase_auth_admin` | スキーマの利用、Hook実行、2テーブルの参照のみ |
| `anon` / `authenticated` / `service_role` / `PUBLIC` | スキーマ・テーブル・Hookへの権限なし |

2テーブルにはRLSも設定し、Auth用の参照ポリシーだけを設けています。`service_role` はRLSを迂回できるため、RLSだけに頼らずオブジェクトの権限も取り消しています。新しいスキーマをData APIの公開対象に追加しないでください。既存の `public` スキーマや映画用テーブルの権限・RLSは変更しません。

招待テーブルは `auth.users` や映画テーブルに外部キー・トリガーで結び付けていません。無効化は将来の新規ユーザー作成の判定だけを変え、既存ユーザーの削除・利用停止・作品の削除は行いません。通常ログイン用の関数や設定も変更しません。

## ローカルテスト

必要なものはPython 3、起動済みのローカルDocker、次のPostgreSQLイメージです。Pythonの追加パッケージ、Supabaseキー、Google Client Secret、実際のメールアドレスは不要です。

イメージが手元にない場合だけ、事前準備として取得します。これはコンテナ配布元へのアクセスで、SupabaseのプロジェクトやDBへの接続ではありません。テストスクリプトは自動取得を行いません。

```sh
docker pull public.ecr.aws/supabase/postgres:17.11.0.002
```

リポジトリのルートで実行します。

```sh
python3 tests/google-invite/run.py
```

誤接続を防ぐため、スクリプトは次の順序で動きます。

1. Dockerの接続設定を読み、実在するローカルUnixソケットだけを受け付けます。TCP・SSH接続先は、デーモンへの接続前に拒否します。
2. そのソケットを以後のDocker操作に固定します。途中で環境変数が変わっても接続先を切り替えません。
3. ランダムな専用名で新しいコンテナを作成します。外部通信なし、公開ポートなし、ホストフォルダの共有なしを確認します。
4. コンテナ内の一時領域に空のDBを初期化します。PostgreSQLのTCP待ち受けを無効にし、コンテナ内のUnixソケットから接続したことを確認します。
5. 架空データを用意し、管理者権限を持たないマイグレーション用接続から `SET ROLE postgres` してSQLを適用します。Hookは実際のPostgreSQL上でAuth用ロールとして実行します。
6. テスト後は自分が作成したコンテナと一時データ・付随ボリュームを削除します。既存のコンテナやDBは停止・削除しません。

DB接続URLや接続先の引数は受け付けません。ホストの `DATABASE_URL`、`PGHOST`、`.env`、Supabaseのリンク設定はDB接続に使いません。SQLファイルを既存のDBへ直接流したり、テストのために `supabase db reset` / `db push` を実行したりしないでください。

成功時は各項目の `PASS` と件数が出ます。1件でも失敗すると終了コードは非ゼロです。Dockerが使えない場合は停止して報告し、本番への代替接続は行いません。イメージ不足は終了コード2、テスト失敗・その他の環境不足は1です。コンテナを削除できなかった場合も1になり、その専用名を表示します。

### 確認する内容

- 招待済みGoogleの許可、未招待・無効化済み・Google以外の拒否。
- メールの正規化、招待の再有効化、期限・使用回数制限がないこと。
- 欠けた値、JSONの型違い、メール不備、匿名登録、`user_metadata` による偽装の拒否。
- 一般ユーザーと `service_role` による直接参照・更新・Hook実行の拒否。
- Auth用ロールの書き込み禁止、テーブル権限を誤付与した場合の一般ユーザーへのRLS保護。
- 参照権限・RLSポリシー・設定行・内部テーブルの欠落時の拒否、Hook実行権限不足時の失敗。
- 一般公開・全件拒否・招待制への切り替え。
- 架空の既存ユーザーID・映画データ・RLS・RPC・権限・トリガーの保持。
- 同名オブジェクトが存在する場合、マイグレーション全体が停止すること。

`bootstrap.sql` のユーザー・映画テーブルは本番定義を再現したものではなく、変更が及ばないことを確認するための最小限の架空データです。実際のSupabase Auth、Google OAuth、Data APIや現在の映画用RPC全体を動かすテストではありません。

### 今回の実行結果（2026-11-01）

- ローカルPostgreSQLによるテスト：87項目成功、最終実行の失敗なし。
- 誤接続ガード：予約済みのテスト用TCPアドレスを指定すると、接続前に拒否されることを確認。接続先を渡すためのコマンド引数も拒否されることを確認。どちらも期待どおり終了コード1。
- 使用イメージID：`sha256:0450166354dc9c1d25f0322ac8b580774d4fb0184d2b087f6e4fe9499c66cf53`。
- テスト後のコンテナ削除に成功し、専用名のコンテナが残っていないことを確認。
- 本番Supabaseへの接続・変更、実データ利用、commit・push・デプロイ：実施なし。
- Auth経由の登録・既存ログイン・自動連携・タイムアウト・クライアント表示・Data API経由の拒否：未実施。下記の独立した検証環境で確認する。

## 招待の管理方法

この節は、将来承認された環境で管理者が使うためのSQL例です。今回、本番で実行していません。通常ユーザー向けRPCや管理画面は作成しません。

実際のメールはGit、HTML、スクリーンショット、チャット、シェル履歴に残さず、アクセスを制限した管理経路で扱ってください。管理用SQLの履歴・監査ログ・DBバックアップにも個人情報が残り得るため、その閲覧権限と保存方針を確認します。実運用の入力は管理用接続のバインド変数で渡し、値をこのファイルに書き込まないでください。

次のメールはすべて予約済みの架空ドメイン `example.invalid` です。例をそのまま実行しても実在する人への招待やメール送信は行われません。

### 追加・再有効化

管理者が所有者 `postgres` として実行します。`ON CONFLICT` により、同じメールを重複登録せず再有効化できます。結果にメールを返す `RETURNING` は付けません。

```sql
BEGIN;
SET LOCAL ROLE postgres;
INSERT INTO google_invite_private.invitations (email, provider, active)
VALUES (lower(btrim('invitee@example.invalid')), 'google', true)
ON CONFLICT (email) DO UPDATE
  SET active = EXCLUDED.active, updated_at = now();
COMMIT;
```

管理ツールからパラメータで渡す場合のSQL本体は次の形です。`$1` は招待メール、`$2` は有効・無効の真偽値です。文字列を連結してSQLを組み立てないでください。

```sql
INSERT INTO google_invite_private.invitations (email, provider, active)
VALUES (lower(btrim($1::text)), 'google', $2::boolean)
ON CONFLICT (email) DO UPDATE
  SET active = EXCLUDED.active, updated_at = now();
```

### 無効化

```sql
BEGIN;
SET LOCAL ROLE postgres;
UPDATE google_invite_private.invitations
SET active = false, updated_at = now()
WHERE email = lower(btrim('invitee@example.invalid'));
COMMIT;
```

更新件数が0の場合は対象がありません。無効化しても、すでに作成済みのユーザーは引き続き通常ログインできます。メール変更・アカウント削除・既存作品の削除には使わないでください。

### 件数だけ確認

メール一覧を出力せず、管理用接続から確認できます。

```sql
SELECT count(*) AS total,
       count(*) FILTER (WHERE active) AS active_count
FROM google_invite_private.invitations;
SELECT mode FROM google_invite_private.signup_policy WHERE singleton;
```

### 将来の一般公開・緊急停止

モード変更は管理者だけが行います。切り替え先を確認し、同じ1行の `mode` を変更します。

```sql
BEGIN;
SET LOCAL ROLE postgres;
UPDATE google_invite_private.signup_policy
SET mode = 'closed', updated_at = now()
WHERE singleton;
COMMIT;
```

この例は新規登録の全件拒否です。招待制へ戻す場合は `invite_only`、一般公開が別途承認された場合だけ `public_google` にします。既存ユーザーや映画データの移行は必要ありません。変更後の新規登録判定から適用され、すでに進行中の処理を取り消す機能ではありません。

障害時にHookを単純に無効化すると、招待チェックが外れて新規登録を許す可能性があります。まず `closed` で登録を止めた状態を保ち、権限・設定・修正版を隔離環境で確認します。設定行や招待データを削除して復旧しようとしないでください。Hookの撤去は、新規登録の別の制限方法を検証してから別作業として行います。

## 本番反映前に残る作業

本番反映・Google Provider設定・Hook登録は今回の作業に含めません。以下を別途実施し、結果を確認してから反映を判断してください。

1. 本番から独立したSupabase Authの検証環境を用意し、実際のイベント形式とGoogle認証後の判定を確認する。テスト専用アカウントを使い、秘密情報・個人情報をリポジトリやログに記録しない。
2. 招待済み・未招待・無効化済みのGoogle登録、招待済みメールのパスワード登録拒否、拒否後にユーザーが作られないこと、クライアントのエラー表示を確認する。
3. 既存のメール＋パスワード・Googleログイン、セッション更新、映画の読み書き、ユーザーID・所有作品の保持を確認する。招待の無効化後も再確認する。
4. **既存アカウントとGoogleの自動連携は別途テストが必須。** 同じメールでの連携、未確認メール、別メール、連携時のユーザーIDと作品の保持を確認する。既存ユーザーへのidentity追加は新規ユーザー作成と異なり、このHookだけでは制御できない。重複ユーザーを消して移し替える対応は行わない。
5. Hookの実行権限不足、タイムアウト、DB障害をAuth経由で再現し、新規作成が拒否され、内部情報がクライアントへ漏れないことを確認する。Data API経由の参照・RPC呼び出しも拒否されることを確認する。
6. 将来反映する時点で、PostgreSQLのバージョン、ロール構成、`postgres` への切り替え権限、既存オブジェクトの名前の衝突、非公開スキーマが公開設定に含まれないことを確認する。初期状態のままなら全新規登録が拒否されるため、承認済みの招待を安全に登録してからHookを有効化する。
7. マイグレーションだけでは保護が有効にならないため、反映時には登録経路を開く前にHookの設定と拒否動作を確認する。既存のパスワードログインを維持するため、Email Providerの停止で代用しない。

独立したローカルSupabase環境でHookを登録する場合の設定形式は次のとおりです。これは参考例で、現在の `supabase/config.toml` には追記していません。

```toml
[auth.hook.before_user_created]
enabled = true
uri = "pg-functions://postgres/google_invite_private/before_user_created"
```

Supabase Authによる呼び出し・権限設定まで含めて確認してください。この設定例だけで本番を有効にする作業は行わないでください。

## 公式仕様

2026-11-01確認。

- [Before User Created Hook](https://supabase.com/docs/guides/auth/auth-hooks/before-user-created-hook)：新規ユーザー作成前の呼び出し、イベントと許可・拒否の戻り値。
- [Auth Hooks](https://supabase.com/docs/guides/auth/auth-hooks)：Postgres関数の引数・戻り値、Auth用ロールへの限定した権限付与、ローカル設定、エラーとタイムアウト。
- [Identity Linking](https://supabase.com/docs/guides/auth/auth-identity-linking)：同じメールによる自動連携と追加検証が必要な根拠。
