export interface RateLimitResult {
  allowed: boolean;
  limit: number;
  remaining: number;
  resetAt: Date;
}

export interface RateLimiter {
  consume(key: string, limit: number, now: Date, deduplicationKey?: string): Promise<RateLimitResult>;
  health(): Promise<void>;
}
