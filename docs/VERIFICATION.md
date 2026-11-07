# v0.1 検証記録

実施日: **2026-11-06（JST）**。開発用の合成音源／一時出力フォルダだけを使い、既存のrekordboxライブラリやUSBメディアは変更していません。

## 自動チェック

```sh
DECKFLOW_BAKEN_BIN="$PWD/.local/baken/bin/baken" npm test
npm run build
```

**52件成功、失敗0、スキップ0**。ローカルNode.js 21.6.2で実行。CIはNode.js 22を指定しています。通常の`npm test`でbakenが見つからない場合、実writerの1件はスキップとなります。今回の52件は実writerを明示して実行しています。

| 範囲 | 確認内容 |
| --- | --- |
| BPM | 90／120／128／174 BPMの合成拍、背景ノイズ、無音、定常音、短尺、無音イントロ、不正入力 |
| KEY LOCK | 実際のSoundTouch DSPで440／660 Hzを処理。速度0.92／1.08／1.25で音程維持を確認 |
| スクラッチDSP | PCMの正転／逆転、分数位置、停止時無音、終端、dispose |
| Transport | rate変更、pause、seek、CUE、loop、scratch中の新曲load、準備前release等の競合 |
| 保存 | メタデータと音源の分離、quotaエラー、初期memory fallbackの明示、参照整合性、JSON検証 |
| アサイン | Note-Off、velocity zero、CC edge、Pitch Bend、相対値、修飾キー、入力中の抑止、競合・保存・hotplug |
| HOT CUE更新 | 同一曲の同時保存、保存失敗からの復帰、削除と遅延書き込みの順序 |
| USB | 固定版bakenを実行。PDB／ANLZ、BPM、先頭拍、HOT CUE、プレイリスト順、音源SHA-256を読み戻し |

静的buildは構文を確認し、実行資産17ファイル・約232 KiBをオフラインキャッシュに登録します。対応ソースとライセンスは別途配布物に含みます。追加のnpmランタイム依存はありません。

## ブラウザでの確認

Codexのin-app browserで実際のUIを操作しました。

- 2曲のデモ生成・BPM解析（124.00／128.00）、曲のA／B読み込み。
- 再生、停止、4拍ループ、相手デッキへのBPM同期。
- プラッターのドラッグ後、元の再生状態へ復帰。逆再生の音声内容自体は上記DSPテストで確認。
- 相対エンコーダーの選択状態でもキーLearnが動作。割り当てを保存。
- プレイリスト作成、曲の追加、再読み込み後の音源・プレイリスト・割り当ての保持。
- ネイティブpromptに依存せず、HTML dialogでプレイリスト作成・確認を実行。
- 1024×768、768×1024、390×844で横方向のはみ出しを確認し、狭い画面の検索欄を修正。
- 1024×768の横向きではデッキとミキサーを一画面に配置。
- **開発HTTPサーバーを停止**して接続できないことを確認後、Service Workerから再読み込み。保存曲を再生し、KEY LOCKの有効状態まで確認。

一時的なブラウザのviewport変更と、開発時のService Worker bypassは検証終了時に解除します。ユーザーのネットワーク設定や他のアプリの音声設定は変更していません。

![1024×768のDECKFLOW](preview.jpg)

## iPadシミュレーター

- Xcode 27.2、deployment target iOS 17.0、Simulator向けarm64／x86_64の署名なしbuild成功。
- iPad mini（A17 Pro）／iOS 27.0の専用Simulatorで **3テスト成功、失敗・スキップ0**。
- localhostのsecure context、実際のapp.jsによるプラッター／アサインUI生成、同梱SoundTouchの取得・Worklet登録・ノード構築を確認。
- Web MIDI互換shimからWKブリッジを通してCoreMIDIを明示的に開始し、入力Mapが返るところまで確認。
- サーバーのパス制限、MIDI running status／分割入力を確認。
- 最新の`dist/`を再同期してbuild。アプリの同梱Webは生成物としてGitから除外し、同期スクリプトを収録。
- 今回作成した専用Simulatorだけを終了・削除。既存Simulatorは変更していません。

