# SQLite write engine

`sql-wasm.js` and `sql-wasm.wasm` are sql.js **1.14.2**, MIT licensed.
Copyright (c) 2017 sql.js authors. See `LICENSE` and `AUTHORS`.

- Official source: https://github.com/sql-js/sql.js
- Pinned release commit: `9c4e167ec37129192d166ab9223faa9a4bd07c58`
- Official distribution: https://github.com/sql-js/sql.js/releases/download/v1.14.2/sqljs-wasm.zip
- Distribution SHA-256: `495be0a6f586bbf7f3df2e81a288f7dd9ef82cf8876a36a80a00f77b6a2fa1a3`
- Upstream JavaScript SHA-256: `f1c84000dbc856c9d87f4f3aabc4d3654bd436165db4be3da13751db3a9c20d7`
- Unmodified WebAssembly SHA-256: `38c14f6e379210bc942bdc4ebca44e7bfdb4318ecc1c72ca666a28fdce96670a`

Three loader-only adaptations make the universal UMD distribution usable as a
browser ES module: declare its `module` variable, disable the Node/CommonJS
branch, and export `initSqlJs` as default. DECKFLOW supplies `wasmBinary` from
its own origin (or directly in tests). No SQLite engine code is modified.
SQLite itself is public domain: https://sqlite.org/copyright.html

`template.js` contains the OneLibrary schema and default browse values from
baken, MIT, pinned commit `50d2ba07fdad49d3a95e02d2951ac7a67197e85a`:

- https://github.com/M-Igashi/baken/blob/50d2ba07fdad49d3a95e02d2951ac7a67197e85a/crates/baken-export/src/onelibrary.rs
- https://github.com/M-Igashi/baken/blob/50d2ba07fdad49d3a95e02d2951ac7a67197e85a/crates/baken-export/src/pdb/fixed.rs

See `LICENSE.baken`. The empty SQLite page was generated with native SQLite
using `SQLITE_FCNTL_RESERVE_BYTES=80`, `page_size=4096` and an empty-schema
VACUUM. Schema/default creation runs only when no previous OneLibrary exists.
Existing databases are edited by SQLite, never regenerated from this template.

The SQLCipher encryptor uses the existing MIT OneLibrary interoperability
component in `../onelibrary/`. Added encryption uses WebCrypto AES-CBC and
HMAC-SHA512, fresh salts/IVs, and requires 80 reserved bytes per page.

OneLibrary cue encoding facts were independently checked against the following
primary documentation. No code from these projects was copied:

- https://github.com/sebasje/seabass/blob/7e8b89eeea91ab8351ccd2ae431ebebc06e56b0c/docs/onelibrary-format.md
- https://github.com/dylanljones/pyrekordbox/blob/02a208837434e4c05c0a222e8fe6583e6ac0547f/pyrekordbox/onelibrary/models.py

OneLibrary uses kind 0 for memory and 1–8 for HOT A–H (different from the master
database's enum). RGB-to-colorTableIndex conversion remains unknown: existing
indices are preserved, new cues use 0 unless an explicit native index is given.
Changed positions invalidate known codec-specific seek fields, leaving those
fields NULL; modern usec positions and 150-frame positions are updated. Real
player acceptance of these generated records must be checked on hardware.
