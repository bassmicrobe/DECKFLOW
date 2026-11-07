import test from 'node:test';
import assert from 'node:assert/strict';
import {LIBRARY_COLUMNS,normalizeLibraryColumns,libraryTrackDate,formatLibraryDate,libraryColumnText} from '../dist/library-columns.js';

test('default columns expose preparation metadata and both dates while keeping optional technical fields hidden',()=>{
  const visible=normalizeLibraryColumns(null);
  for(const id of ['title','artist','album','genre','bpm','key','duration','rating','dateAdded','dateModified'])assert.ok(visible.includes(id),id);
  for(const id of ['fileType','bitRate','sampleRate','comments','fileName'])assert.equal(visible.includes(id),false,id);
  assert.equal(new Set(LIBRARY_COLUMNS.map(column=>column.id)).size,LIBRARY_COLUMNS.length);
});
test('saved visibility rejects unknown fields and always preserves selection and transport controls',()=>{
  assert.deepEqual(normalizeLibraryColumns(['fileName','unknown','title','fileName']),['number','title','fileName','decks','actions']);
  assert.deepEqual(normalizeLibraryColumns([]),['number','title','decks','actions']);
});
test('imported addition dates win, latest local or source edit wins, and missing dates stay blank',()=>{
  const track={dateAdded:'2024-02-03',addedAt:Date.parse('2026-11-07T00:00:00Z'),dateModified:'2025-06-01T00:00:00Z',updatedAt:Date.parse('2026-11-07T00:00:00Z')};
  assert.equal(libraryTrackDate(track,'dateAdded'),'2024-02-03');
  assert.equal(libraryTrackDate(track,'dateModified'),track.updatedAt);
  assert.equal(libraryTrackDate({...track,dateModified:'2027-01-01'},'dateModified'),'2027-01-01');
  assert.equal(libraryTrackDate({addedAt:track.addedAt},'dateAdded'),track.addedAt);
  assert.equal(formatLibraryDate('2024-02-03'),'2024/02/03');
  for(const value of ['',null,undefined,NaN,'2025-02-29',Infinity])assert.equal(formatLibraryDate(value),'');
});
test('rich cells retain real numeric units, ratings, full filenames and absent metadata',()=>{
  const track={bpm:128.5,duration:3672,rating:4,bitRate:320,sampleRate:44100,filename:'日本語.wav'};
  assert.equal(libraryColumnText(track,'bpm'),'128.50');assert.equal(libraryColumnText(track,'duration'),'61:12');
  assert.equal(libraryColumnText(track,'rating'),'★★★★☆');assert.equal(libraryColumnText(track,'bitRate'),'320 kbps');
  assert.equal(libraryColumnText(track,'sampleRate'),'44.1 kHz');assert.equal(libraryColumnText(track,'fileType'),'WAV');assert.equal(libraryColumnText(track,'fileName'),'日本語.wav');
  assert.equal(libraryColumnText(track,'album'),'');assert.equal(libraryColumnText(track,'dateModified'),'');
});