JSONのnative保存・共有はソース確認までです。実機での保存ダイアログ、共有先、外付けストレージへの移動は受け入れ確認に含めてください。

## 残る実機確認

この検証は、次の項目を完了したことにはなりません。

1. 物理iPad mini 8での音質、スクラッチ追従、音声遅延、発熱、メモリ、長時間運転。
2. 実コントローラーのMIDI接続、抜き差し、給電、ジョグの相対値方式、全操作のマッピング。
3. ヘッドホンCUEとマスターの独立出力。現時点で未実装。
4. iPad単体でのCDJ用USB生成。現時点で未実装。
5. USB実媒体のファイルシステム／配置と、CDJ-3000での曲一覧、再生、波形、HOT CUE、Quantize。
6. 実曲コーパスでのBPM／先頭拍の精度、可変テンポ対応。

本番のDJセットで使う前に、テスト用音源と別のUSBで確認してください。

## 2026-11-07: 可変レイアウト・音源ドロップ・管理画面の初期表示

- アプリの最大幅1680pxを撤廃。左右12〜24px（safe areaを除く）を残して全幅を使用。
- 2560×1440、1920×1080、1440×900、1024×768、768×1024、390×844で表示幅を確認。1024×768ではミキサーまで画面内に収まり、停止中の波形もリサイズ後の実寸へ追従。
- 初期表示と再読み込み後の表示を楽曲管理・解析に変更。DJプレイとの切り替え・曲のデッキ読み込みをブラウザで確認。
- ファイルドラッグの判定、複数ファイル、フォルダ除外、子要素への移動、キャンセル時の表示解除、通常ドラッグの非干渉を5件の自動テストで確認。
- ブラウザのファイル選択で合成WAVとテキストファイルを同時指定し、WAVの120 BPM解析・保存と非音源のエラー表示を確認。OSからの実ドラッグ操作と物理iPadの「ファイル」アプリからのドラッグは未確認。
- 全体テスト **57件成功、失敗0、スキップ0**（実bakenを指定）。buildとiPad向けWeb資産同期が成功。今回、native Simulatorの再実行はしていません。

## 2026-11-07: 楽曲管理からの試聴・BPM・EQ

- 楽曲一覧の▶で再生／一時停止。試聴バーから停止（先頭へ戻す）・シーク・別曲への切り替えを確認。検索で試聴中の曲を一覧から隠しても、バーから停止可能。
- 再生BPMの直接入力（124→130、128→132）とテンポ表示、LOW／MID／HIGHの操作、別曲へ切り替えた際の初期値復帰をブラウザで確認。再生BPMは音程と連動し、保存済みの解析BPMを変更しない。
- 「解析BPMを修正」から既存の曲情報編集を開き、保存後の表示更新を確認。試聴のEQ／テンポは音源ファイルには書き込まない。
- DJプレイへの移動で試聴を停止。DJデッキの再生中は試聴を開始せず案内する。スクラッチの準備・復帰中も排他対象とする。
- 1440px、1024px、390px幅で試聴バーの配置と横方向のはみ出しがないことを確認。
- 試聴専用12テストで停止・曲切替・削除相当clearと非同期decodeの競合、古い終了イベント、速度変更時の再生位置、EQ値とノード接続、音量後のlimiter、エラーからの復帰を確認。
- 全体テスト **69件成功、失敗0、スキップ0**（実bakenを指定）。Web build・iPad同梱資産同期を実施。物理iPadでの音声遅延、EQの聴感、背景化／割り込みからの復帰は未検証。今回native Simulatorの再実行はしていません。

## 2026-11-07: rekordbox XML・既存ANLZの引き継ぎ

