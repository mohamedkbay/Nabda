import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';

// Explicitly authorized sandbox-only protocol verification. Hosted mode needs
// an expressly supplied authenticated visitor cookie, not a Sites service token.
// Local mode uses only the supported loopback mock sign-in route. Credentials
// remain in memory; no credentials are accepted from args/env/files.
async function privateInput() {
 const stdin=process.stdin;const raw=Boolean(stdin.isTTY&&stdin.setRawMode);
 if(raw)stdin.setRawMode(true);
 stdin.setEncoding('utf8');
 process.stdout.write('Ready for private credential JSON (input hidden).\n');
 try{return await new Promise((resolve,reject)=>{
  let value='';
  function done(error){stdin.off('data',data);stdin.off('end',ended);stdin.pause();error?reject(error):resolve(value);}
  function ended(){value?done():done(new Error('Private credential input was empty.'));}
  function data(chunk){for(const character of chunk){if(character==='\u0003')return done(new Error('Cancelled before verification.'));if(character==='\r'||character==='\n')return done();if(character==='\u007f'||character==='\b'){value=value.slice(0,-1);continue;}value+=character;if(value.length>65536)return done(new Error('Private input is too large.'));}}
  stdin.on('data',data);stdin.once('end',ended);stdin.resume();
 });}finally{if(raw)stdin.setRawMode(false);}
}

let input;
try{input=JSON.parse(await privateInput());}catch{console.error('Private input was cancelled or invalid. No verification requests were made.');process.exit(1);}
assert.ok(['owned-hosted-sandbox-protocol','owned-local-sandbox-protocol'].includes(input.authorization),'Explicit owned sandbox authorization is required.');
const local=input.authorization==='owned-local-sandbox-protocol';
const origin=new URL(input.origin).origin;
const ownerHeaders=new Headers();
if(local){
 assert.ok(['127.0.0.1','localhost'].includes(new URL(origin).hostname),'Local mode requires loopback.');
 assert.ok(['http:','https:'].includes(new URL(origin).protocol));
 assert.equal(Object.keys(input.owner_headers||{}).length,0,'Local mode obtains its own development cookie through supported sign-in.');
}else{
 assert.equal(new URL(origin).protocol,'https:','Hosted verification requires HTTPS.');
 assert.ok(input.owner_headers&&typeof input.owner_headers==='object'&&!Array.isArray(input.owner_headers),'Supply expressly authorized visitor credentials.');
 for(const [name,value] of Object.entries(input.owner_headers)){
  assert.ok(!name.toLowerCase().startsWith('oai-authenticated-user-'),'Caller-supplied identity headers are not trusted.');
  assert.equal(typeof value,'string');try{ownerHeaders.set(name,value);}catch{throw new Error('Invalid private header format; credential value omitted.');}
 }
 assert.ok(ownerHeaders.get('cookie'),'Hosted mode requires an expressly supplied authenticated visitor cookie; a Sites service bypass supplies no visitor identity.');
}
// This is a reserved documentation number, never attached to a real handset.
const recipient='+12025550123';
const runId=crypto.randomUUID();const checks=[],cleanupErrors=[];
let appKeyId,appKey,deviceId,deviceToken,messageId,organizationId;

