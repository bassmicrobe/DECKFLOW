/** Synthetic SQLite/SQLCipher fixtures; contains no music or user metadata. */
import {pbkdf2Sync,createCipheriv,createHmac} from 'node:crypto';
import {MASTER_KEY,DEFAULT_KEY} from '../../dist/vendor/onelibrary/sqlcipher.js';
const PAGE=4096,RESERVE=80;
function varint(n) {const result=[n&127];while(n>127){n=Math.floor(n/128);result.unshift((n&127)|128);}return Buffer.from(result);}
function record(values) {
  const types=[],valuesBytes=[];
  for(const value of values) {
    if(value==null){types.push(0);continue;}
    if(typeof value==='number'){const b=Buffer.alloc(4);b.writeInt32BE(value);types.push(4);valuesBytes.push(b);continue;}
    const b=Buffer.from(value);types.push(13+b.length*2);valuesBytes.push(b);
  }
  const ts=Buffer.concat(types.map(varint));let size=ts.length+1;
  while(varint(size).length+ts.length!==size)size=varint(size).length+ts.length;
  return Buffer.concat([varint(size),ts,...valuesBytes]);
}
function page(rows,{first=false}={}) {
  const out=Buffer.alloc(PAGE),base=first?100:0;
  out[base]=13;out.writeUInt16BE(rows.length,base+3);let end=PAGE-RESERVE;
  rows.forEach((values,i)=>{const payload=record(values),cell=Buffer.concat([varint(payload.length),varint(i+1),payload]);end-=cell.length;out.set(cell,end);out.writeUInt16BE(end,base+8+i*2);});
  if(end<base+8+rows.length*2)throw new Error('synthetic fixture too large');
  out.writeUInt16BE(end,base+5);return out;
}
export function image(tables) {
  const schema=tables.map((t,i)=>['table',t.name,t.name,i+2,`CREATE TABLE ${t.name} (${t.columns.map(c=>`${c} ${c==='ID'?'TEXT':'ANY'}`).join(', ')})`]);
  const out=Buffer.concat([page(schema,{first:true}),...tables.map(t=>page(t.rows))]);
  out.set(Buffer.from('SQLite format 3\0'));out.writeUInt16BE(PAGE,16);out[18]=out[19]=1;out[20]=RESERVE;out[21]=64;out[22]=out[23]=32;
  out.writeUInt32BE(1,24);out.writeUInt32BE(tables.length+1,28);out.writeUInt32BE(1,40);out.writeUInt32BE(4,44);out.writeUInt32BE(1,56);out.writeUInt32BE(1,92);out.writeUInt32BE(3040000,96);
  return new Uint8Array(out);
}
export function masterTables() {return [
  {name:'djmdContent',columns:['ID','Title','ArtistID','Length','BPM','FolderPath','FileSize','AnalysisDataPath'],rows:[['42','Synthetic 120','7',180,12000,'/Music/Synthetic 120.wav',12345,'/share/PIONEER/USBANLZ/P001/00000001/ANLZ0000.DAT']]},
  {name:'djmdArtist',columns:['ID','Name'],rows:[['7','DECKFLOW Test']]},
  {name:'djmdPlaylist',columns:['ID','Name','Attribute','ParentID','Seq'],rows:[['10','Weekend',1,'root',1],['11','Warmup',0,'10',1]]},
  {name:'djmdSongPlaylist',columns:['ID','PlaylistID','ContentID','TrackNo'],rows:[['20','11','42',1]]},
  {name:'djmdCue',columns:['ID','ContentID','Kind','InMsec'],rows:[['30','42',0,1000]]},
];}
export function deviceTables() {return [
  {name:'content',columns:['content_id','title','artist_id_artist','length','bpmx100','path','fileSize','analysisDataFilePath'],rows:[[42,'Synthetic 120',7,180,12000,'/Contents/Synthetic 120.wav',12345,'/PIONEER/USBANLZ/P001/00000001/ANLZ0000.DAT']]},
  {name:'artist',columns:['artist_id','name'],rows:[[7,'DECKFLOW Test']]},
  {name:'playlist',columns:['playlist_id','name','attribute','playlist_id_parent','sequenceNo'],rows:[[10,'Weekend',1,0,1],[11,'Warmup',0,10,1]]},
  {name:'playlist_content',columns:['playlist_id','content_id','sequenceNo'],rows:[[11,42,1]]},
];}
export function encryptFixture(plain,key=MASTER_KEY) {
  const salt=Buffer.from('00112233445566778899aabbccddeeff','hex');
  const aes=pbkdf2Sync(key,salt,256000,32,'sha512');
  const mac=pbkdf2Sync(aes,Buffer.from(salt.map(x=>x^0x3a)),2,32,'sha512');
  const out=Buffer.alloc(plain.length);out.set(salt);
  for(let i=0;i<plain.length/PAGE;i++) {
    const start=i*PAGE,body=start+(i===0?16:0),end=start+PAGE-RESERVE;
    const iv=Buffer.alloc(16,i+1),cipher=createCipheriv('aes-256-cbc',aes,iv);cipher.setAutoPadding(false);
    const ct=Buffer.concat([cipher.update(plain.subarray(body,end)),cipher.final()]);
    const pageNumber=Buffer.alloc(4);pageNumber.writeUInt32LE(i+1);
    const hmac=createHmac('sha512',mac).update(ct).update(iv).update(pageNumber).digest();
    out.set(ct,body);out.set(iv,end);out.set(hmac,end+16);
  }
  return new Uint8Array(out);
}
export {MASTER_KEY,DEFAULT_KEY};