- 全体テスト **86件成功、失敗0、スキップ0**。固定版bakenを明示指定。Web build成功（22実行資産、約292 KiB）、iPadへ54ファイルのWeb資産同期を実施。
- XMLのUnicode・文字参照、可変TEMPO、HOT CUE A〜H、メモリーCUE、名前・色付きLOOP、階層プレイリスト、Location参照、整数秒曲長の末尾マーカーを検証。DTD・外部エンティティ・不正な数値・参照・重複・未対応マーカーを拒否。
- 保存はトランザクション内で参照を検証して追加。既存IDの編集内容・音源を保持し、再取り込みと別XMLの同名プレイリストを検証。
- 音源の関連付けはBPM解析を通らず、表示用ピークだけを計算。曖昧な同名候補、異なるサイズ／曲長、実音源を超えるマーカーを拒否。実長更新後もテンポ・CUE・LOOPを保持。
- 実bakenでDAT／EXT／2EXを生成し、波形のバイト列を意図的に変えた既存ANLZからの再書き出しで、その波形・PQTZ／PQT2のSHA-256一致と原本ファイルの不変を確認。2EXのない旧形式、フルパス不一致時の再生成、明示マップ、曖昧なキャッシュ、可変TEMPO不一致を確認。
- CUE位置だけでなく、件数、ループ終端、名前、端末パレット色を読み戻して照合。削除後に残存したCUE・色消失・不正な末尾ビートを検知する回帰テストを追加。
- ブラウザUIから合成XMLとWAVを選択し、1曲・階層プレイリストの追加、音源関連付け、曲情報の表示、編集後のXML再取り込みで編集と音源が残ること、ページ再読み込み後の保存を確認。WebからダウンロードしたJSONも検証し、TEMPO／HOT LOOP H／RGB／階層／表示波形を確認。
- DJデッキで取り込んだHOT LOOP Hを再生し、ループONと現在区間の90 BPM表示を確認。可変テンポの区間をまたぐ拍数ループとグリッド表示は単体テストでも確認。管理画面では試聴欄を「再生BPM（平均）」と表示。
- 390／1024／1440px幅で横方向のはみ出しがないことを確認。1024pxのHOT CUEは4列×2段・高さ44px、ミキサーまで画面内に配置。試聴とデッキは停止して検証終了、viewportを解除。
- 元のrekordboxライブラリ・音源・USB媒体は変更していません。今回native Simulatorは再実行していません。物理iPad、実ユーザーの大規模XML、CDJ-3000実機での音出し・波形・Quantizeは未検証です。

## 2026-11-07: 楽曲管理画面のデザイン整理

- 空状態では検索・表・書き出し操作を隠し、音源追加を主操作として配置。XML／デモの代替導線を分け、重複する説明を整理。
- 曲があるときは「ライブラリ操作」メニューへ補助操作を集約。外側クリック・操作選択・Escapeで閉じ、Escape後のフォーカスをsummaryへ戻す。
- モバイルの曲一覧を2段表示にし、曲名・試聴・BPMを優先。試聴・デッキ読み込み・曲操作は44px以上の領域を確保。
- ブラウザで空状態のXMLダイアログ、デモ追加による2曲の保存と一覧への切替、USB案内のメニュー起動、検索結果なし、試聴開始・停止を確認。390px・1024px・1280pxで表示を確認し、横方向のはみ出しがないことを測定。
- 新旧の同じモバイル幅のスクリーンショットを比較。新規音源追加ボタンが画面上部へ近づき、空の表・二重見出しが消えたことを確認。音声を停止し、viewport変更を解除。
- 今後の開発対象はWeb／PWA。以前のnative/iosは検証用として保持し、今回のWeb画面修正では同期・native buildを実行していません。

## 2026-11-07 — 既存ライブラリ・USB取り込み／キャッシュ／ライブラリUI

