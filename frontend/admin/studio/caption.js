const numbersText=numbers=>numbers.map(number=>`#${number}`).join('\n');
const format=(date,numbers)=>`🔒\n日期📆\n${date}\n\n🔥匿名🔥\n${numbersText(numbers)}\n\n⭐️規則說明在置頂！⭐️`;

export function defaultCaption(numbers,now=new Date()){
 const parts=new Intl.DateTimeFormat('en-US',{timeZone:'Asia/Taipei',year:'numeric',month:'2-digit',day:'2-digit',weekday:'short'}).formatToParts(now);
 const value=type=>parts.find(part=>part.type===type).value;
 const weekdays={Sun:'日',Mon:'一',Tue:'二',Wed:'三',Thu:'四',Fri:'五',Sat:'六'};
 return format(`${value('year')}/${value('month')}/${value('day')} - 星期${weekdays[value('weekday')]}`,numbers);
}

// Only maintain an untouched generated template. Custom captions and their dates
// remain the team's text; prepared captions are never passed through this function.
export function syncDefaultCaption(caption,numbers){
 const match=/^🔒\n日期📆\n(\d{4}\/\d{2}\/\d{2} - 星期[日一二三四五六])\n\n🔥匿名🔥\n(?:#\d+(?:\n#\d+)*)?\n\n⭐️規則說明在置頂！⭐️$/.exec(caption);
 return match?format(match[1],numbers):caption;
}
