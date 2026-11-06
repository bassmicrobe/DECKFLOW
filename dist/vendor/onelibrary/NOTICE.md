# OneLibrary read-only import components

Copyright (c) 2026 v1vendi. MIT; see LICENSE.

Source: https://github.com/v1vendi/onelibrary
Pinned commit: `02c6f80c802a635c394e733058502ecf28cf9fc9`

Adapted `viewer/src/sqlcipher.js` and `viewer/src/sqlite.js` for DECKFLOW. Local changes: read-only SQLCipher API, per-page HMAC verification, bounded SQLite parsing with strict validation and cycle detection. Known master/device passphrases documented in upstream `python/src/onelibrary/keys.py`; these are format interoperability constants, not user credentials. No executable scanning or network key retrieval.

The synthetic encrypted test fixture is upstream `viewer/test/fixtures/sample.db`, uses testpassphrase, and contains fictional track metadata only.

Upstream SHA-256 before local changes:

```json
{
  "viewer/src/sqlcipher.js": "d0d9de1b08ae68856edd9b615f06131466e746c3737c8a067f04ab414633c192",
  "viewer/src/sqlite.js": "f9bc4fa838d4dc4106145f11ac2f5460bd7785ef7b94adc59fdf1ebd51a82c03",
  "LICENSE": "b87ea3ea4c1fe4c92913c0c51ea33de97f60a989f26dc3ee1b0eb969de9dfefe",
  "viewer/test/fixtures/sample.db": "72068546a6fa26feda3e0c81a7d54767bb75f6b7a689f6e62534201087d1d94a"
}
```

Master database interoperability facts (schema, tombstones, and cue slot encoding) were checked against pyrekordbox's master database models and independent implementations. No implementation code was copied from these references:

- https://github.com/dylanljones/pyrekordbox/blob/02a208837434e4c05c0a222e8fe6583e6ac0547f/pyrekordbox/masterdb/models.py
- https://github.com/mganss/CueGen/blob/master/CueGen/Generator.cs
- https://github.com/chrisle/rbxport/blob/b739d369665b492534dc2eae0733322c040a26d5/crates/rbl-db/src/write.rs