- `DECKFLOW_BAKEN_BIN="$PWD/.local/baken/bin/baken" npm test`: **134 passed, 0 failed, 0 skipped**。固定bakenの実行を含む。master.db／OneLibraryの独立したSQLCipher合成fixture、改ざんHMAC、SQLite overflow／循環／文字列、削除済みDB行、master CUE A〜H／メモリーループ、PDB／ANLZ、同名音源の逆引き衝突、中止・再開、DAT後のEXT追加、編集保護、容量不足、共有PCMの再利用／上限／キャンセルを確認。
- `npm run build`: **31 runtime assets, 410 KiB**、offline cache `295243c4786709c0`。`git diff --check` passed。
- in-app Chromiumの別ローカルoriginで、合成の `master.db`、`exportLibrary.db`、従来 `export.pdb` をフォルダ選択から取り込み。音源コピー、一覧表示、試聴、DJデッキへの読み込みを確認。ユーザーの実ライブラリは参照していない。
- 従来USB fixtureから2テンポ区間、メモリーループ、HOT H、既存波形を引き継いだ。master fixtureではmemory 0.5秒、active memory loop 2〜4秒、Hot A 1秒、Hot H loop 6〜7.5秒を曲情報で確認。解析ファイルを選ばない場合の警告も確認。
- 同じOneLibraryを再取り込みして「0曲を追加・音源コピー0曲・1曲はキャッシュ・DB解析結果もキャッシュ」を確認。ページ再読み込み後、フォルダ再選択なしで保存済みUSB音源を試聴できた。
- 80曲の合成XMLをWorker経由で取り込み、最初75行／次5行、2ページ目から検索すると1行へ絞り込めることを確認。実運用規模の速度ベンチマークではない。
- 左ナビ／中央一覧／下部試聴バー、試聴BPM120→126（+5%）、テンポ・EQパネルを確認。1280／1024／390 CSS pxでdocumentの横はみ出しなし。390pxで試聴・A/B・詳細ボタンは44×44px。ブラウザのviewport／device metricsは終了時に解除。console error/warnは確認範囲で0件。
- 画面記録: `docs/library-preview.png`（合成データ）。UI部品の参照元は `docs/OSS_REVIEW.md`。React等のUI依存追加なし。
- 物理iPadでのUSBファイル選択・Safari・音声遅延・長時間安定性、実rekordboxの全DBバージョン、CDJ-3000の実機検証は未実施。USB挿入の自動検知はせず、ユーザーがフォルダを選ぶ。保存済み項目を上書きする同期ではなく追加取り込みで、元DB／USBは変更しない。

## 2026-11-07 — 黒ベース・赤アクセント・フラットな選択表示

- 背景・パネルを無彩色の黒／グレーに統一。主操作・選択ライン・デッキA・PWAアイコンのアクセントを赤へ変更。
- 読み込み元とプレイリストの選択は、濃いグレーの面と四辺同じ太さ（2px）の赤い輪郭線で表示。ボタン・入力欄・パネル・ダイアログを含め角丸をなくし、内側の影を取り除いた。プラッターとレコードの円形は保持。飾りのコピー、重複する見出し、バッジも整理。
- Chromiumで合成ライブラリの一覧・試聴の開始／一時停止・初期画面・読み込みダイアログを確認。選択項目の計算済みスタイルは角丸0px、影なし、背景rgb(34,34,34)、輪郭線rgb(239,83,91)。
- 390／1024 CSS pxでdocumentの横はみ出しなし。390pxの試聴ボタンは44×44px。表示幅のエミュレーションを解除し、停止中の一覧を `docs/library-preview.png` に記録。
- `npm run build` 成功（31 runtime assets、412 KiB、offline cache `38bb4c2305687e9a`）。`git diff --check` 成功。表示のみの変更で、音声・取り込み・保存処理は変更していない。物理iPadでの確認は未実施。

## 2026-11-07 — 精細波形・大型プラッター・Docker／Vercel

