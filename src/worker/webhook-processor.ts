import { lookup as dnsLookup } from "node:dns/promises";
import { request as httpRequest, type IncomingMessage } from "node:http";
import { request as httpsRequest } from "node:https";
import { BlockList, isIP } from "node:net";
import { SecretBox, signWebhook } from "../lib/crypto.js";
import type { Repository } from "../repositories/repository.js";

const blockedIpv4Addresses = new BlockList();
const blockedIpv6Addresses = new BlockList();
for (const [network, prefix] of [
  ["0.0.0.0", 8], ["10.0.0.0", 8], ["100.64.0.0", 10], ["127.0.0.0", 8],
  ["169.254.0.0", 16], ["172.16.0.0", 12], ["192.0.0.0", 24], ["192.0.2.0", 24],
  ["192.168.0.0", 16], ["198.18.0.0", 15], ["198.51.100.0", 24], ["203.0.113.0", 24],
  ["224.0.0.0", 4], ["240.0.0.0", 4],
] as const) blockedIpv4Addresses.addSubnet(network, prefix, "ipv4");
for (const [network, prefix] of [
  ["::", 96], ["::ffff:0:0", 96], ["64:ff9b::", 96], ["64:ff9b:1::", 48],
  ["100::", 64], ["2001::", 23], ["2001:db8::", 32], ["2002::", 16],
  ["fc00::", 7], ["fe80::", 10], ["fec0::", 10], ["ff00::", 8],
] as const) blockedIpv6Addresses.addSubnet(network, prefix, "ipv6");

function isPrivateAddress(address: string): boolean {
  const family = isIP(address);
  if (family === 4) return blockedIpv4Addresses.check(address, "ipv4");
  if (family === 6) return blockedIpv6Addresses.check(address, "ipv6");
  return true;
}

export interface ValidatedWebhookDestination {
  url: URL;
  address: string;
}

export type WebhookDnsLookup = (hostname: string) => Promise<readonly { address: string }[]>;

const systemWebhookDnsLookup: WebhookDnsLookup = async (hostname) => (
  dnsLookup(hostname, { all: true, verbatim: true })
);

function deadlineError(phase: string): Error {
  return new Error(`Webhook delivery exceeded its total deadline during ${phase}.`);
}

async function beforeDeadline<T>(operation: Promise<T>, deadlineAt: number, phase: string): Promise<T> {
  const remainingMs = deadlineAt - Date.now();
  if (remainingMs <= 0) throw deadlineError(phase);
  return new Promise<T>((resolve, reject) => {
    let settled = false;
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      reject(deadlineError(phase));
    }, remainingMs);
    timer.unref();
    operation.then(
      (value) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        resolve(value);
      },
      (error: unknown) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        reject(error);
      },
    );
  });
}

export async function validateWebhookUrl(
  rawUrl: string,
  environment: string,
  resolver: WebhookDnsLookup = systemWebhookDnsLookup,
  deadlineAt?: number,
): Promise<ValidatedWebhookDestination> {
  const url = new URL(rawUrl);
  if (url.username || url.password) throw new Error("Webhook URLs cannot contain credentials.");
  if (environment !== "test" && url.protocol !== "https:") throw new Error("Webhook endpoints require HTTPS.");
  if (!["https:", "http:"].includes(url.protocol)) throw new Error("Unsupported webhook URL scheme.");
  const hostname = url.hostname.replace(/^\[|\]$/g, "").toLowerCase();
  if (hostname === "localhost" || hostname.endsWith(".localhost") || hostname.endsWith(".local")) {
    throw new Error("Private webhook hosts are not allowed.");
  }
  const addresses = isIP(hostname)
    ? [{ address: hostname }]
    : deadlineAt == null
      ? await resolver(hostname)
      : await beforeDeadline(
        Promise.resolve().then(() => resolver(hostname)),
        deadlineAt,
        "DNS resolution",
      );
  if (!addresses.length || addresses.some(({ address }) => isPrivateAddress(address))) {
    throw new Error("Private webhook addresses are not allowed.");
  }
  return { url, address: addresses[0]?.address as string };
}

