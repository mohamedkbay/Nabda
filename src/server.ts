import { Redis } from "ioredis";
import { loadConfig } from "./config.js";
import { buildApp } from "./app.js";
import { createPostgresPool } from "./db/pool.js";
import { RedisRateLimiter } from "./rate-limit/redis-rate-limiter.js";
import { PostgresRepository } from "./repositories/postgres-repository.js";

const config = loadConfig();
const pool = createPostgresPool(config.DATABASE_URL, config.DB_POOL_MAX);
const redis = new Redis(config.REDIS_URL, { maxRetriesPerRequest: 1, enableReadyCheck: true });
redis.on("error", () => undefined);
const executionMode = config.PROVIDER_MODE === "httpsms" || config.ENABLE_ANDROID_AGENT_LIVE_REPORTING
  ? "live"
  : "simulation";
const repository = new PostgresRepository(pool, config.PROVIDER_MODE, config.ENABLE_ANDROID_AGENT, executionMode);
const rateLimiter = new RedisRateLimiter(redis, config.QUEUE_PREFIX, config.RATE_LIMIT_FAIL_OPEN);
const app = await buildApp({
  repository,
  rateLimiter,
  apiKeyHashSecret: config.API_KEY_HASH_SECRET,
  providerMode: config.PROVIDER_MODE,
  androidAgentEnabled: config.ENABLE_ANDROID_AGENT,
  androidAgentLiveReportingEnabled: config.ENABLE_ANDROID_AGENT_LIVE_REPORTING,
  dispatchMinIntervalMs: config.DISPATCH_MIN_INTERVAL_MS,
  trustProxy: config.TRUSTED_PROXY_CIDRS.length ? config.TRUSTED_PROXY_CIDRS : false,
  ipRequestsPerMinute: config.IP_REQUESTS_PER_MINUTE,
  apiKeyRequestsPerMinute: config.API_KEY_REQUESTS_PER_MINUTE,
  deviceRequestsPerMinute: config.DEVICE_REQUESTS_PER_MINUTE,
  organizationWritesPerMinute: config.ORGANIZATION_WRITES_PER_MINUTE,
  logger: {
    level: config.LOG_LEVEL,
    redact: [
      "req.headers.authorization",
      "req.headers.x-api-key",
      "request.headers.authorization",
      "request.headers.x-api-key",
      "content",
      "credential",
    ],
  },
});

let closing = false;
async function shutdown(signal: string): Promise<void> {
  if (closing) return;
  closing = true;
  app.log.info({ signal }, "Shutting down API");
  await app.close();
  redis.disconnect();
  await pool.end();
}

process.on("SIGINT", () => void shutdown("SIGINT"));
process.on("SIGTERM", () => void shutdown("SIGTERM"));

try {
  await app.listen({ host: config.HOST, port: config.PORT });
} catch (error) {
  app.log.error({ err: error }, "API failed to start");
  await shutdown("startup-error");
  process.exitCode = 1;
}
