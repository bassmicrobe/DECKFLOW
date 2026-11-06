import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {createHash} from 'node:crypto';

const root = new URL('../dist/vendor/soundtouchjs/', import.meta.url);
const hash = bytes => createHash('sha256').update(bytes).digest('hex');

test('vendored SoundTouch files match upstream hashes after the documented build transformation', async () => {
  const provenance = JSON.parse(await readFile(new URL('provenance.json', root), 'utf8'));
  const transformed = new Set(provenance.build_modified_files ?? []);
  for (const [file, expected] of Object.entries(provenance.sha256)) {
    const bytes = await readFile(new URL(file, root));
    // Only this import is modified by DECKFLOW. Keep the upstream digest and
    // reject any other change to runtime, source, source maps, or notices.
    const original = transformed.has(file)
      ? bytes.toString().replace(/(from ['"]\.\/constants\.js)\?v=[a-f0-9]{16}(['"])/g, '$1$2')
      : bytes;
    assert.equal(hash(original), expected, `${file} differs from its upstream inventory`);
  }
});
