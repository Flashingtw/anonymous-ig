import test from 'node:test';
import assert from 'node:assert/strict';
import {defaultCaption,syncDefaultCaption} from '../frontend/admin/studio/caption.js';

test('caption uses Taiwan date/weekday and one line per final send number',()=>{
 assert.equal(defaultCaption([109,110,111],new Date('2026-09-11T16:01:00Z')),'🔒\n日期📆\n2026/09/12 - Saturday\n\n🔥匿名🔥\n#109\n#110\n#111\n\n⭐️規則說明在置頂！⭐️');
});
test('all weekdays use full English names; legacy captions retain their saved date text',()=>{
 for(const [index,day]of ['Sunday','Monday','Tuesday','Wednesday','Thursday','Friday','Saturday'].entries()){
  assert.ok(defaultCaption([109],new Date(Date.UTC(2026,8,13+index))).includes(` - ${day}\n`));
 }
 const legacy=defaultCaption([109],new Date('2026-09-12T00:00:00Z')).replace('Saturday','星期六');
 assert.equal(syncDefaultCaption(legacy,[110]),legacy.replace('#109','#110'));
});
test('default caption follows selection count and next number without changing its date',()=>{
 const original=defaultCaption([109,110],new Date('2026-09-11T00:00:00Z'));
 assert.equal(syncDefaultCaption(original,[111]),defaultCaption([111],new Date('2026-09-11T00:00:00Z')));
 const ten=Array.from({length:10},(_,i)=>120+i);assert.equal(syncDefaultCaption(original,ten).split('\n').filter(line=>line.startsWith('#')).length,10);
 assert.equal(syncDefaultCaption(original,[]).includes('#'),false);
});
test('customized or deliberately empty captions are not overwritten',()=>{
 for(const caption of ['', '我的說明\n#999', defaultCaption([109])+'\n自己的附註'])assert.equal(syncDefaultCaption(caption,[110,111]),caption);
});
