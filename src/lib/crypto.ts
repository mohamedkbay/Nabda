import {
  createCipheriv,
  createDecipheriv,
  createHash,
  createHmac,
  randomBytes,
  timingSafeEqual,
} from "node:crypto";

export interface GeneratedApiKey {
  rawKey: string;
  prefix: string;
  hash: string;
}

export interface GeneratedDeviceToken {
  rawToken: string;
  prefix: string;
  hash: string;
}

const DEVICE_TOKEN_DOMAIN = "nabda:device-agent-token:v1\0";
const DEVICE_LEASE_DOMAIN = "nabda:device-agent-lease:v1\0";

export function apiKeyDigest(rawKey: string, hashSecret: string): string {
  return createHmac("sha256", hashSecret).update(rawKey, "utf8").digest("hex");
}

export function generateApiKey(hashSecret: string, environment: "live" | "test" = "live"): GeneratedApiKey {
  const publicId = randomBytes(8).toString("base64url");
  const prefix = `nbda_${environment}_${publicId}`;
  const rawKey = `${prefix}.${randomBytes(32).toString("base64url")}`;
  return { rawKey, prefix, hash: apiKeyDigest(rawKey, hashSecret) };
}

export function apiKeyPrefix(rawKey: string): string | null {
  const match = /^(nbda_(?:live|test)_[A-Za-z0-9_-]{8,16})\.[A-Za-z0-9_-]{40,64}$/.exec(rawKey);
  return match?.[1] ?? null;
}

export function verifyApiKey(rawKey: string, expectedHexHash: string, hashSecret: string): boolean {
  try {
    const actual = Buffer.from(apiKeyDigest(rawKey, hashSecret), "hex");
    const expected = Buffer.from(expectedHexHash, "hex");
    return actual.length === expected.length && timingSafeEqual(actual, expected);
  } catch {
    return false;
  }
}

function domainDigest(domain: string, value: string, hashSecret: string): string {
  return createHmac("sha256", hashSecret).update(domain, "utf8").update(value, "utf8").digest("hex");
}

export function deviceTokenDigest(rawToken: string, hashSecret: string): string {
  return domainDigest(DEVICE_TOKEN_DOMAIN, rawToken, hashSecret);
}

export function generateDeviceToken(hashSecret: string): GeneratedDeviceToken {
  const publicId = randomBytes(9).toString("base64url");
  const prefix = `nbda_device_${publicId}`;
  const rawToken = `${prefix}.${randomBytes(32).toString("base64url")}`;
  return { rawToken, prefix, hash: deviceTokenDigest(rawToken, hashSecret) };
}

export function deviceTokenPrefix(rawToken: string): string | null {
  const match = /^(nbda_device_[A-Za-z0-9_-]{12})\.[A-Za-z0-9_-]{43}$/.exec(rawToken);
  return match?.[1] ?? null;
}

export function verifyDeviceToken(rawToken: string, expectedHexHash: string, hashSecret: string): boolean {
  try {
    const actual = Buffer.from(deviceTokenDigest(rawToken, hashSecret), "hex");
    const expected = Buffer.from(expectedHexHash, "hex");
    return actual.length === expected.length && timingSafeEqual(actual, expected);
  } catch {
    return false;
  }
}

export function generateDeviceLease(hashSecret: string): { rawToken: string; hash: string } {
  const rawToken = randomBytes(32).toString("base64url");
  return { rawToken, hash: domainDigest(DEVICE_LEASE_DOMAIN, rawToken, hashSecret) };
}

export function deviceLeaseDigest(rawToken: string, hashSecret: string): string {
  return domainDigest(DEVICE_LEASE_DOMAIN, rawToken, hashSecret);
}

function canonicalize(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalize);
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>)
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([key, child]) => [key, canonicalize(child)]),
    );
  }
  return value;
}

export function requestDigest(value: unknown): string {
  return createHash("sha256").update(JSON.stringify(canonicalize(value))).digest("hex");
}

export function keyedRequestDigest(value: unknown, hashSecret: string, domain: string): string {
  return createHmac("sha256", hashSecret)
    .update(`nabda:${domain}:v1\0`, "utf8")
    .update(JSON.stringify(canonicalize(value)), "utf8")
    .digest("hex");
}

function encryptionKey(secret: string): Buffer {
  const decoded = Buffer.from(secret, "base64");
  if (decoded.length !== 32) throw new Error("APP_ENCRYPTION_KEY must decode to exactly 32 bytes.");
  return decoded;
}

export class SecretBox {
  private readonly key: Buffer;

  constructor(secret: string) {
    this.key = encryptionKey(secret);
  }

  encrypt(plaintext: string): string {
    const iv = randomBytes(12);
    const cipher = createCipheriv("aes-256-gcm", this.key, iv);
    const ciphertext = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
    const tag = cipher.getAuthTag();
    return `v1.${iv.toString("base64url")}.${tag.toString("base64url")}.${ciphertext.toString("base64url")}`;
  }

  decrypt(encoded: string): string {
    const [version, ivValue, tagValue, ciphertextValue, ...rest] = encoded.split(".");
    if (version !== "v1" || !ivValue || !tagValue || !ciphertextValue || rest.length) {
      throw new Error("Invalid encrypted value.");
    }
    const decipher = createDecipheriv("aes-256-gcm", this.key, Buffer.from(ivValue, "base64url"));
    decipher.setAuthTag(Buffer.from(tagValue, "base64url"));
    return Buffer.concat([
      decipher.update(Buffer.from(ciphertextValue, "base64url")),
      decipher.final(),
    ]).toString("utf8");
  }
}

export function signWebhook(timestamp: number, rawBody: string, secret: string): string {
  return `v1=${createHmac("sha256", secret).update(`${timestamp}.${rawBody}`, "utf8").digest("hex")}`;
}
