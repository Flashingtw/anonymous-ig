import test from 'node:test';
import assert from 'node:assert/strict';
import {localMinute,suggestedTime,shiftedTime} from '../frontend/admin/studio/schedule-time.js';
test('schedule suggestion continues last successful time by one hour, including midnight',()=>{
 const now=Date.parse('2030-01-01T12:00:00Z');
 assert.equal(suggestedTime('2030-01-01T23:30:00Z',now),localMinute('2030-01-02T00:30:00Z'));
 for(const value of [null,'invalid','2020-01-01T00:00:00Z'])assert.equal(suggestedTime(value,now),localMinute(now));
});
test('quick time controls preserve date rollover and recover empty inputs',()=>{
 assert.equal(shiftedTime('2030-01-01T23:45',30),'2030-01-02T00:15');
 assert.equal(shiftedTime('2030-01-01T23:45',60),'2030-01-02T00:45');
 assert.equal(shiftedTime('',60,0),localMinute(3600000));
});
