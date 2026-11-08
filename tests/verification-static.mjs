import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';
import path from 'node:path';

// Read-only visual/content verification. Unexpected writes are blocked before
// they reach the server. Run only once the static story is frozen and ready.
const origin = process.env.NABDA_PREVIEW_URL || 'http://127.0.0.1:5173';
assert.ok(['localhost', '127.0.0.1'].includes(new URL(origin).hostname), 'Use an owned loopback preview.');
const modulePath = process.env.PLAYWRIGHT_MODULE || '/Users/mohamedbay/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules/playwright/index.mjs';
const { chromium } = await import(pathToFileURL(modulePath).href);
const browser = await chromium.launch({ executablePath: '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', headless: true });
const output = path.resolve('outputs/qa/story'); await mkdir(output, { recursive: true });
const fixConfirm=process.env.NABDA_QA_STATIC_FIX_CONFIRM==='1';
const passed = [], failures = [], errors = [], assets = [], failedRequests = [], writes = [], screenshots = [], contrast = [];
async function check(name, action) { if(fixConfirm&&!name.includes('images load')&&!name.startsWith('anchors resolve')&&!name.startsWith('no application errors'))return;try { await action(); passed.push(name); console.log(`PASS ${name}`); } catch (error) { failures.push({ name, error: error.message }); console.error(`FAIL ${name}: ${error.message}`); } }
async function shot(page, name, fullPage=true) { const filename=path.join(output,`static-${name}.png`); await page.screenshot({path:filename,fullPage,animations:'disabled'}); screenshots.push(filename); }

