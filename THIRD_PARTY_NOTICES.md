# Third-party notices

DECKFLOW includes or invokes the following third-party software. The licenses for these components do not license the rest of DECKFLOW.

## SoundTouchJS AudioWorklet 2.1.1

- Upstream: https://github.com/cutterbl/SoundTouchJS
- Package: `@soundtouchjs/audio-worklet` version `2.1.1`
- License: Mozilla Public License 2.0.
- Copyright notices, complete MPL-2.0, corresponding TypeScript source, distribution provenance and integrity are included in `dist/vendor/soundtouchjs/`.
- Runtime files are served locally from the same distribution; no external CDN is required.
- DECKFLOW's build adds a cache-version query to the `./constants.js` import in `SoundTouchNode.js`. The dependency notice and provenance describe this transformation and how to verify the unchanged upstream source and DSP bytes.
- The covered source remains available under MPL-2.0. Modified covered files must retain applicable notices and corresponding source availability. This is not an MIT-only dependency.

## baken 4.10.0

- Upstream: https://github.com/M-Igashi/baken
- Reviewed revision: `50d2ba07fdad49d3a95e02d2951ac7a67197e85a`.
- License: MIT; complete notice: `vendor/licenses/baken-MIT.txt`.
- The baken CLI is built locally by `tools/setup-usb-exporter.mjs`, not shipped inside the Web app. Its dependency licenses also apply to any separately redistributed native binary.
- `tools/usb-inspect.mjs`, `tools/analysis-source.mjs` and `tools/export-usb.mjs` retain attribution for their reader layouts, beat expansion, path rewrite and cue palette derived from the upstream MIT source.
- The browser module `dist/rekordbox-device.js` adapts PDB page/string/row layouts from the same revision and includes the full upstream MIT notice in its source. This is a read-only Device Library / ANLZ reader, separate from the native CLI writer.

## OneLibrary SQLCipher / SQLite interoperability

- Upstream: https://github.com/v1vendi/onelibrary
- Pinned revision: `02c6f80c802a635c394e733058502ecf28cf9fc9`.
- License: MIT. Copyright (c) 2026 v1vendi.
- Adapted files: upstream `viewer/src/sqlcipher.js` and `viewer/src/sqlite.js`, distributed in `dist/vendor/onelibrary/`.
- Complete license: `dist/vendor/onelibrary/LICENSE`. Source hashes, local modifications, interoperability references and fixture provenance: `dist/vendor/onelibrary/NOTICE.md`.
- Changes include SQLCipher decryption and WebCrypto encryption with fresh salts/IVs and per-page HMAC verification, bounded SQLite reads, strict validation and cycle detection. The readers run locally in a Web Worker and do not require an external service.
- Upstream `viewer/test/fixtures/sample.db` is a synthetic encrypted test fixture with fictional metadata and a test passphrase. It contains no user music or personal library data.

## Browser Device Library writer

- `dist/vendor/browser-usb/writer.wasm` adapts the MIT baken 4.10.0 PDB/ANLZ encoders at revision `50d2ba07fdad49d3a95e02d2951ac7a67197e85a` for browser and WKWebView execution.
- Complete upstream license, dependency licenses, binary hash and provenance are included in `dist/vendor/browser-usb/`. Adapted Rust source and build instructions are in `tools/browser-usb-writer/`.
- The adaptation removes native filesystem, audio-decoder, SQLite and CLI dependencies; adds an in-memory WebAssembly interface and streaming PCM metering; and preserves unrelated ANLZ sections during HOT CUE edits.
- This component writes the conventional Device Library format. OneLibrary synchronization and physical player validation are separate capabilities.

No third-party music, Pioneer/AlphaTheta artwork or B2B Studio assets are bundled.

## sql.js 1.14.2 / SQLite

- Upstream: https://github.com/sql-js/sql.js, pinned release `1.14.2`, MIT. SQLite is public domain.
- The official WASM engine updates OneLibrary without serializing or rebuilding unknown tables, columns, BLOBs or 64-bit values.
- Local ES module loader adaptations, exact source/distribution hashes, schema provenance, authors and full MIT licenses are included in `dist/vendor/sqlite-writer/`. See its `NOTICE.md`, `LICENSE` and `LICENSE.baken`.
