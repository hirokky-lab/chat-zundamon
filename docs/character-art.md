# キャラクター素材を用意する

公開ソースにはずんだもんの原画・モデル・加工済み画像を含めません。初期状態のPNGは吹き出しを描いた代替画像です。画面・会話の表示確認はこのままできます。

## 静止画

[公式ガイドライン](https://zunko.jp/guideline.html)と配布者の条件を確認して素材を入手します。紹介画面で使った立ち絵の作者は [坂本アヒル氏](https://twitter.com/sakamoto_ahr) です。

自分の利用条件に合うPNGを次へ配置すると差し替えられます。画像はGitへ追加しないでください。

- `apps/web/public/characters/zundamon/sakamoto-ahiru.png` — 会話画面
- `apps/web/public/characters/zundamon/sakamoto-ahiru-welcome.png` — ログイン画面
- `apps/web/public/characters/zundamon/name-jaw-tilt.png` — 名前入力画面

既存のファイル名は互換性のため残しています。初期同梱ファイルの作者が坂本アヒル氏という意味ではありません。

## Live2D（任意）

1. [公式ずんだもんモデル](https://www.live2d.com/en/learn/sample/zundamon/)と [Cubism SDK for Web](https://www.live2d.com/en/sdk/download/web/) の条件を確認して取得します。
2. 準備スクリプトは **Cubism SDK for Web 5-r.5** と固定のモデルアーカイブを対象にしています。取得したZIPを `.superpowers/zundamon/model.zip` と `.superpowers/zundamon/sdk.zip` に配置します。
3. `node scripts/live2d/prepare-zundamon.mjs` を実行します。SHA-256が一致しない新しい配布物は停止します。確認せず検査を外さず、バージョン・スクリプトの互換性を見直してください。
4. 自分で用意した表示用PNGを `apps/web/public/live2d/zundamon/poster.png` に配置します。
5. 生成された `.superpowers/zundamon/runtime.env` の値を `apps/web/.env.local-live2d.local` に設定し、`pnpm build:local-live2d`（本人用接続モードなら `pnpm build:connected`）でビルドします。

SDK/Core/Frameworkとモデルの条件は [NOTICE-LIVE2D.md](../NOTICE-LIVE2D.md) を確認してください。通常の `pnpm build` にはLive2D実行素材を含めません。

## VRM（任意）

利用条件に合うVRMを入手して、メニュー → キャラクター → VRMモデルの追加・管理から選びます。端末内保存で使えます。同期には自分のSupabaseと所定のマイグレーションが必要です。

## アプリアイコン（任意）

公開版は吹き出しの図形です。利用条件に合う原画を使う場合、`scripts/prepare-app-icon-master.py` と `scripts/prepare-app-icons.mjs` は個人用の加工補助です。前者は特定の配布PSDのレイヤー構造に依存し、後者はmacOSのsipsを使います。加工しても元素材の条件がなくなるわけではありません。
