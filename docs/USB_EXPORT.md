# CDJ-3000用USBデータの書き出し

DECKFLOWのWeb画面で管理したBPM・CUE・プレイリストを、macOSのローカルhelperで従来Device Libraryへ変換します。**iPadだけで直接USBへ書き出す機能はまだありません。**

## 1. helperを準備する

Node.js 20以降、Rust／Cargoが必要です。初回のソース取得・ビルドにはネット接続を使います。

```sh
node tools/setup-usb-exporter.mjs
```

baken 4.10.0のレビューしたcommitを `.local/baken/` にビルドします。実行時のbaken更新チェックは無効にしています。必要なライセンスと採用理由は [OSS_REVIEW.md](OSS_REVIEW.md) を参照してください。

## 2. Web画面からライブラリJSONを保存する

BPM、CUE、HOT CUE、プレイリストを整え、ライブラリJSONを書き出します。JSONには音源そのものは入りません。

ブラウザは元ファイルの絶対パスを持たないため、Mac側で元の音源フォルダを `--audio-dir` に指定します。フォルダを再帰的に調べ、JSONの `filename` と一致する音源を選びます。重名が複数ある場合や音源がない場合は、推測せず停止します。隠しフォルダとシンボリックリンクは走査しません。

## 3. 新規フォルダへ書き出す

以下のパスを自分のものに置き換えます。**出力先の親フォルダは存在し、出力先そのものは存在しない必要があります。**

```sh
node tools/export-usb.mjs \
  --library /path/to/deckflow-library.json \
  --audio-dir /path/to/Music \
  --out /path/to/DECKFLOW-NEW-EXPORT
```

確認だけ行う場合:

```sh
node tools/export-usb.mjs \
  --library /path/to/deckflow-library.json \
  --audio-dir /path/to/Music \
  --out /path/to/DECKFLOW-NEW-EXPORT \
  --dry-run
```

処理内容:

1. JSON・音源参照・BPM・CUE範囲を検証。
2. bakenのCDJ-3000フォーマットチェックで、機種が受け付けない音源を拒否。
3. 新しいフォルダへだけ `PIONEER/rekordbox/export.pdb`、`PIONEER/USBANLZ/`、`Contents/` を生成。
4. 曲名・BPM・グリッド・CUE・プレイリスト順を読み戻し、音源SHA-256を比較。
5. 成功すると `DECKFLOW-REPORT.json` を保存。`hardwareVerified:false` は実機確認前という意味です。

どのプレイリストにも入っていない曲も含めるため、全曲リスト `DECKFLOW ALL` が追加されます。My Settingsは書き出さず、CDJ側の設定を使います。出力途中の失敗では、新規フォルダに `DECKFLOW-INCOMPLETE.txt` を残します。そのフォルダを現場用USBとして使わないでください。

このhelperは既存フォルダへの更新、削除、USBの初期化を行いません。

## 4. 専用USBへ配置して実機確認する

生成された `PIONEER/` と `Contents/` を、対応するファイルシステムの**専用USBの直下**に配置します。外側の `DECKFLOW-NEW-EXPORT/` フォルダごと入れると、CDJはライブラリを見つけません。既存rekordbox USBへ重ねず、別のUSBを使ってください。

CDJ-3000とCDJ-3000Xはライブラリ形式が異なります。このhelperの対象は **CDJ-3000** です。対応形式は[メーカーのUSB Export情報](https://rekordbox.com/en/support/usb-export/)で確認してください。

少数曲で曲一覧、BPM、波形、CUE、プレイリスト順、音出しをCDJ-3000で確認してから使用範囲を広げます。Mac上での構造検証だけでは、現場での動作確認にはなりません。

## テスト

通常のテストは純粋なXML／入力検証を実行します。

```sh
node --test tests/usb-export.test.mjs
```

実writerの統合テストを含める場合:

```sh
DECKFLOW_BAKEN_BIN="$PWD/.local/baken/bin/baken" node --test tests/usb-export.test.mjs
```

実音源は使用せず、一時フォルダ内で自動生成したWAVを書き出して検証し、終了後に一時フォルダを除去します。
