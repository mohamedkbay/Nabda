import { randomBytes } from "node:crypto";
import { readFile } from "node:fs/promises";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { ControllerError, LocalController } from "./controller.js";

const moduleDirectory = dirname(fileURLToPath(import.meta.url));
const MAX_BODY_BYTES = 512 * 1024;

function loopback(address: string | undefined): boolean {
  return address === "127.0.0.1" || address === "::1" || address === "::ffff:127.0.0.1";
}
function privateNetwork(address: string | undefined): boolean {
  if (!address) return false;
  if (loopback(address)) return true;
  const normalized = address.startsWith("::ffff:") ? address.slice(7) : address.toLowerCase();
  if (normalized.startsWith("fc") || normalized.startsWith("fd") || normalized.startsWith("fe80:")) return true;
  const parts = normalized.split(".").map(Number);
  if (parts.length !== 4 || parts.some((part) => !Number.isInteger(part) || part < 0 || part > 255)) return false;
  return parts[0] === 10
    || (parts[0] === 172 && (parts[1] as number) >= 16 && (parts[1] as number) <= 31)
    || (parts[0] === 192 && parts[1] === 168);
}
function json(response: ServerResponse, status: number, value: unknown, extra: Record<string, string> = {}): void {
  response.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "cache-control": "no-store",
    "x-content-type-options": "nosniff",
    "referrer-policy": "no-referrer",
    ...extra,
  });
  response.end(JSON.stringify(value));
}
function error(response: ServerResponse, issue: unknown): void {
  const known = issue instanceof ControllerError ? issue : new ControllerError(500, "internal_error", "The local controller could not complete the request.");
  json(response, known.status, { error: { code: known.code, message: known.message } }, known.retryAfter ? { "retry-after": String(known.retryAfter) } : {});
}
async function body(request: IncomingMessage): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = [];
  let total = 0;
  for await (const chunk of request) {
    const value = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    total += value.length;
    if (total > MAX_BODY_BYTES) throw new ControllerError(413, "body_too_large", "Request body is too large.");
    chunks.push(value);
  }
  if (!chunks.length) return {};
  try {
    const parsed = JSON.parse(Buffer.concat(chunks).toString("utf8"));
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error("object required");
    return parsed as Record<string, unknown>;
  } catch {
    throw new ControllerError(400, "invalid_json", "A JSON object is required.");
  }
}
function bearer(request: IncomingMessage): string {
  const value = request.headers.authorization ?? "";
  return value.startsWith("Bearer ") ? value.slice(7).trim() : "";
}

export interface ControllerServer {
  port: number;
  dashboardUrl: string;
  lanUrl: string;
  close(): Promise<void>;
}

