import assert from "node:assert/strict";
import fs from "node:fs/promises";
import http from "node:http";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { spawnSync } from "node:child_process";

// Read-only verification of prepared exports and a real local Wrangler Worker.
// Start the preview Worker on 8787 with the documented local migrations first.
// This harness owns only a temporary static server on 5174. It blocks browser
// writes and never opens GitHub or contacts a phone, carrier or hosting account.
const directory=path.resolve("deploy-build/netlify"),website="http://127.0.0.1:5174",api="http://127.0.0.1:8787";
const output=path.resolve("outputs/qa/independent");await fs.mkdir(output,{recursive:true});
const content=await fs.readFile(path.join(directory,"index.html"),"utf8");
const responseHeaders=Object.fromEntries((await fs.readFile(path.join(directory,"_headers"),"utf8")).split(/\n(?=\/)/)[0].split("\n").filter(line=>/^  [A-Za-z-]+:/.test(line)).map(line=>{const at=line.indexOf(":");return[line.slice(0,at).trim(),line.slice(at+1).trim()];}));
const mime={".html":"text/html; charset=utf-8",".css":"text/css; charset=utf-8",".js":"text/javascript; charset=utf-8",".mjs":"text/javascript; charset=utf-8",".json":"application/json",".svg":"image/svg+xml",".webp":"image/webp",".woff2":"font/woff2",".png":"image/png",".zip":"application/zip",".apk":"application/vnd.android.package-archive",".md":"text/markdown; charset=utf-8"};
const server=http.createServer(async(req,res)=>{
  try{
    assert.ok(["GET","HEAD"].includes(req.method));
    const url=new URL(req.url,website);let relative=decodeURIComponent(url.pathname);if(relative==="/")relative="/index.html";
    const filename=path.resolve(directory,"."+relative);if(!filename.startsWith(directory+path.sep))throw new Error("invalid path");
    const bytes=await fs.readFile(filename);
    res.writeHead(200,{...responseHeaders,"Content-Type":mime[path.extname(filename)]??"application/octet-stream"});res.end(req.method==="HEAD"?undefined:bytes);
  }catch{res.writeHead(404,{"Content-Type":"text/plain"});res.end("not found");}
});
await new Promise((resolve,reject)=>{server.once("error",reject);server.listen(5174,"127.0.0.1",resolve);});
const modulePath=process.env.PLAYWRIGHT_MODULE||"/Users/mohamedbay/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules/playwright/index.mjs";
const {chromium}=await import(pathToFileURL(modulePath).href);
const browser=await chromium.launch({executablePath:process.env.CHROME_PATH||"/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",headless:true});
const checks=[],errors=[],writes=[],externalRequests=[],screenshots=[];let failure;
async function shot(page,name){const file=path.join(output,name+".png");await page.screenshot({path:file,fullPage:true,animations:"disabled"});screenshots.push(file);}
try{
  assert.doesNotMatch(content,/chatgpt\.site|Sites-managed|Continue with ChatGPT/);
  assert.match(content,/GitHub/);assert.match(content,/http:\/\/127\.0\.0\.1:8787\/dashboard/);
  const spec=JSON.parse(await fs.readFile(path.join(directory,"openapi.json"),"utf8"));assert.equal(spec.servers[0].url,api);assert.ok(spec.components.securitySchemes.NabdaBrowserSession);assert.ok(!spec.components.securitySchemes.SitesBrowserSession);
  let operations=0;for(const item of Object.values(spec.paths))for(const method of Object.keys(item))if(["get","post","put","patch","delete","head","options"].includes(method))operations++;assert.equal(operations,17);
  const zipCheck=spawnSync("python3",["-c",String.raw`
import hashlib,json,pathlib,re,sys,zipfile
root=pathlib.Path(sys.argv[1]); archive=root/'downloads/Nabda-Free-Starter-0.2.0.zip'
with zipfile.ZipFile(archive) as z:
 assert len(z.namelist())==9 and z.testzip() is None
 entries=dict(re.fullmatch(r'([a-f0-9]{64})  (.+)',line).group(2,1) for line in z.read('SHA256SUMS.txt').decode().splitlines())
 assert len(entries)==8
 for name,expected in entries.items():
  data=z.read(name);assert hashlib.sha256(data).hexdigest()==expected,name
  relative='api-kit/README.md' if name=='README.md' else name
  assert data==(root/relative).read_bytes(),name
  if name.endswith(('.md','.mjs','.py','.json')): assert b'chatgpt.site' not in data and b'Sites-managed' not in data,name
 digest=hashlib.sha256(archive.read_bytes()).hexdigest()
 assert (archive.with_suffix('.zip.sha256').read_text().split()[0])==digest
 print(json.dumps({'files':9,'manifest_hashes':8,'sha256':digest,'bytes':archive.stat().st_size}))
`,directory],{encoding:"utf8"});assert.equal(zipCheck.status,0,zipCheck.stderr);const zip=JSON.parse(zipCheck.stdout);checks.push("Netlify export: independent origins, 17 OpenAPI operations, cookie authentication, and all nine ZIP files/eight manifest hashes match public files");

  for(const [name,viewport] of [["desktop",{width:1440,height:1000}],["mobile",{width:390,height:844}]]){
    const context=await browser.newContext({viewport,isMobile:name==="mobile",hasTouch:name==="mobile"});
    await context.route("**/*",route=>{const req=route.request();if(!["GET","HEAD"].includes(req.method())){writes.push({method:req.method(),url:req.url()});return route.abort();}if(![website,api].includes(new URL(req.url()).origin)){externalRequests.push(req.url());return route.abort();}return route.continue();});
    const page=await context.newPage();page.on("pageerror",e=>errors.push(e.message));page.on("console",m=>{if(m.type()==="error"&&/Content Security|Refused|violat/i.test(m.text()))errors.push(m.text());});page.on("response",r=>{if(r.status()>=400&&!(r.status()===401&&r.url()===api+"/api/account"))errors.push(r.status()+" "+r.url());});
    assert.equal((await page.goto(website+"/",{waitUntil:"networkidle"})).status(),200);await page.evaluate(()=>document.fonts.ready);
    assert.equal(await page.locator("script,header,footer,nav,button,form").count(),0);assert.equal(await page.locator("html").getAttribute("lang"),"en");assert.doesNotMatch(await page.locator("body").innerText(),/[\u0600-\u06ff\u0750-\u077f\u08a0-\u08ff]/);assert.match(await page.locator("body").evaluate(e=>getComputedStyle(e).fontFamily),/Cairo/);
    assert.equal(await page.locator("details.support-reveal").getAttribute("open"),null);assert.equal(await page.locator(".support-details").isVisible(),false);
    for(const img of await page.locator("img").all()){await img.scrollIntoViewIfNeeded();await img.evaluate(e=>e.decode());assert.match(await img.getAttribute("src"),/-cutout\.webp$/);}assert.equal(await page.locator("img").count(),4);
    assert.match(await page.locator("#disclaimer").innerText(),/responsible/i);const size=await page.evaluate(()=>({viewport:innerWidth,width:document.documentElement.scrollWidth}));assert.ok(size.width<=size.viewport+1,JSON.stringify(size));await shot(page,name+"-netlify-story");
    if(name==="desktop"){
      for(const a of await page.locator("a[href]").all()){const href=await a.getAttribute("href"),url=new URL(href,website);if(![website,api].includes(url.origin))continue;if(url.origin===website&&url.hash){assert.ok(await page.locator("[id]").evaluateAll((nodes,id)=>nodes.some(node=>node.id===id),decodeURIComponent(url.hash.slice(1))),href);}if(url.pathname!=="/"){const r=await page.request.get(url.href,{maxRedirects:0});assert.ok(r.status()<400,url.href+": "+r.status());}}
    }
    await page.locator("details.support-reveal summary").click();assert.equal(await page.locator(".support-details").isVisible(),true);await page.locator("details.support-reveal summary").click();assert.equal(await page.locator(".support-details").isVisible(),false);
    checks.push(name+": independent static website preserves English/Cairo, four cutouts, hidden optional support, disclaimer, working resource links and no overflow under Netlify CSP");
    assert.equal((await page.goto(api+"/dashboard",{waitUntil:"networkidle"})).status(),200);await page.getByRole("link",{name:/Continue with GitHub/}).waitFor();
    const signIn=new URL(await page.getByRole("link",{name:/Continue with GitHub/}).getAttribute("href"),api);assert.equal(signIn.origin,api);assert.equal(signIn.pathname,"/auth/github");assert.doesNotMatch(await page.locator("body").innerText(),/ChatGPT|OpenAI/);assert.equal((await page.request.get(api+"/api/account")).status(),401);
    const dashboardSize=await page.evaluate(()=>({viewport:innerWidth,width:document.documentElement.scrollWidth}));assert.ok(dashboardSize.width<=dashboardSize.viewport+1,JSON.stringify(dashboardSize));await shot(page,name+"-cloudflare-dashboard");checks.push(name+": real Wrangler dashboard renders GitHub sign-in, keeps account API401, and has no overflow");await context.close();
  }
  assert.deepEqual(errors,[]);assert.deepEqual(writes,[]);assert.deepEqual(externalRequests,[]);checks.push("No page errors, CSP violations, missing assets, browser writes or external requests");
  await fs.writeFile(path.join(output,"export-results.json"),JSON.stringify({zip,operations,no_secrets_or_state_packed:true},null,2)+"\n");
}catch(error){failure=error.message;console.error("FAIL "+failure);}finally{
  await fs.writeFile(path.join(output,"ui-results.json"),JSON.stringify({checks,errors,writes,externalRequests,screenshots,failure:failure??null},null,2)+"\n");await browser.close();await new Promise(resolve=>server.close(resolve));
}
console.log(JSON.stringify({passed:checks.length,failure:failure??null,output},null,2));if(failure)process.exitCode=1;
