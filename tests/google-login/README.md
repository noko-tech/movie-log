# GoogleログインUI：ローカル確認

## 今回の変更

`index.html` のログインフォームは、蛍光グリーンのLOGIN → 左右に細い線のある「または」 → Googleでログイン → 新規登録はこちら → 「現在、新規登録は招待制です」の順です。Googleボタンは白地・黒い枠・角丸4px・右下4pxの黒い影で、LOGINと同じ幅・高さ52px・中央揃えです。標準色のGoogle Gアイコン、既存のフォント、キーボードのフォーカス表示を維持しています。

既存の入力欄、蛍光グリーンのLOGINボタン、背景・ロゴ・カード・映画画面のデザインは維持しています。Googleボタンの幅はPCで56%、スマートフォンで76%（最低180px）とし、LOGINに揃えています。新規登録リンクをGoogleボタンの下へ移し、余白を詰めて案内を追加しました。メールによる新規登録画面ではGoogleボタン・区切り・注記を隠し、既存の配置を維持します。今回のデザイン調整ではアプリ内のJavaScriptを一切変更していません。

最終調整では「または」の上余白だけを12pxから16pxへ変更しました。LOGINの下影4pxを含めると、文字と左右の線をまとめた区切り全体の上側・下側とも、見える余白は12pxです。下余白12px、ボタンの寸法・影、リンクと注記の余白は変えていません。PC・スマートフォンの共通ルールで適用し、自動テストで上下の実測値を比較します。

**注記は利用者への案内です。招待制の強制はサーバー側Hookが担当します。本番でのHook適用・検証が終わるまで公開しません。**

既存のSupabase JS SDK `2.117.2` の同じclientで次を呼び出します。追加のGoogle SDK、Client Secret、Gmail・Drive等のスコープ、オフラインアクセス要求は追加していません。

```js
client.auth.signInWithOAuth({
  provider: "google",
  options: { redirectTo },
});
```

移動中は二重操作を止め、Googleボタンに進行中の文言を表示します。開始失敗時は再操作できる状態へ戻します。Googleからの復帰は既存SDKの `detectSessionInUrl`、`getSession`、`onAuthStateChange`、`applySession` を使い、既存の映画読み込みへ接続します。セッション・ユーザーIDを独自に作成したり、アカウントを連携・移行する処理はありません。

ブラウザーの「戻る」で復帰した場合はボタンを再操作できるようにします。再読込を伴う戻り操作の判定には、このタブの `sessionStorage` へ開始時刻だけを保存します。トークンやメールは保存せず、15分で判定対象外となり、復帰確認時に削除します。このストレージが使えない環境でも認証開始は妨げませんが、再読込後のキャンセル案内が出ない場合があります。

認証エラーは固定の日本語に置き換え、招待が必要であることを案内します。外部から返る `error_description` や内部SQL情報を画面・独自ログへ出力しません。エラー用のURLパラメータもSDK処理後に除去します。ユーザーの同意拒否と分かるコードではキャンセルの案内を出し、メール確認リンクの期限切れは既存用途の案内を維持します。

## リダイレクト先と未確認の設定

今回、本番の管理画面・APIにはアクセスしていません。**Supabaseに現在登録されているRedirect URLsの実際の一覧は未確認です。** リポジトリ内の既存メール認証コードでは次の2つのURLを想定していたため、Googleログインも同じURLを明示して使います。

| 開いているページ | Google認証後の戻り先 |
| --- | --- |
| `http://localhost:8000/` または同じ場所の `index.html` | `http://localhost:8000/` |
| `https://noko-tech.github.io/movie-log/` または同じ場所の `index.html` | `https://noko-tech.github.io/movie-log/` |
| `127.0.0.1`、別ポート、別パス、`file://` 等 | 開始せず、対応するURLで開き直すよう案内 |

未知のローカルURLから本番の戻り先を使うフォールバックはありません。現在のメール＋パスワード認証のリダイレクト関数は変更していません。

