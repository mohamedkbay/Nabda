import assert from "node:assert/strict";
import fs from "node:fs/promises";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import vm from "node:vm";

// Local mock only: no real phone, SMS, account, external request or live-send flag.
const temporary = await fs.mkdtemp(path.join(os.tmpdir(), "nabda-clients-"));
const content = "  Sandbox message\r\nArabic: تجربة ✨\r\n";
const file = path.join(temporary, "message.txt");
await fs.writeFile(file, content);
const credential = "nb_app_" + "a".repeat(64);
const requests = [];
let mode = "normal";
const server = http.createServer(async (request, response) => {
  let raw = ""; for await (const part of request) raw += part;
  requests.push({ url: request.url, method: request.method, headers: request.headers, body: raw ? JSON.parse(raw) : null });
  response.setHeader("Content-Type", "application/json");
  if (mode === "redirect") { response.writeHead(302, { Location: "/redirected" }); response.end("{}"); return; }
  if (mode === "error") { response.writeHead(500); response.end(JSON.stringify({ error: { message: credential } })); return; }
  if (request.url === "/health") response.end(JSON.stringify({ status: "ok", mode: "phone-owned", version: "0.2.0" }));
  else if (request.url === "/v1/usage") response.end(JSON.stringify({ accepted_commands: 1 }));
  else if (request.url === "/v1/messages") { response.writeHead(202); response.end(JSON.stringify({ id: "mock-message", status: "accepted", sandbox: true })); }
  else if (request.url.endsWith("/cancellations")) response.end(JSON.stringify({ id: "mock-message", status: "cancelled", guaranteed: true }));
  else response.end(JSON.stringify({ id: "mock-message", status: "queued" }));
});
await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
const base = `http://127.0.0.1:${server.address().port}`;
const environment = { ...process.env, NABDA_BASE_URL: base, NABDA_API_KEY: credential, NABDA_DEVICE_ID: "mock-device", NABDA_TO: "MOCK_RECIPIENT_NO_REAL_PHONE" };
function run(binary, prefix, args, extra = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(binary, [...prefix, ...args], { env: { ...environment, ...extra }, stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "", stderr = "";
    child.stdout.on("data", chunk => { stdout += chunk; });
    child.stderr.on("data", chunk => { stderr += chunk; });
    child.on("error", reject);
    child.on("close", code => { assert.ok(!stdout.includes(credential) && !stderr.includes(credential), "Never print the credential"); resolve({ code, stdout, stderr }); });
  });
}
let checks = 0;
try {
  for (const [binary, prefix] of [[process.execPath, ["public/api-kit/nabda.mjs"]], ["python3", ["public/api-kit/nabda.py"]]]) {
    assert.equal((await run(binary, prefix, ["--help"], { NABDA_BASE_URL: "", NABDA_API_KEY: "" })).code, 0); checks++;
    assert.equal((await run(binary, prefix, ["health"], { NABDA_API_KEY: "" })).code, 0);
    assert.equal(requests.at(-1).headers.authorization, undefined); checks++;
    assert.equal(requests.at(-1).headers["user-agent"], "Nabda-Free-Starter/0.2.0");
    const args = ["send", "--content-file", file, "--idempotency-key", "sandbox-stable-request-1"];
    for (let retry = 0; retry < 2; retry++) {
      assert.equal((await run(binary, prefix, args)).code, 0);
      const request = requests.at(-1);
      assert.equal(request.headers.authorization, `Bearer ${credential}`);
      assert.equal(request.headers["idempotency-key"], "sandbox-stable-request-1");
      assert.deepEqual(request.body, { device_id: "mock-device", to: "MOCK_RECIPIENT_NO_REAL_PHONE", content, sandbox: true }); checks++;
    }
    for (const [command, endpoint] of [["status", "/v1/messages/mock-message"], ["cancel", "/v1/messages/mock-message/cancellations"]]) {
      assert.equal((await run(binary, prefix, [command, "--id", "mock-message"])).code, 0);
      assert.equal(requests.at(-1).url, endpoint); checks++;
    }
    assert.equal((await run(binary, prefix, ["usage"])).code, 0); checks++;
    const before = requests.length;
    assert.equal((await run(binary, prefix, ["usage"], { NABDA_BASE_URL: "http://remote.invalid" })).code, 1);
    assert.equal((await run(binary, prefix, ["usage"], { NABDA_BASE_URL: base + "/prefix" })).code, 1);
    assert.equal((await run(binary, prefix, ["usage"], { NABDA_API_KEY: "" })).code, 1);
    assert.equal((await run(binary, prefix, ["send", "--content-file", file, "--idempotency-key", "short"])).code, 1);
    assert.equal(requests.length, before); checks++;
    mode = "redirect";
    assert.equal((await run(binary, prefix, ["usage"])).code, 1);
    assert.equal(requests.length, before + 1); checks++;
    mode = "error";
    const result = await run(binary, prefix, ["usage"]);
    assert.equal(result.code, 1); assert.match(result.stdout, /REDACTED/); checks++;
    mode = "normal";
  }
  const collection = JSON.parse(await fs.readFile("public/api-kit/Nabda.postman_collection.json", "utf8"));
  const environmentFile = JSON.parse(await fs.readFile("public/api-kit/Nabda.postman_environment.json", "utf8"));
  assert.ok(environmentFile.values.every(value => value.value === "")); checks++;
  const variables = { base_url: base, api_key: credential, device_id: "mock-device", to: "MOCK_RECIPIENT_NO_REAL_PHONE", content, idempotency_key: "sandbox-postman-request-1" };
  const generated = {};
  const context = { pm: { environment: { get: key => variables[key] }, variables: { set: (key, value) => { generated[key] = value; } }, info: { requestName: "Send sandbox message" } } };
  const preRequest = collection.event.find(event => event.listen === "prerequest").script.exec.join("\n");
  vm.runInNewContext(preRequest, context);
  assert.equal(JSON.parse(generated.send_payload).sandbox, true);
  assert.equal(JSON.parse(generated.send_payload).content, content);
  variables.base_url = "http://remote.invalid";
  assert.throws(() => vm.runInNewContext(preRequest, context));
  assert.ok(collection.item.every(item => item.protocolProfileBehavior.followRedirects === false)); checks++;
  console.log(`PASS ${checks} starter client/Postman checks; local mocks and sandbox payloads only.`);
} finally {
  await new Promise(resolve => server.close(resolve));
  await fs.rm(temporary, { recursive: true, force: true });
}
