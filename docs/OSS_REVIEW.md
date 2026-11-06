# 採用OSSと比較結果

## 採用: SoundTouchJS AudioWorklet 2.1.1

- ソース: https://github.com/cutterbl/SoundTouchJS
- パッケージ: `@soundtouchjs/audio-worklet` `2.1.1`。旧archive済みworkletリポジトリではなく、現行monorepoを採用。
- ライセンス: **MPL-2.0**。MITとは扱いません。完全なライセンス、通知、対応TypeScriptソース、npm tarballのintegrity、上流commitの照合を `dist/vendor/soundtouchjs/` に同梱しています。
- 用途: 再生速度に追従してピッチを補償し、KEY LOCKを実装。ランタイムの外部CDN取得はありません。
- 実検証: 同梱した本物のDSPを128-frameずつ実行し、440／660 Hzの入力を速度0.92・1.08・1.25で処理して音程維持を確認。物理iPadでの音質／遅延／CPU確認は別途必要です。
- 配布方針: MPLでカバーされるファイルと変更のソース／通知を保持。DECKFLOW全体がMITになった、または権利条件がなくなったとは扱いません。

ライセンスの一次資料: https://www.mozilla.org/en-US/MPL/2.0/ 。対応ソースと取得根拠は同梱の `provenance.json`／`NOTICE` を参照してください。

## BPM解析の比較

