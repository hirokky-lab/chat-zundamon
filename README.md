# Chatずんだもん

ずんだもんと、いつもの話を。ブラウザーで会話できる、個人開発のAIチャットアプリです。

**自分用に作ったアプリのソースを公開しています。興味があれば、仕組みやUIの参考にどうぞ。** コードの利用・改変はMITライセンスです。ずんだもん等のキャラクター・素材の権利は別です。

## できること

- **AIチャット** — 自分のOpenAI APIにつないで会話。写真やトーク履歴にも対応。
- **音声・通話** — 音声入力、読み上げ、通話形式でのおしゃべり。
- **動くキャラクター** — Live2DまたはVRM。拡大縮小、VRMの回転にも対応。
- **おなじみのBGM** — 解説動画でよく聞く曲を、各自で用意して再生。発話中は音量を下げます。
- **PCでもスマホでも** — 同じWebアプリを使える画面構成。壁紙・ライト／ダーク表示。
- **Codex連携** — 会話の流れで作業を依頼し、進捗・質問・結果を受け取れます。

プロフィール・覚えた内容の管理、Googleカレンダー／Drive／Gmail連携もあります。

## この公開版について

完成済みの一般向けサービスではなく、本人用に運用しながら更新している実装です。公開URLへのログインだけで使う方式ではありません。設置する場合は、自分のPCまたはサーバー、API・DB・素材を用意してください。

- **ソースに含むもの**：アプリ、テスト、DBマイグレーション、設定ツール、壁紙、素材未設定時の代替画像。
- **含まないもの**：APIキー、個人の会話・写真・設定、音源、キャラクター原画、Live2D SDK／モデル、VRMモデル。
- 素材未設定の画面には簡単な吹き出しの代替画像が表示されます。紹介時のキャラクター画像そのものは同梱していません。
- 主にMacで開発・利用しています。各OSでの導入、新規クラウド環境からの全機能の通し確認は未完了です。
- 外部APIには各サービスの利用条件・料金が適用されます。Codex連携は本人の設定・権限を使い、端末上のファイル操作を伴う場合があります。

## まず画面を見る

Node.js 22.13以降と、`package.json` 指定のpnpmを用意します。公開時の検証環境はNode.js 25です。

```sh
git clone https://github.com/hirokky-lab/chat-zundamon.git
cd chat-zundamon
pnpm install --frozen-lockfile
pnpm --filter @yui/web dev
```

[http://127.0.0.1:4383](http://127.0.0.1:4383)を開きます。このモードの返信は**表示確認用の定型文**で、実AI・音声・外部サービスには接続しません。名前や会話の表示を試せます。

設定画面だけを見る場合は `pnpm setup:preview`。自分のサービスにつなぐ場合は [初期設定](docs/initial-setup.md) を読んで `pnpm setup:app` を実行してください。

AIに導入を手伝ってもらう場合：

> AGENTS.mdとdocs/setup-guide.mdを読み、Chatずんだもんの初期設定を手伝ってください。設定済みのものは維持し、足りないところから進めてください。

## 実装を読む

| 場所 | 内容 |
| --- | --- |
| `apps/web/src` | Reactの画面、会話・通話、壁紙、Live2D／VRM表示 |
| `apps/server/src` | AI、音声、本人認証、Google連携、保存 |
| `apps/server/src/codex` | Codex app-serverへの依頼・確認・進捗・結果 |
| `packages/domain/src` | 会話・プロフィールなどの共通型とルール |
| `supabase/migrations` | 保存・同期に使うDBとアクセス制御 |
| `scripts` | 初期設定・起動・バックアップ・素材準備 |

React / TypeScript / Vite / Fastify / Supabaseを使用しています。以前の自作アプリYUIを土台に独立させたため、内部パッケージ名に `@yui` が残っています。作者のYUIのデータや接続情報を使うものではありません。

## 設定・素材

- [AIと一緒に導入する](docs/setup-guide.md) ／ [初期設定](docs/initial-setup.md)
- [DB・ログイン・Googleの準備](docs/service-setup.md)
- [AI接続](docs/ai-connection.md) ／ [声](docs/voice-connection.md) ／ [Codex](docs/codex.md)
- [キャラクター・Live2D・VRMの素材](docs/character-art.md) ／ [BGM](docs/bgm.md)
- [起動・バックアップ・復旧](docs/operations.md)
- [公開版の検証範囲](docs/publication.md)

## ライセンス・クレジット

独自のソースコードは [MIT License](LICENSE)。依存ライブラリ、外部サービス、キャラクター、音声、モデル、楽曲にはそれぞれの条件が適用されます。詳しくは [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md)。

- キャラクター：東北ずん子・ずんだもんプロジェクト
- 紹介時の立ち絵：坂本アヒル
- 紹介時のLive2Dモデル：Live2D Inc.／公式配布モデル
- 音声：VOICEVOX：ずんだもん
- 紹介時のBGM：KK、こおろぎ（DOVA-SYNDROME）

本アプリは個人による非公式の制作物です。各権利者・サービス提供者の公式アプリではありません。
