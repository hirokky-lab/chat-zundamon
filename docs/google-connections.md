# Google接続サービスの承認済み方針

対象はGoogleカレンダー・Google Drive・Gmail。Google Tasksと天気は接続画面から除外。

## 目標
- カレンダー: 予定を読む・作成・更新・削除。
- Drive: 利用者が許可したファイルを読む・作成・更新。
- Gmail: メールを読む・下書きを作成・内容確認後に送信。
- 外部書き込みは対象と内容を提示し、承認した操作だけ実行する。

## 現在の境界
2026-09-07: 画面整理済み。表示確認モードは実API未接続。
既存カレンダー連携にはOAuth・トークン保存・書き込み確認の土台がある。
Drive/Gmailのプロバイダー、権限、プレビュー、実行検証は未実装。
ずんだもんAI専用Google Cloud/OAuth設定の有無は利用者へ確認中。
YUIのOAuth設定・トークン・個人データは流用しない。

## 接続前に必要な設定
専用Google Cloudプロジェクト、OAuth同意画面、テスト利用者、
許可済みリダイレクトURI、サーバーの専用OAuth設定とトークン暗号化キー。
鍵は会話に貼り付けない。

## プロフィール
職業・住んでいる地域は表示確認モードの任意入力。
専用の端末保存キー zundamon-ai-preview-profile-details を使用。
現段階ではAIへの送信・サーバー同期なし。

## 2026-09-09 全カレンダー方針

接続したアカウントの読み取り可能なカレンダーを、既定ではまとめて対象にする。カレンダー名を予定に付ける。予定プレビューは全対象から直近3件を選ぶ。カレンダーリストが上限を超えた場合や一部の取得に失敗した場合は、全件確認済み・予定なしとは扱わない。

ローカルの横断プレビュー処理とカレンダー名の受け渡しを実装。実Googleデータの検証、トークからの期間指定一覧、対象除外UI、既定の書込先はまだ未完了。現在の接続サーバーには専用カレンダーOAuthクライアント設定とトークン暗号化鍵がないため、Googleログインのみで予定の読取はできない。Google同意画面での追加権限はユーザーが確認する。

## 2026-09-09 接続サーバー準備
- connected serverにも専用Google OAuth設定が揃った場合だけCalendarの接続・状態・読み取り・解除ルートを有効化。Tasksと書き込み権限は無効。
- hostedとconnectedでOAuth構築を共用。秘密はbrowser-configに出さない。
- sync、OAuth、ルート、設定の関連49テストとserver型検査を通過。
- Google Cloudの専用zundamon-aiプロジェクトにzundamon-ai-calendarクライアントを作成。リダイレクト先はこのアプリの/api/google-calendar-tasks/callback。
- JSONダウンロード操作後もローカルDownloadsに認証情報ファイルを確認できず、環境変数への保存は未完了。作成ダイアログを保持している。
- Calendar API有効化、必要DB RPC、Google同意からcallbackまでの実接続は未検証。現在の接続済みを意味しない。

### 認証情報保存・案内画面確認
- デスクトップに保存された専用クライアントJSONのproject_idとredirect_uriを検証し、gitignore対象.env.connection.localへ保存。暗号化キー新規生成、ファイル権限600。秘密値は出力しない。
- connected server再起動、healthとbrowser-config応答、実アプリの未接続状態と接続ボタンを確認。
- アプリ接続ボタンからGoogleアカウント選択、テスト用アプリ案内を経て追加アクセス許可画面へ到達。要求はカレンダー一覧とすべての予定の参照のみ。
- Google Calendar APIは未有効。API利用規約の同意とGoogle追加アクセスの最終許可はユーザー確認待ち。callback完了や予定読取は未確認。


### 2026-09-09 Google実接続確認
- ユーザーの直前承認を受け、Google Calendar APIを有効化。Google Cloudのステータス「有効」を確認。
- 一覧参照と全カレンダーの予定参照のみを許可。初回は承認待ちでOAuth試行の5分期限を超過。再試行はサーバーのcomplete結果connected、アプリGoogle連携画面「接続済み」を確認。
- 一時的な秘密を含まない結果診断コードは確認後に除去。
- 実際の予定取得・会話からの期間指定検索は今回未検証。予定の作成・変更・削除権限は未付与。

