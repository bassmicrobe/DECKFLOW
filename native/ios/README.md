# DECKFLOW for iPad

SwiftUIのアプリにWeb版の画面と音声エンジンを同梱し、CoreMIDI入力を追加するiPad用シェルです。依存するSwiftパッケージはありません。

## 実装済みの範囲

- 同梱した`dist/`を起動時に読み込むため、Webサーバーや外部CDNを必要としません。
- 固定の`http://127.0.0.1:49037/`と永続`WKWebsiteDataStore`を使います。同じアプリの再起動ではIndexedDBのoriginが変わりません。
- アプリ内の「MIDIを接続」を押したときだけCoreMIDIクライアントを開始します。接続したMIDI入力を、既存のMIDI Learnへ渡します。
- 入力の接続・切断、Note／CC／Pitch BendなどのMIDI 1チャンネルメッセージ、running statusに対応します。SysExとMIDI出力は未対応です。
- JSONなどのダウンロードはアプリの`Documents/Exports/`へ保存し、共有シートを開きます。上書きを避けるため、同名ファイルがある場合は別名にします。
- 外部のページへの移動、別ウィンドウ、localhost以外からのネイティブブリッジ呼び出しを拒否します。

このアプリのMIDI対応は汎用MIDI入力の対応です。HIDやメーカー独自プロトコル、専用ドライバーが必要なコントローラー、LEDフィードバックを自動的にサポートするものではありません。

## 未実装・未検証

- 音声処理は引き続きWeb Audio／AudioWorkletです。AVAudioEngineによるネイティブ再生、ヘッドホンCUEとマスターの独立多チャンネル出力は実装していません。
- iPadアプリからCDJ互換USBを直接作成する処理は実装していません。リポジトリのMac用USB書き出し補助ツールとは別の機能です。
- バックグラウンド再生を保証しません。画面を開いた状態で操作してください。
- コントローラー実機の接続、iPad mini 8実機、低遅延性能、抜き差しや音声割り込みからの復帰は未検証です。
- SimulatorのMIDIやWeb Audio確認は、実機での音質・遅延・電力・安定性の保証にはなりません。
- App Store／TestFlightには配布していません。実機へ入れるにはXcodeで自身の署名チームを設定してください。

## 起動・ビルド

確認に使用した環境はXcode 27.2、iOS Simulator 27.0です。deployment targetはiOS 17.0、対応端末はiPadです。

2026年11月6日、専用のiPad mini（A17 Pro）／iOS 27.0 Simulatorで3件のテストが成功しました（失敗・skipとも0）。localhostの`isSecureContext`、AudioWorkletモジュールの読み込みとノード生成、MIDI shimからWKブリッジを経由したCoreMIDIの明示的な開始、パス制限とMIDIメッセージの分割を確認しました。

同梱した実際の`app.js`が`#a-platter`とアサイン一覧を生成すること、SoundTouchの`SoundTouchNode.js`と`soundtouch-processor.js`をlocalhostから取得し、Workletを登録してノードを生成できることも確認済みです。これはユーザー操作なしで行う登録・構築の確認です。実音のレンダリングや物理コントローラーの認識・音質・レイテンシの確認とは区別してください。

最終のWeb側HTML dialog対応後に、最新`dist/`を再同期して署名なしSimulator buildも実行しています。`FinalCandidateTests.xcresult`は拡張runtimeテストの記録です。通常は無視対象の`DerivedData/`内にあり、Gitには含めません。

リポジトリのルートで実行します。

```sh
node scripts/sync-ios-assets.mjs
open native/ios/DECKFLOW.xcodeproj
```

Xcodeで`DECKFLOW` schemeとiPadのSimulatorを選び、Runします。Web側を変更したときは、再度同期スクリプトを実行してからビルドしてください。同期先の`Resources/Web/`は生成物なのでGitには含めません。

署名を行わないSimulatorビルド:

```sh
xcodebuild \
  -project native/ios/DECKFLOW.xcodeproj \
  -scheme DECKFLOW \
  -configuration Debug \
  -sdk iphonesimulator \
  -destination 'generic/platform=iOS Simulator' \
  -derivedDataPath native/ios/DerivedData \
  CODE_SIGNING_ALLOWED=NO build
```

テストはインストール済みSimulatorを指定します。利用可能な機種は`xcrun simctl list devices available`で確認できます。

```sh
xcodebuild \
  -project native/ios/DECKFLOW.xcodeproj \
  -scheme DECKFLOW \
  -destination 'platform=iOS Simulator,name=iPad mini (A17 Pro)' \
  -derivedDataPath native/ios/DerivedData \
  CODE_SIGNING_ALLOWED=NO test
```

`generate-project.py`から同じ最小Xcodeプロジェクトを再生成できます。通常のビルドにPythonやXcodeGenは不要です。

```sh
python3 native/ios/generate-project.py
```

## localhostを使う理由

`file://`や独自URL schemeのラップだけでAudioWorkletの動作を仮定せず、loopback HTTP originで起動します。`LocalAssetServer`はNetwork.frameworkを使い、`127.0.0.1`かつloopback interfaceにのみbindします。LANへ広告しません。GETだけを許可し、HostとOrigin、パストラバーサル、シンボリックリンクの逸脱、ヘッダーとファイルサイズを制限します。SoundTouchの正規配布フォルダ`.dist/`は、既知の同梱パッケージ配下だけを明示的に許可しています。

アプリ内ではService Workerを登録せず、同梱ファイルの更新を優先する設計です。アプリ削除やWebデータの消去によって、音源や設定は消去されます。元の音源と書き出した設定を別途保管してください。

## 主なファイル

| ファイル | 内容 |
|---|---|
| `DECKFLOW/DECKFLOWApp.swift` | SwiftUI、WKWebView、origin制限、ダウンロード |
| `DECKFLOW/LocalAssetServer.swift` | 読み取り専用localhostサーバー |
| `DECKFLOW/NativeMIDI.swift` | CoreMIDI入力とMIDIメッセージ分割 |
| `DECKFLOW/NativeMIDIBridge.js` | Web MIDI入力の互換shim |
| `DECKFLOWTests/NativeRuntimeTests.swift` | パス境界、MIDI分割、Webランタイム確認 |

APIの根拠: [CoreMIDI](https://developer.apple.com/documentation/coremidi)、[NWParameters](https://developer.apple.com/documentation/network/nwparameters)、[WKScriptMessageHandler](https://developer.apple.com/documentation/webkit/wkscriptmessagehandler)、[AudioWorklet](https://developer.mozilla.org/en-US/docs/Web/API/AudioWorklet)。