- 全体波形と2／4／8／16／32秒の拡大波形、位置追従、拍／小節／HOT CUE／ループ表示を追加。全体と拡大のシーク座標を分離し、一覧は55本の棒からCanvasへ変更。管理画面の試聴波形は曲全体を表示し、終端へ直接移動できる。
- 読み込み済みPCMを再デコードせずWorkerへ最大1 MiBのチャンクで渡し、通常150 frame/sの正負ピークと3帯域を生成。左右逆相を相殺せず、短いピークと末尾も保持。30万frame上限を超える長尺では実時間範囲を保って密度を下げる。BPM／CUE／既存ANLZは変更しない。
- RAM16 MiB／8件、独立IndexedDB32 MiB／128件のLRUキャッシュ。音源変更・削除・pagehide後の遅延結果を無効化。保存失敗時はRAMと従来波形を利用し、再生は継続。
- 全体テスト **172 passed、0 failed、0 skipped**（固定bakenを含む）。ピーク保持、逆相、帯域、可変テンポ、長尺での拍位相、縮小集約、同入力の描画省略、Worker／保存失敗、キャッシュ無効化を検証。
- 実Chromiumの隔離originで逆相4秒音源を生成し600frame、初回generated=1、キャッシュインスタンス破棄後persistentHits=1／generated=0を確認。検証キーは終了時に削除。
- UIでデモ2曲の詳細波形、8→4秒ズーム、キーボードシーク、再生／停止、プラッターのドラッグ後の位置変更を確認。管理画面では24秒の終端へのシークと停止を確認。console error/warnなし。1280／1024／390 CSS pxで横はみ出しなし。プラッター径は1024幅で256px、390幅で273px。
- ボタン・入力欄・パネルは直角、黒ベース・赤アクセント。選択は四辺2pxの赤枠。プラッター操作の説明文を除去。色付き波形も赤／灰／白に限定。
- 配信先で新旧のCSS／JSが混在する事象を確認したため、CSS／アイコンの内容hashに加え、全JavaScript・dynamic import・Worker・Workletを共通graph hashで参照。2回buildの再現性、依存のみの更新伝播、参照欠落時の書き換え防止を5テストで検証。最終build:35 runtime assets／452 KiB、cache `ae8de3133c0e1493`。
- Dockerは最新コードを隔離Compose projectでbuild／起動しhealthy、uid101、read-onlyを確認。69のprecache URLと30 JS／40依存参照、波形Worker、MIME、cache header、404、nginx -tが成功。検証コンテナとnetworkはdown済み。
- Vercel用にbuildCommand/outputDirectory/headersを設定しREADMEへ手順を追加。Vercelへの実デプロイは行っていない。
- 物理iPad／Safariでの音声遅延・長時間安定性は未検証。帯域分離は表示用で、rekordbox内部の解析アルゴリズムを再現するものではない。

## 2026-11-07 — Vercel本番公開

- Vercel team `cybereye-technology`、project `deckflow` に静的Webアプリを公開。Node.js 22.x、`npm run build`、出力 `dist`。追加の環境変数・データベース・Functionsは不要。
- 本番URL: https://deckflow-five.vercel.app/ 。初回deployment `dpl_DewjTPDJ4rqXpWPUk1qtdG2CAQny`、アプリcommit `e95beee61d9af8e81210a46f18d809ea53591875`、target production、READY。
- 認証Cookieなし・iPad User-Agentで本番HTMLがHTTPS 200、アプリ本文を確認。ログイン用ページへの遷移なし。Vercelのpreview保護設定は変更していない。
- Service Workerの69資産を認証なしでGETし、すべて200。配信バイトのSHA-256がローカルbuildと全件一致。Worker／Workletを含むJavaScriptのMIMEを確認。
- 実ブラウザで本番アプリの起動・ライブラリ画面を確認。物理iPadの音声出力・USB選択・長時間動作は未確認。
- localhost／Sitesと本番URLは別originのため、以前のブラウザ保存曲は自動移行しない。本番URLで音源／ライブラリを選び直す。

## 2026-11-07 — タブレットのタッチ操作改善

- プラッターの操作を `platter-gesture.js` に分離。開始した指だけが終了できるようにし、coalesced samples、最後の指位置、中央のデッドゾーン、中心を横切る線分、曲の端からの折り返しを処理。画面切替・スクロール・リサイズ・バックグラウンド移行・曲交換では操作を終了。
- AudioWorkletはタッチ時刻に沿って20 msの位置補間を行い、60/120 Hz入力時の周期的な速度の揺れを抑制。指位置の外へ予測移動しない。通常速度のKEY LOCKは直結再生を使い、スクラッチからの復帰時に不要なSoundTouch処理を作り直さない。速度変更時のKEY LOCKには内部バッファ遅延が残る。20 msは補間幅であり実機の総遅延測定値ではない。
- タッチ端末ではミキサーを下部固定。横向きの波形ズームをデッキ上部にまとめ、253 pxのプラッターと再生ボタンを1133×744画面内へ配置。EQ/フェーダー/ループの操作領域を拡大。縦向きの試聴波形に幅を明示。黒・赤・四角い操作部を維持。
- Chromeのタッチエミュレーションで両プラッターとクロスフェーダーの3指同時操作を実行。別指の解放後も操作が続き、クロスフェーダー値が変わり、ページはスクロールしないことを確認。停止中のタッチ解放は停止を保ち、再生中の折り返し・解放では再生へ復帰。
- 1133×744、1133×650、1024×768、744×1133、768×1024、390×844で横方向のページはみ出しなし。フェーダー操作領域は高さ44 px。744×1133の楽曲管理で試聴・停止と波形表示を確認。
- `npm test`: 199件中197成功、失敗0、USB補助ツールの実環境依存2件をスキップ。タッチジェスチャー10件、タッチスライダー9件、音声20件を含む。`npm run build` / `git diff --check` 成功。
- 物理iPad/Safariでのタッチ感・音声出力遅延・長時間負荷は未検証。ブラウザのエミュレーションとDSP回帰テストでの確認であり、実機検証の代替ではない。

