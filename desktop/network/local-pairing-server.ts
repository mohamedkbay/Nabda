import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { isIP } from "node:net";
import { z } from "zod";
import type { DesktopServices } from "../contracts.js";

const MAX_BODY_BYTES = 16 * 1024;
const claimSchema = z
  .object({
    code: z.string().regex(/^[A-Za-z0-9_-]{43}$/),
    phone: z
      .object({
        name: z.string().trim().min(1).max(100),
        installationId: z.string().trim().min(8).max(200),
        appVersion: z.string().trim().min(1).max(50),
        platform: z.literal("android"),
      })
      .strict(),
  })
  .strict();
const heartbeatSchema = z
  .object({
    installationId: z.string().trim().min(8).max(200),
    appVersion: z.string().trim().min(1).max(50),
  })
  .strict();

export class LocalPairingServer {
  private server: Server | undefined;
  private readonly requestsByAddress = new Map<string, { count: number; windowStartedAt: number }>();

  public constructor(
    private readonly services: DesktopServices,
    private readonly host: string,
    private readonly port = 47_831,
  ) {
    if (!isPrivateLanAddress(host)) {
      throw new Error("Pairing server requires one explicit private LAN address.");
    }
  }

  public get origin(): string {
    return `http://${this.host}:${this.port}`;
  }

  public async start(): Promise<void> {
    if (this.server) return;
    const server = createServer((request, response) => void this.handle(request, response));
    server.keepAliveTimeout = 5_000;
    server.headersTimeout = 6_000;
    server.requestTimeout = 10_000;
    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen(this.port, this.host, () => {
        server.off("error", reject);
        resolve();
      });
    });
    this.server = server;
  }

  public async stop(): Promise<void> {
    const server = this.server;
    this.server = undefined;
    if (!server) return;
    await new Promise<void>((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));
  }

  private async handle(request: IncomingMessage, response: ServerResponse): Promise<void> {
    response.setHeader("Cache-Control", "no-store");
    response.setHeader("Content-Type", "application/json; charset=utf-8");
    response.setHeader("X-Content-Type-Options", "nosniff");
    const remoteAddress = normaliseAddress(request.socket.remoteAddress);
    if (!remoteAddress || !isPrivateLanAddress(remoteAddress)) {
      return send(response, 403, { error: "lan_only" });
    }
    if (!this.allowRequest(remoteAddress)) return send(response, 429, { error: "rate_limited" });
    if (request.method !== "POST") return send(response, 405, { error: "method_not_allowed" });

    try {
      if (request.url === "/local/v1/pairing/claim") {
        const input = claimSchema.parse(await readJson(request));
        const result = await this.services.devices.claimPairing({
          pairingCode: input.code,
          deviceName: input.phone.name,
          installationId: input.phone.installationId,
          appVersion: input.phone.appVersion,
          platform: input.phone.platform,
          lanOrigin: this.origin,
        });
        return send(response, 201, {
          data: {
            deviceId: result.deviceId,
            deviceToken: result.deviceToken,
            serverTime: new Date().toISOString(),
          },
        });
      }

      if (request.url === "/local/v1/device/heartbeat") {
        const token = readBearer(request);
        const input = heartbeatSchema.parse(await readJson(request));
        const result = await this.services.devices.receiveHeartbeat({
          bearerToken: token,
          installationId: input.installationId,
          appVersion: input.appVersion,
          platform: "android",
        });
        return send(response, 200, {
          data: {
            deviceId: result.deviceId,
            status: "connected",
            lastSeenAt: result.acceptedAt,
            serverTime: new Date().toISOString(),
          },
        });
      }
      return send(response, 404, { error: "not_found" });
    } catch (error) {
      if (error instanceof BodyTooLargeError) return send(response, 413, { error: "payload_too_large" });
      if (error instanceof z.ZodError) return send(response, 400, { error: "invalid_request" });
      if (error instanceof UnauthorizedError) return send(response, 401, { error: "unauthorized" });
      return send(response, 400, { error: "request_rejected" });
    }
  }

  private allowRequest(address: string): boolean {
    const now = Date.now();
    const current = this.requestsByAddress.get(address);
    if (!current || now - current.windowStartedAt >= 60_000) {
      this.requestsByAddress.set(address, { count: 1, windowStartedAt: now });
      return true;
    }
    current.count += 1;
    return current.count <= 30;
  }
}

export function isPrivateLanAddress(value: string): boolean {
  if (isIP(value) !== 4) return false;
  const octets = value.split(".").map(Number);
  const first = octets[0] ?? -1;
  const second = octets[1] ?? -1;
  return first === 10 || (first === 172 && second >= 16 && second <= 31) || (first === 192 && second === 168);
}

function normaliseAddress(value: string | undefined): string | undefined {
  if (!value) return undefined;
  return value.startsWith("::ffff:") ? value.slice(7) : value;
}

async function readJson(request: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const rawChunk of request) {
    const chunk = Buffer.isBuffer(rawChunk) ? rawChunk : Buffer.from(rawChunk);
    size += chunk.byteLength;
    if (size > MAX_BODY_BYTES) throw new BodyTooLargeError();
    chunks.push(chunk);
  }
  return JSON.parse(Buffer.concat(chunks).toString("utf8"));
}

function readBearer(request: IncomingMessage): string {
  const authorization = request.headers.authorization;
  if (!authorization?.startsWith("Bearer ")) throw new UnauthorizedError();
  const token = authorization.slice(7);
  if (token.length < 32 || token.length > 512) throw new UnauthorizedError();
  return token;
}

function send(response: ServerResponse, status: number, body: object): void {
  response.statusCode = status;
  response.end(JSON.stringify(body));
}

class BodyTooLargeError extends Error {}
class UnauthorizedError extends Error {}
