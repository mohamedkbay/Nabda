import assert from "node:assert/strict";
import fs from "node:fs/promises";
import { build } from "esbuild";
import { Miniflare, Log, LogLevel } from "miniflare";

// The real standalone Worker and authentication module run against isolated D1.
// GitHub's three HTTP responses are simulated through the auth module's fetch
// dependency. There is no phone transport, real credential, or network request.
const bundled = await build({
  stdin: {
    contents: 'export {default as worker} from "./worker/cloudflare.ts"; export {handleIndependentAuth,readBrowserSession} from "./lib/independent-auth.ts";',
    resolveDir: process.cwd(), loader: "ts",
  },
  bundle: true, write: false, format: "esm", platform: "browser", target: "es2022",
});
const source = bundled.outputFiles[0].text;
assert.doesNotMatch(source, /vinext\/server|runWithConnectorBinding|sites-vite-plugin|oai-authenticated-user/, "The standalone bundle must not contain Sites identity adapters.");
const { worker, handleIndependentAuth, readBrowserSession } = await import(`data:text/javascript;base64,${Buffer.from(source).toString("base64")}`);
const mf = new Miniflare({
  modules: true, script: "export default {fetch(){return new Response('isolated')}}",
  compatibilityDate: "2026-05-15", d1Databases: ["DB"], log: new Log(LogLevel.ERROR), cf: false,
});
const api = "https://nabda-api.example.test";
const website = "https://nabda.example.test";
const checks = [], failures = [], networkCalls = [], assetRequests = [];
let DB, env, expectedChallenge;

async function check(name, action) {
  try { await action(); checks.push(name); console.log(`PASS ${name}`); }
  catch (error) { failures.push({name, error:error.message}); console.error(`FAIL ${name}: ${error.message}`); }
}
function cookies(response) {
  const values = response.headers.getSetCookie?.() ?? [response.headers.get("set-cookie") ?? ""];
  return values.flatMap(value => value.split(/,\s*(?=__Host-)/)).filter(Boolean);
}
function cookieValue(response, name) {
  return cookies(response).find(value => value.startsWith(name + "="))?.split(";")[0] ?? "";
}
function request(path, {method="GET", body, cookie, headers={}}={}) {
  return new Request(api + path, {method, headers:{...(body===undefined?{}:{"Content-Type":"application/json"}), ...(cookie?{Cookie:cookie}:{}), ...headers}, ...(body===undefined?{}:{body:JSON.stringify(body)})});
}
async function call(path, options, expected) {
  const response = await worker.fetch(request(path, options), env, {waitUntil(){}});
  if(expected!==undefined) assert.equal(response.status,expected,`${options?.method??"GET"} ${path}: ${await response.clone().text()}`);
  return response;
}
async function json(path, options, expected) { return (await call(path,options,expected)).json(); }
const persons = {
  alice:{id:1001,login:"alice-fixture",name:"Alice Fixture",email:"alice@example.test",verified:true},
  bob:{id:2002,login:"bob-fixture",name:"Bob Fixture",email:"bob@example.test",verified:true},
  unverified:{id:3003,login:"unverified",name:"Unverified",email:"unverified@example.test",verified:false},
};
const providerFetch = async (input, init={}) => {
  const url = new URL(typeof input === "string" || input instanceof URL ? input : input.url);
  assert.ok(["github.com","api.github.com"].includes(url.hostname),"Only known provider endpoints are allowed in the simulation.");
  assert.equal(init.redirect,"manual","Provider requests must use the Workers-supported manual mode and must not follow credential redirects.");
  const headers = new Headers(init.headers ?? (input instanceof Request?input.headers:undefined));
  networkCalls.push({url:url.href,method:init.method??"GET"});
  if(url.href === "https://github.com/login/oauth/access_token") {
    const values = typeof init.body === "string" ? new URLSearchParams(init.body) : init.body;
    assert.equal(values.get("client_id"),env.GITHUB_CLIENT_ID);
    assert.equal(values.get("client_secret"),env.GITHUB_CLIENT_SECRET);
    assert.equal(values.get("redirect_uri"),api+"/auth/github/callback");
    assert.match(values.get("code_verifier")??"",/^[A-Za-z0-9_-]{43,128}$/);
    const challenge=Buffer.from(await crypto.subtle.digest("SHA-256",new TextEncoder().encode(values.get("code_verifier")))).toString("base64url");
    assert.equal(challenge,expectedChallenge,"Token exchange must use the verifier committed in this browser's authorization request.");
    assert.ok(persons[values.get("code")],"Only fixture authorization codes may be exchanged.");
    return Response.json({access_token:"fixture-access-"+values.get("code"),token_type:"bearer",scope:"read:user,user:email"});
  }
  const who = headers.get("Authorization")?.replace(/^Bearer fixture-access-/i,"") ?? "";
  const person = persons[who]; assert.ok(person,"Provider request must use the just-issued fixture token.");
  if(url.href === "https://api.github.com/user") return Response.json({id:person.id,login:person.login,name:person.name,email:person.email});
  if(url.href === "https://api.github.com/user/emails?per_page=100") return Response.json([{email:person.email,primary:true,verified:person.verified}]);
  throw new Error("Unexpected provider endpoint: "+url.href);
};
async function start(returnTo) {
  const response = await call("/auth/github"+(returnTo?"?return_to="+encodeURIComponent(returnTo):""),undefined,303);
  const location = new URL(response.headers.get("location"));
  assert.equal(location.origin,"https://github.com");
  assert.equal(location.pathname,"/login/oauth/authorize");
  assert.equal(location.searchParams.get("client_id"),env.GITHUB_CLIENT_ID);
  assert.equal(location.searchParams.get("redirect_uri"),api+"/auth/github/callback");
  assert.equal(location.searchParams.get("code_challenge_method"),"S256");
  assert.match(location.searchParams.get("code_challenge")??"",/^[A-Za-z0-9_-]{43}$/);
  const cookie = cookieValue(response,"__Host-nabda_oauth");
  assert.ok(cookie,"The state is bound to a browser-only OAuth cookie.");
  return {response,location,cookie,state:location.searchParams.get("state")};
}
async function finish(flow, code="alice", overrides={}) {
  expectedChallenge=flow.location.searchParams.get("code_challenge");
  const callback = "/auth/github/callback?"+new URLSearchParams({code,state:flow.state,...overrides.query});
  return handleIndependentAuth(request(callback,{cookie:overrides.cookie??flow.cookie}),env,{fetch:providerFetch});
}