実際に試す前に、承認済みの検証環境のRedirect URLsへ **`http://localhost:8000/` が登録済みか確認が必要です**。なければ後日の設定作業で追加し、末尾のスラッシュまで一致させます。`localhost` と `127.0.0.1` は同じ登録として扱わないでください。SupabaseのSite URLが誤った戻り先になっていないことも確認します。今回は設定を追加・変更していません。

Google Cloudの「承認済みリダイレクトURI」はGoogleからSupabase Authへ戻るコールバックであり、上記の「SupabaseからMovie Logへ戻るURL」とは別です。独立した検証用Supabaseのコールバックを用意し、本番プロジェクトのURLと混ぜないでください。Google Provider・Hookの設定は別作業です。

## 本番に接続しない自動テスト

```sh
node --check tests/google-login/browser.cjs
```

ブラウザーテストでは、変更したHTMLとコミット済み `HEAD:index.html` を比較します。実際のSupabase SDKとブラウザーを使いますが、認証API・OAuth画面・映画データは架空です。ブラウザーの全リクエストをローカルのファイル・模擬レスポンスで返すか遮断し、外部への転送は行いません。HTMLのSupabase接続値も配信前に模擬URL・ダミー値へ置き換えます。Service Workerも無効にしています。

テストに使うURLはPlaywright内だけの仮想URLです。実際にlocalhost:8000でサーバーを起動したり、GitHub Pagesを開いたりしません。本番への接続や実際のGoogle認証は発生しません。

必要なパッケージはリポジトリ外の一時フォルダに用意します。配布元から依存パッケージ・ブラウザー・Tailwindを取得する通信と、アプリの認証先への通信は別です。

```sh
test_dir=$(mktemp -d /private/tmp/movie-log-google-ui.XXXXXX)
npm install --prefix "$test_dir" --ignore-scripts --no-audit --no-fund playwright@1.56.1 @supabase/supabase-js@2.117.2
"$test_dir/node_modules/.bin/playwright" install chromium webkit
curl --fail --silent --show-error https://cdn.tailwindcss.com/3.4.17 -o "$test_dir/tailwind.js"
MOVIE_LOG_TEST_DEPS="$test_dir/node_modules" \
MOVIE_LOG_TEST_TAILWIND="$test_dir/tailwind.js" \
MOVIE_LOG_TEST_OUTPUT="$test_dir/screenshots" \
node tests/google-login/browser.cjs
```

既存Chromeを使う場合は `MOVIE_LOG_TEST_CHROMIUM` に実行ファイルの絶対パスを渡せます。WebKitはPlaywrightが用意したものを使います。追加の依存・ブラウザー・画像・結果JSONをGitへ含めないでください。以前のSQLテスト87件は今回変更しておらず、このブラウザーテストとは別です。

外部Webフォントは、標準では空のCSSで置き換えます。今回の確認画像では既存フォントのログイン用文字を事前に一時フォルダへ取得し、オフラインのキャッシュから配信しました。任意の `MOVIE_LOG_TEST_FONTS` は、取得元URLをローカルファイル名へ対応させた `manifest.json` とフォント・CSSのあるフォルダを指定するためのものです。フォントの配信元へブラウザーから接続する機能ではありません。配信元でのフォント更新・実際の外部配信は未検証です。

確認する内容：

- Chromium・WebKitでPC 1440×1000、スマートフォン390×844・375×667・320×568の表示、横はみ出し、ボタンの大きさ、キーボード操作。
- 既存の入力欄・LOGINの座標保持、ボタンの寸法・中央位置・影・順序、新規登録画面の座標保持、ログイン済み映画画面のスクリーンショット比較。
- SDKが作るGoogle OAuth URL、戻り先、追加スコープなし、二重操作の防止。
- 戻る操作、bfcache復帰、開始失敗、キャンセル、招待拒否、内部情報の非表示とURLからの除去。
- 模擬コールバックから実SDKのセッション復元、映画読み込み、重複Auth通知、再読込、ログアウト。
- 既存のメール＋パスワードログイン、未対応URLの拒否、sessionStorageが使えない場合。

