import {parseRekordboxXml} from './rekordbox-import.js?v=9e830656f38a4042';
import {parseRekordboxLocation} from './rekordbox-model.js?v=9e830656f38a4042';
import {parseDeviceDatabase, parseDeviceAnalysis, mergeDeviceAnalysis} from './rekordbox-device.js?v=9e830656f38a4042';
import {parseRekordboxDatabase} from './rekordbox-sqlite.js?v=9e830656f38a4042';
import {validateLibrarySnapshot} from './library-store.js?v=9e830656f38a4042';
self.onmessage = async ({data}) => {
  const {id,operation} = data;
  try {
    let result;
    if (operation === 'database') {
      if (data.kind === 'pdb') result = parseDeviceDatabase(data.bytes,{sourceId:data.sourceId});
      else if (data.kind === 'sqlite') result = await parseRekordboxDatabase(data.bytes,{sourceId:data.sourceId,kind:data.databaseKind});
      else if (data.kind === 'xml') {
        result = parseRekordboxXml(new TextDecoder('utf-8',{fatal:true}).decode(data.bytes));
        result.entries = result.tracks.map(track=>({trackId:track.id,sourcePath:parseRekordboxLocation(track.rekordbox.location).path,analysisPath:null}));
      } else throw new Error('対応していないライブラリ形式です。');
      const valid=validateLibrarySnapshot({format:'deckflow.library',version:1,tracks:result.tracks,playlists:result.playlists});
      result={...result,...valid,sourceFormat:result.format};
    } else if (operation === 'analysis') {
      result = mergeDeviceAnalysis(data.track,data.files.map(bytes=>parseDeviceAnalysis(bytes,{duration:data.track.duration})),{allowAnonymousPath:true,preserveCues:data.preserveCues===true});
      result=validateLibrarySnapshot({format:'deckflow.library',version:1,tracks:[result],playlists:[]}).tracks[0];
    } else throw new Error('対応していない読み取り操作です。');
    self.postMessage({id,result});
  } catch (error) { self.postMessage({id,error:error.message || 'ライブラリを読み取れませんでした。'}); }
};
