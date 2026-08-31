import { randomUUID } from "node:crypto";
import type { Redis } from "ioredis";
import type { RateLimiter, RateLimitResult } from "./rate-limiter.js";

const SCRIPT = `
local is_new = redis.call('SET', KEYS[2], '1', 'PX', ARGV[1], 'NX')
local current
if is_new then
  current = redis.call('INCR', KEYS[1])
  if current == 1 then redis.call('PEXPIRE', KEYS[1], ARGV[1]) end
else
  current = tonumber(redis.call('GET', KEYS[1]) or '0')
end
local ttl = redis.call('PTTL', KEYS[1])
return {current, ttl}
`;

export class RedisRateLimiter implements RateLimiter {
  constructor(
    private readonly redis: Redis,
    private readonly prefix: string,
    private readonly failOpen = false,
  ) {}

  async consume(key: string, limit: number, now: Date, deduplicationKey?: string): Promise<RateLimitResult> {
    const windowStart = Math.floor(now.getTime() / 60_000);
    const redisKey = `${this.prefix}:rate:${key}:${windowStart}`;
    const dedupKey = `${redisKey}:dedup:${deduplicationKey ?? randomUUID()}`;
    try {
      const result = await this.redis.eval(SCRIPT, 2, redisKey, dedupKey, 61_000) as [number, number];
      const count = Number(result[0]);
      const ttl = Math.max(Number(result[1]), 0);
      return {
        allowed: count <= limit,
        limit,
        remaining: Math.max(limit - count, 0),
        resetAt: new Date(now.getTime() + ttl),
      };
    } catch (error) {
      if (!this.failOpen) throw error;
      return { allowed: true, limit, remaining: limit, resetAt: new Date(now.getTime() + 60_000) };
    }
  }

  async health(): Promise<void> {
    const response = await this.redis.ping();
    if (response !== "PONG") throw new Error("Redis did not respond to ping.");
  }
}