export type WebhookTransport = (
  destination: ValidatedWebhookDestination,
  body: string,
  headers: Record<string, string>,
  timeoutMs: number,
) => Promise<number>;

export const postPinnedWebhook: WebhookTransport = async (destination, body, headers, timeoutMs) => (
  new Promise<number>((resolve, reject) => {
    const { url, address } = destination;
    const originalHostname = url.hostname.replace(/^\[|\]$/g, "");
    const requestOptions = {
      protocol: url.protocol,
      hostname: address,
      ...(url.port ? { port: url.port } : {}),
      method: "POST",
      path: `${url.pathname}${url.search}`,
      headers: { ...headers, host: url.host, "content-length": String(Buffer.byteLength(body)) },
      ...(url.protocol === "https:" && !isIP(originalHostname) ? { servername: originalHostname } : {}),
    };
    let deadline: NodeJS.Timeout;
    const fail = (error: Error) => {
      clearTimeout(deadline);
      reject(error);
    };
    const onResponse = (response: IncomingMessage) => {
      let responseBytes = 0;
      response.on("data", (chunk: Buffer) => {
        responseBytes += chunk.length;
        if (responseBytes > 64 * 1024) response.destroy(new Error("Webhook response exceeded 64 KiB."));
      });
      response.once("end", () => {
        clearTimeout(deadline);
        resolve(response.statusCode ?? 0);
      });
      response.once("aborted", () => fail(new Error("Webhook response was aborted.")));
      response.once("error", fail);
    };
    const outgoing = url.protocol === "https:"
      ? httpsRequest(requestOptions, onResponse)
      : httpRequest(requestOptions, onResponse);
    deadline = setTimeout(
      () => outgoing.destroy(new Error("Webhook request exceeded its total deadline.")),
      timeoutMs,
    );
    deadline.unref();
    outgoing.once("error", fail);
    outgoing.end(body);
  })
);

export class WebhookProcessor {
  constructor(
    private readonly repository: Repository,
    private readonly secretBox: SecretBox,
    private readonly environment: string,
    private readonly timeoutMs: number,
    private readonly transport: WebhookTransport = postPinnedWebhook,
    private readonly resolver: WebhookDnsLookup = systemWebhookDnsLookup,
  ) {}

  async process(deliveryId: string): Promise<void> {
    const delivery = await this.repository.getWebhookDelivery(deliveryId);
    if (!delivery) return;
    let httpStatus: number | undefined;
    const deadlineAt = Date.now() + this.timeoutMs;
    try {
      const destination = await validateWebhookUrl(
        delivery.url,
        this.environment,
        this.resolver,
        deadlineAt,
      );
      const body = JSON.stringify(delivery.payload);
      const timestamp = Math.floor(Date.now() / 1000);
      const secret = this.secretBox.decrypt(delivery.encryptedSecret);
      const remainingMs = deadlineAt - Date.now();
      if (remainingMs <= 0) throw deadlineError("HTTP request");
      httpStatus = await beforeDeadline(this.transport(destination, body, {
        "content-type": "application/json",
        "user-agent": "Nabda-Webhooks/1.0",
        "x-nabda-delivery-id": delivery.id,
        "x-nabda-event-id": delivery.event.id,
        "x-nabda-timestamp": String(timestamp),
        "x-nabda-signature": signWebhook(timestamp, body, secret),
        "x-nabda-event": delivery.event.type,
      }, remainingMs), deadlineAt, "HTTP request");
      if (httpStatus < 200 || httpStatus >= 300) throw new Error(`Webhook endpoint returned ${httpStatus}.`);
      await this.repository.completeWebhookDelivery({
        deliveryId,
        lockId: delivery.lockId,
        succeeded: true,
        httpStatus,
        at: new Date(),
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : "Webhook delivery failed.";
      await this.repository.completeWebhookDelivery({
        deliveryId,
        lockId: delivery.lockId,
        succeeded: false,
        ...(httpStatus ? { httpStatus } : {}),
        error: message,
        at: new Date(),
      });
      throw error;
    }
  }
}