try {
  DB = await mf.getD1Database("DB");
  for(const file of (await fs.readdir("drizzle")).filter(name=>name.endsWith(".sql")).sort()) {
    for(const sql of (await fs.readFile("drizzle/"+file,"utf8")).split("--> statement-breakpoint").map(s=>s.trim()).filter(Boolean)) await DB.prepare(sql).run();
  }
  env={DB,API_ORIGIN:api,WEBSITE_ORIGIN:website,GITHUB_CLIENT_ID:"fixture-client",GITHUB_CLIENT_SECRET:"fixture-secret",ASSETS:{async fetch(input){const url=new URL(typeof input==="string"?input:input.url);assetRequests.push(url.pathname);return new Response("<!doctype html><html lang=\"en\"><title>Nabda fixture asset</title></html>",{headers:{"Content-Type":"text/html"}});}}};

  await check("standalone health works while configuration and authentication fail closed",async()=>{
    const health=await json("/health",undefined,200);assert.equal(health.mode,"phone-owned");
    await call("/api/account",undefined,401);
    await call("/api/account",{headers:{"oai-authenticated-user-id":"forged","oai-authenticated-user-email":"forged@example.test"}},401);
    const unconfigured=await worker.fetch(request("/auth/github"),{DB,ASSETS:env.ASSETS},{waitUntil(){}});
    assert.equal(unconfigured.status,503);
    assert.doesNotMatch(await unconfigured.text(),/fixture-secret|fixture-client/);
    const redirectLoop=await worker.fetch(request("/"),{...env,WEBSITE_ORIGIN:api},{waitUntil(){}});assert.equal(redirectLoop.status,503);
  });
  await check("public website redirect, dashboard shell, and legacy links stay independent",async()=>{
    const home=await call("/",undefined);assert.ok([302,307,308].includes(home.status));assert.equal(new URL(home.headers.get("location")).origin,website);
    const shell=await call("/dashboard",undefined,200);assert.match(shell.headers.get("content-type"),/text\/html/);assert.ok(assetRequests.includes("/dashboard/index.html"));
    const docs=await call("/docs/authentication",undefined);assert.ok([302,307,308].includes(docs.status));assert.equal(new URL(docs.headers.get("location")).origin,website);
  });

  let aliceCookie,bobCookie;
  await check("OAuth uses random browser-bound state, S256 PKCE, verified identity and secure hashed session",async()=>{
    const flow=await start("/dashboard");
    for(const value of cookies(flow.response)){assert.match(value,/HttpOnly/i);assert.match(value,/Secure/i);assert.match(value,/SameSite=Lax/i);assert.match(value,/Path=\//i);assert.doesNotMatch(value,/Domain=/i);}
    const callback=await finish(flow);
    assert.equal(callback.status,303,await callback.clone().text());
    aliceCookie=cookieValue(callback,"__Host-nabda_session");assert.ok(aliceCookie);
    const allCookies=cookies(callback);const session=allCookies.find(c=>c.startsWith("__Host-nabda_session="));assert.match(session,/HttpOnly/i);assert.match(session,/Secure/i);assert.match(session,/SameSite=Lax/i);assert.doesNotMatch(session,/Domain=/i);
    assert.equal(new URL(callback.headers.get("location"),api).origin,api);
    const stored=await DB.prepare("SELECT * FROM browser_sessions").all();
    assert.equal(stored.results.length,1);
    assert.ok(!JSON.stringify(stored.results).includes(aliceCookie.split("=")[1]),"Raw session cookie must never be stored in D1.");
    assert.ok(!JSON.stringify(stored.results).includes("fixture-access-"),"Provider access tokens must not be stored.");
    const identity=await readBrowserSession(request("/api/account",{cookie:aliceCookie}),env);assert.equal(identity.email,"alice@example.test");
    const account=await json("/api/account",{cookie:aliceCookie},200);assert.equal(account.user.email,"alice@example.test");
    const replay=await finish(flow);assert.ok(replay.status>=400,"A consumed authorization attempt must not replay.");
  });
  await check("wrong or missing OAuth browser binding and state are rejected before provider requests",async()=>{
    for(const kind of ["missing cookie","wrong cookie","wrong state"]){
      const flow=await start();const before=networkCalls.length;
      const response=await finish(flow,"alice",kind==="missing cookie"?{cookie:""}:kind==="wrong cookie"?{cookie:"__Host-nabda_oauth=not-the-browser"}:{query:{state:"not-the-state"}});
      assert.ok(response.status>=400,kind);assert.equal(networkCalls.length,before,kind);
    }
  });
  await check("OAuth return targets cannot redirect to another website",async()=>{
    const flow=await start("https://attacker.example/steal");const response=await finish(flow);assert.equal(response.status,303);
    assert.equal(new URL(response.headers.get("location"),api).origin,api);
  });
  await check("expired attempts and concurrent callback replay cannot redeem a second session",async()=>{
    const expired=await start();
    const hash=Buffer.from(await crypto.subtle.digest("SHA-256",new TextEncoder().encode(expired.state))).toString("hex");
    await DB.prepare("UPDATE oauth_attempts SET expires_at=? WHERE state_hash=?").bind("2000-01-01T00:00:00.000Z",hash).run();
    const beforeExpired=networkCalls.length;assert.equal((await finish(expired)).status,400);assert.equal(networkCalls.length,beforeExpired);
    const flow=await start();const beforeRace=networkCalls.length;const results=await Promise.all([finish(flow),finish(flow)]);
    assert.deepEqual(results.map(r=>r.status).sort(),[303,400]);assert.equal(networkCalls.length-beforeRace,3,"Only the winning callback may contact the provider.");
  });
  await check("unverified provider email does not create an authenticated session",async()=>{
    const flow=await start();const response=await finish(flow,"unverified");assert.ok(response.status>=400);assert.equal(cookieValue(response,"__Host-nabda_session"),"");
    const row=await DB.prepare("SELECT COUNT(*) AS n FROM independent_users WHERE email=?").bind("unverified@example.test").first();assert.equal(row.n,0);
  });
  await check("independent sessions isolate tenant keys, phones, message handoff and history",async()=>{
    const flow=await start();const callback=await finish(flow,"bob");assert.equal(callback.status,303);bobCookie=cookieValue(callback,"__Host-nabda_session");
    const accountA=await json("/api/account",{cookie:aliceCookie},200),accountB=await json("/api/account",{cookie:bobCookie},200);assert.notEqual(accountA.organization.id,accountB.organization.id);
    const keyA=await json("/api/keys",{method:"POST",body:{name:"Alice sandbox"},cookie:aliceCookie,headers:{Origin:api}},201);
    const keyB=await json("/api/keys",{method:"POST",body:{name:"Bob sandbox"},cookie:bobCookie,headers:{Origin:api}},201);
    const pairing=await json("/api/pairings",{method:"POST",body:{name:"No-SMS simulated phone"},cookie:aliceCookie,headers:{Origin:api}},201);assert.equal(pairing.qr.server_url,api);
    const phone=await json("/v1/device/pair",{method:"POST",body:{pairing_token:pairing.pairing_token}},201);
    const application={Authorization:"Bearer "+keyA.key,"Idempotency-Key":"independent-sandbox-001"};
    const payload={device_id:phone.device_id,to:"+12025550123",content:"Independent hosting sandbox",sandbox:true};
    const message=await json("/v1/messages",{method:"POST",body:payload,headers:application},202);
    const again=await json("/v1/messages",{method:"POST",body:payload,headers:application},202);assert.equal(again.id,message.id);
    await json("/v1/messages/"+message.id,{headers:{Authorization:"Bearer "+keyB.key}},404);
    const phoneHeaders={Authorization:"Bearer "+phone.device_token};const poll=await json("/v1/device/poll",{method:"POST",body:{ready:false,permission_granted:false,sim_selected:false},headers:phoneHeaders},200);assert.equal(poll.commands.length,1);assert.equal(poll.commands[0].payload.sandbox,true);
    const command=poll.commands[0];const ack=await json("/v1/device/ack",{method:"POST",body:{command_ids:[command.id]},headers:phoneHeaders},200);assert.deepEqual(ack.acknowledged,[command.id]);
    assert.equal((await DB.prepare("SELECT payload_json FROM commands WHERE id=?").bind(command.id).first()).payload_json,null);
    const event={event_id:"independent-queued-001",message_id:message.id,status:"queued",occurred_at:new Date().toISOString()};
    const one=await json("/v1/device/events",{method:"POST",body:{events:[event]},headers:phoneHeaders},200),two=await json("/v1/device/events",{method:"POST",body:{events:[event]},headers:phoneHeaders},200);assert.deepEqual(one.accepted,two.accepted);
    const historyA=await json("/api/messages",{cookie:aliceCookie},200),historyB=await json("/api/messages",{cookie:bobCookie},200);assert.equal(historyA.messages.length,1);assert.equal(historyB.messages.length,0);
    await call("/api/keys",{method:"POST",body:{name:"CSRF denied"},cookie:aliceCookie,headers:{Origin:website}},403);
    await call("/api/pairings",{method:"POST",body:{},cookie:aliceCookie,headers:{"Sec-Fetch-Site":"cross-site"}},403);
  });
  await check("logout rejects cross-site/GET requests and invalidates the server-side session",async()=>{
    const pending=await start();
    await call("/auth/logout",{cookie:bobCookie},405);
    await call("/auth/logout",{method:"POST",cookie:bobCookie,headers:{Origin:website}},403);
    const result=await call("/auth/logout",{method:"POST",cookie:bobCookie+"; "+pending.cookie,headers:{Origin:api}},303);assert.match(cookies(result).join(";"),/Max-Age=0/i);
    assert.equal(await readBrowserSession(request("/api/account",{cookie:bobCookie}),env),undefined);
    await call("/api/account",{cookie:bobCookie},401);
    const before=networkCalls.length;assert.equal((await finish(pending,"bob")).status,400);assert.equal(networkCalls.length,before,"Logout must cancel a browser's unfinished OAuth flow too.");
  });
  await check("expired and tampered session cookies cannot authenticate",async()=>{
    await call("/api/account",{cookie:aliceCookie+"tampered"},401);
    await call("/api/account",{cookie:aliceCookie+"; "+aliceCookie},401);
    await DB.prepare("UPDATE browser_sessions SET expires_at=?").bind("2000-01-01T00:00:00.000Z").run();
    await call("/api/account",{cookie:aliceCookie},401);
  });
  await check("OAuth provider transport runs inside Workers and rejects redirects without forwarding credentials",async()=>{
    // Node's Request supports redirect:'error', while Workers rejects it before
    // sending a request. Run the callback in the real deployment runtime and
    // make the simulated provider construct a native Workers Request from the
    // exact fetch arguments. There are no outbound HTTP calls in this fixture.
    const runtimeBundle=await build({stdin:{resolveDir:process.cwd(),loader:"ts",contents:`
      import {handleIndependentAuth} from "./lib/independent-auth.ts";
      let providerCalls=[];
      export default {async fetch(request,env){
        const incoming=new URL(request.url);
        if(incoming.pathname==="/fixture-calls")return Response.json(providerCalls);
        const simulatedFetch=async(input,init)=>{
          const transport=new Request(input,init);
          if(transport.redirect!=="manual")throw new Error("Credential redirects must not be followed");
          providerCalls.push(new URL(transport.url).hostname+new URL(transport.url).pathname);
          const fixture=incoming.searchParams.get("fixture");
          if(transport.url==="https://github.com/login/oauth/access_token"){
            if(fixture==="redirect")return new Response(null,{status:302,headers:{Location:"https://credential-sink.example.test/collect"}});
            return Response.json({access_token:"fixture-runtime-access-token",token_type:"bearer",scope:"read:user,user:email"});
          }
          if(transport.url==="https://api.github.com/user")return Response.json({id:4404,login:"runtime-fixture",name:"Runtime Fixture"});
          if(transport.url==="https://api.github.com/user/emails?per_page=100")return Response.json([{email:"runtime@example.test",verified:true,primary:true}]);
          throw new Error("Unexpected provider endpoint");
        };
        return await handleIndependentAuth(request,env,{fetch:simulatedFetch})??new Response(null,{status:404});
      }};
    `},bundle:true,write:false,format:"esm",platform:"browser",target:"es2022"});
    let actualOutbound=0;
    const runtime=new Miniflare({modules:true,script:runtimeBundle.outputFiles[0].text,compatibilityDate:"2026-05-15",d1Databases:["DB"],bindings:{API_ORIGIN:api,WEBSITE_ORIGIN:website,GITHUB_CLIENT_ID:"runtime-fixture-client",GITHUB_CLIENT_SECRET:"runtime-fixture-secret"},outboundService:()=>{actualOutbound++;return new Response("Outbound HTTP is disabled in this fixture",{status:503});},log:new Log(LogLevel.ERROR),cf:false});
    try{
      const db=await runtime.getD1Database("DB");
      for(const file of (await fs.readdir("drizzle")).filter(name=>name.endsWith(".sql")).sort()){
        for(const sql of (await fs.readFile("drizzle/"+file,"utf8")).split("--> statement-breakpoint").map(s=>s.trim()).filter(Boolean))await db.prepare(sql).run();
      }
      const complete=async(fixture)=>{
        const begin=await runtime.dispatchFetch(api+"/auth/github",{redirect:"manual"});assert.equal(begin.status,303);
        const state=new URL(begin.headers.get("location")).searchParams.get("state");
        const query=new URLSearchParams({code:"runtime-fixture",state,fixture});
        return runtime.dispatchFetch(api+"/auth/github/callback?"+query,{redirect:"manual",headers:{Cookie:cookieValue(begin,"__Host-nabda_oauth")}});
      };
      const valid=await complete("success");assert.equal(valid.status,303,await valid.clone().text());assert.ok(cookieValue(valid,"__Host-nabda_session"));
      const successfulCalls=await(await runtime.dispatchFetch(api+"/fixture-calls")).json();assert.equal(successfulCalls.length,3);
      const sessionCount=await db.prepare("SELECT COUNT(*) AS n FROM browser_sessions").first();assert.equal(sessionCount.n,1);
      const denied=await complete("redirect");assert.equal(denied.status,502);assert.equal((await denied.json()).error.code,"github_unavailable");assert.equal(cookieValue(denied,"__Host-nabda_session"),"");
      const afterRedirect=await(await runtime.dispatchFetch(api+"/fixture-calls")).json();assert.equal(afterRedirect.length-successfulCalls.length,1,"A redirect must stop at token exchange, before profile requests or credential forwarding.");assert.ok(!afterRedirect.some(value=>value.includes("credential-sink")));
      assert.equal((await db.prepare("SELECT COUNT(*) AS n FROM browser_sessions").first()).n,1,"Rejected redirects must not create a session.");
      assert.equal(actualOutbound,0,"The runtime regression must never make outbound HTTP requests.");
    }finally{await runtime.dispose();}
  });
} finally {
  await mf.dispose();
  await fs.mkdir("outputs/qa/independent",{recursive:true});
  await fs.writeFile("outputs/qa/independent/api-results.json",JSON.stringify({checks,failures,mocked_provider_requests:networkCalls.length,no_real_network:true,no_phone_or_carrier_calls:true,live_oauth_verified:false},null,2)+"\n");
}
console.log(JSON.stringify({passed:checks.length,failed:failures.length,output:"outputs/qa/independent/api-results.json"}));
if(failures.length)process.exitCode=1;
