# Browser Device Library writer

The source for `dist/vendor/browser-usb/writer.wasm`. Runtime operations do not
use the Mac CLI, filesystem APIs, a server, or uploaded audio. The consuming
app supplies storage access and decoded PCM chunks.

Build with Rust and its `wasm32-unknown-unknown` target:

```sh
node tools/browser-usb-writer/build.mjs
node --test tests/browser-usb-writer.test.mjs tests/pdb-merge.test.mjs
```

`src/pdb/*` (except the new `merge.rs`), `src/anlz/*`, and the small collection/layout definitions derive
from MIT baken 4.10.0 at the revision in `UPSTREAM.json`. Upstream unit tests
were removed from these copied modules; DECKFLOW tests exercise the compiled
WebAssembly against separate JavaScript readers and, when available, the
original native baken CLI. `waveform.rs` has its file decoder removed; its
streaming `Meter` and binary waveform encoding are retained.

The custom ABI in `src/lib.rs` exposes allocation, library inspection/planning,
append-only PDB merging, streamed waveform metering, and CUE-only ANLZ patching. It returns a compact
JSON metadata header followed by binary payloads; audio never passes through
JSON. `writer.js` owns memory and validates application input.

`planLibrary` creates a **complete new conventional Device Library**. Use
`mergeLibrary` for an existing `export.pdb`: it appends new pages, updates their
table-chain references and song count, and preserves all other existing bytes.
Existing live/deleted rows, unknown tables, artwork references, history,
preferences, and playlist order are retained. `inspectLibrary` returns the
known metadata and numeric IDs without rewriting anything. All these functions
are pure byte operations; the storage adapter owns change detection and commit.

New tracks use IDs above both existing records (including deleted records) and
optional `idFloors`. `numericId` is available for cross-format coordination.
`existingTrackIds` maps application IDs to existing PDB numeric IDs;
`appendPlaylists` explicitly extends an existing playlist without replacing its
members. A new playlist with an existing name gets a separate ID. Existing
same-parent folders are reused only when the match is unambiguous.

`reuseDeviceFile: {usbPath, analysisPath}` references an existing audio/ANLZ
pair when mirroring a missing database format, without copying or analysing the
audio. It preserves unanalysed BPM and unknown audio metadata instead of inventing
values. `devicePlaylists` accepts explicit numeric node IDs, parents, order and
members so empty folders and complete hierarchies can be mirrored.
`includeAllPlaylist: false` disables the automatic collection playlist in a new
plan. Unsafe paths, ambiguous IDs, malformed page chains and unsupported row
layouts fail before any bytes are returned to the storage adapter. Limits are
10,000 live tracks and a 128 MiB PDB; no rows are silently dropped.

These functions do not implement OneLibrary encryption/SQL updates. The
application's OneLibrary module must synchronize that database separately.
Storage adapters must reject replacement of an existing library with an
incomplete new plan. `patchAnalysis`
does not touch the PDB, audio paths, grids, waveforms or unknown sections.
Its default HOT-only mode also preserves memory-CUE sections verbatim.
Physical CDJ compatibility is not established by the format tests.

The waveform colors/three-band filter values follow baken's approximations.
Imported waveforms are preserved instead of regenerated during CUE edits.