### 2026-09-09 トーク予定検索の実接続
- connected serverにgoogleAssistantとlifeIntentを渡していなかったため、接続済みでも通常のAI返答になっていた。両者を構成し予定照会を実データの読み取りへ接続。
- カレンダーの指定がない照会は読み取り可能な一覧から全件を対象にする。予定ページを各最大10ページ取得、日時順・カレンダー名付きのテキストで最大30件を表示。上限時は一部表示と明記。取得失敗時に予定ゼロとは答えない。
- 関連18テストとserver型検査PASS。実アプリで「明日の予定は？」を送信し、翌日の予定の日時と出典カレンダー名が返ったことを確認。個別の予定内容は本記録に残さない。
- 予定の追加・変更・削除権限は引き続き無効。

### 2026-09-09 確認付き編集の準備
- connected serverの専用フラグでCalendarの書き込み準備・確認・取消・操作状態ルートを有効化。Googleの書き込みスコープ自体は別途追加許可が必要。
- 削除をdomain/intent/router/service/provider/確認カードへ追加。署名・所有者・期限・バージョン・一回限り実行を共通処理で検証。DELETE後に消失またはcancelledを照合し、不明時は再送しない。
- 参加者付き、繰り返し、終日など既存unsupported対象は変更・削除を拒否してGoogle画面へ案内。
- 既存29件と追加provider/routerテスト13件（重複あり）、Web接続5件、両型検査、connected buildを確認。
- 実トークでテスト予定の確認カード（題名・開始・終了・追加確認ボタン）を確認、取消操作。Googleへの実書き込みは未実施。編集スコープ追加許可待ち。
- API仕様: https://developers.google.com/workspace/calendar/api/v3/reference/events/delete

### 2026-09-09 Calendar write OAuth verified
- User approved the Google consent for viewing and editing events across calendars. Retried the same grant and verified the persisted connection through the owner-bound OAuth RPC: `calendar.events` scope is saved.
- Browser returned to the talk page successfully. The earlier confirmation draft is cancelled; no real event was created, updated, or deleted during this verification.
- Actual Google write/read-back remains untested with a real event. App mutations require confirmation of the concrete proposed change.

### 2026-09-10 Referential deletion and status feedback
- Reproduced: follow-up deletion ignored google-operation cards, inferred a stale date, and displayed selection wording for zero matching items. Resolve references such as さっき from the latest relevant card, then re-read the owner-bound operation status and use its verified result identity. Explicit dates/source names in the current request still constrain selection. Cancelled, unknown, and already deleted operations never substitute another event.
- Multiple candidates now expose a delete-preview button for each supported calendar event; zero matches ask for title/date without an empty selection card. All deletion still requires a separate signed confirmation.
- Status checks now visibly show checking and completion feedback even when unchanged. Successful operation headings distinguish registration, change, and deletion.
- Validation: 29 server tests, 10 web tests, both typechecks, connected build passed. Existing stale LifeSettings/create-button labels in this test suite were updated to the current UI.
- Real private deployment: clicked status check and observed progress/result. Retried the exact follow-up after the user's completed deletion: correctly returned already deleted. No calendar mutation was executed during this fix. Successful-create to delete-preview identity is covered by regression tests; no new real event was created for testing.

### 2026-09-10 Drive reading milestone — consent pending
- User selected GPT-like whole-Drive search. Added a separate Drive connection using drive.readonly, owner-bound encrypted refresh tokens, PKCE/nonce, one-use OAuth state, and generation checks. Calendar scopes remain separate.
- Added paginated file search and explicit selected-file reading for Google Docs and text formats. Other file formats report unsupported; creation/update and AI summarization are not implemented in this milestone.
- Applied 202609100001 and 202609100002 through the Supabase SQL UI. Verified schema readiness, service-only RPC permissions, and snapshot card support. Enabled the dedicated Google project's Drive API.
- Validation: 28 related server tests and 17 related web tests passed, both typechecks passed, connected build passed. Live connection page shows Calendar connected and Drive not connected.
- Stopped at Google's additional-access consent screen for “Google ドライブのすべてのファイルの表示、ダウンロード。” No Drive permission has been granted and no real Drive search/read has been verified yet.

### 2026-09-10 Drive summary milestone
- Drive OAuth completed after user consent; live Google connections page verified connected.
- Added an isolated OpenAI summary gateway using the existing dedicated key. Selected documents are re-read under the current owner's authorization; only file name and bounded document text are passed as untrusted input, without tools or conversation/profile data. Summaries remain external-context replies, with a source link and a partial-content notice where applicable.
- “この資料を要約して” resolves the selected Drive card; an ambiguous result asks for selection. Named documents can be searched, and only a unique complete result is read automatically. Empty/failed reads never produce a fabricated summary.
- Validation: 27 related server tests, server typecheck and diff checks passed. Real OpenAI intent classification and summarization passed using a fictional library improvement document. No private Drive file was sent during that smoke test. Restarted the private connected service; private-file end-to-end summary remains user acceptance testing.

