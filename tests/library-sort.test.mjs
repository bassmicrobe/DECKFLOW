import test from 'node:test';
import assert from 'node:assert/strict';
import {sortLibraryTracks} from '../dist/library-sort.js';

const ids = tracks => tracks.map(track => track.id);

test('titles use numeric Japanese collation and stable case-insensitive ties', () => {
  const tracks = [
    {id: 'ten', title: 'Track 10'}, {id: 'two', title: 'Track 2'},
    {id: 'two-lower', title: 'track 2'}, {id: 'jp-ten', title: '曲10'}, {id: 'jp-two', title: '曲2'},
  ];
  const before = [...tracks];
  assert.deepEqual(ids(sortLibraryTracks(tracks, {field: 'title'})), ['two','two-lower','ten','jp-two','jp-ten']);
  assert.deepEqual(ids(sortLibraryTracks(tracks, {field: 'title', direction: 'descending'})), ['jp-ten','jp-two','ten','two','two-lower']);
  assert.deepEqual(tracks, before);
});

test('artist ordering is independent of track titles and keeps missing artists last', () => {
  const tracks = [
    {id: 'z', artist: 'Zebra', title: 'A'}, {id: 'empty', artist: '  '},
    {id: 'a', artist: 'Artist 2', title: 'Z'}, {id: 'a10', artist: 'Artist 10'}, {id: 'missing'},
  ];
  assert.deepEqual(ids(sortLibraryTracks(tracks, {field: 'artist'})), ['a','a10','z','empty','missing']);
  assert.deepEqual(ids(sortLibraryTracks(tracks, {field: 'artist', direction: 'descending'})), ['z','a10','a','empty','missing']);
});

test('BPM sorting keeps absent and invalid values last and equal values stable', () => {
  const tracks = [
    {id: 'null', bpm: null}, {id: 'slow', bpm: 90}, {id: 'fast-a', bpm: 128},
    {id: 'zero', bpm: 0}, {id: 'fast-b', bpm: 128}, {id: 'nan', bpm: NaN},
  ];
  assert.deepEqual(ids(sortLibraryTracks(tracks, {field: 'bpm'})), ['slow','fast-a','fast-b','null','zero','nan']);
  assert.deepEqual(ids(sortLibraryTracks(tracks, {field: 'bpm', direction: 'descending'})), ['fast-a','fast-b','slow','null','zero','nan']);
});

test('duration uses numeric seconds rather than displayed minute strings', () => {
  const tracks = [{id:'long',duration:600},{id:'short',duration:59},{id:'minute',duration:60},{id:'unknown',duration:0}];
  assert.deepEqual(ids(sortLibraryTracks(tracks, {field:'duration'})), ['short','minute','long','unknown']);
  assert.deepEqual(ids(sortLibraryTracks(tracks, {field:'duration',direction:'descending'})), ['long','minute','short','unknown']);
});

test('added order preserves a playlist sequence, including its zero index', () => {
  const tracks = [{id:'a',addedAt:30},{id:'b',addedAt:10},{id:'c',addedAt:20}];
  const playlistOrder = new Map([['c',0],['a',1],['b',2]]);
  assert.deepEqual(ids(sortLibraryTracks(tracks)), ['b','c','a']);
  assert.deepEqual(ids(sortLibraryTracks(tracks, {field:'added',direction:'descending'})), ['a','c','b']);
  assert.deepEqual(ids(sortLibraryTracks(tracks, {playlistOrder})), ['c','a','b']);
  assert.deepEqual(ids(sortLibraryTracks(tracks, {playlistOrder,direction:'descending'})), ['b','a','c']);
  assert.deepEqual(ids(sortLibraryTracks([{id:'zero',addedAt:0},{id:'later',addedAt:1}])), ['zero','later']);
});
