# DECKFLOW

**曲を整える。流れをつくる。**

手元の音源を整理・解析し、タッチでもMIDIでもプレイできるDJワークスペース。iPad miniで外に持ち出し、CDJ-3000用USBの準備につなげることを目指しています。

現在は **v0.1 開発版**です。Web版、CoreMIDIを橋渡しするiPadアプリ、Mac用USB生成ツールを収録しています。物理iPad・コントローラー・CDJでの実機検証はまだ完了していません。

![DECKFLOWの2デッキとタッチプラッター](docs/preview.jpg)

## 動かす

Web版にnpm依存のインストールは不要です。Node.js 22以上を推奨します。

```sh
git clone https://github.com/bassmicrobe/DECKFLOW.git
cd DECKFLOW
npm run build
npm run dev
```

表示されたローカルURLを開き、「デモ音源を試す」または「音源を追加」から始めます。デモ2曲は端末内で合成するオリジナル音源です。再生は自動では始まりません。

Macのlocalhost URLを別端末のiPadから開くことはできません。iPadではHTTPS配信したWeb版、または同梱配信するiPadアプリを利用してください。

音源を追加 → BPMを確認 → 曲の **A / B** でデッキへ読み込み → 再生。プラッターは押さえて前後に回すとスクラッチし、離すと押さえる前の再生状態に戻ります。押さえる前が停止中なら停止状態を保ちます。

## 現在の機能

| 機能 | 実装と範囲 |
| --- | --- |
| 音源管理 | ブラウザがデコードできるMP3・WAV・AAC等。曲名／アーティストの編集、検索、並び替え、プレイリスト |
| ローカル保存 | IndexedDBに音源とメタデータを分けて保存。再読み込み後も保持。保存できない環境では一時保存と明示 |
| BPM解析 | Web Workerで解析。無音時はBPMを作らず、手動修正・半分／倍への変更が可能 |
| 2デッキ | 再生、停止、波形からシーク、3-band EQ、レベル、equal-powerクロスフェーダー、マスター |
| テンポ／KEY LOCK | ±50%。SoundTouchJSで音程を維持。非対応や失敗時はPITCH LINK表示で通常再生へ戻る |
| スクラッチ | 専用AudioWorkletがPCMを正転／逆転。Pointer Eventsでマウス・タッチ・ペンを共通処理 |
| CUE／ループ | CUEへ復帰、4つのHOT CUE、1／2／4／8拍ループ。HOT CUEはShift＋クリックで解除 |
| SYNC | 相手デッキの実効BPMにテンポを合わせる。拍位相の自動整列や可変テンポ同期は未実装 |
| MIDI Learn | Note、CC、14-bit Pitch Bend、チャンネル別、絶対値／相対エンコーダー、複数入力・接続変更 |
| キーアサイン | 再生・CUE等のボタン操作。Shift／Alt、競合の置換、押しっぱなしの連打防止、文字入力との分離 |
| プロファイル | 割り当ての自動保存、JSONによる書き出し／読み込み。連続値はMIDIへ割り当て |
| オフライン | Service Worker／PWA。初回の資産取得完了後、同じブラウザのローカル音源を利用 |
| CDJ-3000用生成 | Mac補助ツールでDevice LibraryのPDB・ANLZ・音源を新規ディレクトリへ生成。iPad単体生成は未実装 |
| iPadアプリ | SwiftUI／WKWebView＋同梱localhost配信＋CoreMIDI→Web MIDI互換ブリッジ。Simulatorで確認 |

キーボード初期設定: **Q** = A再生、**A** = AのCUE、**P** = B再生、**L** = BのCUE、**G** = クロスフェーダー中央。

## iPadで使う

Webのタッチ操作と、iPadアプリの機材連携は区別しています。

- SafariのWeb版ではタッチと外付けキーボードを利用できます。Safari自体はWeb MIDIに対応していません。
- `native/ios` は同じ画面・音源管理・Web Audioを同梱し、CoreMIDIによる入力を追加します。WebViewで包むだけでなく、機材接続処理を実装しています。
- iPadアプリのビルド・MIDIの仕様は [native/ios/README.md](native/ios/README.md) を参照してください。
- **ヘッドホンCUEとマスターの独立出力、任意コントローラーの専用HID／ジョグ／LED対応、iPad単体USB生成は未実装**です。通常の音声出力はシステムの出力先を使います。
- 物理iPad mini 8の遅延・CPU・長時間動作、USBハブ・給電・実コントローラーの組み合わせは未検証です。

```sh
npm run build
npm run ios:sync
```

その後Xcodeで `native/ios/DECKFLOW.xcodeproj` を開きます。実機用の署名チームは利用するApple Developerアカウントで設定します。署名情報や証明書はリポジトリに含めません。

## CDJ-3000用USB生成

ブラウザの「USB書き出し」は **Macへ渡すライブラリJSON** を保存する入口です。JSON単体はCDJ用ライブラリではなく、音源も含みません。

