import { randomUUID } from "node:crypto";
import type { RateLimiter, RateLimitResult } from "../../src/rate-limit/rate-limiter.js";

interface Bucket {
  windowStart: number;
  count: number;
}

export class MemoryRateLimiter implements RateLimiter {
  readonly consumeCalls: Array<{ key: string; limit: number; now: Date; deduplicationKey?: string }> = [];
  failHealth = false;
  failConsume = false;

  private readonly buckets = new Map<string, Bucket>();
  private readonly deduplicationKeys = new Set<string>();

  async health(): Promise<void> {
    if (this.failHealth) throw new Error("memory rate limiter unavailable");
  }

  async consume(key: string, limit: number, now: Date, deduplicationKey?: string): Promise<RateLimitResult> {
    this.consumeCalls.push({ key, limit, now: new Date(now.getTime()), ...(deduplicationKey ? { deduplicationKey } : {}) });
    if (this.failConsume) throw new Error("memory rate limiter unavailable");

    const windowStart = Math.floor(now.getTime() / 60_000) * 60_000;
    const current = this.buckets.get(key);
    const bucket = current?.windowStart === windowStart
      ? current
      : { windowStart, count: 0 };
    const dedupKey = `${key}:${windowStart}:${deduplicationKey ?? randomUUID()}`;
    if (!this.deduplicationKeys.has(dedupKey)) bucket.count += 1;
    this.deduplicationKeys.add(dedupKey);
    this.buckets.set(key, bucket);

    const allowed = bucket.count <= limit;
    return {
      allowed,
      limit,
      remaining: Math.max(limit - bucket.count, 0),
      resetAt: new Date(windowStart + 60_000),
    };
  }

  reset(): void {
    this.buckets.clear();
    this.deduplicationKeys.clear();
    this.consumeCalls.length = 0;
  }
}
