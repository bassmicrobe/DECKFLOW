import test from 'node:test';
import assert from 'node:assert/strict';
import {normalizeBeatGrid, beatSegment, beatPosition} from '../dist/beat-grid.js';

test('beat grids normalize unsorted imported anchors and preserve last duplicate',()=>{
 const grid=normalizeBeatGrid({tempos:[{start:10,bpm:100},{start:0,bpm:120},{start:10,bpm:90},{start:-1,bpm:999},{start:2,bpm:0}]});
 assert.deepEqual(grid,[{start:0,bpm:120},{start:10,bpm:90}]);
 assert.equal(beatSegment(grid,10).bpm,90);
 assert.equal(beatPosition(grid,9.8,'next'),10);
 assert.ok(Math.abs(beatPosition(grid,10.4,'next')-(10+2/3))<1e-9);
});

test('local quantize honors nonzero beat offsets and missing metadata stays immediate',()=>{
 const grid=normalizeBeatGrid({bpm:120,beatOffset:.13});
 assert.equal(beatPosition(grid,.25),.13);
 assert.equal(beatPosition(grid,.25,'next'),.63);
 assert.equal(beatPosition([],1.234),1.234);
});
