import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const origin=process.env.NABDA_PREVIEW_URL||'http://127.0.0.1:5173';
assert.ok(['127.0.0.1','localhost'].includes(new URL(origin).hostname));
const modulePath=process.env.PLAYWRIGHT_MODULE||'/Users/mohamedbay/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules/playwright/index.mjs';
const {chromium}=await import(pathToFileURL(modulePath).href);
const browser=await chromium.launch({executablePath:'/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',headless:true});
const output=path.resolve('outputs/qa/cutouts');await mkdir(output,{recursive:true});
const passed=[],failures=[],errors=[],assets=[],writes=[],screenshots=[],contrast=[];
async function check(name,action){try{await action();passed.push(name);console.log(`PASS ${name}`);}catch(error){failures.push({name,error:error.message});console.error(`FAIL ${name}: ${error.message}`);}}
async function shot(page,selector,name){const filename=path.join(output,name+'.png');await page.locator(selector).screenshot({path:filename,animations:'disabled'});screenshots.push(filename);}
try{
 for(const [name,viewport] of [['desktop',{width:1440,height:1000}],['mobile',{width:390,height:844}]]){
  const context=await browser.newContext({viewport,isMobile:name==='mobile',hasTouch:name==='mobile'});
  await context.route('**/*',route=>{const req=route.request();if(!['GET','HEAD'].includes(req.method())){writes.push({url:req.url(),method:req.method()});return route.abort();}return route.continue();});
  const page=await context.newPage();page.on('pageerror',error=>errors.push(error.message));page.on('response',response=>{if(response.status()>=400)assets.push({url:response.url(),status:response.status()});});page.on('requestfailed',request=>{if(!request.failure()?.errorText?.includes('ERR_ABORTED'))errors.push(`${request.url()}: ${request.failure()?.errorText}`);});
  await page.goto(origin+'/',{waitUntil:'networkidle'});
  await check(`${name}: four cutouts and quiet pattern load without overflow`,async()=>{
   const images=page.locator('img');assert.equal(await images.count(),4);
   for(const image of await images.all()){assert.match(await image.getAttribute('src'),/-cutout\.webp$/);await image.scrollIntoViewIfNeeded();await image.evaluate(element=>element.decode());assert.equal(await image.evaluate(element=>getComputedStyle(element).mixBlendMode),'normal');}
   assert.match(await page.locator('body').evaluate(element=>getComputedStyle(element).backgroundImage),/\/story\/pattern\.svg/);
   const width=await page.evaluate(()=>({document:document.documentElement.scrollWidth,viewport:innerWidth}));assert.ok(width.document<=width.viewport+1,JSON.stringify(width));
   assert.equal(await page.locator('script,header,footer,nav,button,form').count(),0);
   for(const [selector,label] of [['.cover','opening'],['#setup','setup'],['#queue','queue'],['.scene-results','parts']])await shot(page,selector,`${name}-${label}`);
  });
  await check(`${name}: support starts hidden, reveals exact accounts and remains keyboard collapsible`,async()=>{
   const details=page.locator('details.support-reveal');const summary=details.locator('summary');
   assert.equal(await details.getAttribute('open'),null);assert.equal((await summary.innerText()).trim(),'Show support details');
   assert.equal(await details.locator('dd').first().isVisible(),false);await shot(page,'#support',`${name}-support-collapsed`);
   await summary.click();await details.locator('dd').first().waitFor({state:'visible'});assert.equal((await summary.innerText()).trim(),'Hide support details');
   assert.deepEqual(await details.locator('dd').allTextContents(),['LY93007011011011325337018','011011325337018']);await shot(page,'#support',`${name}-support-expanded`);
   await summary.focus();await page.keyboard.press('Space');assert.equal(await details.getAttribute('open'),null);assert.equal(await details.locator('dd').first().isVisible(),false);
   await page.keyboard.press('Enter');await details.locator('dd').first().waitFor({state:'visible'});assert.ok(await details.evaluate(element=>element.open));
  });
  await check(`${name}: text remains readable against paper and strongest pattern tint`,async()=>{
   const measured=await page.evaluate(()=>{
    function parse(value){const values=value.match(/[\d.]+/g)?.map(Number);return values&&values.length>=3?values:null;}
    function lum(rgb){const channels=rgb.slice(0,3).map(value=>{const x=value/255;return x<=.04045?x/12.92:((x+.055)/1.055)**2.4;});return channels[0]*.2126+channels[1]*.7152+channels[2]*.0722;}
    const paper=parse(getComputedStyle(document.body).backgroundColor)||[250,249,244];const backgrounds=[paper,[232,234,227]];
    return Array.from(document.querySelectorAll('h1,h2,h3,p,li,dt,dd,summary,figcaption,td,th,pre')).filter(element=>element.getClientRects().length&&getComputedStyle(element).visibility!=='hidden').flatMap(element=>{
     const style=getComputedStyle(element),color=parse(style.color);if(!color)return[];const large=parseFloat(style.fontSize)>=24||(parseFloat(style.fontSize)>=18.66&&Number(style.fontWeight)>=700);
     return backgrounds.map(background=>{const alpha=color[3]??1;const opaque=color.slice(0,3).map((value,index)=>value*alpha+background[index]*(1-alpha));const a=lum(opaque),b=lum(background);return{text:element.textContent.trim().slice(0,90),background,color:style.color,ratio:Number(((Math.max(a,b)+.05)/(Math.min(a,b)+.05)).toFixed(2)),minimum:large?3:4.5};});
    });
   });contrast.push({viewport:name,measurements:measured});assert.deepEqual(measured.filter(item=>item.ratio<item.minimum),[]);
   const summary=page.locator('details.support-reveal summary');await summary.focus();await page.keyboard.press('Space');assert.equal(await page.locator('details.support-reveal').getAttribute('open'),null);
  });
  await context.close();
 }
 await check('no errors, missing assets, or attempted writes',async()=>{assert.deepEqual(errors,[]);assert.deepEqual(assets,[]);assert.deepEqual(writes,[]);});
}finally{await writeFile(path.join(output,'browser-results.json'),JSON.stringify({origin,passed,failures,errors,assets,writes,screenshots,contrast},null,2));await browser.close();}
console.log(JSON.stringify({passed:passed.length,failed:failures.length,output},null,2));if(failures.length)process.exitCode=1;
