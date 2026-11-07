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

## 採用: OneLibraryのブラウザ用SQLCipher／SQLite reader

確認日: 2026-11-07。対象はrekordbox 6/7の `master.db` とUSBの `exportLibrary.db` の**読み取り**です。

- ソース: [v1vendi/onelibrary](https://github.com/v1vendi/onelibrary)。固定commit: `02c6f80c802a635c394e733058502ecf28cf9fc9`。
- ライセンス: MIT、Copyright (c) 2026 v1vendi。原文を `dist/vendor/onelibrary/LICENSE` に保存。
- 採用ファイル: `viewer/src/sqlcipher.js` と `viewer/src/sqlite.js`。対応する上流SHA-256、変更点、試験用fixtureの出自を `dist/vendor/onelibrary/NOTICE.md` に記載。
- ローカル変更: 読み取り専用のSQLCipher API、ページごとのHMAC検証、SQLiteの範囲検査・循環検出・読み取り上限を追加。Web CryptoとWeb Workerで処理し、外部サーバーへDBを送信しません。
- DBの相互運用定数は上流の `python/src/onelibrary/keys.py` を参照。ユーザーの認証情報を取得する仕組みや、実行ファイルからのキー探索は含みません。
- 上流の `viewer/test/fixtures/sample.db` は架空の曲情報とテスト用passphraseを持つ合成fixtureです。実ユーザーの音源やDBは同梱しません。

`dist/rekordbox-sqlite.js` は読み取り結果をDECKFLOWの曲・階層プレイリストへ変換します。`master.db` のCUE種別、削除フラグ、スキーマは [pyrekordboxの固定モデル](https://github.com/dylanljones/pyrekordbox/blob/02a208837434e4c05c0a222e8fe6583e6ac0547f/pyrekordbox/masterdb/models.py)、[CueGen](https://github.com/mganss/CueGen/blob/master/CueGen/Generator.cs)、[rbxportの固定ソース](https://github.com/chrisle/rbxport/blob/b739d369665b492534dc2eae0733322c040a26d5/crates/rbl-db/src/write.rs) の構造情報と照合しました。これら3件の実装コードはコピーしていません。

HOT CUE A〜HとメモリーCUE／LOOP・名前を取り込みます。DB固有のCUE色、HOT CUE I以降、終了位置がないループ、スマートプレイリストなどは未対応として警告します。OneLibraryのCUE／LOOPは対応ANLZから引き継ぎます。非空の同名 `-wal` が選択範囲にあるDBは読み込まず、rekordboxで確定してからの再選択またはXMLを案内します。

## ブラウザ用Device Library／ANLZ reader

`dist/rekordbox-device.js` は、固定版bakenのPDBページ／行／文字列レイアウトと [Deep Symmetryの形式資料](https://djl-analysis.deepsymmetry.org/rekordbox-export-analysis/) をもとに実装した読み取り専用モジュールです。baken由来のMIT通知をファイル内に保持します。

`export.pdb` の曲・アーティスト・プレイリストと、対応するDAT／EXTの波形、ビートグリッド、CUE／LOOPをブラウザで読みます。USBの音源パスと解析ファイルの参照を照合し、表示用ピークを生成します。端末へのライブラリ取り込みは音源全体をデコードせず、元の符号化データをIndexedDBへコピーします。USBを接続しただけで自動読み込みしたり、元のUSBを書き換えたりはしません。

DBは128 MiB、Webで読むANLZは32 MiB、ライブラリは10,000曲・1,000プレイリストまでです。形式検証・合成fixture・生成USBの読み戻しは、全rekordboxバージョン、物理iPad、CDJ全機種での受け入れ確認を代替しません。今回のテストとブラウザ確認は [VERIFICATION.md](VERIFICATION.md) に記録します。

## 操作画面の参考資料

2026-11-07に以下の公開ページを確認し、既存の暗色・オレンジ／ティールの配色に合わせてHTML／CSSで実装しました。各サイトの画像・ロゴ・実装コードはコピーせず、React／Motion等の依存も追加していません。

| 参考 | 採用した考え方 |
| --- | --- |
| [21stのSidebar例](https://21st.dev/@shadcn/components/sidebar) | 読み込み元とプレイリストをグループ分けした常設サイドバー、選択状態 |
| [React Bits Dock](https://reactbits.dev/components/dock) | よく使う操作をコンパクトにまとめる配置 |
| [Magic UI Dock](https://magicui.design/docs/components/dock) | 画面下部の試聴コントロール。拡大・バウンド等の演出は使わない |
| [Uiverse Input](https://uiverse.io/ErzenXz/horrible-rattlesnake-14) | 検索欄の境界、フォーカス状態の見やすさ |
| [Mobbin](https://mobbin.com/) | 公開の紹介・カタログを確認。ログイン内の画面は未閲覧、素材の流用なし |

読み込み元を左、検索可能な曲一覧を中央、試聴を下部に置く構成です。rekordboxの基本的な作業順序を参考にしつつ、タッチ操作の44pxターゲット、狭い画面での折り返し、75曲単位のページ表示を用意しています。

## USB書き出しのブラウザ／iPad対応について

`baken-export` は現在、`std::fs`による音源・ディレクトリ操作、rayon、ネイティブSQLite（OneLibrary用）、OSごとのボリューム処理を含みます。公開crateをそのままWebAssemblyへ入れる構成は確認できていません。PDBの純粋なエンコード部分を切り出す将来の移植は検討できますが、今回それを完了済みと扱っていません。

USBの読み取りは前述のブラウザreaderで行います。USB書き出しは、ブラウザが保存したライブラリJSONをmacOS helperへ渡し、CDJ-3000向けファイル一式を新規ディレクトリに生成する方式です。iPad単体のUSB生成は未実装です。Web／PWAを開発対象としており、ネイティブ版へのwriter移植は含みません。

## 自動生成の解析データの限界

BPM、先頭拍、CUE、HOT CUEはDECKFLOWの値からrekordbox XMLを作り、bakenに渡します。baken自身がBPMを推定するわけではありません。取り込んだ可変TEMPOはグリッドへ引き継ぎますが、曲構成のPhrase情報やrekordboxと同等の色波形を新しく生成するものではありません。既存解析を指定しない場合は `--generate-analysis --anlz-dir <空の一時フォルダ> --no-settings` を使います。`--analysis-dir` を明示した場合だけ対応する既存解析を読み取り、一時コピーから引き継ぎます。rekordboxのライブラリやMy Settingsを自動探索しません。プレイヤーの設定はそのまま使います。

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

## 追記: DJ再生改善・既存USB更新のOSS評価

確認日: 2026-11-07。以下は、上記の初期実装時点から追加・継続した採用判断です。

| OSS | 一次資料で確認したライセンス | 今回の扱い |
| --- | --- | --- |
| [SoundTouchJS](https://github.com/cutterbl/SoundTouchJS/tree/d9e39a7ddcf74c7a145bbba45856f30068c82b79) | [MPL-2.0](https://github.com/cutterbl/SoundTouchJS/blob/d9e39a7ddcf74c7a145bbba45856f30068c82b79/LICENSE) | `@soundtouchjs/audio-worklet` **2.1.1** をKEY LOCK用に継続利用。スクラッチ／SYNCの改善を理由にDSP本体を改変・置換していない |
| [Tone.js](https://github.com/Tonejs/Tone.js) | [MIT](https://github.com/Tonejs/Tone.js/blob/dev/LICENSE.md) | 音声スケジュールの設計比較に限定。実装コードのコピー、依存追加、同梱なし |
| [Mixxx](https://github.com/mixxxdj/mixxx) | [GPL-2.0-or-later](https://github.com/mixxxdj/mixxx/blob/main/LICENSE) | DJ再生・同期・スクラッチの設計比較に限定。実装コードのコピー、リンク、同梱なし |
| [sql.js](https://github.com/sql-js/sql.js/tree/9c4e167ec37129192d166ab9223faa9a4bd07c58) | [MIT](https://github.com/sql-js/sql.js/blob/9c4e167ec37129192d166ab9223faa9a4bd07c58/LICENSE) | **1.14.2** を新たに同梱。既存OneLibraryをSQLiteで編集し、対象外の行・未知の列・64-bit整数を維持するために採用 |

SoundTouchJSの固定commitは `d9e39a7ddcf74c7a145bbba45856f30068c82b79`。配布物のintegrity、対応ソース、ビルド時のimport変換は [同梱NOTICE](../dist/vendor/soundtouchjs/NOTICE.md) と [provenance.json](../dist/vendor/soundtouchjs/provenance.json) に記録し、MPLの通知・対応ソースを継続して提供します。

sql.jsの固定release commitは `9c4e167ec37129192d166ab9223faa9a4bd07c58`。[同梱NOTICE](../dist/vendor/sqlite-writer/NOTICE.md) に公式配布ZIPとJS／WASMのSHA-256、著作権表示、ES module化のためのloader変更3点を記録しています。SQLiteエンジン本体は変更していません。新規OneLibraryのスキーマには、既採用のMITライセンスのbaken固定commitを使用します。既存DBはそのテンプレートから再生成せず、SQLiteのトランザクションで必要な変更を加えます。

USBアクセス層と組み合わせ、Device Library／OneLibrary双方への追加・HOT CUE更新を実装しています。既存音源・CUE・プレイリストの保持は合成データによる統合テストの対象ですが、物理iPad・USB実媒体・CDJ-3000での受け入れ確認は別途必要です。