- 追加検証でブラウザ標準スライダーがプラッター操作中の別の指を無視するケースを再現し、`touch-slider.js` でタッチ／ペンを指ごとに捕捉。マウスとキーボードは標準操作を維持。修正後は3指同時操作で両デッキがSCRATCHINGのままクロスフェーダーが0.500→0.663へ変化し、フェーダーの指だけを離しても両デッキのスクラッチが継続することを確認。


## 2026-11-07 — 包括監査・ローカル修正（未デプロイ）

開始 `ba8650e`、作業ブランチ `codex/audit-20261107`。保存の原子性・上限、MIDI設定保持、KEY LOCK復帰、曲削除後の音声解放、逆相音源解析、dialog名、読み込み元件数、SoundTouch来歴表示を修正。詳細・根拠・残件は [監査報告](audit-2026-11-07.md)。

- Node24: 217成功、失敗/skip0（固定baken含む）。Node22: 215成功、失敗0、実writer2skip。
- 実IndexedDB8項目成功、失敗注入rollback・同時更新・上限を検証し一時DBを削除。`node scripts/serve-tests.mjs` から再実行可能。
- 最終build: 38 runtime assets / 約476 KiB、SW `09586c34122f3937`。Dockerの75 precache URLが最終distとbytes一致。iOSへ72資産同期、署名なしgeneric Simulator build成功。
- localhostで主要UI操作、日本語編集/検索、削除、配信サーバー停止後のPWA再起動・保存曲再生を確認。
- 本番反映・実ユーザーデータ変更・実MIDI/USB/CDJ・物理iPad・native runtime確認は行っていない。監査用コンテナ/タブ/サーバーは終了。

## 2026-11-07 — Library workspace, precise waveform and direct iPad USB layer

- Library preview moved above the browser; one track per row, separate sortable title/artist/BPM/duration columns and75-track pages. Runtime demo-audio generation removed.
- Selected-track waveform preparation runs without playback, with600points/sec (maximum600,000points), persistent bounded cache, visible beat/bar lines and bar.beat position. Imported preparation is retained.
- Mobile390/474px empty and loaded states, iPad744/1133px widths and desktop1288px checked in a browser. Sidebar stretching, oversized open button and empty-state minimum heights fixed. Detailed visual evidence and screenshot locations: [design-qa.md](../design-qa.md).
- Full Node suite:303tests,299passed,4skipped,0failed. Final subsequent USB-specific suite:19/19passed, including native-baken section comparison. The final WASM generation matches original baken DAT/EXT/2EX section hashes except the intentionally relocated PPTH audio path.
- Native bridge6/6; exact Swift filesystem sources tested on macOS temporary folders10/10, including ordered writes, changes detected by SHA-256, rollback, reconnect recovery and coordinated concurrent writers.
- Final synchronized iPad app passed generic Simulator build-for-testing. Simulator runtime tests stalled at launch before execution; no actual iPad/USB/file-picker/CDJ verification was performed.
- USB initial scope: conventional Device Library HOT CUE A–H updates; new conventional libraries with WAV/MP3, PDB and ANLZ. Existing-library new-track merging and OneLibrary updates remain unsupported and are blocked. Source audio/PDB/wave/grid/memory cues remain unchanged during HOT CUE edits. Download/ZIP is not used for direct USB access.
- Docker rebuilt with cache`04a52cb885c57bf9`; localhost8080healthy. These changes were not pushed or deployed to Vercel in this work.