今回の最終結果：ブラウザーテスト40項目成功（Chromium・WebKit各20項目）、配信ビルド用の既存Pythonテスト21件成功、JavaScript構文・差分の空白検査に合格。最終実行での失敗はありません。bfcache用ハンドラーは復帰イベントを模擬して確認しており、実機のキャッシュ保存・復帰条件そのものは別途確認が必要です。

## 操作できるローカル確認画面

`preview.cjs` は認証・登録を無効にしたデザイン確認専用サーバーです。リポジトリのHTMLを読みますが、配信時だけ接続先と公開キーをダミーへ置き換え、認証SDKもローカルの模擬実装へ置き換えます。LOGIN・Googleボタンを押すと「デザイン確認用」の案内だけが表示されます。アプリの元ファイルやOAuth処理は書き換えません。

```sh
MOVIE_LOG_TEST_TAILWIND="$test_dir/tailwind.js" \
MOVIE_LOG_PREVIEW_PORT=8787 \
node tests/google-login/preview.cjs
```

確認用URL：**http://127.0.0.1:8787/**

127.0.0.1だけで待ち受け、外部スクリプト・フォントをローカルへ差し替え、CSPで接続先を同一オリジンへ制限します。HTML・画像・必要なローカル資材だけを公開し、`.env`、SQL、テストソースへのURLは404にします。ローカルのフォントキャッシュがあれば `MOVIE_LOG_TEST_FONTS` で指定できます。使用中のポートのサーバーを停止・上書きする処理はありません。

今回、Chromium・WebKitで実際にこのローカルURLを開き、Google・LOGINを押しても認証が始まらないこと、招待制の案内、CSPと非公開ファイルの404を確認しました。本番への通信・実際のGoogle認証は行っていません。サーバーは実行した端末でCtrl+Cにより停止できます。

元の `index.html` をそのまま配信するサーバーとは用途が異なります。デザイン確認はこのプレビューURLを使ってください。

## 実際の認証を試す前の準備

1. ボタンの位置・デザインをユーザーが確認する。今回は確認待ちで停止する。
2. 本番から独立したSupabase検証環境とGoogle検証設定を用意し、HTMLを検証用接続先へ向ける方法を別途決める。**現在のHTMLの接続先は従来どおりのため、そのまま開いて実際にGoogleボタンを押さない。** 今回の動作確認は上記の模擬テストだけで行う。
3. Redirect URLs、Site URL、GoogleのコールバックURIを確認する。必要な設定追加は別途承認後に行う。
4. 招待SQLの適用・招待登録・Before User Created Hook・Google Providerの有効化を検証環境で準備する。UIだけでは招待制を強制できない。
5. テスト専用アカウントで、招待済み・未招待・無効化、同意拒否、通信障害、再ログインを確認する。秘密情報や個人情報はGitや画面キャプチャへ記録しない。
6. **既存アカウントとのGoogle自動連携は未検証。** 同じメール・別メール・メール未確認のケースで、ユーザーIDと作品所有権が保持されることを別途確認する。既存ユーザー・作品を削除して合わせない。

実Google認証、実Hookとの結合、実際の招待制限、実機スマートフォン、トークン更新や復帰の長時間動作、現在の本番Redirect URLsは、このテストでは検証できません。

## 参照した公式仕様

- [Supabase signInWithOAuth](https://supabase.com/docs/reference/javascript/auth-signinwithoauth)
- [Supabase Google認証](https://supabase.com/docs/guides/auth/social-sign-in/auth-google)
- [Supabase Redirect URLs](https://supabase.com/docs/guides/auth/redirect-urls)
- [Googleのボタン表示ガイド](https://developers.google.com/identity/branding-guidelines)