Macに元音源を用意し、Rust／Cargoを利用して固定版bakenをプロジェクト内へビルドします。

```sh
npm run usb:setup
npm run usb:export -- \
  --library /path/to/deckflow-library.json \
  --audio-dir /path/to/Music \
  --out /path/to/DECKFLOW-NEW-EXPORT
```

出力先は**まだ存在しない新規フォルダ**に限定し、既存USBライブラリを更新・上書きしません。曲名、BPM、先頭拍、CUE／HOT CUE、プレイリスト、波形を生成し、別のreaderで読み戻してから完了します。元音源は変更しません。同名ファイルの衝突や欠損はエラーにします。

出力フォルダの中身を適切な形式のテスト用USB直下へ配置し、CDJ実機で確認する段階が別途必要です。Mac helperはUSBのフォーマット・取り外し処理をしません。対象は **CDJ-3000の従来Device Library**で、CDJ-3000X等のOneLibrary対応を意味しません。

詳しくは [USB_EXPORT.md](docs/USB_EXPORT.md)。実際のUSB媒体とCDJ-3000での再生・波形・Quantize・キューは未検証です。

## 技術構成

| 部分 | 技術 |
| --- | --- |
| UI | HTML／CSS／ES Modules。ビルド不要の静的アプリ |
| 音声 | Web Audio API、AudioWorklet、SoundTouchJS |
| BPM／波形 | Web Worker＋独自解析＋Canvas |
| データ | IndexedDB、割り当て設定はlocalStorage |
| 操作 | Pointer Events、Web MIDI、キーボード、iPad CoreMIDIブリッジ |
| USB | Node.js helper、固定commitのRust製baken |
| iPad | SwiftUI、WKWebView、Network.framework、CoreMIDI |
| チェック | Node組み込みtest runner、実DSP処理、実USB writerの読み戻し、XCTest |

APIサーバー、クラウド音源保管、ログイン、課金、解析結果の外部送信は実装していません。音源はアップロードせず端末内で扱います。アプリの初回取得と更新には配信元への通信が必要です。

## ログインとマネタイズ

推奨方針は **基本利用はログイン不要、同期やバックアップだけ任意アカウント**。外出先・オフラインでの即時利用を保ちます。現時点で認証画面や課金のゲートはありません。

有料化の候補は、①大量曲の整理・高度な準備支援を買い切りPro、②端末間同期・履歴付きバックアップを継続課金、③複数機材・現場のプロファイル管理です。基本のMIDI／キーアサインは使える状態を保つ案です。需要を検証した収益予測ではありません。

公式競合情報・価格仮説・優先順位は [PRODUCT_STRATEGY.md](docs/PRODUCT_STRATEGY.md)。課金実装より先に、iPad・コントローラー・CDJの実機検証を進めます。

## 品質と制約

- 1曲80 MiB、20分まで。圧縮音源のデコードに加えてスクラッチ用PCMも保持するため、iPadでは少数曲から確認してください。
- BPM・先頭拍は推定です。実曲コーパスでの精度やrekordboxとの一致は保証しません。可変テンポ／曲構成の解析は未実装です。
- ブラウザの保存領域は永続バックアップではありません。サイトデータの削除、ストレージ不足、ブラウザによる削除で失われ得ます。元音源を保持してください。
- 「ライブラリ保存」はメタデータの書き出しです。音源バックアップ・クラウド同期・メタデータJSONの再取り込みは未実装です。
- デモで動くこと、DSPテスト、Simulator起動は、本番ライブや物理機材での受け入れ確認を代替しません。

```sh
npm test
npm run build
```

bakenの実writerを含む検証:

```sh
DECKFLOW_BAKEN_BIN="$PWD/.local/baken/bin/baken" node --test tests/usb-export.test.mjs
```

baken未インストール時のテストは該当する実書き出しをスキップします。構造検証・失敗系のテストだけでUSB実出力まで検証したとは扱いません。今回の実行記録は [VERIFICATION.md](docs/VERIFICATION.md) に記載します。

## OSSと参考

- **SoundTouchJS AudioWorklet 2.1.1 / MPL-2.0**: KEY LOCKに採用。配布物のintegrity、対応ソース、原文ライセンス、NOTICEを `dist/vendor/soundtouchjs/` に同梱。
- **baken 4.10.0 / MIT**: USB writerに採用。commitを固定し、著作権・ライセンス表示を保持。
- Essentia／aubioはライセンスと配布方針の整理が別途必要なため、今回は同梱していません。
- [B2B Studio](https://b2bstudio.live/)のデッキとミキサーの配置、ゲストで試す入口、操作学習の導線を参考にしています。画像・ロゴ・実装コードは流用していません。遠隔B2Bセッション機能は含みません。

採用・比較の根拠は [OSS_REVIEW.md](docs/OSS_REVIEW.md)、配布物の通知は [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md)。DECKFLOW本体のライセンスは現時点で未設定です。各OSSのライセンスとは区別してください。
