/**
 * In-memory sliding-window rate limiter for public demo mode.
 * Protects mutation endpoints without requiring external stores like Redis.
 */

export interface RateLimitOptions {
  windowMs: number;
  maxRequests: number;
}

interface ClientRecord {
  timestamps: number[];
  lastSeen: number;
}

export class InMemoryRateLimiter {
  private readonly records = new Map<string, ClientRecord>();
  private readonly windowMs: number;
  private readonly maxRequests: number;
  private cleanupTimer: NodeJS.Timeout | null = null;

  constructor(options: Partial<RateLimitOptions> = {}) {
    this.windowMs = options.windowMs ?? 60_000; // 1 minute default
    this.maxRequests = options.maxRequests ?? 30; // 30 mutation requests/min default

    // Periodically sweep stale records to bound memory
    if (typeof setInterval !== 'undefined') {
      this.cleanupTimer = setInterval(() => this.cleanup(), 60_000);
      if (this.cleanupTimer.unref) {
        this.cleanupTimer.unref();
      }
    }
  }

  public check(key: string): { allowed: boolean; remaining: number; retryAfterSec?: number } {
    const now = Date.now();
    const windowStart = now - this.windowMs;

    let record = this.records.get(key);
    if (!record) {
      record = { timestamps: [], lastSeen: now };
      this.records.set(key, record);
    }

    // Filter out timestamps outside the sliding window
    record.timestamps = record.timestamps.filter((ts) => ts > windowStart);
    record.lastSeen = now;

    if (record.timestamps.length >= this.maxRequests) {
      const oldestInWindow = record.timestamps[0] ?? now;
      const retryAfterSec = Math.ceil((oldestInWindow + this.windowMs - now) / 1000);
      return {
        allowed: false,
        remaining: 0,
        retryAfterSec: Math.max(1, retryAfterSec),
      };
    }

    record.timestamps.push(now);
    return {
      allowed: true,
      remaining: this.maxRequests - record.timestamps.length,
    };
  }

  public reset(): void {
    this.records.clear();
  }

  public destroy(): void {
    if (this.cleanupTimer) {
      clearInterval(this.cleanupTimer);
      this.cleanupTimer = null;
    }
    this.records.clear();
  }

  private cleanup(): void {
    const now = Date.now();
    const staleThreshold = now - this.windowMs * 2;
    for (const [key, record] of this.records.entries()) {
      if (record.lastSeen < staleThreshold) {
        this.records.delete(key);
      }
    }
  }
}
