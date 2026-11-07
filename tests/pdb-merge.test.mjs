import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {initWriter,planLibrary,mergeLibrary,inspectLibrary} from '../dist/vendor/browser-usb/writer.js';
import {inspectPdb} from '../tools/usb-inspect.mjs';
import {parseDeviceDatabase} from '../dist/rekordbox-device.js';

await initWriter({wasmBytes:await readFile(new URL('../dist/vendor/browser-usb/writer.wasm',import.meta.url))});
const fixture = new Uint8Array(await readFile(new URL('./fixtures/device-library/export.pdb',import.meta.url)));
const PAGE = 4096;
const view = bytes => new DataView(bytes.buffer,bytes.byteOffset,bytes.byteLength);
const u16 = (bytes,at) => view(bytes).getUint16(at,true);
const u32 = (bytes,at) => view(bytes).getUint32(at,true);
const set32 = (bytes,at,value) => view(bytes).setUint32(at,value,true);
const source = (id,extra = {}) => ({id,title:`Track ${id}`,filename:`${id}.wav`,artist:'DJ 共通',album:'Album',genre:'House',key:'Am',
  bpm:128,duration:2,size:352844,sampleRate:44100,bitRate:1411,bitDepth:16,...extra});

// Deliberately independent of the WASM merger; includes dead row slots so the
// assertions cover both live metadata and deleted payloads at original offsets.
function table(bytes,type) {
  for (let i=0;i<u32(bytes,8);i++) {
    const pointer=28+i*16;
    if (u32(bytes,pointer)!==type) continue;
    const first=u32(bytes,pointer+8),last=u32(bytes,pointer+12),pages=[],rows=[];
    for (let index=first;!pages.includes(index);index=u32(bytes,index*PAGE+12)) {
      pages.push(index);const start=index*PAGE;
      if (!(bytes[start+27]&0x40)) {
        const count=u16(bytes,start+24)&0x1fff;
        for (let slot=0;slot<count;slot++) {
          const group=start+PAGE-Math.floor(slot/16)*36, mask=group-4;
          rows.push({at:start+40+u16(bytes,group-6-(slot%16)*2),offsetAt:group-6-(slot%16)*2,mask,bit:1<<(slot%16),live:!!(u16(bytes,mask)&(1<<(slot%16)))});
        }
      }
      if (index===last) return {pointer,first,last,pages,rows};
    }
    throw new Error('Bad test chain');
  }
  throw new Error(`Missing test table ${type}`);
}
function retire(bytes,row) {view(bytes).setUint16(row.mask,u16(bytes,row.mask)&~row.bit,true);}

function assertOnlyAppendHeadersChanged(before,after) {
  assert.ok(after.length>=before.length);
  const allowed=new Set();
  const word=at => {for(let i=at;i<at+4;i++)allowed.add(i);};
  word(12);word(20);
  for(let i=0;i<u32(before,8);i++) {
    const descriptor=28+i*16;
    if(u32(before,descriptor+12)===u32(after,descriptor+12)) continue;
    const first=u32(before,descriptor+8),last=u32(before,descriptor+12);
    word(descriptor+12);word(last*PAGE+12);word(last*PAGE+16);
    if(first===last&&(before[first*PAGE+27]&0x40))word(first*PAGE+44);
  }
  for(const row of table(before,19).rows)if(row.live&&u16(before,row.at)===0x280)word(row.at+4);
  for(let i=0;i<before.length;i++)if(!allowed.has(i))assert.equal(after[i],before[i],`original byte ${i} changed`);
}

test('inspection and no-op merge preserve the upstream device fixture exactly',async()=>{
  const info=await inspectLibrary(fixture);
  assert.equal(info.existingTracks[0].filename,'日本語 120.wav');
  assert.equal(info.existingTracks[0].fileType,11);
  assert.equal(info.existingTracks[0].artist,'DJ Fixture');
  const result=await mergeLibrary({pdb:fixture});
  assert.deepEqual(result.pdb,fixture);
  assert.deepEqual(result.existingTracks,info.existingTracks);
  assert.deepEqual(result.existingPlaylists,info.playlistMappings);
  assert.deepEqual(result.tracks,[]);
});

