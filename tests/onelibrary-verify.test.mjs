import test from 'node:test';
import assert from 'node:assert/strict';
import {verifyOneLibrary} from '../tools/onelibrary-verify.mjs';

const devices = [{id:3,title:'長時間録音',bpm:120,duration:1865,size:1073741864,
  path:'/Contents/recording.wav',analysisPath:'/PIONEER/USBANLZ/P001/ANLZ0000.DAT'},
{id:7,title:'Second',bpm:128,duration:5,size:882044,
  path:'/Contents/second.wav',analysisPath:'/PIONEER/USBANLZ/P002/ANLZ0000.DAT'}];
const expected = [{name:'Set',folderPath:['Live'],trackIds:[7,3]},
  {name:'Empty',folderPath:[],trackIds:[]}];
const snapshot = () => ({tracks:devices.map(track => ({id:`r-${track.id}`,title:track.title,
  bpm:track.bpm,duration:track.duration,rekordbox:{trackId:String(track.id),size:track.size}})),
entries:devices.map(track => ({trackId:`r-${track.id}`,sourcePath:track.path,analysisPath:track.analysisPath})),
playlists:expected.map(list => ({...list,trackIds:list.trackIds.map(id => `r-${id}`)}))});

test('OneLibrary readback matches large-track identity, paths and nested playlist order', () => {
  verifyOneLibrary(snapshot(),{tracks:devices},expected);
  for (const [field,value] of [['title','Wrong'],['bpm',121],['duration',1864],['rekordbox',{trackId:'3',size:12}]]) {
    const input = snapshot();
    const changed = {...input,tracks:input.tracks.map((track,index) => index === 0 ? {...track,[field]:value} : track)};
    assert.throws(() => verifyOneLibrary(changed,{tracks:devices},expected), /一致しません/);
  }
  const input = snapshot();
  for (const field of ['sourcePath','analysisPath']) {
    const changed = {...input,entries:input.entries.map((entry,index) => index === 0 ? {...entry,[field]:'/wrong'} : entry)};
    assert.throws(() => verifyOneLibrary(changed,{tracks:devices},expected), /一致しません/);
  }
});

test('OneLibrary mismatch catches wrong folder, reversed order and missing empty playlists', () => {
  const input = snapshot();
  for (const playlists of [input.playlists.slice(0,1),
    input.playlists.map((list,index) => index === 0 ? {...list,trackIds:[...list.trackIds].reverse()} : list),
    input.playlists.map((list,index) => index === 0 ? {...list,folderPath:[]} : list)]) {
    assert.throws(() => verifyOneLibrary({...input,playlists},{tracks:devices},expected), /一致しません/);
  }
});
