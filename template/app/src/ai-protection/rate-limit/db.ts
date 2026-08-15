import type { RateLimitConsumeResult, RateLimitStore } from "./types";

export interface RateLimitCounterModel {
  upsert(args: {
    where: { key_windowStart: { key: string; windowStart: bigint } };
    update: { count: { increment: number } };
    create: { key: string; windowStart: bigint; count: number };
  }): Promise<{ count: number }>;
}

export class DbRateLimitStore implements RateLimitStore {
  constructor(private readonly counter: RateLimitCounterModel) {}

  async consume(
    key: string,
    windowMs: number,
    max: number,
  ): Promise<RateLimitConsumeResult> {
    const now = Date.now();
    const windowStart = BigInt(Math.floor(now / windowMs) * windowMs);
    const row = await this.counter.upsert({
      where: { key_windowStart: { key, windowStart } },
      update: { count: { increment: 1 } },
      create: { key, windowStart, count: 1 },
    });
    if (row.count > max) {
      return {
        allowed: false,
        retryAfterMs: Number(windowStart + BigInt(windowMs) - BigInt(now)),
      };
    }
    return { allowed: true };
  }
}
