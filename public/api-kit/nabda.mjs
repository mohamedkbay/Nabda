#!/usr/bin/env node
// Node.js 22+; standard library only. Application credentials stay in environment variables.
import { readFile } from "node:fs/promises";

const help = `Nabda 0.2.0 application client — Node.js 22+

Environment:
  NABDA_BASE_URL    HTTPS origin of your Nabda site (HTTP only for loopback development)
  NABDA_API_KEY     Application key from the dashboard; never pass it as an argument
  NABDA_DEVICE_ID   Linked Android device ID (used by send)
  NABDA_TO          Optional recipient; --to overrides this value

Commands:
  node nabda.mjs health
  node nabda.mjs usage
  node nabda.mjs send --content-file message.txt --idempotency-key YOUR_UNIQUE_REQUEST_KEY [--to YOUR_RECIPIENT] [--send-at RFC3339] [--expires-at RFC3339] [--live]
  node nabda.mjs status --id MESSAGE_ID
  node nabda.mjs cancel --id MESSAGE_ID

Send explicitly sets sandbox=true unless --live is present. A sandbox command still
uses platform allowance and needs the linked phone to process it. A 202 response
means accepted, not delivered. Reuse the SAME key and payload after a timeout;
choose a new idempotency key only for a genuinely new message. No automatic retries.
`;

function fail(message) { throw new Error(message); }
function options(args, allowed) {
  const values = {};
  for (let i = 0; i < args.length; i++) {
    const name = args[i];
    if (!allowed.includes(name) || Object.hasOwn(values, name)) fail(`Unknown or repeated option: ${name}`);
    if (name === "--live") values[name] = true;
    else {
      const value = args[++i];
      if (!value || value.startsWith("--")) fail(`Missing value for ${name}`);
      values[name] = value;
    }
  }
  return values;
}
function origin() {
  let url;
  try { url = new URL(process.env.NABDA_BASE_URL ?? ""); } catch { fail("Set NABDA_BASE_URL to your Nabda HTTPS origin."); }
  if (url.username || url.password || url.search || url.hash || url.pathname !== "/") fail("NABDA_BASE_URL must be an origin, without credentials, path, query or fragment.");
  const loopback = ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname);
  if (url.protocol !== "https:" && !(url.protocol === "http:" && loopback)) fail("Use HTTPS. HTTP is allowed only for localhost/loopback development.");
  return url.origin;
}
function identifier(value) {
  if (!value || value.length > 80 || /[\s/\\?#]/.test(value)) fail("Set --id to a message ID returned by Nabda.");
  return encodeURIComponent(value);
}

async function main() {
  const [command, ...args] = process.argv.slice(2);
  if (!command || command === "--help" || command === "help") { console.log(help); return; }
  let path, method = "GET", payload, idempotency;
  switch (command) {
    case "health": options(args, []); path = "/health"; break;
    case "usage": options(args, []); path = "/v1/usage"; break;
    case "status": { const opts = options(args, ["--id"]); path = `/v1/messages/${identifier(opts["--id"])}`; break; }
    case "cancel": { const opts = options(args, ["--id"]); path = `/v1/messages/${identifier(opts["--id"])}/cancellations`; method = "POST"; payload = {}; break; }
    case "send": {
      const opts = options(args, ["--content-file", "--idempotency-key", "--to", "--send-at", "--expires-at", "--live"]);
      if (!opts["--content-file"]) fail("Set --content-file to a UTF-8 text file.");
      const content = await readFile(opts["--content-file"], "utf8");
      if (!content.trim() || content.length > 4000) fail("Message must contain 1–4,000 UTF-16 units; whitespace is preserved.");
      idempotency = opts["--idempotency-key"];
      if (!idempotency || !/^[\x21-\x7e]{8,128}$/.test(idempotency)) fail("Set --idempotency-key to 8–128 printable non-space ASCII characters. Keep it for retries.");
      const device = process.env.NABDA_DEVICE_ID;
      const to = opts["--to"] ?? process.env.NABDA_TO;
      if (!device || device.length > 80) fail("Set NABDA_DEVICE_ID to your linked phone ID.");
      if (!to?.trim()) fail("Set NABDA_TO or --to to your own test recipient.");
      payload = { device_id: device, to, content, sandbox: !opts["--live"] };
      for (const [option, field] of [["--send-at", "send_at"], ["--expires-at", "expires_at"]]) {
        if (opts[option]) payload[field] = opts[option];
      }
      if (opts["--live"]) console.error("Live request: sandbox=false. Carrier charges may apply; 202 means accepted, not sent.");
      path = "/v1/messages"; method = "POST"; break;
    }
    default: fail("Unknown command. Run node nabda.mjs --help.");
  }
  const base = origin();
  const headers = { Accept: "application/json", "User-Agent": "Nabda-Free-Starter/0.2.0" };
  let credential = "";
  if (command !== "health") {
    credential = process.env.NABDA_API_KEY ?? "";
    if (!/^nb_app_[a-f0-9]{64}$/.test(credential)) fail("Set NABDA_API_KEY to an application key from the dashboard.");
    headers.Authorization = `Bearer ${credential}`;
  }
  if (payload !== undefined) headers["Content-Type"] = "application/json";
  if (idempotency) headers["Idempotency-Key"] = idempotency;
  let response;
  try {
    response = await fetch(base + path, { method, headers, ...(payload === undefined ? {} : { body: JSON.stringify(payload) }), redirect: "error", signal: AbortSignal.timeout(30_000) });
  } catch { fail("Request failed or timed out. For send, retry with the identical Idempotency-Key and payload; do not create a new key."); }
  const text = await response.text();
  let value;
  try { value = JSON.parse(text); } catch { fail(`HTTP ${response.status}: expected JSON. Check NABDA_BASE_URL and proxy configuration.`); }
  let output = JSON.stringify(value, null, 2);
  if (credential) output = output.replaceAll(credential, "[REDACTED]");
  console.log(output);
  if (!response.ok) { console.error(`HTTP ${response.status}. See README.md for error handling.`); process.exitCode = 1; }
}
main().catch(() => { console.error("Nabda client failed. Check command options, environment, input file and network. Run --help for usage."); process.exitCode = 1; });
