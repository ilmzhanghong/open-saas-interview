import { DbRateLimitStore } from "./db";
import type { RateLimitCounterModel } from "./db";
import { InMemoryRateLimitStore } from "./in-memory";
import type { RateLimitStore, RateLimitStoreKind } from "./types";

export function createRateLimitStore(
  kind: RateLimitStoreKind,
  counter: RateLimitCounterModel,
): RateLimitStore {
  return kind === "db"
    ? new DbRateLimitStore(counter)
    : new InMemoryRateLimitStore();
}
