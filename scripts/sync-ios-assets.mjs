import {cp, mkdir, readdir, rename, rm, stat} from 'node:fs/promises';
import {fileURLToPath} from 'node:url';
import {dirname, join} from 'node:path';

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const source = join(root, 'dist');
const resources = join(root, 'native', 'ios', 'DECKFLOW', 'Resources');
const destination = join(resources, 'Web');
const staging = join(resources, '.Web-staging');
for (const file of ['index.html', 'app.js', 'audio-engine.js', 'mappings.js']) {
  if (!(await stat(join(source, file)).catch(() => null))?.isFile()) {
    throw new Error(`dist/${file} がありません。Web版を仕上げてから同期してください。`);
  }
}
await mkdir(resources, {recursive: true});
await rm(staging, {recursive: true, force: true});
await cp(source, staging, {recursive: true, dereference: false});
// The fixed destination is generated from tracked dist assets only. Never
// remove documents, user audio, the Xcode project, or another build directory.
await rm(destination, {recursive: true, force: true});
await rename(staging, destination);
const count = async path => {
  let files = 0;
  for (const item of await readdir(path, {withFileTypes: true})) {
    files += item.isDirectory() ? await count(join(path, item.name)) : 1;
  }
  return files;
};
process.stdout.write(`DECKFLOW iOS: ${await count(destination)} files copied from dist/.\n`);