### 2026-09-10 Natural media link search
- Media link requests no longer require the word Drive. The intent extracts a topic and a video/image filter. Search includes direct children of exact-name folders, as well as matching file text, with trashed items excluded; it does not recursively scan nested folders.
- Media filters survive pagination and card persistence. One-item requests return one verified search result and do not change sharing permissions.
- Validation: 31 related server tests, 4 web tests, both typechecks, connected build passed. In the private app, replayed the user's earlier media-link request and verified a single MOV link with the short reply. No file contents were fetched and no sharing permission was changed during this test.

### 2026-09-10 Gmail and text-PDF batch
- Added dedicated Gmail readonly OAuth, encrypted service-only Supabase RPC and chat-card types. Google Gmail API enabled; SQL result confirmed `gmail_ready`, `server_only`, `gmail_cards_ready` all true. No credentials or account content recorded here.
- Gmail supports bounded search, selected-mail reading, short AI summaries, editable/copyable in-app reply drafts. Drafts are not saved to Gmail or sent. Mail MIME parsing prefers plaintext, converts HTML without fetching resources, decodes declared charsets, excludes attachments, and limits bytes/parts/depth/text.
- AI re-reads the selected authorized mail, uses a tool-free gateway and marks results external_context. Intent classification receives only the selected source kind, not mail-card contents. Real OpenAI smoke with fictional mail passed summary, requested reply wording and selected-mail intent.
- Drive text-PDF extraction uses PDF.js in an isolated worker (10 MB, 30 pages, 20k characters, 15 seconds). Scans without extractable text and malformed/locked documents produce errors; no OCR. Tests use a real generated PDF fixture. Reading a real Drive PDF remains unverified.
- Relevant 59 tests across server/web passed in focused runs, both TypeScript checks and connected build passed. Private app returned HTTP 200 after restart; UI shows Calendar and Drive connected, Gmail connect available. Gmail permission grant and real inbox verification remain pending.

### 2026-09-10 Gmail grant and live verification
- User explicitly approved readonly Gmail access. Completed Google consent; the app returned `gmail=connected` and the connection page showed Gmail connected alongside Calendar and Drive.
- Earlier callback attempts failed around the consume step; added stage-only diagnostics and repository error codes without tokens, email contents or raw errors. A subsequent fresh attempt succeeded; no schema or permission weakening was required. The original transient cause is not proven.
- On the private app, searched recent promotional mail, opened one message, then requested a short summary. Real Gmail search/read and OpenAI summary all returned successfully. No mail was sent, no Gmail draft was written, and private content is not copied into this record.
- Gmail server tests (6) and server TypeScript check passed after diagnostics. Local reply drafting remains verified with fictional mail and component tests, not a real outgoing message.

## 2026-09-11: Gmail送信 / Driveテキスト保存の準備

- Gmailの返信下書きから宛先・件名・本文を編集し、確認画面で明示的に送信する実装を追加。Driveは会話の返答から新規テキストを保存し、既存フォルダを検索して選択する。
- 追加権限: Gmail `gmail.send`、Drive `drive`。Driveは任意の既存フォルダに保存するため全体権限を要求するが、今回の実装は新規テキスト作成のみ。既存ファイルの更新・削除・共有変更は未実装。追加OAuth同意は未実施。
- 内容は所有者に結びつけて暗号化し、5分期限・DBの原子的な取得で一度だけ実行。接続世代とGoogleアカウントも照合する。結果不明では自動再送しない。
- `202609110001_google_writes.sql` を専用Supabaseへ反映。実DBで所有者分離、再実行拒否、取消、期限、クライアントの直接アクセス拒否を検証し、試験レコードはロールバック。
- サーバー関連29テスト、Web関連14テスト、両方の型検査、connectedビルド成功。private URLでDrive編集画面と390x844表示を確認。Googleへの実メール送信・実ファイル保存は未確認（追加権限待ち）。
- 広域の旧UIテストは40件失敗 / 92件成功。今回のUI導線を一時的に外しても同じ40件が失敗。地域設定・廃止済みホーム/表示スタイル・旧ログイン文言・旧写真確認画面等を含む既存テスト整備は別途必要。
- 確認画面の状態は現在その画面の存続中のみ保持。DBの結果は永続化されるが、ページ再読み込み後の操作履歴一覧は今後の対応。

API仕様: https://developers.google.com/workspace/gmail/api/guides/sending 、 https://developers.google.com/workspace/drive/api/guides/manage-uploads