async function request(route,{method='GET',body,token,owner=false,idempotency}={}){
 assert.ok(route.startsWith('/')&&!route.startsWith('//'));
 if(route==='/v1/messages'&&method==='POST')assert.equal(body?.sandbox,true,'Live messages are forbidden in this harness.');
 const headers=owner?new Headers(ownerHeaders):new Headers();
 headers.set('Accept','application/json');
 if(owner)headers.set('Origin',origin);
 if(token)headers.set('Authorization',`Bearer ${token}`);
 if(body!==undefined)headers.set('Content-Type','application/json');
 if(idempotency)headers.set('Idempotency-Key',idempotency);
 const response=await fetch(origin+route,{method,headers,body:body===undefined?undefined:JSON.stringify(body),redirect:'manual',signal:AbortSignal.timeout(20000)});
 if(!response.headers.get('content-type')?.includes('application/json'))throw new Error(`${method} ${route}: expected JSON, received HTTP ${response.status}.`);
 return{status:response.status,body:await response.json()};
}
async function expect(route,options,status){const response=await request(route,options);assert.equal(response.status,status,`${options?.method||'GET'} ${route}: HTTP ${response.status}, expected ${status}.`);return response.body;}
function pass(name){checks.push(name);console.log(`PASS ${name}`);}
const pollBody={ready:false,permission_granted:false,sim_selected:false,app_version:'release-sandbox-emulator',android_version:'simulated-no-modem'};
let failure;
try{
 if(local){
  const signIn=await fetch(origin+'/signin-with-chatgpt?return_to=%2Fdashboard',{redirect:'manual',signal:AbortSignal.timeout(20000)});
  assert.equal(signIn.status,302,'The supported local mock sign-in route must respond.');
  const cookies=signIn.headers.getSetCookie();const cookie=cookies.find(value=>value.startsWith('__sites_local_auth=1;'));
  assert.ok(cookie,'Supported local sign-in did not issue its development cookie.');ownerHeaders.set('Cookie',cookie.split(';')[0]);
  pass('supported loopback Sites mock sign-in establishes development identity');
 }
 const account=await expect('/api/account',{owner:true},200);organizationId=account.organization.id;
 if(input.expected_organization_id)assert.equal(organizationId,input.expected_organization_id,'Owner workspace differs from the authorized workspace.');
 pass(local?'local development identity reaches its workspace':'authenticated Sites visitor reaches the expected workspace');
 const key=await expect('/api/keys',{method:'POST',owner:true,body:{name:'Release sandbox verification'}},201);appKeyId=key.id;appKey=key.key;
 const pairing=await expect('/api/pairings',{method:'POST',owner:true,body:{name:'Release sandbox verification (not a phone)'}},201);
 const paired=await expect('/v1/device/pair',{method:'POST',body:{pairing_token:pairing.pairing_token,name:'Release sandbox verification (not a phone)',app_version:'release-sandbox-emulator',android_version:'simulated-no-modem'}},201);deviceId=paired.device_id;deviceToken=paired.device_token;
 pass('one disposable app key and one explicitly simulated device created');
 const payload={device_id:deviceId,to:recipient,content:'Sandbox protocol verification. No physical phone or carrier submission.',sandbox:true};
 const message=await expect('/v1/messages',{method:'POST',token:appKey,body:payload,idempotency:`release-sandbox-${runId}`},202);messageId=message.id;assert.equal(message.sandbox,true);assert.equal(message.status,'accepted');
 const repeated=await expect('/v1/messages',{method:'POST',token:appKey,body:payload,idempotency:`release-sandbox-${runId}`},202);assert.equal(repeated.id,messageId);
 pass('one sandbox message accepted and idempotent replay returns the same ID');
 const poll=await expect('/v1/device/poll',{method:'POST',token:deviceToken,body:pollBody},200);
 assert.ok(poll.poll_after_ms>=60000);const commands=poll.commands.filter(command=>command.message_id===messageId);assert.equal(commands.length,1);const command=commands[0];assert.equal(command.type,'message.send');assert.equal(command.payload.sandbox,true);
 const redelivery=await expect('/v1/device/poll',{method:'POST',token:deviceToken,body:pollBody},200);assert.equal(redelivery.commands.find(item=>item.message_id===messageId)?.id,command.id);
 pass('unacknowledged sandbox command is durably redelivered');
 const ack=await expect('/v1/device/ack',{method:'POST',token:deviceToken,body:{command_ids:[command.id]}},200);assert.ok(ack.acknowledged.includes(command.id));
 const duplicateAck=await expect('/v1/device/ack',{method:'POST',token:deviceToken,body:{command_ids:[command.id]}},200);assert.ok(duplicateAck.acknowledged.includes(command.id));
 const handedOff=await expect(`/v1/messages/${messageId}`,{token:appKey},200);assert.equal(handedOff.status,'on_device');assert.ok(handedOff.handed_off_at);assert.equal(handedOff.content,undefined);assert.equal(handedOff.to,undefined);
 assert.ok(!(await expect('/v1/device/poll',{method:'POST',token:deviceToken,body:pollBody},200)).commands.some(item=>item.id===command.id));
 pass('handoff ACK is repeatable and removes the command from polling');
 const queued={event_id:crypto.randomUUID(),message_id:messageId,status:'queued',occurred_at:new Date().toISOString()};
 await expect('/v1/device/events',{method:'POST',token:deviceToken,body:{events:[queued]}},200);
 await expect('/v1/device/events',{method:'POST',token:deviceToken,body:{events:[queued]}},200);
 await expect('/v1/device/events',{method:'POST',token:deviceToken,body:{events:[{event_id:crypto.randomUUID(),message_id:messageId,status:'cancelled',occurred_at:new Date().toISOString(),failure_code:'SANDBOX_EMULATOR_NO_CARRIER'}]}},200);
 const final=await expect(`/v1/messages/${messageId}`,{token:appKey},200);assert.equal(final.status,'cancelled');assert.equal(final.sandbox,true);
 const history=await expect('/api/messages?limit=25',{owner:true},200);assert.ok(history.messages.some(item=>item.id===messageId&&item.sandbox===true&&item.status==='cancelled'));
 pass('emulated queued event deduplicates and resolves to cancelled, without delivery claims');
 const usage=await expect('/v1/usage',{token:appKey},200);assert.equal(usage.source,'device_reported');
 pass('usage and account history remain readable through their respective credentials');
}catch(error){failure=error;console.error(`FAIL ${error.message}`);}finally{
 for(const [kind,id] of [['keys',appKeyId],['devices',deviceId]]){
  if(!id)continue;
  try{await expect(`/api/${kind}/${id}`,{method:'DELETE',owner:true},200);}catch(error){cleanupErrors.push({kind,id,error:error.message});}
 }
 if(!cleanupErrors.length&&appKey&&deviceToken){
  try{await expect('/v1/usage',{token:appKey},401);await expect('/v1/device/poll',{method:'POST',token:deviceToken,body:pollBody},401);pass('disposable credentials revoked and rejected afterward');}catch(error){cleanupErrors.push({kind:'revocation-check',error:error.message});}
 }
 const report={origin,mode:local?'supported-local-mock-auth':'authenticated-hosted-visitor',hosted_authenticated_flow_proven:!local&&!failure,run_id:runId,organization_id:organizationId,device_id:deviceId,message_id:messageId,sandbox:true,physical_phone:false,carrier_submission:false,delivery_claim:false,checks,failure:failure?.message||null,cleanup_errors:cleanupErrors};
 const directory=path.resolve('outputs/qa/free-release');await mkdir(directory,{recursive:true});await writeFile(path.join(directory,local?'local-protocol-results.json':'hosted-protocol-results.json'),JSON.stringify(report,null,2)+'\n');
 console.log(JSON.stringify(report,null,2));
 // Never serialize the input object, headers, raw app key, or device token.
}
if(failure||cleanupErrors.length)process.exitCode=1;
