import { z } from "zod";
import { isIP } from "node:net";

const booleanFromString = z.enum(["true", "false"]).transform((value) => value === "true");

function isIpOrCidr(value: string): boolean {
  const [address, prefix, ...extra] = value.split("/");
  if (!address || extra.length) return false;
  const family = isIP(address);
  if (!family) return false;
  if (prefix === undefined) return true;
  if (!/^\d+$/.test(prefix)) return false;
  const bits = Number(prefix);
  return bits >= 0 && bits <= (family === 4 ? 32 : 128);
}

const trustedProxyCidrs = z.string().default("")
  .transform((value) => value.split(",").map((entry) => entry.trim()).filter(Boolean))
  .refine((values) => values.every(isIpOrCidr), "must contain only comma-separated IP addresses or CIDRs");

const schema = z.object({
  NODE_ENV: z.enum(["development", "test", "production"]).default("development"),
  HOST: z.string().default("0.0.0.0"),
  PORT: z.coerce.number().int().min(1).max(65_535).default(3000),
  LOG_LEVEL: z.string().default("info"),
  DATABASE_URL: z.string().min(1),
  DB_POOL_MAX: z.coerce.number().int().min(6).max(100).default(10),
  TRUSTED_PROXY_CIDRS: trustedProxyCidrs,
  REDIS_URL: z.string().min(1),
  API_KEY_HASH_SECRET: z.string().min(32),
  APP_ENCRYPTION_KEY: z.string().min(1),
  PROVIDER_MODE: z.enum(["mock", "httpsms"]).default("mock"),
  ENABLE_LIVE_SMS: booleanFromString.default(false),
  ENABLE_ANDROID_AGENT: booleanFromString.default(true),
  ENABLE_ANDROID_AGENT_LIVE_REPORTING: booleanFromString.default(false),
  HTTPSMS_API_BASE: z.string().url().default("https://api.httpsms.com/v1"),
  PROVIDER_TIMEOUT_MS: z.coerce.number().int().min(1000).max(60_000).default(15_000),
  DISPATCH_MIN_INTERVAL_MS: z.coerce.number().int().min(1000).max(60_000).default(3_000),
  STATUS_POLL_INTERVAL_MS: z.coerce.number().int().min(1000).max(300_000).default(10_000),
  CLEANUP_INTERVAL_MS: z.coerce.number().int().min(60_000).max(86_400_000).default(3_600_000),
  CLEANUP_BATCH_SIZE: z.coerce.number().int().min(1).max(5_000).default(500),
  QUEUE_PREFIX: z.string().regex(/^[A-Za-z0-9:_-]+$/).default("nabda"),
  RATE_LIMIT_FAIL_OPEN: booleanFromString.default(false),
  IP_REQUESTS_PER_MINUTE: z.coerce.number().int().min(60).max(100_000).default(1_200),
  API_KEY_REQUESTS_PER_MINUTE: z.coerce.number().int().min(10).max(100_000).default(600),
  DEVICE_REQUESTS_PER_MINUTE: z.coerce.number().int().min(10).max(10_000).default(120),
  ORGANIZATION_WRITES_PER_MINUTE: z.coerce.number().int().min(10).max(10_000).default(60),
  WEBHOOK_TIMEOUT_MS: z.coerce.number().int().min(1000).max(30_000).default(10_000),
});

export type AppConfig = z.infer<typeof schema>;

function isOfficialHttpSmsApiBase(value: string): boolean {
  try {
    const url = new URL(value);
    return url.protocol === "https:" && url.hostname === "api.httpsms.com";
  } catch {
    return false;
  }
}

export function loadConfig(environment: NodeJS.ProcessEnv = process.env): AppConfig {
  const parsed = schema.safeParse(environment);
  if (!parsed.success) {
    const problems = parsed.error.issues.map((issue) => `${issue.path.join(".")}: ${issue.message}`).join("; ");
    throw new Error(`Invalid configuration: ${problems}`);
  }
  const key = Buffer.from(parsed.data.APP_ENCRYPTION_KEY, "base64");
  if (key.length !== 32) throw new Error("Invalid configuration: APP_ENCRYPTION_KEY must be base64 for exactly 32 bytes.");
  if (parsed.data.PROVIDER_MODE === "httpsms" && (!parsed.data.ENABLE_LIVE_SMS || parsed.data.NODE_ENV !== "production")) {
    throw new Error("Invalid configuration: httpsms mode requires NODE_ENV=production and ENABLE_LIVE_SMS=true explicitly.");
  }
  if (parsed.data.NODE_ENV === "production" && parsed.data.RATE_LIMIT_FAIL_OPEN) {
    throw new Error("Invalid configuration: RATE_LIMIT_FAIL_OPEN must remain false in production.");
  }
  if (parsed.data.PROVIDER_MODE === "httpsms" && !isOfficialHttpSmsApiBase(parsed.data.HTTPSMS_API_BASE)) {
    throw new Error("Invalid configuration: HTTPSMS_API_BASE must use the official https://api.httpsms.com host in httpsms mode.");
  }
  if (parsed.data.ENABLE_ANDROID_AGENT_LIVE_REPORTING && (
    !parsed.data.ENABLE_ANDROID_AGENT
    || !parsed.data.ENABLE_LIVE_SMS
    || parsed.data.NODE_ENV !== "production"
  )) {
    throw new Error(
      "Invalid configuration: Android agent live reporting requires production, ENABLE_ANDROID_AGENT=true, and ENABLE_LIVE_SMS=true explicitly.",
    );
  }
  return parsed.data;
}
