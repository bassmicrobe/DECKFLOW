# Browser USB writer

`writer.wasm` contains a browser adaptation of baken 4.10.0, MIT licensed,
copyright (c) 2025 Jesse Pinkman (JPHFA), revision
`50d2ba07fdad49d3a95e02d2951ac7a67197e85a`.
Upstream: https://github.com/M-Igashi/baken

The complete original notice is in `LICENSE.baken`. Source and reproducible
build instructions are in `tools/browser-usb-writer/`. Source hashes,
compiler version, binary integrity, dependency versions and licenses are in
`provenance.json`; full dependency licenses are in `licenses/`.

Changes: extract PDB/ANLZ encoders, remove filesystem/decoder/SQLite/native
export dependencies, add a small in-memory WebAssembly ABI, stream decoded
PCM into the upstream waveform meter, and add strict CUE-only patching that
preserves all unrelated original ANLZ bytes. DECKFLOW also adds an append-only
PDB merger/inspector which preserves existing record payloads and unknown tables.
No upstream native executable is needed by users. The writer targets conventional Device Library;
it does not generate or synchronize OneLibrary.

The binary is served locally with DECKFLOW. There is no external CDN or
runtime music upload. Browser generation and structural validation do not
constitute physical iPad/USB/CDJ-3000 certification.