## 2026-11-07 — 両USBライブラリ更新・MIDI Learn・DJ再生改善（ローカル）

- 全体テスト **371件中370成功、失敗0、1スキップ**。固定bakenを指定して実行。スキップは明示的な環境変数を必要とする1 GiB WAVの長時間テストのみ。USB追記・再取り込み・OneLibrary暗号化・拍同期・逆再生・描画キャッシュを含む。
- Native USB JSブリッジ **7/7**。実Swiftストアソースの一時フォルダテスト **11/11**。最新Web資産133ファイルを同期し、署名なしgeneric iOS Simulatorの **build-for-testing成功**。今回Simulator runtimeを再実行していない。
- Device LibraryとOneLibraryを音源のフルパスで対応付け、異なる曲IDを保持。片側だけの曲・プレイリストも取り込み、欠けた形式は元の音源とANLZを再利用して作成。既存の曲・CUE・重複を含むプレイリスト順・空フォルダ・未知テーブル/カラム・64bit値を保持する統合テストを追加。両DBと参照ANLZの変更検出、WAL/競合/キャンセル、再転送no-opを確認。
- 許可済みUSBの再接続一覧を低頻度で更新。未許可のUSBは最初にフォルダ選択が必要。実物のUSB自動検出・書き戻し・CDJ再生を確認したという意味ではない。
- 楽曲一覧は1曲1行、アルバム/ジャンル/キー/評価/追加日/最終変更日などを表示し、項目別ソート・列の表示設定を保存。XMLの日時を表示し、読み込んだだけで最終変更日時を更新しない。
- 実ブラウザで82曲の合成XML/WAVを読み込み、試聴波形、タイトル/日時ソート、列設定の再読み込み後の保持、DJ画面でのMIDI対象選択（再生は発火しない）、設定JSONの保存・読み込みを確認。物理MIDIからのLearn完了は未確認。
- SYNC＋QUANTIZEは相手の次の拍へ音声クロックで再生/HOT CUEを予約。マスターのテンポ変更、停止取消、ループ境界、可変TEMPOアンカーを検証。両デッキの実再生と95 BPMへの同期、モード表示をブラウザで確認。SoundTouchの遅延を確実に補正できないため拍同期ペアは両方PITCH LINKへ切り替え、KEY LOCK要求は保持して解除後に復元。可変BPMの演奏中の連続伸縮追従は対象外。
- PCMファイルのスクラッチを20 msの時刻補間へ統一し、高速逆回転に補間/アンチエイリアス処理を追加。ブラウザのプラッタードラッグで位置変更と再生復帰を確認。タッチ入力の追加注入は利用中ブラウザのAPIで未対応のため未実施。実iPadの操作感・音質・出力遅延は未検証。
- 波形は全体/詳細の描画をキャッシュ（全体32 MiB、1面8 MiB、最大64面）。2デッキ60 Hz/10秒のCanvas計装ベンチでfillRect **10,124,050→127,662（98.74%減）**、JSハーネス3198.9→133.1 ms。これはiPadのFPSやGPU時間を測った数値ではない。連続MIDI操作で不要なCUE DOM/両デッキ描画を行わない。
- 1920×1080、1133×744、390×844で確認。ページ全体の横はみ出しなし。ブラウザconsole errorなし。検証用viewport/touch/SW bypassは解除し、開発サーバーを終了。合成曲は隔離QA originだけに保存。
- 最終build **64 runtime assets、1981 KiB、cache `463bf986ff3eb58b`**。Docker再ビルド後healthy、`http://localhost:8080/` の実画面で新版QUANTIZEを確認。Vercelへの再デプロイ・Git pushは行っていない。
- 画像と操作記録は [design-qa.md](../design-qa.md)。OSSの版/ライセンスと採否は [OSS_REVIEW.md](OSS_REVIEW.md)。