test('append preserves every existing payload byte, unknown table, dead slot, ID and rich metadata across new pages',async()=>{
  const first=await planLibrary({tracks:[source('old0'),source('old1'),source('old2')],
    playlists:[{id:'keep',name:'Keep',folderPath:['Folders'],trackIds:['old2','old0','old2']}],idFloors:{track:100,artist:70,playlist:20}});
  const old=first.pdb.slice();
  const removed=table(old,0).rows.find(row=>u32(old,row.at+72)===102);retire(old,removed);
  for(const row of table(old,8).rows)if(u32(old,row.at+4)===102)retire(old,row);
  // A known track has player/library fields our editing model does not expose.
  const preserved=table(old,0).rows[0];set32(old,preserved.at+24,0x12345678);set32(old,preserved.at+28,98765);
  old[preserved.at+86]=0xa5;old[preserved.at+87]=0x5a;
  const unknown=table(old,9);set32(old,unknown.pointer,202);
  for(const page of unknown.pages){set32(old,page*PAGE+8,202);old.fill(0xb7,page*PAGE+64,page*PAGE+96);}
  const snapshot=await inspectLibrary(old),before=inspectPdb(old);
  const additions=Array.from({length:230},(_,i)=>source(`new${i}`,{artist:`Artist ${i%15} 日本語`,album:`Album ${i%11}`,label:'Label',composer:'Writer'}));
  const output=await mergeLibrary({pdb:old,tracks:additions,idFloors:{track:1000,playlist:500},
    existingTrackIds:{old0:101,old2:103},playlists:[{id:'newSet',name:'Keep',folderPath:['Folders'],trackIds:['new229','old0','new0']}],
    appendPlaylists:[{playlistId:snapshot.playlistMappings.find(p=>p.name==='Keep').numericId,trackIds:['old2','new0','new0','new229']}]});
  assertOnlyAppendHeadersChanged(old,output.pdb);
  assert.deepEqual((await inspectLibrary(output.pdb)).existingTracks.slice(0,2),snapshot.existingTracks);
  const checked=inspectPdb(output.pdb),app=parseDeviceDatabase(output.pdb);
  assert.equal(checked.tracks.length,232);assert.equal(app.tracks.length,232);
  assert.deepEqual(checked.tracks.slice(0,2),before.tracks);
  assert.equal(output.idMappings.new0,1001);assert.equal(output.idMappings.new229,1230);
  assert.equal(output.playlistMappings.filter(p=>p.isFolder).length,0);
  assert.equal(output.playlistMappings[0].numericId,501);
  assert.equal(checked.playlists.filter(p=>p.name==='Keep').length,2);
  const existing=checked.playlists.find(p=>p.id===snapshot.playlistMappings.find(p=>p.name==='Keep').numericId);
  assert.deepEqual(existing.trackIds,[103,101,103,1001,1230]);
  assert.deepEqual(output.appendPlaylistTracks,[{playlistId:existing.id,trackIds:[1001,1230]}]);
  assert.equal(output.entityMappings.labels[0].name,'Label');
  const property=table(output.pdb,19).rows.find(r=>r.live&&u16(output.pdb,r.at)===0x280);
  assert.equal(u32(output.pdb,property.at+4),232);
  // Repeating an append is idempotent and does not rewrite a single byte.
  const again=await mergeLibrary({pdb:output.pdb,existingTrackIds:{new0:1001},appendPlaylists:[{playlistId:existing.id,trackIds:['new0']}]});
  assert.deepEqual(again.pdb,output.pdb);
});

