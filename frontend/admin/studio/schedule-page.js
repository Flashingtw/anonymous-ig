import {apiRequest} from '../../assets/api.js';
import {adminAuth} from '../../assets/admin-auth.js';
import {mountInstagram} from './instagram.js';
import {navigateToResume} from './resume-batch.js';
const status=document.querySelector('#schedule-status');
let busy=false;
const say=text=>{status.textContent=text;};
async function run(action){
 if(busy)return;busy=true;say('處理中⋯');
 const controls=[...document.querySelectorAll('button,input')].map(el=>[el,el.disabled]);
 controls.forEach(([el])=>{el.disabled=true;});
 try{await action();}catch(error){say(error.status===401?'登入已過期，請返回投稿管理重新登入。':error.message??'操作失敗，請重試。');}
 finally{busy=false;controls.forEach(([el,disabled])=>{el.disabled=disabled;});}
}
const refresh=mountInstagram({run,say,onChange:async()=>{},onResume:navigateToResume});
await run(async()=>{
 const session=await apiRequest('/api/auth/me',{headers:adminAuth.requestHeaders()});adminAuth.setSession(session);
 const user=adminAuth.identity();document.querySelector('#schedule-identity').textContent=`${user?.accessEmail??user?.username??'管理員'} · ${user?.role??''}`;
 await refresh();say('');
});
