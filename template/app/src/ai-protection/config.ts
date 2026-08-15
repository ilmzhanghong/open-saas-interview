export interface RateLimitConfig {
  windowMs: number;
  max: number;
}

export interface AiOperationConfig<TArgs = unknown> {
  operationType: string;
  quotaCost?: number;
  rateLimit?: RateLimitConfig;
  dedupeTtlMs?: number;
  inputToDedupeKey: (args: TArgs) => string;
  inputToLogText: (args: TArgs) => string;
}

export const DEFAULT_QUOTA_COST = 1;
export const DEFAULT_DEDUPE_TTL_MS = 600_000;
export const DEFAULT_RATE_LIMIT: RateLimitConfig = {
  windowMs: 60_000,
  max: 10,
};
