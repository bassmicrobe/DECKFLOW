# DECKFLOW

本番アプリ: **[deckflow-five.vercel.app](https://deckflow-five.vercel.app/)** — iPadのSafariからアクセスできます。共有メニューから「ホーム画面に追加」でPWAとして利用できます。

**曲を整える。流れをつくる。**

手元の音源を整理・解析し、タッチでもMIDIでもプレイできるDJワークスペース。iPad miniで外に持ち出し、CDJ-3000用USBの準備につなげることを目指しています。

現在は **v0.1 開発版**です。画面・解析・DJプレイはWebアプリ／PWAとして動作します。USBへの直接保存には、同じWeb画面を同梱したiPadアプリのファイルアクセス機能を使います。物理iPad・USB・コントローラー・CDJでの実機検証はまだ完了していません。

![DECKFLOWのライブラリ管理と試聴バー（合成テスト音源）](docs/library-preview.png)

## 動かす

Web版にnpm依存のインストールは不要です。Node.js 22以上を推奨します。

```sh
git clone https://github.com/bassmicrobe/DECKFLOW.git
cd DECKFLOW
npm run build
npm run dev
```

表示されたローカルURLを開くと、最初に**楽曲管理・解析**画面が表示されます。左側の「ライブラリを開く」から既存のrekordboxライブラリやUSBを選べます。音源ファイルのドラッグ＆ドロップ、「音源を追加」にも対応します。再生は自動では始まりません。

Macのlocalhost URLを別端末のiPadから開くことはできません。iPadではHTTPS配信したWeb版を利用してください。

音源を追加 → BPMを確認 → 曲の **A / B** でデッキへ読み込み → 「DJプレイ」に切り替えて再生。プラッターは押さえて前後に回すとスクラッチし、離すと押さえる前の再生状態に戻ります。押さえる前が停止中なら停止状態を保ちます。

画面はウインドウの横幅いっぱいに広がり、デッキ・波形・プラッター・曲名欄が幅に応じて伸縮します。狭い画面では操作部を折り返します。タッチ端末のDJモードではミキサーを画面下に固定し、プラッターとクロスフェーダーを同時に操作できます。iPad横向きでは波形の拡大・縮小ボタンをデッキ上部にまとめ、大きいプラッターの操作領域を確保します。ドラッグ＆ドロップを使えないタッチ環境では「音源を追加」からファイルを選択できます。

楽曲管理は上部に選択曲のプレビュー、下部に一覧を配置しています。曲名または行を選ぶと再生せずに曲情報・波形を表示し、**▶** でその場で試聴できます。同じボタンで一時停止、試聴バーの **■** で停止して先頭に戻ります。上部の全体波形・拡大波形から再生位置を変更でき、「テンポ・EQ」を開くと再生BPM（±50%）、LOW／MID／HIGHの3バンドEQ（−24〜＋12 dB）を調整できます。「解析BPMを修正」では保存する曲情報を編集します。試聴のテンポ変更は音程と連動し、別の曲の▶を押すと調整をリセットして切り替わります。DJプレイへ移ると試聴を停止します。DJデッキが再生中の場合は、デッキを停止してから試聴してください。試聴は端末の通常出力を使い、独立したヘッドホンCUEではありません。

曲一覧はマウス操作では32px、タッチ操作では約44pxの行高で表示します。曲名とアーティストを別列に揃え、列見出しとプレビューを残したまま一覧をスクロールできます。1ページ75曲に分割し、検索に加え、列見出しから追加順・曲名・アーティスト・BPM・長さの昇順／降順を切り替えられます。

## Dockerで起動する

Docker Engine／Docker DesktopとCompose v2以降で起動できます。Node.jsをホストへインストールする必要はありません。

```sh
docker compose up --build
```

[http://localhost:8080](http://localhost:8080) を開きます。バックグラウンド起動は `docker compose up --build -d`、停止は `docker compose down` です。ポートが使用中なら `DECKFLOW_PORT=8081 docker compose up --build` のように指定します。

ビルド用Node.jsと配信用nginxを分けた構成で、起動時は静的なWeb資産だけを配信します。コンテナは非root・読み取り専用で動き、音源やライブラリは引き続きブラウザ内のIndexedDBに保存されます。Docker用のデータボリュームは不要です。接続先のホスト名やポートを変えるとブラウザ上は別の保存領域になります。

初期設定はMac自身の `127.0.0.1` のみに公開します。iPadから利用する場合は、VercelなどのHTTPS配信を使うか、このコンテナの前にHTTPSのリバースプロキシを置いてください。LANへバインドする設定は `DECKFLOW_BIND=0.0.0.0` です。LANのHTTP URLだけではAudioWorkletやPWAなどが動作しないため、iPad利用にはHTTPSが必要です。

## Vercelにデプロイする

DECKFLOWはブラウザ側で音源処理・保存を行う静的アプリなので、Vercelへデプロイできます。リポジトリの `vercel.json` が `npm run build` と出力ディレクトリ `dist` を指定します。VercelではDockerコンテナではなく、この静的ビルドを配信します。

1. Vercelの **Add New → Project** から、このGitHubリポジトリをImportします。
2. **Framework Preset: Other**、**Root Directory: リポジトリ直下**を選びます。
3. Build Commandが `npm run build`、Output Directoryが `dist` になっていることを確認し、Deployします。npmパッケージのインストールや環境変数の設定は不要です。
4. 発行されたHTTPS URLをiPadのSafariで開きます。必要に応じてホーム画面へ追加できます。

Vercelで選択したProduction Branchへのpushが本番更新になります。HTML・JavaScript・CSSは更新時に再検証し、CSS・アイコンには内容のバージョン、JavaScript・Worker・Workletには共通のバージョンを付け、新旧の混在を防ぎます。オフライン利用はアプリのService Workerが担当します。再生中に画面を強制更新する処理は入れていません。

音源はVercelへアップロードされません。独自ドメインやPreview URLに変えると保存領域も変わるため、日常利用には同じ本番URLを使ってください。公開先を変更しても、以前のURLに保存した音源が自動移行されるわけではありません。

設定の根拠: [Vercelのビルド設定](https://vercel.com/docs/builds/configure-a-build)、[プロジェクト設定](https://vercel.com/docs/project-configuration)、[Cache-Control](https://vercel.com/docs/caching/cache-control-headers)。

## 現在の機能

| 機能 | 実装と範囲 |
| --- | --- |
| 音源管理 | 1曲1行の一覧。曲名・アーティスト・アルバム・ジャンル・BPM・キー・時間・評価・追加日・最終変更日などを表示／ソート。表示列を選択でき、設定を端末に保存。音源追加・ドラッグ＆ドロップ・プレイリスト |
| ライブラリ試聴 | 曲ごとの再生／一時停止、停止、シーク、再生BPM、3バンドEQ。検索中も試聴バーから操作可能 |
| ローカルキャッシュ | IndexedDBにメタデータ・音源・読み込み元を保存。保存したライブラリは次回、USBを外していても開ける。保存できない環境では一時保存と明示 |
| 既存ライブラリ | フォルダ選択でrekordbox 6/7の `master.db`、USBの `export.pdb`／`exportLibrary.db`、rekordbox XMLを読み取り。元ファイルは変更しない |
| 既存ANLZ | DBが参照するDAT／EXTから波形・ビートグリッド・対応CUEを取り込み。音源パスを照合して引き継ぐ |
| rekordbox XML | BPM・可変TEMPO・8 HOT CUE・メモリーCUE／LOOP・名前／色・階層プレイリストを取り込み。元音源を追加して再解析せず関連付け |
| BPM解析 | Web Workerで解析。無音時はBPMを作らず、手動修正・半分／倍への変更が可能 |
| 2デッキ | 再生、停止、波形からシーク、3-band EQ、レベル、equal-powerクロスフェーダー、マスター |
| 精細波形 | 全体波形＋2／4／8／16／32秒の拡大・追従表示。通常600点/秒の正負ピークとLOW／MID／HIGHをWorkerで生成。選曲時に無音で準備し、拍線・赤い小節頭・小節番号・CUE／LOOPを重ねる。現在の小節.拍とBPMの由来も表示 |
| 波形キャッシュ | 再デコードせず読み込み済み音源を利用。RAM16 MiB、独立IndexedDB32 MiBの上限付きキャッシュ。60万点を超える長尺は全体を保持したまま解像度を下げる。元のBPM・CUE・ANLZは変更しない。描画済み波形を別途32 MiB以内で再利用してスクロール負荷を抑制 |
| テンポ／KEY LOCK | ±50%。SoundTouchJSで音程を維持。非対応や失敗時はPITCH LINK表示で通常再生へ戻る |
| スクラッチ | 大型プラッターと専用AudioWorkletがPCMを正転／逆転。指ごとの独立操作、中央通過時の急回転防止、タッチ時刻に基づく補間。通常速度ではKEY LOCKの不要な音声処理を省略。大容量PCMも同じ時刻補間を使い、高速バックスピンの折り返しノイズを低減 |
| CUE／ループ | 楽曲管理のプレビューからHOT CUE A〜Hを設定・呼び出し・解除。DJ側はCUEへ復帰、8つのHOT CUE、1／2／4／8拍ループ |
| SYNC／QUANTIZE | 相手の実効BPMへ同期。QUANTIZEを併用すると再生・HOT CUEの開始を相手の次の拍へ予約。可変TEMPO区間を参照し、停止で予約を取り消す。正確な位相合わせ中は両デッキをPITCH LINKで出力し、KEY LOCKの設定は保持 |
| MIDI Learn | DJ画面で操作箇所をクリックし、コントローラーを動かして割り当て。Note・CC・Pitch Bend、絶対値／相対エンコーダーに対応。設定JSONを保存／読み込み |
| キーアサイン | 再生・CUE等のボタン操作。Shift／Alt、競合の置換、押しっぱなしの連打防止、文字入力との分離 |
| プロファイル | 割り当ての自動保存、JSONによる書き出し／読み込み。連続値はMIDIへ割り当て |
| オフライン | Service Worker／PWA。初回の資産取得完了後、同じブラウザのローカル音源を利用 |
| USB直接保存 | iPadアプリで既存USBへ新曲・プレイリストを追加し、HOT CUE A〜Hを保存。Device LibraryとOneLibraryを同時更新し、欠けた形式を補完。既存音源・解析・未知データを保持。実機検証前 |
| Mac補助ツール | Device Library・OneLibraryの両形式を新規フォルダへ生成し読み戻し検証。既存ANLZの波形・グリッド引き継ぎにも対応 |

追加日は元ライブラリの値を優先します。最終変更日は元データの記録またはDECKFLOWで実際に編集した日時を表示し、日時が不明なら空欄にします。読み込み・キャッシュだけでは変更日時を更新しません。

キーボード初期設定: **Q** = A再生、**A** = AのCUE、**P** = B再生、**L** = BのCUE、**G** = クロスフェーダー中央。

## 楽曲管理でHOT CUEを設定する

1. 曲名を選び、波形をタップ／ドラッグして設定したい位置へ移動します。
2. プレビュー下の **HOT CUE A〜H** の空き枠を押すと、その位置を保存します。
3. 設定済みの枠を押すとその位置へ移動します。再生中なら再生を続け、停止中なら停止したままです。
4. 消すときは **解除** を押してから対象の枠を押します。変更は端末内へ保存され、iPadアプリでは「CUEをUSBへ保存」でUSBへ反映できます。

## rekordbox・USBのライブラリを開く

1. PCのライブラリを読む場合は、先にrekordboxを終了します。
2. 左側の **ライブラリを開く → フォルダ・USBを選択** から、`master.db` を含むライブラリフォルダ、またはUSBの名前が付いた一番上のフォルダ（USB全体）を選びます。`PIONEER`／`Contents` の中へは入りません。
3. 読み込むDB／XMLを選びます。元音源が別の場所にある場合は、続けてその音源フォルダを選びます。
4. **読み込んでキャッシュ** を押します。曲情報を先に表示し、見つかった音源を順番に端末内へ保存します。

iPadアプリでは、初回に「USB追加」からルートフォルダーへのアクセスを許可します。許可済みUSBは再接続を自動確認してデバイス一覧に表示し、選択すると曲とUSB内のプレイリストを読み込みます。Mac／PC／Safari／PWAでは **DEVICES → USBを開く** からフォルダを指定してください。ブラウザはUSBの接続を自動検出しません。読み込み後はデバイス欄に保存済みライブラリとして表示し、曲とそのライブラリ内のプレイリストを開けます。フォルダ選択が使えない環境では **DB・XMLファイルを選択** を使い、取り込み後に各曲の **音源を選択** で関連付けます。

| 読み込み元 | 引き継ぐ情報 |
| --- | --- |
| rekordbox 6/7 `master.db` | 曲情報、階層プレイリスト、HOT CUE A〜H、メモリーCUE／LOOP・名前。対応するSQLCipherをブラウザ内で読み取り |
| USB `PIONEER/rekordbox/export.pdb` | 従来Device Libraryの曲情報・プレイリスト。対応するANLZから波形・ビートグリッド・CUE／LOOP |
| USB `exportLibrary.db` | OneLibrary／Device Library Plusの曲情報・プレイリスト。CUE／LOOPは対応ANLZから取り込み |
| rekordbox XML | 平均BPM、可変TEMPO、HOT CUE A〜H、メモリーCUE／LOOP・名前／色、階層プレイリスト |

取り込みは追加方式です。DECKFLOWで編集した既存曲と保存済み音源を保持し、元のrekordboxへは書き戻しません。元ライブラリの変更を読み直すときは、**ライブラリを開く → 保存したライブラリの「再読み込み」** から選び直します。自動同期ではなく、既存項目の編集・削除も自動反映しません。

DBと解析ファイルはWorkerで読み取り、音源は全曲デコードせず元の圧縮形式のままIndexedDBへ保存します。保存したライブラリは左側の読み込み元から開けます。同じDBの再読み込みでは内容のハッシュを比較して解析済み情報を再利用し、保存済み音源のコピーを省きます。試聴とデッキは最大2件・合計96 MiBの共有PCMキャッシュを使い、一覧は75曲ごとに表示します。この96 MiBはキャッシュの上限であり、再生中のデッキ・スクラッチ用データなどを含むアプリ全体のメモリ上限ではありません。

XMLだけを取り込む場合は **ライブラリ操作 → rekordbox XMLを取り込む**、またはXMLのドラッグ＆ドロップも使えます。XMLには音源・波形本体はありません。DBの直接取り込みとXMLでは引き継げる項目が異なります。CUE色、スマートプレイリスト、未確定DBなどの制限は [REKORDBOX_IMPORT.md](docs/REKORDBOX_IMPORT.md) を参照してください。

## iPadで使う

Safari／PWAでは音源の取り込み・解析・試聴・DJプレイを利用できます。USBへの直接保存はSafariのフォルダ書き込み制限を受けるため、[iPadアプリ](native/ios/README.md)で提供します。画面と音声処理は同じWebコードを使い、Swift側が選択したUSBのファイルアクセスを担当します。アプリは現在Xcodeからインストールする開発版で、App Store／TestFlightには未配布です。

- 音源とメタデータは端末内へ保存します。初回取得後は、キャッシュ済みの画面・読み込み済みの曲をオフラインで利用できます。
- 「ライブラリを開く」から「ファイル」内のライブラリや外部ドライブを選択します。OS・ブラウザでフォルダ選択が使えない場合はDB／XMLを選び、音源は曲ごとに関連付けます。単体の曲は「音源を追加」から選べます。
- 外部MIDIはWeb MIDI API対応ブラウザ向けです。iPadでの外部MIDI機材接続は現在のWeb版の対応範囲外です。
- ヘッドホンCUEとマスターの独立出力は未実装です。iPadアプリにはUSB直接保存とCoreMIDI入力の橋渡しがありますが、物理機材との互換性は未検証です。
- 物理iPadでの外部USB・フォルダ選択、音声遅延・CPU負荷・長時間動作は未検証です。ブラウザ上の確認は実機での対応保証を意味しません。

## USBへの直接保存（iPadアプリ）

**ライブラリ操作 → USB書き出し → USBを選択** から、接続したUSBのルートフォルダを選びます。ダウンロードや「ファイル」でのコピーを挟まず、選択したUSBへ直接読み書きします。

- **ライブラリを読み込む**: PDB／OneLibraryと音源をローカルにキャッシュします。保存済み音源の再コピーを省きます。
- **HOT CUEをUSBへ保存**: DAT／EXTとOneLibraryのHOT CUE A〜Hを同じ保存処理で更新します。音源・波形・グリッド・メモリーCUE・未知のANLZセクションは保持します。既存曲のBPM／メモリーCUEの変更はこの操作では反映しません。
- **曲を転送**: 選択中のコレクション／プレイリストの新曲を既存USBへ追加します。両データベースとWAV・MP3・DAT／EXT／2EXを直接保存し、既存の曲とプレイリストの順序・重複・CUEは保持します。検索で転送対象を絞っても、既存のプレイリストの曲は削除しません。WAVは16／24 bit PCM・44.1／48／88.2／96 kHz、MP3は32／44.1／48 kHz、1〜2chに対応します。

変更前のSHA-256を照合し、一時ファイル・バックアップ・ジャーナルを使って保存します。USB側に別の変更がある場合は停止します。中断が残っている場合は、同じUSBを選び直して **中断した保存を復旧** を実行します。複数ファイルの更新は単一の原子的操作ではないため、転送中はUSBを外さないでください。

Device LibraryとOneLibraryの曲IDが異なる場合は音源のフルパスで対応付けます。片方の形式だけがあるUSBでは、既存の音源・解析ファイルを再利用してもう片方を作成します。未対応のスキーマ、未確定WAL、別データが参照するCUEの削除などは、元データを変更せずエラーにします。 MP3の波形生成は圧縮音源32 MiB・展開後PCM256 MiB以内に制限し、それ以上はPCM WAVを案内します。実際のiPad・USB媒体・CDJ-3000で、転送・HOT CUE・波形・Quantize・抜き差しの受入確認が必要です。

## Mac補助ツールでのCDJ-3000用USB生成

通常の「ライブラリを保存」で取得するJSONと元音源を、Mac補助ツールに渡す方法も残しています。JSON単体はCDJ用データではありません。

Macに元音源を用意し、Rust／Cargoを利用して固定版bakenをプロジェクト内へビルドします。

```sh
npm run usb:setup
npm run usb:export -- \
  --library /path/to/deckflow-library.json \
  --audio-dir /path/to/Music \
  --out /path/to/DECKFLOW-NEW-EXPORT
```

出力先は**まだ存在しない新規フォルダ**に限定し、既存USBライブラリを更新・上書きしません。曲名、BPM、先頭拍、CUE／HOT CUE、プレイリスト、波形を生成し、別のreaderで読み戻してから完了します。元音源は変更しません。同名ファイルの衝突や欠損はエラーにします。

出力フォルダの中身を適切な形式のテスト用USB直下へ配置し、CDJ実機で確認する段階が別途必要です。Mac helperはUSBのフォーマット・取り外し処理をしません。**従来Device LibraryとOneLibraryの両方**を生成して読み戻します。CDJ-3000向けの音源形式チェックを行いますが、CDJ-3000／3000X等の実機受入・再生は未確認です。[USB形式・大容量書き出しの検証記録](docs/usb-large-audio-2026-11-07.md)を参照してください。

詳しくは [USB_EXPORT.md](docs/USB_EXPORT.md)。実際のUSB媒体とCDJ-3000での再生・波形・Quantize・キューは未検証です。

## 技術構成

| 部分 | 技術 |
| --- | --- |
| UI | HTML／CSS／ES Modules。ビルド不要の静的アプリ |
| 音声 | Web Audio API、AudioWorklet、SoundTouchJS |
| BPM／波形 | Web Worker＋独自解析＋ANLZ読み取り＋Canvas |
| ライブラリ読み取り | Web Worker、JavaScriptのPDB／SQLite reader、Web CryptoによるSQLCipher復号 |
| データ | IndexedDB、割り当て設定はlocalStorage |
| 操作 | Pointer Events、Web MIDI、キーボード |
| USB書き出し | baken由来のRust／WASM、sql.js／SQLiteとSQLCipher、SwiftのUSBアクセス層。MacではNode.js helper |
| iPad | Safari／PWA、USB利用時はSwiftUI＋WKWebView。タッチ、外付けキーボード |
| チェック | Node組み込みtest runner、実DSP処理、実USB writerの読み戻し |

音源と解析結果はアップロードせず、端末内で処理・保存します。アプリの初回取得と更新には配信元への通信が必要です。

## 品質と制約

- 音源の80 MiB／20分制限を撤廃しました。大容量RIFF WAVは必要な部分だけを読み出し、1 GiB・約93分の合成音源で保存・再読み込み・試聴・DJ再生を検証しています。ファイルサイズまたはデコード後のPCMが32 MiBを超えるWAVは部分読み取りへ切り替えます。32 MiBは読込方式の切替値で、ファイルサイズの上限ではありません。
- 大容量経路はPCM8／16／24／32-bit・float32／64-bit・WAVEFORMATEXTENSIBLEのRIFF WAVに対応し、再生確認はmono／stereoです。3ch以上は先頭2chを出力します。RF64・BW64・RIFX・圧縮方式のWAVは未対応。MP3／AAC／FLAC等はブラウザの全体デコード能力とメモリに依存し、1 GiBでの検証対象には含みません。保存可能な量は端末のストレージ空き容量にも依存します。
- 大容量WAVのBPMは先頭・中間・末尾の各40秒以内をWorkerで解析します。取り込み直後の全体波形は区間ごとの標本で、選曲後に全音声の詳細波形を少量ずつ生成します。音源未接続時は取り込んだ概要波形を表示します。実曲の解析精度・iPadの音声遅延や長時間安定性は未検証です。
- DBは128 MiB、XMLは32 MiB、最大10,000曲・1,000プレイリスト。ライブラリの曲長は24時間以内です。USB helperは従来PDBの整数形式に合わせて4 GiB未満・65,535秒以内を検証します。
- PCのDBは確定済みのスナップショットを選んでください。同時に選んだフォルダに非空の `master.db-wal` などがある場合は読み取りを停止します。rekordboxを終了して再選択するか、XMLを使ってください。
- DB直接取り込みではCUE色、HOT CUE I以降、スマートプレイリストなどに制限があります。未対応の暗号形式やDBスキーマは読み取りエラーにします。
- 新しく音源を追加した場合のBPM・先頭拍は推定です。実曲コーパスでの精度やrekordboxとの一致は保証しません。既存の可変テンポはXML／ANLZから引き継ぎますが、DECKFLOW自身による可変テンポ／曲構成の推定は未実装です。
- ブラウザの保存領域は永続バックアップではありません。サイトデータの削除、ストレージ不足、ブラウザによる削除で失われ得ます。元音源を保持してください。
- 「ライブラリ保存」はメタデータの書き出しです。音源バックアップ・クラウド同期・メタデータJSONの再取り込みは未実装です。
- テスト音源での動作、DSPテスト、Simulator起動は、本番ライブや物理機材での受け入れ確認を代替しません。

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
- **baken 4.10.0 / MIT**: USB writerとPDB／ANLZの形式読み取りに採用。commitを固定し、著作権・ライセンス表示を保持。
- **OneLibrary / MIT**: SQLCipher／SQLite読み取りを固定commitから採用し、WebCryptoによる保存を追加。原文ライセンスと変更内容を同梱。
- **sql.js 1.14.2 / MIT**: OneLibraryの差分更新に採用。未知の列・テーブル・BLOB・64-bit整数をSQLite内で保持。固定バイナリとライセンスを `dist/vendor/sqlite-writer/` に同梱。
- Essentia／aubioはライセンスと配布方針の整理が別途必要なため、今回は同梱していません。
- [B2B Studio](https://b2bstudio.live/)のデッキとミキサーの配置、ゲストで試す入口、操作学習の導線を参考にしています。画像・ロゴ・実装コードは流用していません。遠隔B2Bセッション機能は含みません。

採用・比較の根拠は [OSS_REVIEW.md](docs/OSS_REVIEW.md)、配布物の通知は [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md)。DECKFLOW本体のライセンスは現時点で未設定です。各OSSのライセンスとは区別してください。
