export function localMinute(value){
 const date=new Date(value);if(!Number.isFinite(date.getTime()))return '';
 return new Date(date.getTime()-date.getTimezoneOffset()*60000).toISOString().slice(0,16);
}
export function suggestedTime(last,now=Date.now()){
 const previous=last?Date.parse(last):NaN;
 return localMinute(Math.max(Number.isFinite(previous)?previous+3600000:now,now));
}
export function shiftedTime(value,minutes,now=Date.now()){
 const date=Date.parse(value);return localMinute((Number.isFinite(date)?date:now)+minutes*60000);
}
export function mountScheduleTime(root,onChange){
 const value=root.querySelector('#publish-time'),date=root.querySelector('#publish-date'),hour=root.querySelector('#publish-hour'),minute=root.querySelector('#publish-minute');
 for(const [select,count]of [[hour,24],[minute,60]])for(let n=0;n<count;n++){const option=document.createElement('option');option.value=option.textContent=String(n).padStart(2,'0');select.append(option);}
 function render(text,locked=false){value.value=text;date.value=text.slice(0,10);hour.value=text.slice(11,13);minute.value=text.slice(14,16);for(const el of root.querySelectorAll('input,select,button'))el.disabled=locked;}
 function change(text){render(text);onChange(text);}
 for(const field of [date,hour,minute])field.addEventListener('change',()=>change(date.value?`${date.value}T${hour.value}:${minute.value}`:''));
 value.addEventListener('input',()=>change(value.value));
 for(const button of root.querySelectorAll('[data-time-shift]'))button.addEventListener('click',()=>change(button.dataset.timeShift==='now'?localMinute(Date.now()):shiftedTime(value.value,Number(button.dataset.timeShift))));
 return {set:render};
}
