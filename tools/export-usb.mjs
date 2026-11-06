#!/usr/bin/env node
/** Safe new-directory CDJ-3000 export, using reviewed baken expressport. */
import {spawn} from 'node:child_process';
import {createHash} from 'node:crypto';
import {createReadStream} from 'node:fs';
import {readFile, writeFile, mkdir, mkdtemp, readdir, realpath, lstat, rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {resolve, dirname, join, sep} from 'node:path';
import {fileURLToPath} from 'node:url';
import {validateUsbLibrary, buildRekordboxXml} from '../dist/usb-export.js';
import {readExport} from './usb-inspect.mjs';
import {BAKEN_VERSION, BAKEN_REVISION} from './setup-usb-exporter.mjs';
const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const run = (binary, args, {quiet = false} = {}) => new Promise((done, reject) => {
  const child = spawn(binary, args, {env:{...process.env, BAKEN_NO_UPDATE_CHECK:'1', NO_COLOR:'1'}, stdio:['ignore','pipe','pipe']});
  let output = '';
  const collect = chunk => { if (output.length < 2 * 1024 * 1024) output += chunk.toString(); if (!quiet) process.stderr.write(chunk); };
  child.stdout.on('data', collect); child.stderr.on('data', collect);
  child.once('error', error => reject(new Error(`bakenを実行できません。node tools/setup-usb-exporter.mjs を実行してください。${error.message}`)));
  child.once('exit', code => code === 0 ? done(output) : reject(new Error(`bakenが終了コード${code}で停止しました。\n${output.slice(-5000)}`)));
});
async function hashFile(path) {
  const hash = createHash('sha256');
  for await (const chunk of createReadStream(path)) hash.update(chunk);
  return hash.digest('hex');
}
async function missing(path) {
  try { await lstat(path); return false; } catch (error) { if (error.code === 'ENOENT') return true; throw error; }
}
export async function resolveAudioFiles(library, audioDir) {
  const base = await realpath(audioDir), index = new Map();
  const walk = async directory => {
    for (const item of await readdir(directory, {withFileTypes:true})) {
      if (item.name.startsWith('.')) continue;
      const path = join(directory, item.name);
      if (item.isDirectory()) await walk(path);
      else if (item.isFile()) {
        const key = item.name.normalize('NFC');
        if (!index.has(key)) index.set(key, []);
        index.get(key).push(path);
      }
    }
  };
  await walk(base);
  const result = new Map();
  for (const track of library.tracks) {
    const matches = index.get(track.filename.normalize('NFC')) || [];
    if (matches.length !== 1) throw new Error(`${track.filename}: ${matches.length ? '同名ファイルが複数あります。音源フォルダを絞ってください。' : '指定フォルダに音源がありません。'}`);
    const path = await realpath(matches[0]);
    if (!path.startsWith(base + sep)) throw new Error('音源フォルダ外のファイルは使用できません。');
    result.set(track.id, path);
  }
  return result;
}
export async function exportUsb({libraryPath, audioDir, out, bakenPath, dryRun = false, quiet = false}) {
  if (!libraryPath || !audioDir || !out) throw new Error('--library、--audio-dir、--out を指定してください。');
  const output = resolve(out);
  if (!(await missing(output))) throw new Error('出力先は存在しない新規フォルダを指定してください。既存USBや既存フォルダは上書きしません。');
  const parent = await realpath(dirname(output));
  if (!(await lstat(parent)).isDirectory()) throw new Error('出力先の親フォルダがありません。');
  const info = await lstat(libraryPath);
  if (!info.isFile() || info.size > 64 * 1024 * 1024) throw new Error('64 MiB以下のライブラリJSONを指定してください。');
  const library = validateUsbLibrary(await readFile(libraryPath, 'utf8'));
  const sources = await resolveAudioFiles(library, audioDir);
  const generated = buildRekordboxXml(library, sources);
  const binary = bakenPath || process.env.DECKFLOW_BAKEN_BIN || resolve(root,'.local/baken/bin/baken');
  const version = (await run(binary, ['--version'], {quiet:true})).trim();
  if (version !== `baken ${BAKEN_VERSION}`) throw new Error(`検証対象はbaken ${BAKEN_VERSION}です。現在: ${version}`);
  const scratch = await mkdtemp(join(tmpdir(), 'deckflow-export-'));
  let createdOutput = false;
  try {
    const xmlPath = join(scratch, 'collection.xml'), analysisDir = join(scratch,'empty-analysis');
    await writeFile(xmlPath, generated.xml);
    await mkdir(analysisDir);
    await run(binary, ['cdjsafe', xmlPath, '--check', '--player', 'cdj-3000'], {quiet});
    const device = dryRun ? join(scratch,'dry-run-device') : output;
    await mkdir(device); // exclusive: never open an existing library
    createdOutput = !dryRun;
    const args = ['expressport', xmlPath, '--device', device, '--device-name', 'DECKFLOW',
      '--generate-analysis', '--anlz-dir', analysisDir, '--no-settings'];
    if (dryRun) args.push('--dry-run');
    await run(binary, args, {quiet});
    if (dryRun) return {dryRun:true, tracks:library.tracks.length, target:'CDJ-3000', output, bakenVersion:BAKEN_VERSION};
    const reread = await readExport(output);
    if (reread.tracks.length !== library.tracks.length) throw new Error('出力された曲数がライブラリと一致しません。');
    const trackMap = new Map(reread.tracks.map(track => [track.sourceId, track]));
    const checked = [];
    for (let i = 0; i < library.tracks.length; i++) {
      const source = library.tracks[i], deviceTrack = trackMap.get(i + 1);
      if (!deviceTrack || deviceTrack.title !== source.title || Math.abs(deviceTrack.bpm - source.bpm) > .011) throw new Error(`${source.filename}: PDBメタデータの読み戻しが一致しません。`);
      if (!deviceTrack.dat.tags.includes('PWAV') || !deviceTrack.dat.tags.includes('PWV2') ||
          !deviceTrack.ext.tags.includes('PWV3') || !deviceTrack.ext.tags.includes('PWV4') ||
          !deviceTrack.two.tags.includes('PWV7')) throw new Error(`${source.filename}: 波形データが不足しています。`);
      const beats = deviceTrack.dat.beats;
      if (!beats.length || Math.abs(beats[0].time - source.beatOffset) > .003 || beats.some(beat => Math.abs(beat.bpm - source.bpm) > .011)) throw new Error(`${source.filename}: ビートグリッドの読み戻しが一致しません。`);
      const cueRows = [...deviceTrack.dat.cues, ...deviceTrack.ext.cues];
      const expectedCues = [{number:0,time:source.cue}, ...source.hotcues.flatMap((time, index) => time === null ? [] : [{number:index + 1,time}])];
      if (expectedCues.some(cue => !cueRows.some(row => row.number === cue.number && Math.abs(row.time-cue.time) <= .003))) throw new Error(`${source.filename}: CUEの読み戻しが一致しません。`);
      const hash = await hashFile(sources.get(source.id));
      if (hash !== await hashFile(deviceTrack.audio)) throw new Error(`${source.filename}: コピーした音源が元ファイルと一致しません。`);
      checked.push({id:source.id, title:source.title, filename:source.filename, bpm:deviceTrack.bpm, sha256:hash,
        usbPath:deviceTrack.path, analysisPath:deviceTrack.analysisPath, beats:beats.length});
    }
    const uncheckedLists = reread.playlists.filter(list => !list.folder);
    if (uncheckedLists.length !== generated.playlists.length) throw new Error('プレイリストの数が一致しません。');
    for (const expected of generated.playlists) {
      const expectedIds = JSON.stringify(expected.trackIds.map(id => generated.numericIds[id]));
      const index = uncheckedLists.findIndex(list => list.name === expected.name &&
        JSON.stringify(list.trackIds.map(id => reread.tracks.find(track => track.id === id)?.sourceId)) === expectedIds);
      if (index < 0) throw new Error(`${expected.name}: プレイリストの曲順が一致しません。`);
      uncheckedLists.splice(index, 1);
    }
    const report = {format:'deckflow.usb-export-report', version:1, exportedAt:new Date().toISOString(),
      target:'CDJ-3000', deviceFormat:'Device Library', bakenVersion:BAKEN_VERSION, reviewedBakenRevision:BAKEN_REVISION,
      validation:'PDB/ANLZ metadata, playlist order, cue positions and SHA-256 audio copy checked',
      hardwareVerified:false, settings:'not exported; player keeps its settings', tracks:checked,
      playlists:reread.playlists.filter(list => !list.folder).map(list => ({name:list.name,tracks:list.trackIds.length}))};
    await writeFile(join(output,'DECKFLOW-REPORT.json'), JSON.stringify(report,null,2) + '\n', {flag:'wx'});
    return {...report, output};
  } catch (error) {
    if (createdOutput) await writeFile(join(output,'DECKFLOW-INCOMPLETE.txt'), `書き出しは完了していません。このフォルダを現場用USBとして使用しないでください。\n${error.message}\n`).catch(() => {});
    throw error;
  } finally { await rm(scratch, {recursive:true, force:true}); }
}
function parseArgs(args) {
  const options = {};
  const names = {'--library':'libraryPath','--audio-dir':'audioDir','--out':'out','--baken':'bakenPath'};
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === '--dry-run') options.dryRun = true;
    else if (names[arg] && args[i + 1] && !args[i + 1].startsWith('--')) options[names[arg]] = args[++i];
    else throw new Error(`不明、または値がないオプション: ${arg}`);
  }
  return options;
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  if (process.argv.includes('--help')) console.log(`DECKFLOW → CDJ-3000 USB用データ（新規フォルダのみ）\n\nnode tools/export-usb.mjs --library library.json --audio-dir /path/to/music --out /path/to/NEW_EXPORT\n\n--baken /path/to/baken  検証済みbaken ${BAKEN_VERSION}の場所\n--dry-run              元音源と形式を確認し、出力先を作らない\n\n出力内のPIONEERとContentsを専用USBの直下へ配置します。既存ライブラリへ重ねないでください。\nこのhelperはディスクを初期化せず、既存の出力先も上書きしません。CDJ-3000での実機確認は別途必要です。`);
  else {
    try { const result = await exportUsb(parseArgs(process.argv.slice(2))); console.log(JSON.stringify(result,null,2)); }
    catch (error) { console.error(error.message); process.exitCode = 1; }
  }
}
