const numbersText=numbers=>numbers.map(number=>`#${number}`).join('\n');
const format=(date,numbers)=>`🔒\n日期📆\n${date}\n\n🔥匿名🔥\n${numbersText(numbers)}\n\n⭐️規則說明在置頂！⭐️`;

export function defaultCaption(numbers,now=new Date()){
 const parts=new Intl.DateTimeFormat('en-US',{timeZone:'Asia/Taipei',year:'numeric',month:'2-digit',day:'2-digit',weekday:'long'}).formatToParts(now);
 const value=type=>parts.find(part=>part.type===type).value;
 return format(`${value('year')}/${value('month')}/${value('day')} - ${value('weekday')}`,numbers);
}

// Only maintain an untouched generated template. Custom captions and their dates
// remain the team's text; prepared captions are never passed through this function.
export function syncDefaultCaption(caption,numbers){
 const match=/^🔒\n日期📆\n(\d{4}\/\d{2}\/\d{2} - (?:Sunday|Monday|Tuesday|Wednesday|Thursday|Friday|Saturday|星期[日一二三四五六]))\n\n🔥匿名🔥\n(?:#\d+(?:\n#\d+)*)?\n\n⭐️規則說明在置頂！⭐️$/.exec(caption);
 return match?format(match[1],numbers):caption;
}

// Preserve legacy notes around an exact generated block. Other captions become
// custom text; locked snapshots are never rewritten by the editor.
export function customCaption(caption){
 return editableCaption(caption).customText;
}
export function editableCaption(caption){
 const template=/🔒\n日期📆\n\d{4}\/\d{2}\/\d{2} - (?:Sunday|Monday|Tuesday|Wednesday|Thursday|Friday|Saturday|星期[日一二三四五六])\n\n🔥匿名🔥\n(?:#\d+(?:\n#\d+)*)?\n\n⭐️規則說明在置頂！⭐️/;
 const normalized=caption.replace(/\r\n/g,'\n');
 const matches=[...normalized.matchAll(new RegExp(template.source,'g'))];
 // An ambiguous/unknown format stays byte-for-byte intact for human review.
 if(matches.length!==1)return {customText:caption,recognized:false};
 return {customText:normalized.replace(template,'').trim(),recognized:true};
}
export function scheduledCaption(custom,numbers,publishAt){
 return (custom.trim()?custom.trim()+'\n\n':'')+defaultCaption(numbers,new Date(publishAt));
}
