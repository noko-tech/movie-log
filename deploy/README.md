Movie LogのPages公開（ローカル準備段階）

公開ファイルは`pages-files.json`の10件だけです。HTMLを含めてバイト列を変えずにコピーします。画像・SVG・ライセンス以外にローカルのCSS・JS・フォント・favicon参照はありません。Google Fonts、Tailwind CDN、Supabase JSは既存の外部参照を維持します。

生成例（リポジトリ外の、新規または空のディレクトリを指定）：

```sh
python3 -B -m unittest discover -s tests/pages -p 'test_*.py' -v
python3 -B scripts/build_pages.py --output /tmp/movie-log-pages-review/site
python3 -B scripts/build_pages.py --output /tmp/movie-log-pages-review/site --verify-only
```

必要な素材の欠落、未登録のローカル参照、未使用素材の追加、秘密キー等の既知パターン、シンボリックリンク・ハードリンク、成果物への余分なファイルや改変を検出したら失敗します。既存の出力ファイルを削除・上書きしません。検出メッセージに秘密の値を出しません。秘密情報・個人情報の完全な監査に代わる検査ではありません。

`watchtime-accent.png`は既存HTMLの古いCSSだけに残る削除済み素材です。現在はスマホ・PCの後続ルールで`watchtime-line2.png`に置き換わっています。この1件だけを理由付きで例外登録し、公開しません。ブラウザテストで実効マスクと画像リクエストを確認します。HTMLを変更したら例外も再審査してください。

ブラウザ確認は`tests/pages/browser.cjs`を使用します。既存のPlaywright・ブラウザ・ローカルTailwindバンドルが必要です。

- `MOVIE_LOG_TEST_DEPS`：Playwright・Supabase JSのnode_modules
- `MOVIE_LOG_PAGES_SITE`：生成済み公開ディレクトリ
- `MOVIE_LOG_TEST_OUTPUT`：リポジトリ外のスクリーンショット出力先
- `MOVIE_LOG_TEST_TAILWIND`：ローカルTailwindバンドル
- `MOVIE_LOG_TEST_CHROMIUM`・`PLAYWRIGHT_BROWSERS_PATH`：必要に応じて既存ブラウザを指定

```sh
node tests/pages/browser.cjs
```

外部通信を遮断し、SDK・Tailwindは手元のファイル、Supabaseは模擬GET/HEAD応答で検証します。作品の書き込みはありません。スクリーンショット比較は、画像/GPUの端数差として最大1/255・全画素の0.01%以内だけを許容します。Google Fontsの本番表示・iPhone実機・GitHub Actionsサービス自体の検証にはなりません。

workflowの実行条件：

- `workflow_dispatch`だけ。push・PR・scheduleでは公開しません。
- build・deployとも`refs/heads/main`を確認し、それ以外は実行しません。
- buildの権限はcontents:readだけ。deployだけにpages:write・id-token:write。
- `github-pages`環境を使用。公式Actionsは確認済みリリースのSHAに固定。
- 一時生成フォルダだけをアップロードし、チェックアウト用資格情報を残しません。
- configure-pagesのenablementはfalseで、自動的にPagesを有効化しません。

将来の切り替え（今回実施しない）：

1. 旧公開版のHTML・素材・コミットID・Pages設定を記録する。
2. workflowをmainへ導入する際、その時点のmainのHTMLに合う許可リスト・素材で検証する。今回の許可リストは開発版専用であり、旧mainへそのままコピーすると素材不足で停止する。
3. Settings → Pages → Build and deployment → SourceをGitHub Actionsに変更する。github-pages環境のDeployment branches and tagsをmainだけに制限する。
4. 旧画面を維持した切り替えなら、旧画面の内容で最初のActions公開を確認する。TMDb・SQL移行の準備前に開発版index.htmlをmainへ反映しない。
5. 承認されたmainのコミットでRun workflowを手動実行する。配信後に画像・サブパス・ログイン等を確認する。

このローカル作業だけでは現行Pagesは変わりません。ソース方式の設定変更や初回公開が必ず無停止になる保証はないため、将来は切り替え時間を決めて確認してください。

生成・テスト失敗時はdeployへ進みません。公開後の復旧には、保存した正常版のHTML・素材を戻した新しいmainのコミットを同じworkflowで公開します。復旧先が旧UIの場合も、SQL・Functionとの互換性を事前確認します。DB全体の復元や無認証Functionの再開を自動実行しません。既知の正常版の公開ファイル一式は別途保管してください。

Publicリポジトリにpushしたソース・SQL・テスト・履歴はGitHubから閲覧できます。Pages配信対象を限定する仕組みは、GitHubリポジトリ自体の秘密情報チェックを置き換えません。
