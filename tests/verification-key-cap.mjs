import assert from "node:assert/strict";
import fs from "node:fs/promises";
import { build } from "esbuild";
import { Miniflare, convertV4MiniflareOptions, Log, LogLevel } from "miniflare";

// Isolated ephemeral D1; no phone, deployment, network integration or real SMS.
const bundled = await build({
  stdin: { contents: 'import {handleNabdaApi} from "./lib/nabda-api.ts"; export default {fetch:(request,env)=>handleNabdaApi(request,env,{id:"key-cap-test",email:"key-cap@example.test",name:"Key cap test"})};', resolveDir: process.cwd(), loader: "ts" },
  bundle: true, write: false, format: "esm", platform: "browser", target: "es2022",
});
const mf = new Miniflare(convertV4MiniflareOptions({ modules: true, script: bundled.outputFiles[0].text, compatibilityDate: "2026-05-15", d1Databases: ["DB"], log: new Log(LogLevel.ERROR), cf: false }));
try {
  const db = await mf.getD1Database("DB");
  for (const file of (await fs.readdir("drizzle")).filter(name => name.endsWith(".sql")).sort()) {
    for (const sql of (await fs.readFile(`drizzle/${file}`, "utf8")).split("--> statement-breakpoint").map(s => s.trim()).filter(Boolean)) await db.prepare(sql).run();
  }
  const headers = { "content-type": "application/json", Origin: "https://key-cap.test" };
  const call = (path, method = "POST", data = { name: "Isolated test" }) => mf.dispatchFetch(`https://key-cap.test${path}`, { method, headers, ...(method === "POST" ? { body: JSON.stringify(data) } : {}) });
  for (let i = 0; i < 19; i++) assert.equal((await call("/api/keys")).status, 201);
  const concurrent = await Promise.all(Array.from({ length: 20 }, () => call("/api/keys")));
  assert.equal(concurrent.filter(r => r.status === 201).length, 1);
  assert.equal(concurrent.filter(r => r.status === 429).length, 19);
  assert.equal((await db.prepare("SELECT COUNT(*) AS n FROM api_keys WHERE revoked_at IS NULL").first()).n, 20);
  const key = await db.prepare("SELECT id FROM api_keys WHERE revoked_at IS NULL LIMIT 1").first();
  assert.equal((await call(`/api/keys/${key.id}`, "DELETE")).status, 200);
  assert.equal((await call("/api/keys")).status, 201);
  assert.equal((await call("/api/keys")).status, 429);
  assert.equal((await db.prepare("SELECT COUNT(*) AS n FROM api_keys WHERE revoked_at IS NULL").first()).n, 20);
  assert.equal((await db.prepare("SELECT COUNT(*) AS n FROM api_keys").first()).n, 21);
  console.log("PASS atomic key cap: concurrent creation stays at 20; revocation permits one replacement.");
} finally { await mf.dispose(); }
