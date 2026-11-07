import test from 'node:test';
import assert from 'node:assert/strict';
import {planUSBMerge} from '../dist/usb-library-plan.js';
const pdb={existingTracks:[{numericId:1,usbPath:'/Contents/A.wav'},{numericId:2,usbPath:'/Contents/B.wav'}],idFloors:{track:2,playlist:11},
  playlistMappings:[{numericId:10,parentId:0,isFolder:true,name:'Folder',trackIds:[]},{numericId:11,parentId:10,isFolder:false,name:'Set',trackIds:[1,1]}]};
const one={tracks:[{contentId:99,path:'/Contents/A.wav'},{contentId:1,path:'/Contents/C.wav'}],maxIds:{track:99,playlist:51},
  playlists:[{playlistId:50,parentId:0,attribute:1,name:'Folder',trackIds:[]},{playlistId:51,parentId:50,attribute:0,name:'Set',trackIds:[99,1]}]};
test('different IDs map by full audio path; both indexes retain originals and gain missing tracks/members',()=>{
  const result=planUSBMerge({pdb,one});
  const a=result.nodes.find(t=>t.audioPath==='/Contents/A.wav');assert.equal(a.pdbId,1);assert.equal(a.oneLibraryId,99);
  const c=result.nodes.find(t=>t.audioPath==='/Contents/C.wav');assert.ok(c.pdbId>99);assert.equal(c.oneLibraryId,1);
  assert.equal(result.lists.length,2);assert.equal(result.lists[1].pdbId,11);assert.equal(result.lists[1].oneLibraryId,51);
  assert.deepEqual(result.lists[1].pdb.trackIds,[1,1]);assert.deepEqual(result.appendPlaylists[0].trackIds,[c.id]);
  assert.deepEqual(result.appendPlaylistTracks,[]);
});
test('missing counterpart preserves empty folder IDs and parent relationships',()=>{
  for(const input of [{pdb},{one}]) {
    const result=planUSBMerge(input);assert.equal(result.lists.length,2);
    assert.equal(result.lists[1].parent,result.lists[0]);
    if(input.pdb){assert.equal(result.addPlaylists[0].attribute,1);assert.deepEqual(result.addPlaylists[0].trackIds,[]);}
    else {assert.equal(result.devicePlaylists[0].isFolder,true);assert.equal(result.devicePlaylists[1].parentId,50);}
  }
});
test('filtered transfer appends only available new references without removing existing playlist members',()=>{
  const state={tracks:{a:{pdbId:1,audioPath:'/Contents/A.wav'}},playlists:{set:{pdbId:11,baseline:{trackIds:['a']}}}};
  const result=planUSBMerge({pdb,state,tracks:[{id:'new',title:'New'}],playlists:[{id:'set',name:'Set',trackIds:['a','new','not-transferred']}]});
  assert.deepEqual(result.appendPlaylists[0].trackIds,['new']);
  assert.equal(result.lists.find(list=>list.localId==='set').members.length,2);
});
test('unbound same-name local playlist is a distinct playlist; malformed references cannot silently merge',()=>{
  const result=planUSBMerge({pdb,playlists:[{id:'different',name:'Set',folderPath:['Folder'],trackIds:[]}]});
  assert.equal(result.lists.filter(list=>list.name==='Set').length,2);
  assert.throws(()=>planUSBMerge({pdb:{...pdb,playlistMappings:[{...pdb.playlistMappings[1],parentId:555}]}}),/親/);
  assert.throws(()=>planUSBMerge({pdb:{...pdb,existingTracks:[...pdb.existingTracks,{numericId:3,usbPath:'/Contents/A.wav'}]}}),/重複/);
});