## 2026-11-07 — 公開前のHOT CUE操作・ブラウザUSB欄修正

- 楽曲管理のプレビューにHOT CUE A〜Hを追加。空き枠で保存、設定済み枠で現在の再生/停止状態を維持して移動、「解除」後のタップで削除。共有編集関数は既存memory/loop/他bankを保持し、保存成功後だけ表示を更新する。
- 実ブラウザの合成音源で0:00.400への設定、停止中/再生中の呼び出し、再読み込み後の保持、解除を確認。390pxでは4列×2段、各44px以上、ページ横はみ出しなし。
- ブラウザでDEVICES欄が消える問題を修正。「USBを開く」からフォルダ選択へ進み、USBの名前が付いた一番上のフォルダを選ぶ図と説明を追加。ブラウザでは自動接続検出/直接書き戻しは行わず、保存済みデバイスDBとして区別する。
- 合成export.pdbをUIから読み込み、DEVICESへ登録、対象の1曲と3プレイリスト（空リスト含む）だけを表示することを確認。一般ブラウザ取り込みの戻り値にsource参照を追加し、取り込み直後のsource絞り込みを修正。物理USBの曲は読み込み/書き込みしていない。
- CUE/プレビュー/保存キュー/USB一覧の対象テスト33件成功。元のテストに、CUE保存の失敗、export時のmainCUE保持、USB DBの判定、保存sourceの返却を追加。
- 最終build:65 runtime assets /1993KiB、cache `5efc940e30d08886`。iOS同梱資産134ファイルへ同期。
- スクリーンショット: `outputs/deckflow-final-qa/library-hotcue.png` と `usb-folder-guide.png`（ローカルQA出力）。
- 固定bakenを指定した最終全体テストは **376件中375成功、失敗0、1スキップ**（任意の1 GiB WAVテスト）。
- 読み込みダイアログとREADMEに端末内処理・サーバー送信なしを明記。File API→Worker→IndexedDBの経路を確認し、音源/メタデータを送信する処理がないことをコードで確認。

- 対応ブラウザのフォルダ選択は `showDirectoryPicker({mode:"read"})` を優先し、ファイル入力の確認画面を経由しない。選択後は既存の遅延読み取り索引を利用し、走査の中止・読み込み操作の二重実行を防止。書き込み権限や永続ハンドル保存は要求しない。Safariなど未対応環境のみ標準ファイル選択を使う。


## 2026-11-07 — ローカル読み込みの進捗表示

- USB/rekordboxライブラリ読み込みに、フォルダ確認・DB・曲情報・音源コピー・保存確定の段階別プログレスバーを追加。総量が未確定の段階は割合を出さず、確定後は処理済み曲数と現在曲の保存済みMiBを表示する。最終保存の成功前には100%を表示しない。
- 音源の1 MiB分割保存後だけバイト進捗を通知。進捗コールバックの例外は保存・後片付けに影響させない。音源の保存形式と最終反映のトランザクションは維持。
- キャッシュ済み/欠損/削除済みの曲も処理済み数に含め、連続スキップ時に定期的にUIへ処理を戻す。大きなプレイリストの照合はSetを使い、同じリストの繰り返し走査を削減。
- 固定bakenを指定した全体テスト **386件中385成功、失敗0、1スキップ**（任意の1 GiB WAVテスト）。対象の保存/USB統合テスト32件、sourceテスト27件も成功。
- 実ブラウザの隔離QA originで4曲・256 MiBの合成WAV/XMLを取り込み、曲数/容量/進捗が実際のコピー中に進むことを確認。3曲保存後に中止し、再開時は3曲を再利用・残り1曲だけ保存、完了後100%を確認。390px幅で横はみ出しなし、console errorなし。
- メインページで取得した取り込み時NetworkイベントはローカルWorker JSのGETのみ（子Workerを含む全通信キャプチャではない）。コード追跡でも音源/メタデータのサーバー送信処理なし。検証用合成音源のみを使用し、実USBは読み書きしていない。
- UI記録: `outputs/deckflow-final-qa/library-import-progress.png` / `library-import-mobile.png`（ローカルQA出力）。
