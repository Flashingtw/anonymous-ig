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
  let signedIn=false,role="owner",submitMode="success",queueMode="success",moderationMode="success",queue=[];
  let submissionRequests=0,moderationRequests=0;
  let longIdentity=false;
  let providers={github:true,access:true,local:false,dev:false};
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
    if(u.pathname==="/api/auth/providers")return reply({providers});
    if(u.pathname==="/api/auth/me")return reply({user:{adminId:1,username:null,githubUsername:role==="owner"&&!longIdentity?"demo.owner":null,accessEmail:longIdentity?`${"long-name".repeat(16)}@example.com`:`${role}@example.com`,role,authMethods:["access"]},csrfToken:"local-visual-fixture-not-a-real-token"},signedIn?200:401);
    if(u.pathname==="/api/auth/logout"){signedIn=false;return reply({});}
    if(u.pathname==="/api/submissions"){
      submissionRequests++;
      await new Promise(r=>setTimeout(r,400));
      return reply({submission:{id:128,status:"pending",createdAt:"2026-09-09T09:00:00Z"}},submitMode==="success"?201:503);
    }
    if(u.pathname==="/api/admin/admins")return reply({admins:[{id:1,identity:"demo.owner",email:"owner@example.com",role:"owner",enabled:true,providers:["github","access"]},{id:2,identity:"moderator@example.com",email:"moderator@example.com",role:"moderator",enabled:true,providers:["access"]}]},role==="owner"?200:403);
    if(u.pathname==="/api/admin/submissions"){
      await new Promise(r=>setTimeout(r,250));
      return reply({submissions:queue},queueMode==="error"?500:200);
    }
    const match=u.pathname.match(/\/submissions\/(\d+)\/(approve|reject)$/);
    if(match){
      moderationRequests++;
      assert.ok(route.request().headers()["x-csrf-token"]);
      await new Promise(r=>setTimeout(r,350));
      if(moderationMode==="error")return reply({},500);
      queue=queue.filter(s=>s.id!==Number(match[1]));return reply({});
    }
    return reply({},404);
  });
  const shot=async name=>{
    assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth>innerWidth),false,`${name} overflows`);
    await page.screenshot({path:resolve(out,name+".png"),fullPage:true});
  };
  await page.goto(origin);await page.locator("#form-title").waitFor();
  assert.equal(await page.locator("#form-title").textContent(),"匿名投稿");
  assert.equal(await page.getByText("大安匿名", { exact: true }).isVisible(), true);
  assert.equal(await page.getByText("DAAN ANONYMOUS", { exact: true }).isVisible(), true);
  assert.equal(await page.locator("#character-count").textContent(), "0 / 100");
  for (const [value, count] of [["你好", 2], ["👨‍👩‍👧‍👦e\u0301🇹🇼👍🏽", 4], ["👨‍👩‍👧‍👦".repeat(100), 100], ["e\u0301".repeat(100), 100], ["字".repeat(99), 99], ["字".repeat(100), 100]]) {
    await page.locator("#content").fill(value);
    assert.equal(await page.locator("#character-count").textContent(), `${count} / 100`);
    assert.equal(await page.locator("#submit-button").isEnabled(), true);
  }
  assert.equal(await page.locator("#character-count").evaluate(el=>el.classList.contains("is-near-limit")),true);
  await page.locator("#content").fill("字".repeat(101));
  assert.equal(await page.locator("#character-count").textContent(), "101 / 100");
  assert.equal(await page.locator("#submit-button").isDisabled(), true);
  assert.match(await page.locator("#content-error").textContent(), /超出 1/);
  assert.equal((await page.locator("#content").inputValue()).length, 101);
  await page.locator("#submission-form").dispatchEvent("submit");
  assert.equal(submissionRequests,0,"Over-limit submit must not reach the API");
  await page.locator("#content").fill("");
  await shot("public-desktop");
  await page.locator("#content").focus();
  assert.equal(await page.locator("#content").evaluate(el=>el===document.activeElement),true);
  assert.notEqual(await page.locator("#content").evaluate(el=>getComputedStyle(el).boxShadow),"none");
  await page.keyboard.press("Tab");
  assert.equal(await page.locator("#submit-button").evaluate(el=>el===document.activeElement),true);
  assert.notEqual(await page.locator("#submit-button").evaluate(el=>getComputedStyle(el).outlineStyle),"none");
  await page.locator("#content").fill("這是一則本機測試，不會送往正式站。");
  await page.locator("#submission-form").evaluate(el=>{
    el.dispatchEvent(new Event("submit",{bubbles:true,cancelable:true}));
    el.dispatchEvent(new Event("submit",{bubbles:true,cancelable:true}));
  });
  await page.locator("#submit-button:disabled").waitFor();
  await page.locator(".notice--success").waitFor();
  assert.equal(submissionRequests,1,"Duplicate form submits must create only one request");
  assert.equal(await page.locator("#content").inputValue(),"");
  submitMode="error";await page.locator("#content").fill("本機錯誤狀態測試。");await page.locator("#submit-button").click();await page.locator(".notice--error").waitFor();
  assert.equal(await page.locator("#content").inputValue(),"本機錯誤狀態測試。");
  assert.equal(await page.locator("#submit-button").isEnabled(),true);
  await page.goto(origin+"/admin/");await page.locator("#access-auth-panel:not([hidden])").waitFor();
  assert.equal(await page.locator("#local-auth-form").isVisible(),false);
  assert.equal(await page.locator("#auth-title").textContent(),"管理登入");
  assert.equal(await page.locator(".wall-note, .nav-note").count(),0);
  assert.equal(await page.locator(".login-help").getAttribute("open"),null);
  await page.locator(".login-help summary").click();
  assert.equal(await page.locator('[data-copy="admin.auth.accessLogoutHint"]').isVisible(),true);
  await page.locator(".login-help summary").click();
  await shot("admin-login-desktop");
  providers={github:true,access:false,local:true};await page.reload();await page.locator("#github-auth-panel:not([hidden])").waitFor();
  assert.equal(await page.locator("#access-auth-panel").isVisible(),false);
  assert.equal(await page.locator("#local-auth-form").isVisible(),false);
  providers={github:true,access:true,local:false};
  signedIn=true;await page.reload();await page.locator(".submission-card").first().waitFor();
  assert.equal(await page.locator("#dashboard").getByText("DAAN ANONYMOUS",{exact:true}).isVisible(),true);
  assert.equal(await page.getByRole("button",{name:/新增帳號|新增管理員/}).count(),0);
  assert.equal(await page.locator(".admin-heading h1").textContent(),"投稿管理");
  const cardPositions=await page.locator(".submission-card").evaluateAll(cards=>cards.map(card=>card.getBoundingClientRect().x));
  assert.equal(new Set(cardPositions).size,1,"Minimal queue must be single-column");
  await shot("admin-dashboard-desktop");
  await page.locator("#team-tab").click();await page.locator(".team-member").first().waitFor();
  assert.equal(await page.locator('.admin-nav #studio-nav').isVisible(),true);
  assert.equal(await page.locator('#studio-nav').getAttribute('href'),'/admin/studio/');
  assert.equal(await page.getByRole('link',{name:'圖片工作室',exact:true}).count(),1);
  assert.equal(await page.locator(".admin-heading h1").textContent(),"管理員");
  await shot("admin-team-desktop");
  await page.locator("#queue-tab").click();
  await page.locator('[data-action="approve"]').first().waitFor();
  assert.equal(await page.locator(".admin-heading h1").textContent(),"投稿管理");
  await page.locator('[data-action="approve"]').first().evaluate(el=>{
    el.dispatchEvent(new MouseEvent("click",{bubbles:true}));
    el.dispatchEvent(new MouseEvent("click",{bubbles:true}));
  });
  await page.locator('.submission-card[aria-busy="true"]').waitFor();
  await page.waitForFunction(()=>document.querySelectorAll('.submission-card').length===2);
  assert.equal(moderationRequests,1,"Duplicate approve must create only one request");
  await page.locator('[data-action="reject"]').first().click();await page.getByRole('button',{name:'確定拒絕',exact:true}).click();await page.waitForFunction(()=>document.querySelectorAll('.submission-card').length===1);
  moderationMode="error";
  await page.locator('[data-action="approve"]').first().click();
  await page.waitForFunction(()=>document.querySelector('.submission-card__error')?.textContent.length>0);
  assert.equal(await page.locator(".submission-card").count(),1);
  assert.equal(await page.locator('[data-action="approve"]').isEnabled(),true);
  moderationMode="success";await page.locator('[data-action="approve"]').click();await page.locator("#empty-state:not([hidden])").waitFor();
  assert.equal(await page.locator("#empty-refresh-button").evaluate(el=>document.activeElement===el),true);
  queueMode="error";await page.locator("#refresh-button").click();await page.locator("#loading-state:not([hidden])").waitFor();await page.locator("#error-state:not([hidden])").waitFor();
  queueMode="success";resetQueue();await page.locator("#retry-button").click();await page.locator(".submission-card").first().waitFor();
  resetQueue();await page.setViewportSize({width:390,height:844});await page.reload();await page.locator(".submission-card").first().waitFor();await shot("admin-dashboard-mobile");
  const mobileToolbar = await page.evaluate(() => {
    const box = id => { const r=document.querySelector(id).getBoundingClientRect();return {top:r.top,bottom:r.bottom,height:r.height,width:r.width}; };
    return {identity:box("#admin-identity"),count:box("#pending-count"),refresh:box("#refresh-button"),logout:box("#clear-auth-button")};
  });
  assert.ok(mobileToolbar.identity.bottom <= mobileToolbar.count.top);
  assert.ok(mobileToolbar.count.bottom < mobileToolbar.refresh.top);
  assert.equal(mobileToolbar.refresh.top,mobileToolbar.logout.top);
  assert.ok(mobileToolbar.refresh.height>=48&&mobileToolbar.logout.height>=48);
  const badgeContrast=await page.locator(".status-badge--pending").first().evaluate(el=>{
    const luminance=rgb=>rgb.match(/\d+/g).slice(0,3).map(Number).map(n=>n/255).map(n=>n<=0.04045?n/12.92:((n+0.055)/1.055)**2.4).reduce((sum,n,i)=>sum+n*[0.2126,0.7152,0.0722][i],0);
    const style=getComputedStyle(el),a=luminance(style.color),b=luminance(style.backgroundColor);
    return (Math.max(a,b)+0.05)/(Math.min(a,b)+0.05);
  });
  assert.ok(badgeContrast>=7,"Pending badge text contrast must be at least 7:1");
  role="moderator";await page.reload();await page.locator(".submission-card").first().waitFor();assert.equal(await page.locator("#team-tab").isVisible(),false);assert.match(await page.locator("#admin-username").textContent(),/moderator@example.com/);
  await page.locator("#clear-auth-button").click();await page.locator("#auth-panel:not([hidden])").waitFor();
  assert.equal(await page.locator("#auth-error").textContent(),"已登出。");
  assert.equal(await page.locator("#auth-error").getAttribute("role"),"status");
  assert.equal(await page.locator("#auth-error").evaluate(el=>getComputedStyle(el).color),"rgb(98, 97, 88)");
  await shot("admin-login-mobile");
  await page.goto(origin+"/admin/?auth=unauthorized");await page.locator("#auth-error").filter({hasText:"此帳號沒有管理權限"}).waitFor();
  assert.equal(await page.locator("#auth-error").getAttribute("role"),"alert");
  assert.notEqual(await page.locator("#auth-error").evaluate(el=>getComputedStyle(el).color),"rgb(98, 97, 88)");
  await page.goto(origin);await page.getByRole("heading",{name:"匿名投稿",exact:true}).waitFor();await shot("public-mobile");
  for(const width of [320,768,1024]) {
    await page.setViewportSize({width,height:900});
    assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth>innerWidth),false,`public width ${width}`);
    signedIn=true;longIdentity=true;queue[0].content="long".repeat(150);await page.goto(origin+'/admin/');await page.locator('.submission-card').first().waitFor();
    assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth>innerWidth),false,`admin width ${width}`);
    await page.goto(origin);await page.getByRole('heading',{name:'匿名投稿',exact:true}).waitFor();
  }
  assert.deepEqual(errors,[]);
  const report={result:"PASS",fixtureOnly:true,productionRequests:0,checks:["99/100 accepted and 101 blocked in browser","Chinese/ZWJ/combining grapheme counter","near-limit warning and no truncation","public loading/success/error preserves draft","duplicate submit sends one request","keyboard focus and disabled states","desktop/mobile no horizontal overflow including long identities/content","dynamic providers and password hidden","owner read-only directory and no create account UI","moderator directory hidden","Email-only display","approve/reject CSRF retained and list updates","duplicate moderation sends one request","moderation error retry and focus restoration","queue loading/empty/error retry","logout","public title and team/queue heading switch","logout neutral info versus actual auth error styling","mobile toolbar separate identity/count/actions","pending badge text contrast >=7:1"],badgeContrast,screenshots:7};
  await writeFile(resolve(out,"report.json"),JSON.stringify(report,null,2)+"\n");
  console.log(JSON.stringify(report));
} finally {await browser?.close();await new Promise(r=>server.close(r));}