test('new IDs respect floors and explicit IDs while all references and entity fields stay coherent',async()=>{
  const plan=await planLibrary({tracks:[source('a',{numericId:900,label:'L',composer:'C'}),source('b')],idFloors:{track:500,playlist:80,artist:30,label:20},
    playlists:[{id:'set',name:'Set',folderPath:['Folder'],trackIds:['b','a']}]});
  assert.deepEqual(plan.idMappings,{a:900,b:901});
  assert.deepEqual(plan.playlistMappings.map(p=>p.numericId),[81,82,83]);
  assert.deepEqual(plan.playlistMappings.find(p=>p.id==='set').trackIds,[901,900]);
  const info=await inspectLibrary(plan.pdb);
  assert.equal(info.existingTracks[0].composer,'C');assert.equal(info.existingTracks[0].label,'L');
  assert.equal(info.entityMappings.labels[0].numericId,21);
  assert.deepEqual(inspectPdb(plan.pdb).tracks.map(t=>t.sourceId),[900,901]);
});

test('missing-format mirroring references original audio/ANLZ, rich metadata and empty nested folders without analysis',async()=>{
  const reuseDeviceFile={usbPath:'/Contents/Original Artist/Album/Existing.mp3',analysisPath:'/.PIONEER/USBANLZ/P001/ABCDEF12/ANLZ0012.DAT'};
  const rich=source('mirrored',{numericId:700,filename:'ignored.wav',title:'Original',reuseDeviceFile,bpm:0,duration:0,sampleRate:0,bitDepth:0,
    comments:'line 1\nline 2\tcomment',label:'Label',composer:'Composer',remixer:'Remix',originalArtist:'Original Artist',
    trackNumber:12,discNumber:2,playCount:47,year:2026,rating:4,colorId:7,dateAdded:'2026-11-07',dateCreated:'2024-05-06',releaseDate:'2023-04-05',mixName:'Dub',masterContentId:8888});
  const devicePlaylists=[{numericId:50,parentId:0,sortOrder:7,isFolder:true,name:'Folder',trackIds:[]},
    {numericId:51,parentId:50,sortOrder:3,isFolder:true,name:'Empty folder',trackIds:[]},
    {numericId:52,parentId:50,sortOrder:8,isFolder:false,name:'Set',trackIds:[700,700]}];
  const plan=await planLibrary({tracks:[rich],devicePlaylists,includeAllPlaylist:false});
  const track=plan.tracks[0];assert.equal(track.usbPath,reuseDeviceFile.usbPath);assert.equal(track.anlzPaths.dat,reuseDeviceFile.analysisPath);assert.equal(track.anlzIndex,12);
  const info=await inspectLibrary(plan.pdb),saved=info.existingTracks[0];
  for(const key of ['label','composer','remixer','originalArtist','trackNumber','discNumber','playCount','year','rating','colorId','dateCreated','releaseDate','mixName','comments','masterContentId'])assert.equal(saved[key],rich[key],key);
  assert.equal(saved.addedDate,rich.dateAdded);assert.equal(saved.fileType,1);assert.equal(saved.bitDepth,0);assert.equal(saved.bpm,0);
  assert.deepEqual(info.playlistMappings.map(({id,...p})=>p),devicePlaylists);
  const merged=await mergeLibrary({pdb:fixture,tracks:[rich],devicePlaylists});
  assert.equal(merged.tracks[0].numericId,700);assert.equal(merged.tracks[0].anlzPaths.dat,reuseDeviceFile.analysisPath);
  assertOnlyAppendHeadersChanged(fixture,merged.pdb);
});

