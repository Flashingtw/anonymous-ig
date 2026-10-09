const key='anonymous-submissions.studio-resume';

export function navigateToResume(id){
 sessionStorage.setItem(key,JSON.stringify({id,createdAt:Date.now()}));
 location.assign('/admin/studio/?batch='+encodeURIComponent(id));
}

export function consumeResume(id){
 const raw=sessionStorage.getItem(key);sessionStorage.removeItem(key);
 if(!raw)return false;
 try{
  const intent=JSON.parse(raw),age=Date.now()-intent.createdAt;
  return Boolean(id&&intent.id===id&&Number.isFinite(age)&&age>=0&&age<=120000);
 }catch{return false;}
}
