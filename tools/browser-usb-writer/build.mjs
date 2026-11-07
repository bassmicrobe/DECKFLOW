#!/usr/bin/env node
// Developer build only. The Web app uses the committed, self-contained WASM.
import {spawnSync} from 'node:child_process';
import {readFile, writeFile, copyFile, mkdir, readdir} from 'node:fs/promises';
import {dirname, join, resolve} from 'node:path';
import {fileURLToPath} from 'node:url';
import {createHash} from 'node:crypto';
const root = dirname(fileURLToPath(import.meta.url));
const destination = resolve(root, '../../dist/vendor/browser-usb');
const run = args => {
  const result = spawnSync('cargo', args, {cwd:root, encoding:'utf8'});
  if (result.status !== 0) throw new Error(result.stderr || result.error?.message || 'Cargo failed');
  return result.stdout;
};
run(['build', '--locked', '--release', '--target', 'wasm32-unknown-unknown']);
await mkdir(destination, {recursive:true});
const binary = await readFile(join(root, 'target/wasm32-unknown-unknown/release/deckflow_browser_usb_writer.wasm'));
await writeFile(join(destination, 'writer.wasm'), binary);
await copyFile(join(root, 'LICENSE.baken'), join(destination, 'LICENSE.baken'));
const metadata = JSON.parse(run(['metadata', '--locked', '--format-version', '1']));
const dependencies = [];
await mkdir(join(destination, 'licenses'), {recursive:true});
for (const pkg of metadata.packages.filter(pkg => pkg.source)) {
  const directory = dirname(pkg.manifest_path);
  const licenses = (await readdir(directory)).filter(name => /^LICEN[CS]E(?:[._-]|$)|^COPYING$/i.test(name));
  for (const name of licenses) await copyFile(join(directory, name), join(destination, 'licenses', `${pkg.name}-${name}`));
  dependencies.push({name:pkg.name, version:pkg.version, license:pkg.license, repository:pkg.repository, notices:licenses});
}
await writeFile(join(destination, 'provenance.json'), JSON.stringify({
  format:'deckflow.browser-usb-writer', version:1,
  upstream:JSON.parse(await readFile(join(root, 'UPSTREAM.json'), 'utf8')),
  wasmSha256:createHash('sha256').update(binary).digest('hex'), wasmBytes:binary.length,
  rustc:spawnSync('rustc', ['--version'], {encoding:'utf8'}).stdout.trim(), dependencies,
}, null, 2) + '\n');
console.log(`Browser USB writer: ${binary.length} bytes`);