test('deleted record IDs are reserved and generated ANLZ paths avoid an existing directory slot',async()=>{
  const base=await planLibrary({tracks:[source('a'),source('deleted')],idFloors:{track:500}});
  const pdb=base.pdb.slice();
  retire(pdb,table(pdb,0).rows.find(row=>u32(pdb,row.at+72)===502));
  for(const row of table(pdb,8).rows)if(u32(pdb,row.at+4)===502)retire(pdb,row);
  const inspected=await inspectLibrary(pdb);assert.equal(inspected.idFloors.track,502);
  const merged=await mergeLibrary({pdb,tracks:[source('new')]});assert.equal(merged.tracks[0].numericId,503);
  await assert.rejects(mergeLibrary({pdb,tracks:[source('other',{numericId:502})]}),/already exists/);
  const stale=pdb.slice(),slots=table(stale,0).rows,live=slots[0],dead=slots[1];
  const title=live.at+u16(stale,live.at+94+17*2),pageBase=Math.floor(live.at/PAGE)*PAGE;
  view(stale).setUint16(dead.offsetAt,title-pageBase-40,true);
  assert.equal((await inspectLibrary(stale)).existingTracks[0].title,'Track a');

  const future=await planLibrary({tracks:[source('collision')]});
  const occupant=source('occupant',{reuseDeviceFile:{usbPath:'/Contents/kept.wav',analysisPath:future.tracks[0].anlzPaths.dat}});
  const occupied=await planLibrary({tracks:[occupant]});
  const result=await mergeLibrary({pdb:occupied.pdb,tracks:[source('collision')]});
  assert.equal(result.tracks[0].anlzIndex,1);
  assert.equal(result.tracks[0].anlzPaths.dat,future.tracks[0].anlzPaths.dat.replace('ANLZ0000','ANLZ0001'));
  assert.equal(inspectPdb(result.pdb).tracks[1].analysisPath,result.tracks[0].anlzPaths.dat);
  // A missing PDB can contain old OneLibrary references and new tracks in
  // either order; neither order may reuse an existing ANLZ destination.
  for(const tracks of [[occupant,source('collision')],[source('collision'),occupant]]){
    const fresh=await planLibrary({tracks});
    assert.equal(fresh.tracks.find(t=>t.id==='collision').anlzIndex,1);
    assert.equal(fresh.tracks.find(t=>t.id==='occupant').anlzPaths.dat,occupant.reuseDeviceFile.analysisPath);
  }
});

test('empty missing-format library can preserve empty folders without an artificial collection',async()=>{
  const plan=await planLibrary({tracks:[],includeAllPlaylist:false,devicePlaylists:[{numericId:7,parentId:0,sortOrder:0,isFolder:true,name:'Empty',trackIds:[]}]});
  const result=await inspectLibrary(plan.pdb);assert.deepEqual(result.existingTracks,[]);assert.equal(result.playlistMappings[0].name,'Empty');
  assert.equal(plan.idFloors.playlist,7);
});

test('duplicates, unsafe paths, invalid references, cycles, missing tables and ID overflow fail without changing the input',async()=>{
  const old=fixture.slice(),info=await inspectLibrary(old),existing=info.existingTracks[0];
  await assert.rejects(mergeLibrary({pdb:old,tracks:[source('same',{reuseDeviceFile:{usbPath:existing.usbPath,analysisPath:existing.analysisPath}})]}),/already exists/);
  await assert.rejects(mergeLibrary({pdb:old,tracks:[source('bad',{reuseDeviceFile:{usbPath:'/Contents/../evil.wav',analysisPath:existing.analysisPath}})]}),/パス/);
  await assert.rejects(mergeLibrary({pdb:old,existingTrackIds:{bad:999},appendPlaylists:[]}),/Unknown existing/);
  await assert.rejects(mergeLibrary({pdb:old,tracks:[source('new',{numericId:1})]}),/already exists/);
  await assert.rejects(mergeLibrary({pdb:old,tracks:[source('new')],idFloors:{track:0xffffffff}}),/overflow/);
  await assert.rejects(mergeLibrary({pdb:old,devicePlaylists:[{numericId:99,parentId:99,sortOrder:0,isFolder:true,name:'Cycle',trackIds:[]}]}),/cycle/);
  await assert.rejects(mergeLibrary({pdb:old,devicePlaylists:[{numericId:99,parentId:0,sortOrder:0,isFolder:false,name:'Bad',trackIds:[999]}]}),/unknown track/);
  const corrupt=old.slice(),tracks=table(corrupt,0);set32(corrupt,tracks.first*PAGE+12,tracks.first);
  await assert.rejects(inspectLibrary(corrupt),/cycles/);
  const absent=old.slice(),artists=table(absent,2);set32(absent,artists.pointer,200);
  for(const page of artists.pages)set32(absent,page*PAGE+8,200);
  await assert.rejects(mergeLibrary({pdb:absent,tracks:[source('new')]}),/Required PDB table/);
  assert.deepEqual(old,fixture);
});
