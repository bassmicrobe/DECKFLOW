# Third-party notices

DECKFLOW includes or invokes the following third-party software. The licenses for these components do not license the rest of DECKFLOW.

## SoundTouchJS AudioWorklet 2.1.1

- Upstream: https://github.com/cutterbl/SoundTouchJS
- Package: `@soundtouchjs/audio-worklet` version `2.1.1`
- License: Mozilla Public License 2.0.
- Copyright notices, complete MPL-2.0, corresponding TypeScript source, distribution provenance and integrity are included in `dist/vendor/soundtouchjs/`.
- Runtime files are served locally from the same distribution; no external CDN is required.
- The covered source remains available under MPL-2.0. Modified covered files must retain applicable notices and corresponding source availability. This is not an MIT-only dependency.

## baken 4.10.0

- Upstream: https://github.com/M-Igashi/baken
- Reviewed revision: `50d2ba07fdad49d3a95e02d2951ac7a67197e85a`.
- License: MIT; complete notice: `vendor/licenses/baken-MIT.txt`.
- baken is built locally by `tools/setup-usb-exporter.mjs`, not shipped inside the Web app. Its dependency licenses also apply to any separately redistributed native binary.
- `tools/usb-inspect.mjs` retains attribution for its reader layouts derived from the upstream MIT source.

The original generated demo audio is created by DECKFLOW in the browser. No third-party music, Pioneer/AlphaTheta artwork or B2B Studio assets are bundled.
