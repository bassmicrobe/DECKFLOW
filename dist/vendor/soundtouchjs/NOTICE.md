# SoundTouchJS for DECKFLOW

- Upstream: https://github.com/cutterbl/SoundTouchJS
- Package: `@soundtouchjs/audio-worklet` **2.1.1**
- Copyright: Steve “Cutter” Blades and the SoundTouchJS contributors; preserve the notices in the included source files.
- License: **Mozilla Public License 2.0**. The complete text is in [MPL-2.0.txt](MPL-2.0.txt).
- Runtime: `packages/audio-worklet/.dist/SoundTouchNode.js`, `constants.js`, `soundtouch-processor.js`, sourced from the published npm archive. DECKFLOW's build adds a cache-version query to the `./constants.js` import in `SoundTouchNode.js`; DSP and TypeScript sources are unchanged.
- Corresponding source: the TypeScript files under `packages/*/src/`, the included upstream source maps, and the Lanczos interpolation module under `packages/interpolation-strategy-lanczos/`. They are available with this application at the same URL base.
- Source snapshot: https://github.com/cutterbl/SoundTouchJS/tree/d9e39a7ddcf74c7a145bbba45856f30068c82b79
- Integrity and SHA-256 inventory: [provenance.json](provenance.json). These are upstream digests. To verify the built `SoundTouchNode.js`, remove only `?v=<16 lowercase hexadecimal characters>` from its `./constants.js` import; all other listed files must match byte-for-byte. The build transformation is in `scripts/build.mjs`, and `tests/vendor-integrity.test.mjs` verifies the inventory.

DECKFLOW keeps this dependency separate from its own application code. MPL allows a larger work under other terms, including proprietary terms, while the covered files and modifications to those files remain subject to MPL source-availability and notice requirements. This is not an MIT-licensed dependency. If redistributing a changed build, retain these notices, provide the corresponding covered source and follow the complete license; the application’s own license does not replace MPL for these files.

The browser uses these local files directly. No CDN is contacted at runtime.