| 候補 | 確認した条件 | 今回の判断 |
| --- | --- | --- |
| [Essentia.js](https://github.com/MTG/essentia.js) | ブラウザで動く音楽解析。AGPLと商用ライセンスの整理が必要 | 自由な閉ソース商用同梱とみなさず、今回は不採用 |
| [aubio](https://github.com/aubio/aubio)／aubiojs | wrapperのMIT表示だけでは本体GPL-3.0の条件を消せない | MIT-only依存とは扱わず、今回は不採用 |
| DECKFLOW独自解析 | Workerでオンセットとテンポを推定。外部依存なし | 継続。合成拍のテストを実施し、実曲の精度は今後評価 |

Essentiaの一次ライセンス説明: https://essentia.upf.edu/licensing_information.html 。aubio: https://github.com/aubio/aubio/blob/master/COPYING 。

## USB書き出し

確認日: 2026-11-06。対象は **CDJ-3000（3000Xではない）** の従来Device Libraryです。

## 採用: baken 4.10.0

- ソース: https://github.com/M-Igashi/baken
- 確認したcommit: `50d2ba07fdad49d3a95e02d2951ac7a67197e85a`
- ライセンス: MIT。原文を `vendor/licenses/baken-MIT.txt` に保存。
- 実装根拠: `crates/baken-export/src/pdb/writer.rs` は `export.pdb` のwriter、`anlz/generate/` は音源からPMAI解析ファイルを生成する実装。読み取り専用ライブラリではありません。
- 上流の操作説明: https://github.com/M-Igashi/baken#direct-usb-export-baken-expressport
- 上流の実機報告: https://github.com/M-Igashi/baken/issues/116 。CDJ-3000 firmware 3.22の報告があります。**DECKFLOWから出力したUSBの実機確認を代替しません。**

`tools/setup-usb-exporter.mjs` は、このcommitを指定した `cargo install --git ... --rev ... --locked` を実行し、プロジェクト内の `.local/baken/` にだけビルドします。グローバル環境へのインストールではありません。デバイスwriterはブラウザへ同梱せず、macOS上のhelperからCLIを呼びます。`--baken`で別バイナリを指定する場合も4.10.0を要求しますが、そのバイナリのソースcommitまで認証する仕組みではありません。出力レポートの `reviewedBakenRevision` はレビュー対象のcommitを示します。

`tools/usb-inspect.mjs` のページチェーンと文字列の読み取りは、上流のMIT実装 `pdb/read.rs` / `pdb/string.rs` のレイアウトに基づく小さい検証readerです。上流の著作権表示をコードと上記ライセンスファイルに保持しています。汎用編集ツールとしては扱いません。

## 比較した候補

| 候補 | 一次資料で確認した役割 | DECKFLOWでの判断 |
| --- | --- | --- |
| [baken](https://github.com/M-Igashi/baken) | Device Library PDB writer、音源コピー、解析ファイル生成、XML由来のグリッド／CUE／プレイリスト | 採用。版固定のローカルhelperとして利用 |
| [rekordcrate](https://github.com/Holzhaus/rekordcrate) | PioneerデバイスのPDB／ANLZ／設定ファイルの解析・dump。MPL-2.0 | 読み取り調査の候補。README上のparserを完成したUSB writerとは扱わず、今回は組み込まない |
| [Craft Anything](https://github.com/storytold/craft-anything) | 汎用の静的／動的解析とAIによる再実装補助。初期alpha | USB専用writerではないため実行時依存にしない。必要な調査に限定して利用を検討 |
| [BLA](https://github.com/qybaihe/bla) | AIによる解析を妨げる保護ツール | 曲解析／USB writerの実装には使わない |

## ブラウザ／iPadへの移植について

`baken-export` は現在、`std::fs`による音源・ディレクトリ操作、rayon、ネイティブSQLite（OneLibrary用）、OSごとのボリューム処理を含みます。公開crateをそのままWebAssemblyへ入れる構成は確認できていません。PDBの純粋なエンコード部分を切り出す将来の移植は検討できますが、今回それを完了済みと扱っていません。

今回の完成範囲は、ブラウザが書き出したライブラリJSONをmacOS helperへ渡し、CDJ-3000向けファイル一式を新規ディレクトリに生成するところです。iPad単体でUSBを完成させる処理や、iPadネイティブ版へのwriter移植は別途必要です。

## 自動生成の解析データの限界

BPM、先頭拍、CUE、HOT CUEはDECKFLOWの値からrekordbox XMLを作り、bakenに渡します。baken自身がBPMを推定するわけではありません。可変テンポのグリッド、楽曲構成のPhrase情報、rekordboxと同等の色波形を保証しません。`--generate-analysis --anlz-dir <空の一時フォルダ> --no-settings` を指定するため、rekordboxの個人ライブラリや解析キャッシュ、My Settingsを読みません。プレイヤーの設定はそのまま使います。

## 検証

ローカルでRust 1.93.0を使い、対象commitの `cargo build --locked --release -p baken` が成功。`baken --version` は `baken 4.10.0` でした。`tools/setup-usb-exporter.mjs` による固定commitからのローカルインストールと既存ローカル版の入れ直しも成功しました。

以下の実書き出しテストを一時ディレクトリ上で実行し、**5件成功、スキップ0件**:

```sh
DECKFLOW_BAKEN_BIN="$PWD/.local/baken/bin/baken" node --test tests/usb-export.test.mjs
```

- 自動生成した16-bit／44.1 kHz／stereo WAVを2曲（128／174 BPM）用意。
- XML属性の日本語、`&`、引用符、曲順、CUE／HOT CUE位置を保持。
- 実際に `export.pdb`、各曲の `.DAT`／`.EXT`／`.2EX`、`Contents/` を生成。
- 別の小さいreaderでPDBを読み戻し、曲名・BPM・プレイリスト順を照合。
- ANLZの先頭拍、全拍のBPM、CUE位置、各ファイルの音源参照を照合。
- コピー先音源のSHA-256がコピー元と一致し、コピー元は不変。
- 同名の複数音源、パストラバーサル、シンボリックリンク、既存出力先を拒否。
- `--dry-run` は実出力先を作らないことを確認。

これはディスク上の構造と内容の検証です。**iPad、USB実媒体、CDJ-3000での読込・再生・波形表示・Quantize・長時間運用は未検証**です。