export async function startControllerServer(input: {
  controller: LocalController;
  lanAddress: string;
  port?: number;
}): Promise<ControllerServer> {
  const requestedPort = input.port ?? 3210;
  let port = requestedPort;
  const browserSecret = randomBytes(32).toString("base64url");
  const cookie = `nbda_control=${browserSecret}`;
  let lanUrl = `http://${input.lanAddress}:${port}`;
  const [html, css, script, contactImport, cairo, lucide, qrCode] = await Promise.all([
    readFile(join(moduleDirectory, "web", "index.html")),
    readFile(join(moduleDirectory, "web", "styles.css")),
    readFile(join(moduleDirectory, "web", "app.js")),
    readFile(join(moduleDirectory, "web", "contact-import.js")),
    readFile(join(moduleDirectory, "web", "cairo.woff2")).catch(() => readFile(join(moduleDirectory, "..", "..", "public", "fonts", "cairo-arabic-wght-normal.woff2"))),
    readFile(join(moduleDirectory, "web", "vendor", "lucide.js")).catch(() => readFile(join(moduleDirectory, "..", "renderer", "vendor", "lucide.js"))),
    readFile(join(moduleDirectory, "web", "vendor", "qrcode.js")).catch(() => readFile(join(moduleDirectory, "..", "..", "node_modules", "qrcode-generator", "dist", "qrcode.js"))),
  ]);

  const server = createServer(async (request, response) => {
    try {
      const url = new URL(request.url ?? "/", `http://${request.headers.host ?? `127.0.0.1:${port}`}`);
      const path = url.pathname;
      const method = request.method ?? "GET";

      if (path === "/health" && method === "GET") return json(response, 200, { status: "ok", delivery_mode: "android_lan", live_enabled: input.controller.liveEnabled });

      if (path === "/v1/device/pair" && method === "POST") {
        if (!privateNetwork(request.socket.remoteAddress)) throw new ControllerError(403, "private_network_required", "Pairing is available only on the trusted private network.");
        return json(response, 201, input.controller.pairDevice(await body(request)));
      }

      if (path.startsWith("/v1/device/")) {
        const token = bearer(request);
        if (!token) throw new ControllerError(401, "invalid_device_token", "A device token is required.");
        const device = input.controller.authenticateDevice(token);
        const payload = await body(request);
        if (path === "/v1/device/heartbeat" && method === "POST") return json(response, 200, input.controller.heartbeat(device, payload));
        if (path === "/v1/device/messages/claim" && method === "POST") return json(response, 200, input.controller.claim(device, payload));
        const begin = path.match(/^\/v1\/device\/messages\/([0-9a-f-]{36})\/begin$/i);
        if (begin && method === "POST") return json(response, 200, input.controller.begin(device, begin[1] as string, payload));
        const event = path.match(/^\/v1\/device\/messages\/([0-9a-f-]{36})\/events$/i);
        if (event && method === "POST") return json(response, 200, input.controller.event(device, event[1] as string, payload));
        throw new ControllerError(404, "not_found", "Device endpoint not found.");
      }

      if (!loopback(request.socket.remoteAddress)) throw new ControllerError(403, "local_browser_only", "The control dashboard is available only on this Windows computer.");
      const cookies = String(request.headers.cookie ?? "").split(/;\s*/);
      const authenticated = cookies.includes(cookie);
      if (path === "/" && method === "GET" && url.searchParams.get("access") === browserSecret) {
        response.writeHead(302, {
          location: "/",
          "set-cookie": `${cookie}; HttpOnly; SameSite=Strict; Path=/; Max-Age=43200`,
          "cache-control": "no-store",
        });
        return response.end();
      }
      if (!authenticated) throw new ControllerError(401, "dashboard_locked", "Open Nabda Controller from its Windows tray icon.");

      if (path === "/" && method === "GET") {
        response.writeHead(200, {
          "content-type": "text/html; charset=utf-8",
          "cache-control": "no-store",
          "content-security-policy": "default-src 'self'; script-src 'self'; style-src 'self'; font-src 'self'; img-src 'self' data:; connect-src 'self'; object-src 'none'; frame-src 'none'; base-uri 'none'; form-action 'self'; frame-ancestors 'none'",
          "x-frame-options": "DENY",
          "x-content-type-options": "nosniff",
          "referrer-policy": "no-referrer",
        });
        return response.end(html);
      }
      if (path === "/styles.css" && method === "GET") {
        response.writeHead(200, { "content-type": "text/css; charset=utf-8", "cache-control": "public, max-age=3600", "x-content-type-options": "nosniff" });
        return response.end(css);
      }
      if (path === "/app.js" && method === "GET") {
        response.writeHead(200, { "content-type": "application/javascript; charset=utf-8", "cache-control": "no-cache", "x-content-type-options": "nosniff" });
        return response.end(script);
      }
      if (path === "/contact-import.js" && method === "GET") {
        response.writeHead(200, { "content-type": "application/javascript; charset=utf-8", "cache-control": "no-cache", "x-content-type-options": "nosniff" });
        return response.end(contactImport);
      }
      if (path === "/vendor/lucide.js" && method === "GET") {
        response.writeHead(200, { "content-type": "application/javascript; charset=utf-8", "cache-control": "public, max-age=31536000, immutable", "x-content-type-options": "nosniff" });
        return response.end(lucide);
      }
      if (path === "/vendor/qrcode.js" && method === "GET") {
        response.writeHead(200, { "content-type": "application/javascript; charset=utf-8", "cache-control": "public, max-age=31536000, immutable", "x-content-type-options": "nosniff" });
        return response.end(qrCode);
      }
      if (path === "/cairo.woff2" && method === "GET") {
        response.writeHead(200, { "content-type": "font/woff2", "cache-control": "public, max-age=31536000, immutable", "x-content-type-options": "nosniff" });
        return response.end(cairo);
      }

      if (!path.startsWith("/control-api/")) throw new ControllerError(404, "not_found", "Page not found.");
      if (method !== "GET" && request.headers["x-nabda-control"] !== "1") throw new ControllerError(403, "csrf_rejected", "The browser control header is required.");
      if (path === "/control-api/state" && method === "GET") return json(response, 200, input.controller.getDashboard(lanUrl));
      if (path === "/control-api/live" && method === "POST") {
        const payload = await body(request); input.controller.setLiveEnabled(payload.enabled === true, typeof payload.confirmation === "string" ? payload.confirmation : undefined);
        return json(response, 200, { live_enabled: input.controller.liveEnabled });
      }
      if (path === "/control-api/devices" && method === "POST") {
        const payload = await body(request); return json(response, 201, input.controller.provisionDevice(payload.name));
      }
      if (path === "/control-api/pairing" && method === "POST") {
        const payload = await body(request); return json(response, 201, input.controller.createPairing(lanUrl, payload.name));
      }
      if (path === "/control-api/contacts" && method === "POST") return json(response, 201, input.controller.createContact(await body(request)));
      if (path === "/control-api/contacts/import" && method === "POST") return json(response, 201, input.controller.importContacts(await body(request)));
      const optOut = path.match(/^\/control-api\/contacts\/([0-9a-f-]{36})\/opt-out$/i);
      if (optOut && method === "POST") {
        const payload = await body(request); input.controller.setOptOut(optOut[1] as string, payload.opted_out === true); return json(response, 200, { ok: true });
      }
      if (path === "/control-api/messages" && method === "POST") return json(response, 202, input.controller.createMessage(await body(request)));
      const cancel = path.match(/^\/control-api\/messages\/([0-9a-f-]{36})\/cancel$/i);
      if (cancel && method === "POST") { input.controller.cancelMessage(cancel[1] as string); return json(response, 200, { ok: true }); }
      if (path === "/control-api/campaigns" && method === "POST") return json(response, 202, input.controller.createCampaign(await body(request)));
      throw new ControllerError(404, "not_found", "Control endpoint not found.");
    } catch (issue) {
      error(response, issue);
    }
  });

  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(requestedPort, "0.0.0.0", () => {
      server.off("error", reject);
      const address = server.address();
      if (address && typeof address === "object") port = address.port;
      lanUrl = `http://${input.lanAddress}:${port}`;
      resolve();
    });
  });
  return {
    port,
    dashboardUrl: `http://127.0.0.1:${port}/?access=${encodeURIComponent(browserSecret)}`,
    lanUrl,
    close: () => new Promise<void>((resolve, reject) => server.close((issue) => issue ? reject(issue) : resolve())),
  };
}
