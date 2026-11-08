import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const origin = process.env.NABDA_PREVIEW_URL || 'http://127.0.0.1:5173';
if (!['localhost', '127.0.0.1'].includes(new URL(origin).hostname)) throw new Error('This harness only writes to owned local preview accounts.');
const modulePath = process.env.PLAYWRIGHT_MODULE || '/Users/mohamedbay/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules/playwright/index.mjs';
const { chromium } = await import(pathToFileURL(modulePath).href);
const output = path.resolve('outputs/qa');
const finalPass = process.env.NABDA_QA_FINAL === '1';
const uiOnly = process.env.NABDA_QA_UI_ONLY === '1';
const menuOnly = process.env.NABDA_QA_MENU_ONLY === '1';
await mkdir(output, { recursive: true });
const browser = await chromium.launch({ executablePath: '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', headless: true });
const failures = [], screenshots = [], passed = [], consoleErrors = [], failedRequests = [];
async function check(name, run) { if (menuOnly && !name.includes('fullscreen menu') && !name.startsWith('browser produces')) return; try { await run(); passed.push(name); console.log(`PASS ${name}`); } catch (error) { failures.push({ name, error: error.message }); console.error(`FAIL ${name}: ${error.message}`); } }
function observe(page) { page.on('pageerror', e => consoleErrors.push(e.message)); page.on('requestfailed', r => { if (!r.failure()?.errorText?.includes('ERR_ABORTED')) failedRequests.push({ url: r.url(), error: r.failure()?.errorText }); }); }
async function shot(page, name, fullPage = true) { const file = path.join(output, `${finalPass ? 'final-' : ''}${name}.png`); await page.screenshot({ path: file, fullPage, animations: 'disabled' }); screenshots.push(file); }
async function ready(page, route) { const response = await page.goto(`${origin}${route}`, { waitUntil: 'networkidle' }); assert.equal(response.status(), 200); await page.locator('h1').waitFor(); }
async function noOverflow(page) { const widths = await page.evaluate(() => ({ viewport: innerWidth, doc: document.documentElement.scrollWidth })); assert.ok(widths.doc <= widths.viewport + 1, JSON.stringify(widths)); }
const desktop = await browser.newContext({ viewport: { width: 1440, height: 1000 }, permissions: ['clipboard-read', 'clipboard-write'] });
const page = await desktop.newPage(); observe(page);
async function menuQA(target, device) {
 for (const language of ['en', 'ar']) {
  await ready(target, '/');
  const desired = language === 'ar' ? 'rtl' : 'ltr';
  if (await target.evaluate(() => document.documentElement.dir) !== desired) await target.locator('header .language-switch').click();
  await target.waitForFunction(dir => document.documentElement.dir === dir, desired);
  assert.equal(await target.locator('header nav').count(), 0, 'Header should use one fullscreen menu, with no duplicate inline navigation.');
  const trigger = target.locator('header .menu-toggle'); assert.ok(await trigger.isVisible());
  await trigger.click(); const dialog = target.locator('#nabda-menu'); await dialog.waitFor({state:'visible'});
  const masks=await dialog.evaluate(element=>Array.from(element.querySelectorAll('[data-menu-motion="panel"]')).filter(part=>part.getClientRects().length>0).map(part=>part.getAnimations()[0]?.effect?.getKeyframes()?.[0]?.clipPath));
  assert.ok(new Set(masks.filter(Boolean)).size>=2,'Visible menu panels should assemble from more than one direction.');
  if(language==='en') { await target.waitForTimeout(200); const file=path.join(output,`final-${device}-menu-opening-200ms.png`); await target.screenshot({path:file,fullPage:false,animations:'allow'}); screenshots.push(file); }
  await target.locator('#nabda-menu[data-motion-state="open"][open]').waitFor({state:'visible'});
  assert.equal(await trigger.getAttribute('aria-expanded'), 'true');
  assert.equal(await target.evaluate(() => document.body.style.overflow), 'hidden');
  assert.equal(await target.evaluate(() => document.activeElement?.className), 'menu-close');
  await target.keyboard.press('Shift+Tab'); assert.ok(await target.evaluate(() => !!document.activeElement?.closest('#nabda-menu')));
  await target.keyboard.press('Tab'); assert.equal(await target.evaluate(() => document.activeElement?.className), 'menu-close');
  for (let index=0;index<20;index++) { await target.keyboard.press('Tab'); assert.ok(await target.evaluate(() => !!document.activeElement?.closest('#nabda-menu')), `focus escaped at Tab ${index}`); }
  const dialogWidths = await dialog.evaluate(element => ({ client: element.clientWidth, scroll: element.scrollWidth })); assert.ok(dialogWidths.scroll <= dialogWidths.client + 1, JSON.stringify(dialogWidths));
  const scrollBefore = await target.evaluate(() => scrollY); await target.mouse.wheel(0,500); await target.evaluate(() => new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve)))); assert.equal(await target.evaluate(() => scrollY), scrollBefore);
  await noOverflow(target); await shot(target, `${device}-menu-${language}`, false);
  await target.keyboard.press('Escape'); await dialog.waitFor({state:'hidden'}); await target.waitForFunction(() => document.body.style.overflow === '');
  assert.equal(await target.evaluate(() => document.activeElement?.className), 'menu-toggle');
  await trigger.click(); await target.locator('#nabda-menu[data-motion-state="open"][open]').waitFor({state:'visible'}); await dialog.locator('.menu-directory-footer .language-switch').click();
  await target.waitForFunction(dir => document.documentElement.dir !== dir, desired); assert.ok(await dialog.isVisible());
  await dialog.locator('.menu-directory-footer .language-switch').click(); await target.waitForFunction(dir => document.documentElement.dir === dir, desired);
  await dialog.locator('.menu-primary-link[href="/docs"]').click(); await target.waitForURL('**/docs'); await dialog.waitFor({state:'hidden'}); await target.waitForFunction(() => document.body.style.overflow === '');
 }
}
let keyId, deviceId;
try {
 await check('desktop public routes render substantive English content without overflow', async () => {
  for (const route of ['/', '/how-it-works', '/docs', '/docs/messages', '/docs/authentication', '/docs/installation', '/docs/testing', '/docs/phone-queue', '/docs/limits', '/support', '/download', '/help', '/privacy', '/terms']) {
   await ready(page, route); assert.ok((await page.locator('main').innerText()).length > 200, route); await noOverflow(page);
   if (['/', '/docs/messages', '/support', '/download'].includes(route)) await shot(page, `desktop-${route === '/' ? 'home' : route.slice(1).replaceAll('/', '-')}-en`);
  }
 });
 await check('support details and clipboard retain exact values and leading zero', async () => {
  await ready(page, '/support'); const rows = page.locator('.payment-row'); assert.equal(await rows.count(), 2);
  for (const [index, exact] of ['LY93007011011011325337018', '011011325337018'].entries()) {
   assert.equal(await rows.nth(index).locator('code').textContent(), exact); await rows.nth(index).getByRole('button').click(); assert.equal(await page.evaluate(() => navigator.clipboard.readText()), exact);
  }
  assert.equal(await page.locator('main img, main svg[role="img"]').count(), 0); assert.equal(await page.locator('main a[href^="http"]').count(), 0);
  assert.match(await page.locator('main').innerText(), /doesn't change your access/);
 });
 await check('docs nested routes, search, and previous/next navigation work', async () => {
  await ready(page, '/docs/messages'); await page.locator('.docs-search').fill('API keys'); await page.locator('.docs-sidebar nav a').first().waitFor(); assert.equal(await page.locator('.docs-sidebar nav a').count(), 1); await page.locator('.docs-sidebar nav a').click(); await page.waitForURL('**/docs/authentication'); assert.match(await page.locator('main').innerText(), /A key for your application/); await page.locator('.docs-search').fill('');
  await page.locator('.doc-nav a').last().click(); await page.waitForURL('**/docs/messages');
 });
 await check('privacy describes temporary server command storage truthfully', async () => { await ready(page, '/privacy'); assert.match(await page.locator('main').innerText(), /temporarily contains the text and recipient/); assert.match(await page.locator('main').innerText(), /Status and timing metadata remain/); });
 await check('Android download resolves to an actual APK zip, not an HTML fallback', async () => { const r = await page.request.get(`${origin}/downloads/Nabda-Android-0.2.0.apk`); assert.equal(r.status(), 200); const b = await r.body(); assert.equal(b.subarray(0, 2).toString(), 'PK'); assert.ok(b.length > 100_000); });
 await check('public identity spoofing cannot access management through Sites middleware', async () => { const anonymous = await browser.newContext(); const r = await anonymous.request.get(`${origin}/api/account`, { headers: { 'oai-authenticated-user-id': 'attacker', 'oai-authenticated-user-email': 'qa@example.test' } }); assert.equal(r.status(), 401); await anonymous.close(); });
 await check('anonymous dashboard displays sign-in, local supported sign-in opens account', async () => { await ready(page, '/dashboard'); await page.getByRole('link', { name: 'Continue with ChatGPT' }).click(); await page.waitForURL('**/dashboard'); await page.getByRole('heading', { name: 'Your workspace.' }).waitFor(); await shot(page, 'desktop-dashboard-en'); });
 await check(uiOnly ? 'dashboard key and activity tabs render without creating work' : 'dashboard creates usable QR and API key, sandbox protocol appears in history', async () => {
  if (uiOnly) { await page.getByRole('button', {name:'API keys',exact:true}).click(); await page.getByRole('heading',{name:'Application keys'}).waitFor(); await page.getByRole('button',{name:'Activity',exact:true}).click(); await page.getByRole('heading',{name:'What the server knows'}).waitFor(); await shot(page,'desktop-dashboard-activity-en'); return; }
  await page.getByLabel("A name you'll recognize").fill('QA sandbox handset'); const pairResponse = page.waitForResponse(r => r.url() === `${origin}/api/pairings` && r.request().method() === 'POST'); await page.getByRole('button', { name: 'Create pairing code' }).click(); const pairing = await (await pairResponse).json(); const img = page.getByAltText('Temporary pairing QR, scan with Nabda Android'); await img.waitFor(); assert.match(await img.getAttribute('src'), /^data:image\/png;base64,/); assert.equal(pairing.qr.server_url, origin);
  const paired = await page.request.post(`${origin}/v1/device/pair`, { data: { pairing_token: pairing.pairing_token, name: 'QA sandbox handset', app_version: 'qa', android_version: 'sandbox' } }); assert.equal(paired.status(), 201); const device = await paired.json(); deviceId = device.device_id;
  await page.getByRole('button', { name: 'API keys', exact: true }).click(); await page.getByLabel('Application name').fill('QA browser sandbox'); const keyResponse = page.waitForResponse(r => r.url() === `${origin}/api/keys` && r.request().method() === 'POST'); await page.getByRole('button', { name: 'Create API key' }).click(); const createdKey = await (await keyResponse).json(); const key = createdKey.key; keyId = createdKey.id; assert.match(key, /^nb_app_/); await page.getByRole('button', { name: 'Hide key' }).click();
  const create = await page.request.post(`${origin}/v1/messages`, { headers: { Authorization: `Bearer ${key}`, 'Idempotency-Key': `qa-browser-${Date.now()}` }, data: { device_id: deviceId, to: '+218910000000', content: 'Sandbox verification only. No physical transport.', sandbox: true } }); assert.equal(create.status(), 202); const message = await create.json();
  const dh = { Authorization: `Bearer ${device.device_token}` }; const poll = await page.request.post(`${origin}/v1/device/poll`, { headers: dh, data: { ready: true, permission_granted: true, sim_selected: true } }); assert.equal(poll.status(), 200); const commands = (await poll.json()).commands; assert.ok(commands.some(c => c.type === 'message.send' && c.payload.sandbox === true));
  const ack = await page.request.post(`${origin}/v1/device/ack`, { headers: dh, data: { command_ids: commands.map(c => c.id) } }); assert.equal(ack.status(), 200);
  await page.getByRole('button', { name: 'Activity', exact: true }).click(); await page.getByText(message.id, { exact: true }).waitFor(); assert.match(await page.locator('main').innerText(), /On device/); assert.equal(await page.getByText('Sandbox verification only. No physical transport.', { exact: true }).count(), 0); await shot(page, 'desktop-dashboard-activity-en');
 });
 await check('Arabic changes content, direction and persists across routes', async () => { await ready(page, '/'); await page.getByRole('button', { name: 'التبديل للعربية' }).click(); await page.waitForFunction(() => document.documentElement.dir === 'rtl' && document.documentElement.lang === 'ar'); assert.match(await page.locator('h1').innerText(), /هاتفك/); await shot(page, 'desktop-home-ar'); await ready(page, '/docs/messages'); await page.waitForFunction(() => document.documentElement.dir === 'rtl'); await noOverflow(page); await shot(page, 'desktop-docs-messages-ar'); });
 const mobile = await browser.newContext({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true }); const phone = await mobile.newPage(); observe(phone);
 await check('mobile English and Arabic navigation, docs and support fit viewport', async () => {
  for (const route of ['/', '/docs/messages', '/support', '/download', '/dashboard']) { await ready(phone, route); await noOverflow(phone); if (['/', '/docs/messages', '/support'].includes(route)) await shot(phone, `mobile-${route === '/' ? 'home' : route.slice(1).replaceAll('/', '-')}-en`); }
  await ready(phone, '/'); await phone.getByRole('button', { name: 'Open all pages' }).click(); await phone.locator('#nabda-menu .menu-primary-link[href="/docs"]').click(); await phone.waitForURL('**/docs'); await phone.getByRole('button', { name: 'التبديل للعربية' }).click(); await phone.waitForFunction(() => document.documentElement.dir === 'rtl');
  for (const route of ['/', '/docs/messages', '/support']) { await ready(phone, route); await phone.waitForFunction(() => document.documentElement.dir === 'rtl'); await noOverflow(phone); await shot(phone, `mobile-${route === '/' ? 'home' : route.slice(1).replaceAll('/', '-')}-ar`); }
 });
 await check('desktop fullscreen menu keyboard, close, scroll lock, links and locale', async()=>{await menuQA(page,'desktop');});
 await check('mobile fullscreen menu keyboard, close, scroll lock, links and locale', async()=>{await menuQA(phone,'mobile');});
 await check('reduced-motion fullscreen menu opens and closes without active animations',async()=>{const context=await browser.newContext({viewport:{width:390,height:844},reducedMotion:'reduce'});const reduced=await context.newPage();observe(reduced);await ready(reduced,'/');await reduced.locator('header .menu-toggle').click();await reduced.locator('#nabda-menu[data-motion-state="open"][open]').waitFor({state:'visible'});assert.equal(await reduced.locator('dialog').evaluate(element=>element.getAnimations({subtree:true}).filter(animation=>animation.playState==='running').length),0);await reduced.keyboard.press('Escape');await reduced.locator('dialog').waitFor({state:'hidden'});await reduced.waitForFunction(()=>document.body.style.overflow==='');assert.equal(await reduced.evaluate(()=>document.activeElement?.className),'menu-toggle');await context.close();});
 await mobile.close();
 await check('browser produces no uncaught app errors or failed assets', async () => { assert.deepEqual(consoleErrors, []); assert.deepEqual(failedRequests, []); });
} finally {
 if (keyId) await page.request.delete(`${origin}/api/keys/${keyId}`);
 if (deviceId) await page.request.delete(`${origin}/api/devices/${deviceId}`);
 await writeFile(path.join(output, menuOnly ? 'final-menu-results.json' : finalPass ? 'final-browser-results.json' : 'browser-results.json'), JSON.stringify({ origin, uiOnly, passed, failures, consoleErrors, failedRequests, screenshots }, null, 2));
 await browser.close();
}
console.log(JSON.stringify({ passed: passed.length, failed: failures.length, output }, null, 2));
if (failures.length) process.exitCode = 1;
