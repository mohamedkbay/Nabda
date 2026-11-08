import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';
import path from 'node:path';
const origin='http://127.0.0.1:5173';
const {chromium}=await import(pathToFileURL('/Users/mohamedbay/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules/playwright/index.mjs').href);
const browser=await chromium.launch({executablePath:'/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',headless:true});
const output=path.resolve('outputs/qa/free-release');await mkdir(output,{recursive:true});
const checks=[],errors=[],writes=[],screenshots=[];let failed;
async function shot(page,selector,name){const file=path.join(output,name+'.png');await page.locator(selector).screenshot({path:file,animations:'disabled'});screenshots.push(file);}
try{
 for(const [name,viewport] of [['desktop',{width:1440,height:1000}],['mobile',{width:390,height:844}]]){
  const context=await browser.newContext({viewport,isMobile:name==='mobile',hasTouch:name==='mobile'});
  await context.route('**/*',route=>{const request=route.request();if(!['GET','HEAD'].includes(request.method())){writes.push({url:request.url(),method:request.method()});return route.abort();}return route.continue();});
  const page=await context.newPage();page.on('pageerror',error=>errors.push(error.message));page.on('response',response=>{if(response.status()>=400)errors.push(`${response.status()} ${response.url()}`);});page.on('requestfailed',request=>{if(!request.failure()?.errorText?.includes('ERR_ABORTED'))errors.push(`${request.url()}: ${request.failure()?.errorText}`);});
  const response=await page.goto(origin+'/',{waitUntil:'networkidle'});assert.equal(response.status(),200);await page.evaluate(()=>document.fonts.ready);
  assert.equal(await page.locator('script,header,footer,nav,button,form').count(),0);assert.equal(await page.locator('html').getAttribute('lang'),'en');assert.doesNotMatch(await page.locator('body').innerText(),/[\u0600-\u06ff\u0750-\u077f\u08a0-\u08ff]/);assert.match(await page.locator('body').evaluate(element=>getComputedStyle(element).fontFamily),/Cairo/);assert.equal(await page.locator('details.support-reveal').getAttribute('open'),null);assert.equal(await page.locator('.support-details').isVisible(),false);
  assert.match(await page.locator('#request').innerText(),/RECIPIENT_IN_E164/);assert.match(await page.locator('#request').innerText(),/Replace the key, device ID, and recipient/);
  assert.match(await page.locator('#request-fields').innerText(),/raw API defaults to false/);assert.match(await page.locator('#client-examples').innerText(),/sandbox: true/);assert.match(await page.locator('.full-response-note').innerText(),/Initially null/);assert.match(await page.locator('#setup').innerText(),/sandbox mode before selecting a SIM or granting SMS permission/);
  assert.equal(await page.locator('#request-fields tbody tr').count(),6);assert.match(await page.locator('#client-examples').innerText(),/Node.js/);assert.match(await page.locator('#client-examples').innerText(),/PowerShell/);
  for(const [selector,label] of [['#free-download','free-download'],['#request-fields','request-fields'],['#client-examples','client-examples']])await shot(page,selector,`${name}-${label}`);
  for(const image of await page.locator('img').all()){await image.scrollIntoViewIfNeeded();await image.evaluate(element=>element.decode());assert.match(await image.getAttribute('src'),/-cutout\.webp$/);}
  if(name==='mobile')await shot(page,'.scene-results','mobile-parts');
  const size=await page.evaluate(()=>({width:innerWidth,document:document.documentElement.scrollWidth}));assert.ok(size.document<=size.width+1,JSON.stringify(size));
  for(const link of await page.locator('#free-download a[href]').all()){const url=new URL(await link.getAttribute('href'),origin);const res=await page.request.get(url.href);assert.equal(res.status(),200,url.pathname);}
  checks.push(`${name}: new integration/download documentation, static English/Cairo, hidden support, four cutouts, no overflow, and all kit links pass`);await context.close();
 }
 assert.deepEqual(errors,[]);assert.deepEqual(writes,[]);checks.push('no browser errors, missing assets, or attempted writes');
}catch(error){failed=error.message;console.error(`FAIL ${failed}`);}finally{await writeFile(path.join(output,'release-ui-results.json'),JSON.stringify({origin,checks,errors,writes,screenshots,failure:failed||null},null,2));await browser.close();}
console.log(JSON.stringify({passed:checks.length,failure:failed||null,output},null,2));if(failed)process.exitCode=1;
