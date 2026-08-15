import type { RateLimitConsumeResult, RateLimitStore } from "./types";

export class InMemoryRateLimitStore implements RateLimitStore {
  private hits = new Map<string, number[]>();

  async consume(
    key: string,
    windowMs: number,
    max: number,
  ): Promise<RateLimitConsumeResult> {
    const now = Date.now();
    const window = (this.hits.get(key) ?? []).filter(
      (t) => now - t < windowMs,
    );
    if (window.length >= max) {
      this.hits.set(key, window);
      return { allowed: false, retryAfterMs: windowMs - (now - window[0]) };
    }
    window.push(now);
    this.hits.set(key, window);
    return { allowed: true };
  }
}
