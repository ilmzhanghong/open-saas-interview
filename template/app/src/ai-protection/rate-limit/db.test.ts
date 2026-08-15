import { describe, expect, it, vi } from "vitest";
import { DbRateLimitStore } from "./db";
import type { RateLimitCounterModel } from "./db";

function makeFakeCounter(initial = 0) {
  let count = initial;
  const upsert = vi.fn(
    async (_args: Parameters<RateLimitCounterModel["upsert"]>[0]) => ({
      count: ++count,
    }),
  );
  const counter: RateLimitCounterModel = { upsert };
  return { counter, upsert, getCount: () => count };
}

describe("DbRateLimitStore", () => {
  it("allows requests within the limit", async () => {
    const { counter } = makeFakeCounter();
    const store = new DbRateLimitStore(counter);
    for (let i = 0; i < 3; i++) {
      expect((await store.consume("k", 1000, 3)).allowed).toBe(true);
    }
  });

  it("blocks requests over the limit with retryAfterMs", async () => {
    const { counter } = makeFakeCounter(3);
    const store = new DbRateLimitStore(counter);
    const res = await store.consume("k", 1000, 3);
    expect(res.allowed).toBe(false);
    expect(res.retryAfterMs).toBeGreaterThan(0);
  });

  it("upserts with key and deterministic windowStart", async () => {
    const now = Date.now();
    const { counter, upsert } = makeFakeCounter();
    const store = new DbRateLimitStore(counter);
    await store.consume("k", 1000, 3);
    const args = upsert.mock.calls[0]![0]!;
    expect(args.where.key_windowStart.key).toBe("k");
    expect(args.where.key_windowStart.windowStart).toBe(
      BigInt(Math.floor(now / 1000) * 1000),
    );
    expect(args.update).toEqual({ count: { increment: 1 } });
    expect(args.create.count).toBe(1);
  });
});
