# ライセンスと素材

## コード

このリポジトリの独自コード（自作アプリYUIから引き継いだコードを含む）はMITライセンスです。npm依存パッケージのコードは同梱せず、`pnpm-lock.yaml` にバージョンを固定しています。各パッケージのライセンス・通知を確認してください。MITの許諾は第三者の素材やサービス利用の権利を与えるものではありません。

## キャラクター・原画

ずんだもんは東北ずん子・ずんだもんプロジェクトのキャラクターです。紹介画面では坂本アヒル氏の立ち絵と公式Live2D配布モデルを利用していますが、公開ソースには原画、加工済みの立ち絵・アイコン、モデルの書き出し画像を同梱していません。

- [キャラクター利用のガイドライン](https://zunko.jp/guideline.html)
- [坂本アヒル氏](https://twitter.com/sakamoto_ahr)
- [Live2D公式ずんだもんモデル](https://www.live2d.com/en/learn/sample/zundamon/)

## Live2D / VRM

SDK、Core、Framework、モデル、テクスチャ、モーション、生成した結合済みブリッジは同梱しません。コード中のCubism向けアダプターはSDKを別途入手してビルドする構成です。利用・公開・配布時はSDKとモデル双方の最新条件を確認してください。[NOTICE-LIVE2D.md](NOTICE-LIVE2D.md)参照。

VRMモデルも各自で用意します。モデル固有の利用条件とVRMメタデータを確認してください。

## 音声・BGM

音声生成物・BGMファイルは同梱しません。

- [VOICEVOX 利用規約](https://voicevox.hiroshiba.jp/term/)
- [DOVA-SYNDROME 音源利用ライセンス](https://dova-s.jp/help/articles/license/)
- [DOVA-SYNDROME 禁止事項](https://dova-s.jp/help/articles/license-prohibitions/)

音声を使った動画・作品では「VOICEVOX：ずんだもん」などの必要なクレジットを付けてください。BGMの入手先と本人用の配置先は [BGM](docs/bgm.md) へ。第三者への音源の再配布・配信を許諾するリポジトリではありません。

## 同梱の代替画像・壁紙

公開版のアイコン・立ち絵枠の画像は、独自の単純な吹き出し図形です。坂本アヒル氏の原画を加工したものではありません。`scripts/prepare-source-placeholders.mjs` で再生成できます。4枚の枝豆柄壁紙は開発時に画像生成で制作したものです。これら独自アセットも本リポジトリのMIT条件で提供します。第三者のキャラクター権利を含めて許諾するものではありません。
