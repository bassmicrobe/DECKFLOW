#!/usr/bin/env node
/** Install the reviewed baken revision inside this project, not into the home directory. */
import {spawn} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import {resolve, dirname} from 'node:path';
import {mkdir, writeFile} from 'node:fs/promises';
const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
export const BAKEN_VERSION = '4.10.0';
export const BAKEN_REVISION = '50d2ba07fdad49d3a95e02d2951ac7a67197e85a';
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const installRoot = resolve(root, '.local/baken');
  await mkdir(installRoot, {recursive:true});
  const args = ['install', '--git', 'https://github.com/M-Igashi/baken.git', '--rev', BAKEN_REVISION,
    '--locked', '--force', '--root', installRoot, 'baken'];
  console.log(`baken ${BAKEN_VERSION}をプロジェクト内へビルドします。Rust/Cargoとネット接続が必要です。`);
  const code = await new Promise((done, reject) => {
    const child = spawn('cargo', args, {stdio:'inherit'});
    child.once('error', reject); child.once('exit', value => done(Number.isInteger(value) ? value : 1));
  }).catch(error => { console.error(`Cargoを実行できません: ${error.message}`); return 1; });
  if (code === 0) {
    await writeFile(resolve(installRoot,'DECKFLOW-PIN.json'), JSON.stringify({version:BAKEN_VERSION, revision:BAKEN_REVISION}, null, 2) + '\n');
    console.log('準備完了: node tools/export-usb.mjs --help');
  }
  process.exitCode = code || 0;
}
