import test from 'node:test';
import assert from 'node:assert/strict';
import {snapPosition} from '../frontend/admin/studio/alignment.js';
test('snap both axes to canvas center within threshold',()=>{
 assert.deepEqual(snapPosition({x:537,y:680},{x:400,y:319},8),{position:{x:540,y:675},guides:{x:540,y:675}});
});
test('snap to other text center; outside threshold remains free',()=>{
 assert.deepEqual(snapPosition({x:401,y:315},{x:400,y:319},8),{position:{x:400,y:319},guides:{x:400,y:319}});
 assert.deepEqual(snapPosition({x:450,y:500},{x:400,y:319},8),{position:{x:450,y:500},guides:{}});
});
test('Alt bypasses snapping and does not mutate positions',()=>{
 const p={x:537,y:680};assert.deepEqual(snapPosition(p,{x:400,y:319},8,{disabled:true}),{position:p,guides:{}});assert.equal(p.x,537);
});