try {
 for (const [name,viewport] of [['desktop',{width:1440,height:1000}],['mobile',{width:390,height:844}]]) {
  const context = await browser.newContext({viewport,isMobile:name==='mobile',hasTouch:name==='mobile'});
  await context.route('**/*',route=>{const req=route.request();if(!['GET','HEAD'].includes(req.method())){writes.push({url:req.url(),method:req.method()});return route.abort();}return route.continue();});
  const page = await context.newPage();
  page.on('pageerror',error=>errors.push(error.message));
  page.on('requestfailed',req=>{if(!req.failure()?.errorText?.includes('ERR_ABORTED'))failedRequests.push({url:req.url(),error:req.failure()?.errorText});});
  page.on('response',response=>{if(response.status()>=400)assets.push({url:response.url(),status:response.status()});});
  if(fixConfirm)await page.goto(origin+'/',{waitUntil:'networkidle'});
  await check(`${name}: static English article without application chrome or scripts`,async()=>{
   const response=await page.goto(origin+'/',{waitUntil:'networkidle'});assert.equal(response.status(),200);const html=await response.text();
   assert.doesNotMatch(html,/<script\b/i);assert.doesNotMatch(html,/__NEXT_DATA__|react-server|vite\/client|vinext\/client/i);
   assert.match(await page.title(),/Nabda/);assert.equal(await page.locator('html').getAttribute('lang'),'en');
   const text=await page.locator('body').innerText();assert.doesNotMatch(text,/[\u0600-\u06ff\u0750-\u077f\u08a0-\u08ff]/);assert.match(text,/Nabda/);assert.ok(text.length>=3000,`Article has ${text.length} characters.`);
   assert.equal(await page.locator('script,header,footer,nav,button,form,input,select,textarea,[role="button"],[role="navigation"],[role="banner"],[role="contentinfo"]').count(),0);
   assert.equal(await page.locator('a').filter({hasText:/^(connect (my|your) phone|get started|start now)$/i}).count(),0);
   for(const term of [/Android/i,/SIM/,/API/,/SQLite/i,/sandbox/i,/idempotenc/i])assert.match(text,term);
  });
  await check(`${name}: images load with descriptions and page fits viewport`,async()=>{
   for(const img of await page.locator('img').all()){await img.scrollIntoViewIfNeeded();await img.evaluate(element=>element.complete&&element.naturalWidth>0?Promise.resolve():new Promise((resolve,reject)=>{element.addEventListener('load',resolve,{once:true});element.addEventListener('error',()=>reject(new Error('Image failed: '+element.src)),{once:true});}));}
   await page.evaluate(()=>window.scrollTo({top:0,behavior:'instant'}));await page.evaluate(()=>document.fonts.ready);
   const images=await page.locator('img').evaluateAll(elements=>elements.map(img=>({src:img.getAttribute('src'),alt:img.getAttribute('alt'),complete:img.complete,width:img.naturalWidth})));
   assert.ok(images.length>=3,'The story should contain the approved scene and its extended scenes.');
   assert.deepEqual(images.filter(img=>!img.complete||img.width===0||!img.alt?.trim()),[]);
   const widths=await page.evaluate(()=>({document:document.documentElement.scrollWidth,viewport:innerWidth}));assert.ok(widths.document<=widths.viewport+1,JSON.stringify(widths));
   await shot(page,`${name}-full`);for(let i=0;i<Math.min(images.length,4);i++){const filename=path.join(output,`static-${name}-scene-${i+1}.png`);await page.locator('img').nth(i).screenshot({path:filename,animations:'disabled'});screenshots.push(filename);}
  });
  await check(`${name}: text contrast meets WCAG AA`,async()=>{
   const result=await page.evaluate(()=>{
    function rgb(value){const parts=value.match(/[\d.]+/g)?.map(Number);return parts&&parts.length>=3?[parts[0],parts[1],parts[2],parts[3]??1]:null;}
    function lum(color){const linear=color.slice(0,3).map(channel=>{const x=channel/255;return x<=.04045?x/12.92:((x+.055)/1.055)**2.4;});return linear[0]*.2126+linear[1]*.7152+linear[2]*.0722;}
    return Array.from(document.querySelectorAll('h1,h2,h3,p,li,figcaption,blockquote,td,th,pre')).filter(el=>el.getClientRects().length&&el.textContent.trim()).flatMap(el=>{
     const style=getComputedStyle(el);let ancestor=el,background=null,hasImage=false;while(ancestor){const s=getComputedStyle(ancestor);if(s.backgroundImage!=='none')hasImage=true;const c=rgb(s.backgroundColor);if(c&&c[3]===1){background=c;break;}ancestor=ancestor.parentElement;}background??=[255,255,255,1];const foreground=rgb(style.color);if(!foreground||hasImage)return[];
     const opaque=foreground.slice(0,3).map((x,i)=>x*foreground[3]+background[i]*(1-foreground[3]));const a=lum(opaque),b=lum(background),ratio=(Math.max(a,b)+.05)/(Math.min(a,b)+.05);const large=parseFloat(style.fontSize)>=24||(parseFloat(style.fontSize)>=18.66&&Number(style.fontWeight)>=700);return[{text:el.textContent.trim().slice(0,100),ratio:Number(ratio.toFixed(2)),minimum:large?3:4.5,color:style.color,background}];
    });
   });contrast.push({viewport:name,measurements:result});assert.deepEqual(result.filter(item=>item.ratio<item.minimum),[]);
  });
  if(name==='desktop')await check('anchors resolve and the API remains independently readable',async()=>{
   const links=await page.locator('a[href]').evaluateAll(elements=>elements.map(el=>({href:el.getAttribute('href'),text:el.textContent.trim()})));
   for(const link of links){const url=new URL(link.href,origin);assert.ok(['https:','http:','mailto:'].includes(url.protocol),JSON.stringify(link));if(url.origin!==origin)continue;if(url.hash){const id=decodeURIComponent(url.hash.slice(1));assert.ok(await page.locator('[id]').evaluateAll((elements,id)=>elements.some(el=>el.id===id),id),`Missing fragment ${url.hash}`);}if(url.pathname!=='/'){const response=await page.request.get(url.href,{maxRedirects:5});assert.ok(response.ok(),`${url.href}: ${response.status()}`);}}
   const health=await page.request.get(origin+'/health');assert.equal(health.status(),200);assert.equal((await health.json()).mode,'phone-owned');
   const account=await page.request.get(origin+'/api/account');assert.equal(account.status(),401);
   const head=await page.request.head(origin+'/');assert.equal(head.status(),200);assert.match(head.headers()['content-type'],/text\/html/);assert.equal((await head.body()).length,0);
   for(const [route,fragment] of [['/how-it-works','#idea'],['/download','#setup'],['/help','#questions'],['/support','#support'],['/privacy','#privacy'],['/terms','#terms'],['/docs','#api'],['/docs/messages','#request'],['/docs/phone-queue','#queue'],['/docs/status','#results'],['/docs/limits','#limits']]){const response=await page.request.get(origin+route,{maxRedirects:0});assert.equal(response.status(),308,route);assert.equal(new URL(response.headers().location,origin).href,origin+'/'+fragment,route);assert.ok(await page.locator('[id]').evaluateAll((elements,id)=>elements.some(el=>el.id===id),fragment.slice(1)),`Missing redirect target ${fragment}`);}
  });
  await context.close();
 }
 await check('no application errors, broken assets, or attempted writes',async()=>{assert.deepEqual(errors,[]);assert.deepEqual(assets,[]);assert.deepEqual(failedRequests,[]);assert.deepEqual(writes,[]);});
} finally { await writeFile(path.join(output,fixConfirm?'static-fix-results.json':'static-results.json'),JSON.stringify({origin,passed,failures,errors,assets,failedRequests,writes,screenshots,contrast},null,2));await browser.close(); }
console.log(JSON.stringify({passed:passed.length,failed:failures.length,output},null,2));if(failures.length)process.exitCode=1;
