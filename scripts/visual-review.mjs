// Local visual review only. Browser API fixtures never contact production.
// Install Playwright separately or pass PLAYWRIGHT_MODULE as an absolute module path.
import assert from "node:assert/strict";
import {createServer} from "node:http";
import {readFile,mkdir,writeFile} from "node:fs/promises";
import {resolve,extname,sep} from "node:path";
import {pathToFileURL} from "node:url";
const {chromium}=await import(process.env.PLAYWRIGHT_MODULE ? pathToFileURL(process.env.PLAYWRIGHT_MODULE).href : "playwright");
const root=resolve(import.meta.dirname,"../frontend");
const out=resolve(import.meta.dirname,"../tmp/phase-4.7-visual-review");
await mkdir(out,{recursive:true});
const mime={".html":"text/html; charset=utf-8",".js":"application/javascript",".css":"text/css",".json":"application/json"};
const server=createServer(async(req,res)=>{
  const pathname=new URL(req.url,"http://localhost").pathname;
  const file=resolve(root,"."+(pathname.endsWith("/")?pathname+"index.html":pathname));
  if(!file.startsWith(root+sep)){res.writeHead(403);res.end();return;}
  try {res.writeHead(200,{"Content-Type":mime[extname(file)]??"application/octet-stream"});res.end(await readFile(file));}
  catch {res.writeHead(404);res.end();}
});
await new Promise(r=>server.listen(0,"127.0.0.1",r));
const origin=`http://127.0.0.1:${server.address().port}`;
let browser;
try {
  browser=await chromium.launch({headless:true,...(process.env.VISUAL_BROWSER_CHANNEL?{channel:process.env.VISUAL_BROWSER_CHANNEL}:{})});
  const context=await browser.newContext({viewport:{width:1440,height:1050},deviceScaleFactor:1});
  const page=await context.newPage();
  const errors=[];page.on("pageerror",e=>errors.push(e.message));
  let signedIn=false,role="owner",submitMode="success",queue=[];
  const resetQueue=()=>{queue=[
    {id:127,status:"pending",createdAt:"2026-09-09T08:24:00Z",content:"想謝謝今天在實習課借我工具的同學。\n\n你可能覺得只是小事，但真的救了我一整個下午。下次換我幫你！"},
    {id:126,status:"pending",createdAt:"2026-09-09T07:12:00Z",content:"放學後的操場，是一天裡最喜歡的地方。\n風剛剛好，天空也是。\n\n希望忙著趕路的大家，偶爾也記得抬頭看看。"},
    {id:125,status:"pending",createdAt:"2026-09-08T09:30:00Z",content:"第一次上台報告，緊張到忘記下一句。謝謝台下那個跟我點頭的人。"}
  ];};resetQueue();
  await page.route("**/*",async route=>{
    const u=new URL(route.request().url());
    if(u.origin!==origin){await route.abort();return;}
    if(u.pathname==="/config.js"){await route.fulfill({contentType:"application/javascript",body:'window.APP_CONFIG={API_BASE_URL:"",ADMIN_AUTH_MODE:"github"};'});return;}
    if(!u.pathname.startsWith("/api/")){await route.continue();return;}
    const reply=(data,status=200)=>route.fulfill({status,contentType:"application/json",body:JSON.stringify(status<400?{ok:true,data}:{ok:false,error:{code:"FIXTURE_ERROR",message:"測試錯誤：請稍後重試。"}})});
    if(u.pathname==="/api/auth/providers")return reply({providers:{github:true,access:true,local:false,dev:false}});
    if(u.pathname==="/api/auth/me")return reply({user:{adminId:1,username:null,githubUsername:role==="owner"?"demo.owner":null,accessEmail:`${role}@example.com`,role,authMethods:["access"]},csrfToken:"local-visual-fixture-not-a-real-token"},signedIn?200:401);
    if(u.pathname==="/api/auth/logout"){signedIn=false;return reply({});}
    if(u.pathname==="/api/submissions"){
      await new Promise(r=>setTimeout(r,400));
      return reply({submission:{id:128,status:"pending",createdAt:"2026-09-09T09:00:00Z"}},submitMode==="success"?201:503);
    }
    if(u.pathname==="/api/admin/admins")return reply({admins:[{id:1,identity:"demo.owner",email:"owner@example.com",role:"owner",enabled:true,providers:["github","access"]},{id:2,identity:"moderator@example.com",email:"moderator@example.com",role:"moderator",enabled:true,providers:["access"]}]},role==="owner"?200:403);
    if(u.pathname==="/api/admin/submissions")return reply({submissions:queue});
    const match=u.pathname.match(/\/submissions\/(\d+)\/(approve|reject)$/);
    if(match){assert.ok(route.request().headers()["x-csrf-token"]);queue=queue.filter(s=>s.id!==Number(match[1]));return reply({});}
    return reply({},404);
  });
  const shot=async name=>{
    assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth>innerWidth),false,`${name} overflows`);
    await page.screenshot({path:resolve(out,name+".png"),fullPage:true});
  };
  await page.goto(origin);await page.getByRole("heading",{name:"發送匿名",exact:true}).waitFor();
  await shot("public-desktop");
  await page.locator("#content").fill("這是一則本機測試，不會送往正式站。");
  await page.locator("#submit-button").click();
  await page.locator("#submit-button:disabled").waitFor();
  await page.locator(".notice--success").waitFor();
  submitMode="error";await page.locator("#content").fill("本機錯誤狀態測試。");await page.locator("#submit-button").click();await page.locator(".notice--error").waitFor();
  await page.goto(origin+"/admin/");await page.locator("#access-auth-panel:not([hidden])").waitFor();
  assert.equal(await page.locator("#local-auth-form").isVisible(),false);
  await shot("admin-login-desktop");
  signedIn=true;await page.reload();await page.locator(".submission-card").first().waitFor();
  await shot("admin-dashboard-desktop");
  await page.locator("#team-tab").click();await page.locator(".team-member").first().waitFor();await shot("admin-team-desktop");
  await page.locator("#queue-tab").click();
  await page.locator('[data-action="approve"]').first().click();await page.waitForFunction(()=>document.querySelectorAll('.submission-card').length===2);
  await page.locator('[data-action="reject"]').first().click();await page.getByRole('button',{name:'確定拒絕',exact:true}).click();await page.waitForFunction(()=>document.querySelectorAll('.submission-card').length===1);
  resetQueue();await page.setViewportSize({width:390,height:844});await page.reload();await page.locator(".submission-card").first().waitFor();await shot("admin-dashboard-mobile");
  role="moderator";await page.reload();await page.locator(".submission-card").first().waitFor();assert.equal(await page.locator("#team-tab").isVisible(),false);assert.match(await page.locator("#admin-username").textContent(),/moderator@example.com/);
  await page.locator("#clear-auth-button").click();await page.locator("#auth-panel:not([hidden])").waitFor();await shot("admin-login-mobile");
  await page.goto(origin);await page.getByRole("heading",{name:"發送匿名",exact:true}).waitFor();await shot("public-mobile");
  for(const width of [320,768,1024]) {
    await page.setViewportSize({width,height:900});
    assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth>innerWidth),false,`public width ${width}`);
    signedIn=true;await page.goto(origin+'/admin/');await page.locator('.submission-card').first().waitFor();
    assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth>innerWidth),false,`admin width ${width}`);
    await page.goto(origin);await page.getByRole('heading',{name:'發送匿名',exact:true}).waitFor();
  }
  assert.deepEqual(errors,[]);
  const report={result:"PASS",fixtureOnly:true,productionRequests:0,checks:["desktop/mobile no horizontal overflow","providers and password hidden","public loading/success/error","owner directory","moderator directory hidden","Email-only display","approve/reject CSRF header retained","logout"],screenshots:7};
  await writeFile(resolve(out,"report.json"),JSON.stringify(report,null,2)+"\n");
  console.log(JSON.stringify(report));
} finally {await browser?.close();await new Promise(r=>server.close(r));}
