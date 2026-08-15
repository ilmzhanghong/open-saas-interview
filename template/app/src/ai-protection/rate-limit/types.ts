export interface RateLimitConsumeResult {
  allowed: boolean;
  retryAfterMs?: number;
}

export interface RateLimitStore {
  consume(
    key: string,
    windowMs: number,
    max: number,
  ): Promise<RateLimitConsumeResult>;
}

export type RateLimitStoreKind = "memory" | "db";
