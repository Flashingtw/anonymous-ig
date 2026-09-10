import assert from 'node:assert/strict';
import {createServer} from 'node:http';
import {readFile,mkdir,writeFile} from 'node:fs/promises';
import {resolve,extname,sep} from 'node:path';
import {pathToFileURL} from 'node:url';
import {createTestDatabase} from '../test/helpers/d1.js';
import {handleApiRequest} from '../worker/src/index.js';
const serve=process.argv.includes('--serve');
const root=resolve(import.meta.dirname,'..'),frontend=resolve(root,'frontend'),output=resolve(root,'tmp/studio-visual-review');
await mkdir(output,{recursive:true});
const db=createTestDatabase({images:true}),objects=new Map(),localToken=crypto.randomUUID();
db.raw.exec("INSERT INTO admins(id,github_user_id,github_username,role,access_email) VALUES(1,'123','test-owner','owner','owner@example.test'); INSERT INTO submissions(id,content,status) VALUES(1,'今天也要記得，留一點時間給自己。','approved'),(2,'不知道該怎麼說，但還是想謝謝一直陪著我的你。','approved');");
const env={DB:db.DB,APP_ENV:'development',IMAGE_STUDIO_ENABLED:'true',ADMIN_AUTH_PROVIDER:'dev',DEV_ADMIN_MODE:'true',DEV_ADMIN_TOKEN:localToken,STUDIO_IMAGES:{async put(k,v){objects.set(k,v);},async get(k){return objects.has(k)?{body:objects.get(k)}:null;}}};
const server=createServer(async(req,res)=>{
 try{
  const url=new URL(req.url,'http://127.0.0.1');
  if(url.pathname.startsWith('/api/')){
   const chunks=[];for await(const chunk of req)chunks.push(chunk);
   const r=await handleApiRequest(new Request(`http://127.0.0.1:${server.address().port}${req.url}`,{method:req.method,headers:req.headers,...(!['GET','HEAD'].includes(req.method)?{body:Buffer.concat(chunks)}:{})}),env);
   res.writeHead(r.status,Object.fromEntries(r.headers));res.end(Buffer.from(await r.arrayBuffer()));return;
  }
  if(url.pathname==='/config.js'){res.setHeader('Content-Type','text/javascript');res.end('window.APP_CONFIG={API_BASE_URL:"",ADMIN_AUTH_MODE:"dev"};'+(serve?`sessionStorage.setItem('anonymous-submissions.dev-admin-token',${JSON.stringify(localToken)});`:''));return;}
  const path=resolve(frontend,'.'+decodeURIComponent(url.pathname)+(url.pathname.endsWith('/')?'index.html':''));
  if(!path.startsWith(frontend+sep)){res.writeHead(404);res.end();return;}
  const type={'.html':'text/html; charset=utf-8','.js':'text/javascript','.css':'text/css','.json':'application/json','.png':'image/png','.woff2':'font/woff2','.ttf':'font/ttf'}[extname(path)];
  res.setHeader('Content-Type',type??'application/octet-stream');res.end(await readFile(path));
 }catch{res.writeHead(500);res.end('Local fixture error');}
});
await new Promise(r=>server.listen(0,'127.0.0.1',r));const origin=`http://127.0.0.1:${server.address().port}`;
if(serve){
 console.log(`Isolated ephemeral preview: ${origin}/admin/studio/ (Ctrl+C to stop; data resets on restart; no production calls)`);
 await new Promise(resolve=>process.once('SIGINT',resolve));await new Promise(r=>server.close(r));db.close();process.exit(0);
}
const {chromium}=await import(pathToFileURL(process.env.PLAYWRIGHT_MODULE).href);
const browser=await chromium.launch({channel:process.env.VISUAL_BROWSER_CHANNEL??'msedge',headless:true});
const context=await browser.newContext({viewport:{width:1440,height:1050},acceptDownloads:true});
await context.addInitScript(token=>sessionStorage.setItem('anonymous-submissions.dev-admin-token',token),localToken);
const page=await context.newPage(),errors=[];page.on('pageerror',e=>errors.push(e.message));
await page.route('**/*',route=>new URL(route.request().url()).origin===origin?route.continue():route.abort());
const idle=()=>page.waitForFunction(()=>!document.querySelector('#reload').disabled);
const checks=[];
try{
 await page.goto(origin+'/admin/studio/');await idle();
 await page.route('**/CanvaBeautifulTC-Regular.woff2',route=>route.abort());
 await page.getByRole('button',{name:'建立圖片草稿'}).first().click();await idle();
 assert.equal(await page.locator('#ready-image').isDisabled(),true);assert.equal(await page.locator('#retry-assets').isVisible(),true);
 await page.unroute('**/CanvaBeautifulTC-Regular.woff2');await page.locator('#retry-assets').click();await idle();await page.locator('#auto-layout').click();
 checks.push('font load failure blocks export; explicit retry recovers without fallback');
 await page.waitForFunction(()=>document.querySelector('#image-canvas').getBoundingClientRect().width>0&&document.querySelector('#font-size').value);
 assert.equal(await page.locator('#image-error').innerText(),'');
 assert.equal(await page.locator('#pos-x').inputValue(),'540');assert.equal(await page.locator('#pos-y').inputValue(),'675');
 const rect=await page.locator('#image-canvas').boundingBox();
 await page.mouse.move(rect.x+rect.width/2,rect.y+rect.height*675/1350);await page.mouse.down();await page.mouse.move(rect.x+rect.width/2+12,rect.y+rect.height*675/1350+12);await page.mouse.up();
 assert.notEqual(await page.locator('#pos-x').inputValue(),'540');await page.locator('#auto-layout').click();
 await page.screenshot({path:resolve(output,'editor-desktop.png'),fullPage:true});
 await page.locator('#image-number').fill('110');await page.locator('#auto-layout').click();
 assert.equal(await page.locator('#image-number').inputValue(),'110');
 const textarea=page.locator('#image-text');await textarea.fill('這是編輯後的文字。\n謝謝你願意停下來，看見這些話。');
 await page.locator('#font-size').fill('64');await page.locator('#image-canvas').focus();await page.keyboard.press('ArrowRight');
 assert.equal(await page.locator('#pos-x').inputValue(),'541');
 const bodyY=await page.locator('#pos-y').inputValue();
 await page.locator('#center-text').focus();await page.keyboard.press('Enter');
 assert.equal(await page.locator('#pos-x').inputValue(),'540');assert.equal(await page.locator('#pos-y').inputValue(),bodyY);assert.equal(await page.locator('#font-size').inputValue(),'64');
 await page.locator('#selected-box').selectOption('number');const numberY=await page.locator('#pos-y').inputValue();
 await page.locator('#center-text').click();assert.equal(await page.locator('#pos-x').inputValue(),'540');assert.equal(await page.locator('#pos-y').inputValue(),numberY);assert.equal(numberY,'385');assert.equal(await page.locator('#font-size').inputValue(),'40');
 await page.locator('#selected-box').selectOption('body');
 checks.push('horizontal centering works for both text boxes and keyboard; preserves Y and font size');
 await page.getByRole('button',{name:'保存草稿',exact:true}).click();await idle();
 assert.equal(await page.locator('#editor').isVisible(),false);assert.equal(await page.locator('[data-tab="draft"]').getAttribute('aria-pressed'),'true');
 await page.getByRole('button',{name:'編輯圖片',exact:true}).click();await idle();
 assert.equal(await page.locator('#image-number').inputValue(),'110');
 await page.getByRole('button',{name:'加入待發送',exact:true}).click();await idle();
 assert.match(await page.locator('#studio-status').innerText(),/已加入待發送/);
 assert.equal(await page.locator('#editor').isVisible(),false);assert.equal(await page.locator('[data-tab="draft"]').getAttribute('aria-pressed'),'true');
 checks.push('save and ready success return to image drafts; internal save does not interrupt upload');
 checks.push('real browser fonts/canvas, editing, keyboard movement, save and PNG upload to private fixture storage');
 await page.getByRole('button',{name:'待發送',exact:true}).click();await idle();
 await page.getByRole('button',{name:'圖片草稿',exact:true}).click();await idle();
 await page.getByRole('button',{name:'建立圖片草稿'}).click();await idle();
 await page.getByRole('button',{name:'加入待發送',exact:true}).click();await idle();assert.equal(await page.locator('#editor').isVisible(),false);
 await page.getByRole('button',{name:'待發送',exact:true}).click();await idle();
 await page.locator('.studio-card img').first().waitFor();await page.waitForFunction(()=>[...document.querySelectorAll('.studio-card img')].every(i=>i.complete&&i.naturalWidth===1080));
 await page.screenshot({path:resolve(output,'ready-desktop.png'),fullPage:true});
 await page.setViewportSize({width:390,height:844});await page.screenshot({path:resolve(output,'ready-mobile.png'),fullPage:true});
 assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth>innerWidth),false);await page.setViewportSize({width:1440,height:1050});
 for(const checkbox of await page.getByRole('checkbox').all())await checkbox.check();await page.locator('#compose').click();await idle();
 await page.getByRole('button',{name:'往後',exact:true}).first().click();await idle();
 await page.locator('#caption').fill('今晚，留一句話給自己。');await page.getByRole('button',{name:'保存發送草稿',exact:true}).click();await idle();
 await page.screenshot({path:resolve(output,'dispatch-desktop.png'),fullPage:true});
 await page.setViewportSize({width:390,height:844});await page.screenshot({path:resolve(output,'dispatch-mobile.png'),fullPage:true});
 assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth>innerWidth),false);await page.setViewportSize({width:1440,height:1050});
 const downloadPromise=page.waitForEvent('download');await page.getByRole('button',{name:'下載整組 ZIP'}).click();const download=await downloadPromise;await idle();
 await download.saveAs(resolve(output,'dispatch.zip'));assert.equal(await download.failure(),null);
 const archive=await readFile(resolve(output,'dispatch.zip'));let offset=0;const entries=[];
 while(archive.readUInt32LE(offset)===0x04034b50){const size=archive.readUInt32LE(offset+18),n=archive.readUInt16LE(offset+26),extra=archive.readUInt16LE(offset+28),start=offset+30+n+extra;entries.push({name:archive.subarray(offset+30,offset+30+n).toString(),data:archive.subarray(start,start+size)});offset=start+size;}
 assert.deepEqual(entries.map(e=>e.name),['01-submission-2.png','02-submission-1.png','caption.txt']);
 assert.equal(entries[2].data.toString(),'今晚，留一句話給自己。');assert.equal(entries[0].data.readUInt32BE(16),1080);assert.equal(entries[0].data.readUInt32BE(20),1350);
 checks.push('ready selection, ordered immutable dispatch save, ZIP download');
 await page.locator('#close-dispatch').click();await page.getByRole('button',{name:'發送草稿',exact:true}).click();await idle();
 await page.getByRole('button',{name:'開啟發送草稿'}).click();await idle();assert.equal(await page.locator('#caption').inputValue(),'今晚，留一句話給自己。');
 checks.push('dispatch reopening preserves caption and version');
 await page.locator('#close-dispatch').click();await page.getByRole('button',{name:'待發送',exact:true}).click();await idle();await page.getByRole('button',{name:'編輯圖片'}).first().click();await idle();
 await page.setViewportSize({width:390,height:844});await page.screenshot({path:resolve(output,'editor-mobile.png'),fullPage:true});
 assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth>innerWidth),false);
 await page.locator('#pos-y').fill('1300');assert.equal(await page.getByRole('button',{name:'加入待發送',exact:true}).isDisabled(),true);
 await page.locator('#auto-layout').click();assert.equal(await page.locator('#image-error').innerText(),'');
 await textarea.fill('字'.repeat(1001));assert.equal(await page.getByRole('button',{name:'加入待發送',exact:true}).isDisabled(),true);
 await textarea.fill('觸控與衝突測試');await page.locator('#auto-layout').click();
 await page.locator('#image-canvas').scrollIntoViewIfNeeded();const mobileRect=await page.locator('#image-canvas').boundingBox(),cdp=await context.newCDPSession(page);
 const touch={x:mobileRect.x+mobileRect.width/2,y:mobileRect.y+mobileRect.height*675/1350};
 await cdp.send('Input.dispatchTouchEvent',{type:'touchStart',touchPoints:[touch]});await cdp.send('Input.dispatchTouchEvent',{type:'touchMove',touchPoints:[{x:touch.x+10,y:touch.y+10}]});await cdp.send('Input.dispatchTouchEvent',{type:'touchEnd',touchPoints:[]});
 assert.notEqual(await page.locator('#pos-x').inputValue(),'540');await cdp.detach();
 db.raw.exec('UPDATE image_drafts SET revision=revision+1 WHERE id=1');await page.locator('#save-image').click();await idle();
 assert.match(await page.locator('#studio-status').innerText(),/重新載入/);assert.equal(await textarea.inputValue(),'觸控與衝突測試');
 page.once('dialog',dialog=>dialog.dismiss());await page.locator('#close-editor').click();assert.equal(await page.locator('#editor').isVisible(),true);
 checks.push('mouse and real touch drag; revision conflict retains edits; unsaved leave warning');
 checks.push('mobile no overflow, out-of-paper warning, reset, over-limit export blocked');
 assert.deepEqual(errors,[]);
 assert.equal(db.raw.prepare("SELECT content FROM submissions WHERE id=2").get().content,'不知道該怎麼說，但還是想謝謝一直陪著我的你。');
 await writeFile(resolve(output,'report.json'),JSON.stringify({result:'PASS',checks,productionRequests:0,screenshots:6},null,2));console.log(JSON.stringify({result:'PASS',checks,productionRequests:0,screenshots:6}));
}finally{await browser.close();await new Promise(r=>server.close(r));db.close();}
