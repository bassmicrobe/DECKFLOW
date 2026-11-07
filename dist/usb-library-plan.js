/** Plan a union of the two device indexes without renumbering/deleting originals.
 * Matching is by full audio path and unambiguous playlist hierarchy, never basename. */
import {normalizeSourcePath} from './library-source.js?v=61851a879bde64c2';
const path = value => '/' + normalizeSourcePath(value);
const fail = message => { throw new Error(message); };
const max = values => Math.max(0, ...values);
export function planUSBMerge({pdb, one, state = {}, tracks = [], playlists = []}) {
  const nodes = [], byPath = new Map(), byLocal = new Map(), pTracks = new Map(), oTracks = new Map();
  let trackId = Math.max(pdb?.idFloors?.track || 0, one?.maxIds?.track || 0);
  const add = (raw, format) => {
    const audioPath = path(format === 'pdb' ? raw.usbPath : raw.path);
    let node = byPath.get(audioPath);
    if (!node) {node = {id:`usb-existing-${nodes.length}`,audioPath};nodes.push(node);byPath.set(audioPath,node);}
    if (node[format]) fail(`同じ音源パスの曲が重複しています: ${audioPath}`);
    node[format] = raw;
    if (format === 'pdb') {node.pdbId = raw.numericId;pTracks.set(raw.numericId,node);}
    else {node.oneLibraryId = raw.contentId;oTracks.set(raw.contentId,node);}
  };
  for (const raw of pdb?.existingTracks ?? []) add(raw,'pdb');
  for (const raw of one?.tracks ?? []) add(raw,'one');
  for (const [localId,binding] of Object.entries(state.tracks ?? {})) {
    const node = binding.audioPath && byPath.get(path(binding.audioPath));
    if (!node) continue;
    if (binding.pdbId && node.pdbId && binding.pdbId !== node.pdbId || binding.oneLibraryId && node.oneLibraryId && binding.oneLibraryId !== node.oneLibraryId) fail('USBの曲IDが変更されています。読み込み直してください。');
    if (node.localId && node.localId !== localId) fail('同じUSB曲へのローカル参照が重複しています。読み込み直してください。');
    node.localId = localId; node.id = localId; byLocal.set(localId,node);
  }
  for (const track of tracks) {
    let node = byLocal.get(track.id);
    if (!node) {node = {id:track.id,localId:track.id,isNew:true};nodes.push(node);byLocal.set(track.id,node);}
    node.localTrack = track;
  }
  for (const node of nodes) {
    if (!node.pdbId && !node.oneLibraryId) node.pdbId = node.oneLibraryId = ++trackId;
    else if (!node.pdbId) node.pdbId = ++trackId;
    else if (!node.oneLibraryId) node.oneLibraryId = one ? ++trackId : node.pdbId;
  }
  const lists = [], pLists = new Map(), oLists = new Map();
  const originalP = pdb?.playlistMappings ?? [], originalO = (one?.playlists ?? []).filter(list => [0,1].includes(list.attribute));
  function hierarchy(records, key, folder) {
    const byId = new Map(records.map(row=>[row[key],row])), paths = new Map();
    function visit(row,seen=new Set()) {
      if (paths.has(row[key])) return paths.get(row[key]);
      if (seen.has(row[key]) || seen.size >= 32) fail('USBのプレイリスト階層が不正です。');
      seen.add(row[key]);
      const parent = row.parentId ? byId.get(row.parentId) : null;
      if (row.parentId && (!parent || !folder(parent))) fail('USBの親プレイリストが見つかりません。');
      const names = [...(parent?visit(parent,seen):[]),row.name];paths.set(row[key],names);return names;
    }
    for (const row of records) visit(row);
    return paths;
  }
  const pp = hierarchy(originalP,'numericId',row=>row.isFolder), op = hierarchy(originalO,'playlistId',row=>row.attribute===1);
  for (const row of originalP) {
    const unit={pdb:row,pdbId:row.numericId,name:row.name,isFolder:row.isFolder,names:pp.get(row.numericId),members:[]};
    lists.push(unit);pLists.set(row.numericId,unit);
  }
  for (const unit of lists) unit.parent = unit.pdb.parentId ? pLists.get(unit.pdb.parentId) : null;
  const bindingByOne = new Map(Object.values(state.playlists ?? {}).filter(item=>item.oneLibraryId && item.pdbId).map(item=>[item.oneLibraryId,item.pdbId]));
  for (const row of [...originalO].sort((a,b)=>op.get(a.playlistId).length-op.get(b.playlistId).length)) {
    const names=op.get(row.playlistId), parent=row.parentId?oLists.get(row.parentId):null, folder=row.attribute===1;
    let unit = pLists.get(bindingByOne.get(row.playlistId));
    if (!unit) {
      const candidates=lists.filter(item=>item.pdb && !item.one && item.isFolder===folder && item.parent===parent && JSON.stringify(item.names)===JSON.stringify(names));
      const duplicates=originalO.filter(item=>item.attribute===row.attribute && JSON.stringify(op.get(item.playlistId))===JSON.stringify(names));
      if(candidates.length===1 && duplicates.length===1) unit=candidates[0];
    }
    if (unit?.one || unit && unit.isFolder!==folder) fail('USBのプレイリスト参照が競合しています。読み込み直してください。');
    if (!unit) {unit={name:row.name,isFolder:folder,names,parent,members:[]};lists.push(unit);}
    unit.one=row;unit.oneLibraryId=row.playlistId;oLists.set(row.playlistId,unit);
  }
  const memberNodes=(ids,map)=>ids.map(id=>{const node=map.get(id);if(!node)fail('USBのプレイリストに不明な曲があります。');return node;});
  for (const unit of lists) unit.members=[...new Set([...memberNodes(unit.pdb?.trackIds??[],pTracks),...memberNodes(unit.one?.trackIds??[],oTracks)])];
  for (const [localId,binding] of Object.entries(state.playlists ?? {})) {
    const unit=pLists.get(binding.pdbId)??oLists.get(binding.oneLibraryId);
    if(unit) unit.localId=localId;
  }
  for(const playlist of playlists) {
    let unit=lists.find(item=>item.localId===playlist.id);
    if(!unit) {
      let parent=null,names=[];
      for(const name of playlist.folderPath??[]) {
        names=[...names,name];
        const candidates=lists.filter(item=>item.isFolder && item.parent===parent && item.name===name);
        let folder=candidates.length===1?candidates[0]:null;
        if(!folder){folder={name,isFolder:true,names,parent,members:[]};lists.push(folder);}
        parent=folder;
      }
      unit={name:playlist.name,isFolder:false,names:[...names,playlist.name],parent,members:[],localId:playlist.id};lists.push(unit);
    }
    // A search selection can add a subset, but it never deletes an old member.
    unit.members=[...new Set([...unit.members,...playlist.trackIds.map(id=>byLocal.get(id)).filter(Boolean)])];
  }
  let playlistId=Math.max(pdb?.idFloors?.playlist||0,one?.maxIds?.playlist||0,max(lists.map(unit=>unit.pdbId||0)),max(lists.map(unit=>unit.oneLibraryId||0)));
  for(const unit of lists) {
    if(!unit.pdbId&&!unit.oneLibraryId)unit.pdbId=unit.oneLibraryId=++playlistId;
    else if(!unit.pdbId)unit.pdbId=pdb?++playlistId:unit.oneLibraryId;
    else if(!unit.oneLibraryId)unit.oneLibraryId=one?++playlistId:unit.pdbId;
  }
  const existingTrackIds=Object.fromEntries(nodes.filter(node=>node.pdb).map(node=>[node.id,node.pdbId]));
  const mirroredMembers=(unit,target)=>{
    const original=target==='pdb'?memberNodes(unit.one?.trackIds??[],oTracks):memberNodes(unit.pdb?.trackIds??[],pTracks);
    return [...original,...unit.members.filter(node=>!original.includes(node))];
  };
  const devicePlaylists=lists.filter(unit=>!unit.pdb).map(unit=>({numericId:unit.pdbId,parentId:unit.parent?.pdbId??0,
    sortOrder:unit.one?.sequenceNo??lists.indexOf(unit)+1,isFolder:unit.isFolder,name:unit.name,trackIds:mirroredMembers(unit,'pdb').map(node=>node.pdbId)}));
  const appendPlaylists=lists.filter(unit=>unit.pdb&&!unit.isFolder).map(unit=>({playlistId:unit.pdbId,
    trackIds:unit.members.filter(node=>!unit.pdb.trackIds.includes(node.pdbId)).map(node=>node.id)})).filter(item=>item.trackIds.length);
  const addPlaylists=lists.filter(unit=>!unit.one).map(unit=>({playlistId:unit.oneLibraryId,parentId:unit.parent?.oneLibraryId??0,
    sequenceNo:unit.pdb?.sortOrder??lists.indexOf(unit)+1,attribute:unit.isFolder?1:0,name:unit.name,trackIds:mirroredMembers(unit,'one').map(node=>node.oneLibraryId)}));
  const appendPlaylistTracks=lists.filter(unit=>unit.one&&!unit.isFolder).map(unit=>({playlistId:unit.oneLibraryId,
    trackIds:unit.members.filter(node=>!unit.one.trackIds.includes(node.oneLibraryId)).map(node=>node.oneLibraryId)})).filter(item=>item.trackIds.length);
  return {nodes,lists,existingTrackIds,devicePlaylists,appendPlaylists,addPlaylists,appendPlaylistTracks};
}
