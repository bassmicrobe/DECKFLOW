# 大容量WAVとUSB書き出しの検証（2026-11-07）

Mac helperは従来のDevice Library (`export.pdb`) とOneLibrary (`exportLibrary.db`) を同じ新規フォルダへ生成します。出力後に両データベースを読み戻し、曲、サイズ、曲長、音源・ANLZパス、プレイリスト階層・曲順を照合します。既存の音源SHA-256、CUE／LOOP、ビートグリッド、引き継いだ波形の検査も継続します。

これまではWAVの`SampleRate`／`BitRate`を中間XMLへ渡しておらず、PDBにサンプルレート0が保存されていました。ヘッダーを範囲読み取りして実測情報を渡し、出力にも同じ値が保存されることを検証するようにしました。非WAV音源のサンプルレート／ビットレート検査は今回追加していません。

## 確認したこと

固定baken 4.10.0（`50d2ba07fdad49d3a95e02d2951ac7a67197e85a`）とNode 24.16.0で、次の合成ファイルを実際に書き出しました。

| 項目 | 結果 |
| --- | --- |
| 元音源 | WAV PCM 24-bit、2ch、96 kHz、1,073,741,864 bytes |
| 音源長 | 1,864.135104秒（約31分04秒） |
| USBコピー | 元ファイルとSHA-256一致、末尾まで同じサイズ |
| PDB | サイズ、曲長1,865秒、96 kHz、4,608 kbpsが一致 |
| OneLibrary | 暗号化DBを復号してサイズ・曲長・曲情報を照合 |
| 解析・操作位置 | DAT／EXT／2EX生成、全ビート検査、末尾1秒前のHOT CUE Hを読み戻し |
| 保存先 | 一時新規フォルダのみ。検証後に音源・出力とも削除 |

実行は約3.13秒、`/usr/bin/time -l`の最大常駐メモリは109,854,720 bytesでした。疎ファイルを使った無音中心の合成音源で、実曲の解析速度・USB機器へのコピー速度を保証する値ではありません。音源全体をJavaScriptのメモリに載せない経路と、1 GiB級のサイズが書き出し・読み戻しで保持されることを確認しています。

再実行:

```sh
DECKFLOW_BAKEN_BIN="$PWD/.local/baken/bin/baken" \
DECKFLOW_LARGE_AUDIO_TEST=1 \
node --test tests/audio-source-info.test.mjs tests/onelibrary-verify.test.mjs tests/usb-export.test.mjs
```

通常テストでは実bakenが指定された場合に小規模な実書き出しを検証します。1 GiBの実書き出しは上記フラグを指定した場合だけ実行します。APIの不正メタデータ、元音源とのサイズ／曲長不一致、出力メタデータの破損、OneLibraryのパス・曲順・階層・空プレイリスト欠落も拒否テストで確認しました。

## 形式上の範囲と未確認事項

- Webの80 MB／20分制限とは別に、現在のUSB helperは従来PDBを同時生成するため、ファイルサイズはuint32で表せる4 GiB未満、曲長は65,535秒以内です。4 GiB以上の音源をbakenがサイズ切り詰めして成功扱いにしないよう、書き出し前に形式上の理由を表示します。OneLibraryだけを生成するモードは今回追加していません。
- WAVの対応サンプル形式と実機の対応形式は同一ではありません。helperの既存`cdjsafe --check --player cdj-3000`を通します。音源の自動変換はしません。
- CDJ-3000は従来Device Library、CDJ-3000X等はOneLibraryが必要と公式に案内されています。両形式を出力しますが、DECKFLOW生成物の実機受入・再生・スクラッチ・長時間安定性は未確認です。[CDJ-3000公式案内](https://www.pioneerdj.com/en/news/2026/cdj-3000-firmware-ver330-important-notice/)、[OneLibrary公式FAQ](https://rekordbox.com/en/support/faq/onelibrary-7/)
- USBのフォーマット、既存USBへの追記・上書き、履歴の逆同期、iPad単体でのUSB生成は対象外です。
